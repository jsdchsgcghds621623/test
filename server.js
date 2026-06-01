import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

app.get(["/admin", "/admin.html"], (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

/* ─────────────────────────────
   ENV CHECK
───────────────────────────── */

if (!process.env.ENCRYPTION_KEY) {
  throw new Error("ENCRYPTION_KEY is required (32-byte hex)");
}

if (!process.env.DECRYPT_API_KEY) {
  throw new Error("DECRYPT_API_KEY is required");
}

const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
const DECRYPT_API_KEY = process.env.DECRYPT_API_KEY;
const ALGORITHM = "aes-256-gcm";

const API_KEY = "e11a7debaaa4f5d25b671706ffe4d2acb56efbd4";

const BASE_HEADERS = {
  accept: "*/*",
  referer: "https://streams.iqsmartgames.com",
};

const PROVIDER_URLS = {
  strmp2: "https://multimovies.p2pplay.pro/#",
  upnshr: "https://server1.uns.bio/#",
  rpmshre: "https://multimovies.rpmhub.site/#",
};

const PROVIDER_NAMES = {
  strmp2: "StreamP2P",
  upnshr: "UpnShare",
  rpmshre: "RpmShare",
};

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const MAX_ANALYTICS = 10000;

/* ─────────────────────────────
   ANALYTICS STORE
───────────────────────────── */

const analytics = {
  requests: [],
  counters: {
    total: 0,
    movies: 0,
    series: 0,
    decrypts: 0,
    cacheHits: 0,
    errors: 0,
    byProvider: { strmp2: 0, upnshr: 0, rpmshre: 0 },
    byOrigin: {},
    byRoute: { "/movie": 0, "/series": 0, "/decrypt": 0 },
  },
  hourly: Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    count: 0,
    movies: 0,
    series: 0,
    decrypts: 0,
    errors: 0,
  })),
  startedAt: Date.now(),
};

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function getOriginInfo(req) {
  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  const host = req.headers.host || "";
  let domain = "direct";

  if (origin) {
    try {
      domain = new URL(origin).hostname;
    } catch {
      domain = origin;
    }
  } else if (referer) {
    try {
      domain = new URL(referer).hostname;
    } catch {
      domain = referer;
    }
  }

  return { origin, referer, host, domain };
}

function detectProviderFromUrl(url) {
  if (!url) return null;
  if (url.includes("p2pplay.pro")) return "strmp2";
  if (url.includes("uns.bio")) return "upnshr";
  if (url.includes("rpmhub.site")) return "rpmshre";
  return null;
}

function bumpHourly(field = "count") {
  const hour = new Date().getHours();
  analytics.hourly[hour][field] += 1;
}

function trackOrigin(domain) {
  analytics.counters.byOrigin[domain] =
    (analytics.counters.byOrigin[domain] || 0) + 1;
}

function logRequest(entry) {
  analytics.counters.total += 1;
  bumpHourly("count");

  if (entry.type === "movie") {
    analytics.counters.movies += 1;
    bumpHourly("movies");
  } else if (entry.type === "series") {
    analytics.counters.series += 1;
    bumpHourly("series");
  } else if (entry.type === "decrypt") {
    analytics.counters.decrypts += 1;
    bumpHourly("decrypts");
  }

  if (entry.cached) analytics.counters.cacheHits += 1;
  if (entry.status >= 400) {
    analytics.counters.errors += 1;
    bumpHourly("errors");
  }

  if (entry.route && analytics.counters.byRoute[entry.route] !== undefined) {
    analytics.counters.byRoute[entry.route] += 1;
  }

  trackOrigin(entry.origin?.domain || "direct");

  if (entry.providers) {
    for (const p of entry.providers) {
      if (analytics.counters.byProvider[p] !== undefined) {
        analytics.counters.byProvider[p] += 1;
      }
    }
  }

  if (entry.decryptedProvider && analytics.counters.byProvider[entry.decryptedProvider] !== undefined) {
    analytics.counters.byProvider[entry.decryptedProvider] += 1;
  }

  analytics.requests.unshift(entry);
  if (analytics.requests.length > MAX_ANALYTICS) {
    analytics.requests.length = MAX_ANALYTICS;
  }
}

function requireAdmin(req, res, next) {
  const secret =
    req.headers["x-admin-secret"] ||
    req.query.secret ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "");

  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* ─────────────────────────────
   SIMPLE MEMORY CACHE
───────────────────────────── */

const CACHE_TTL = 1000 * 60 * 15; // 15 minutes
const cache = new Map();
const pendingFetches = new Map();

function queryStr(val) {
  if (val == null || val === "") return "";
  const v = Array.isArray(val) ? val[0] : val;
  return String(v).trim();
}

function movieCacheKey(imdb) {
  const id = queryStr(imdb).toLowerCase();
  return id ? `movie:${id}` : null;
}

function seriesCacheKey(tmdb, season, episode) {
  const id = queryStr(tmdb);
  const s = parseInt(queryStr(season), 10);
  const e = parseInt(queryStr(episode), 10);
  if (!id || !Number.isFinite(s) || !Number.isFinite(e) || s < 1 || e < 1) {
    return null;
  }
  return `series:${id}:${s}:${e}`;
}

function getCache(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data) {
  cache.set(key, {
    data,
    expiry: Date.now() + CACHE_TTL,
  });
}

async function resolveCached(key, fetchFn) {
  const cached = getCache(key);
  if (cached) {
    return { data: cached, fromCache: true };
  }

  if (pendingFetches.has(key)) {
    const data = await pendingFetches.get(key);
    return { data, fromCache: true };
  }

  const promise = fetchFn()
    .then((data) => {
      setCache(key, data);
      return data;
    })
    .finally(() => {
      pendingFetches.delete(key);
    });

  pendingFetches.set(key, promise);
  const data = await promise;
  return { data, fromCache: false };
}

function toClientResponse(data, fromCache) {
  const { streams, ...rest } = data;
  return {
    ...rest,
    streams: encryptStreams(streams),
    cached: fromCache,
  };
}

setInterval(() => {
  const now = Date.now();

  for (const [key, value] of cache.entries()) {
    if (now > value.expiry) {
      cache.delete(key);
    }
  }
}, 60 * 1000); // every 1 min

/* ─────────────────────────────
   SAFE JSON PARSER (FIX)
───────────────────────────── */

async function safeJson(res) {
  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("❌ Invalid JSON response from upstream:");
    console.error(text.slice(0, 800)); // show first part only

    throw new Error("Upstream API returned non-JSON (likely HTML error page)");
  }
}

/* ─────────────────────────────
   ENCRYPT / DECRYPT
───────────────────────────── */

const ALGO = "aes-256-gcm";

function encryptUrl(url) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, ENCRYPTION_KEY, iv);

  let enc = cipher.update(url, "utf8", "hex");
  enc += cipher.final("hex");

  const tag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}.${tag}.${enc}`;
}

function decryptUrl(token) {
  const [ivHex, tagHex, enc] = token.split(".");
  if (!ivHex || !tagHex || !enc) throw new Error("Invalid token");

  const decipher = crypto.createDecipheriv(
    ALGO,
    ENCRYPTION_KEY,
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  let dec = decipher.update(enc, "hex", "utf8");
  dec += decipher.final("utf8");

  return dec;
}

function encryptStreams(streams) {
  const out = {};

  for (const [key, val] of Object.entries(streams)) {
    out[key] = {
      token: encryptUrl(val.url),
      name: val.name,
    };
  }

  return out;
}

/* ─────────────────────────────
   API FETCHERS
───────────────────────────── */

async function getMovieSlug(imdbId) {
  const url = `https://streams.iqsmartgames.com/mymovieapi?imdbid=${imdbId}&key=${API_KEY}`;

  const res = await fetch(url, { headers: BASE_HEADERS });
  const json = await safeJson(res);

  if (!json.success || !json.data?.length) {
    throw new Error("Movie not found");
  }

  return json.data[0];
}

async function getSeriesSlug(tmdbId, season, episode) {
  const url = `https://streams.iqsmartgames.com/myseriesapi?tmdbid=${tmdbId}&season=${season}&epname=${episode}&key=${API_KEY}`;

  const res = await fetch(url, { headers: BASE_HEADERS });
  const json = await safeJson(res);

  if (!json.success || !json.data?.length) {
    throw new Error("Episode not found");
  }

  return json.data[0];
}

async function resolveEmbed(fileslug) {
  const body = new URLSearchParams({
    sid: fileslug,
    UserFavSite: "rpmshre",
    currentDomain: JSON.stringify([
      "streams.iqsmartgames.com",
      "pro.iqsmartgames.com",
    ]),
  });

  const res = await fetch("https://pro.iqsmartgames.com/embedhelper.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      accept: "*/*",
      referer: "https://streams.iqsmartgames.com",
    },
    body: body.toString(),
  });

  const json = await safeJson(res);

  if (!json.mresult) {
    throw new Error("No mresult returned from embed API");
  }

  return json.mresult;
}

/* ─────────────────────────────
   STREAM BUILDER
───────────────────────────── */

function buildStreamUrls(mresult) {
  const decoded = JSON.parse(
    Buffer.from(mresult, "base64").toString("utf8")
  );

  const streams = {};

  for (const [provider, baseUrl] of Object.entries(PROVIDER_URLS)) {
    if (decoded[provider]) {
      streams[provider] = {
        url: `${baseUrl}${decoded[provider]}`,
        name: PROVIDER_NAMES[provider] || provider,
      };
    }
  }

  return streams;
}

/* ─────────────────────────────
   ROUTES
───────────────────────────── */

app.get("/movie", async (req, res) => {
  const start = Date.now();
  const imdbId = queryStr(req.query.imdb).toLowerCase();
  const originInfo = getOriginInfo(req);
  const clientIp = getClientIp(req);

  if (!imdbId) {
    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/movie",
      method: "GET",
      type: "movie",
      imdb: imdbId,
      status: 400,
      durationMs: Date.now() - start,
      cached: false,
      error: "imdb required",
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });
    return res.status(400).json({ error: "imdb required" });
  }

  const cacheKey = movieCacheKey(imdbId);

  try {
    const { data, fromCache } = await resolveCached(cacheKey, async () => {
      console.log("🔥 Fetching movie from upstream:", imdbId);

      const movie = await getMovieSlug(imdbId);
      const mresult = await resolveEmbed(movie.fileslug);
      const streams = buildStreamUrls(mresult);

      return {
        type: "movie",
        imdb: imdbId,
        filename: movie.filename,
        fsize: movie.fsize,
        fileslug: movie.fileslug,
        streams,
      };
    });

    if (fromCache) {
      console.log("⚡ Movie cache hit:", imdbId);
    }

    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/movie",
      method: "GET",
      type: "movie",
      imdb: imdbId,
      filename: data.filename,
      fsize: data.fsize,
      fileslug: data.fileslug,
      providers: Object.keys(data.streams || {}),
      status: 200,
      durationMs: Date.now() - start,
      cached: fromCache,
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });

    res.json(toClientResponse(data, fromCache));
  } catch (err) {
    console.error(err);

    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/movie",
      method: "GET",
      type: "movie",
      imdb: imdbId,
      status: 500,
      durationMs: Date.now() - start,
      cached: false,
      error: err.message,
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });

    res.status(500).json({
      error: err.message,
    });
  }
});

app.get("/series", async (req, res) => {
  const start = Date.now();
  const tmdbId = queryStr(req.query.tmdb);
  const seasonNum = parseInt(queryStr(req.query.season), 10);
  const episodeNum = parseInt(queryStr(req.query.episode), 10);
  const originInfo = getOriginInfo(req);
  const clientIp = getClientIp(req);

  if (!tmdbId || !Number.isFinite(seasonNum) || !Number.isFinite(episodeNum)) {
    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/series",
      method: "GET",
      type: "series",
      tmdb: tmdbId,
      season: seasonNum,
      episode: episodeNum,
      status: 400,
      durationMs: Date.now() - start,
      cached: false,
      error: "missing params",
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });
    return res.status(400).json({ error: "missing params" });
  }

  const cacheKey = seriesCacheKey(tmdbId, seasonNum, episodeNum);

  try {
    const { data, fromCache } = await resolveCached(cacheKey, async () => {
      console.log(
        "🔥 Fetching series from upstream:",
        tmdbId,
        seasonNum,
        episodeNum
      );

      const ep = await getSeriesSlug(tmdbId, seasonNum, episodeNum);
      const mresult = await resolveEmbed(ep.fileslug);
      const streams = buildStreamUrls(mresult);

      return {
        type: "series",
        tmdb: tmdbId,
        season: seasonNum,
        episode: episodeNum,
        filename: ep.filename,
        fsize: ep.fsize,
        fileslug: ep.fileslug,
        streams,
      };
    });

    if (fromCache) {
      console.log(
        "⚡ Series cache hit:",
        tmdbId,
        seasonNum,
        episodeNum
      );
    }

    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/series",
      method: "GET",
      type: "series",
      tmdb: tmdbId,
      season: seasonNum,
      episode: episodeNum,
      filename: data.filename,
      fsize: data.fsize,
      fileslug: data.fileslug,
      providers: Object.keys(data.streams || {}),
      status: 200,
      durationMs: Date.now() - start,
      cached: fromCache,
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });

    res.json(toClientResponse(data, fromCache));
  } catch (err) {
    console.error(err);

    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/series",
      method: "GET",
      type: "series",
      tmdb: tmdbId,
      season: seasonNum,
      episode: episodeNum,
      status: 500,
      durationMs: Date.now() - start,
      cached: false,
      error: err.message,
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });

    res.status(500).json({
      error: err.message,
    });
  }
});

/* ─────────────────────────────
   DECRYPT
───────────────────────────── */

app.post("/decrypt", (req, res) => {
  const start = Date.now();
  const { token, apiKey } = req.body;
  const originInfo = getOriginInfo(req);
  const clientIp = getClientIp(req);

  if (!token || !apiKey) {
    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/decrypt",
      method: "POST",
      type: "decrypt",
      status: 400,
      durationMs: Date.now() - start,
      cached: false,
      error: "token and apiKey required",
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });
    return res.status(400).json({ error: "token and apiKey required" });
  }

  if (apiKey !== DECRYPT_API_KEY) {
    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/decrypt",
      method: "POST",
      type: "decrypt",
      status: 403,
      durationMs: Date.now() - start,
      cached: false,
      error: "Invalid API key",
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });
    return res.status(403).json({ error: "Invalid API key" });
  }

  try {
    const url = decryptUrl(token);
    const decryptedProvider = detectProviderFromUrl(url);

    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/decrypt",
      method: "POST",
      type: "decrypt",
      decryptedProvider,
      providerName: decryptedProvider ? PROVIDER_NAMES[decryptedProvider] : null,
      status: 200,
      durationMs: Date.now() - start,
      cached: false,
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });

    res.json({ url });
  } catch {
    logRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      route: "/decrypt",
      method: "POST",
      type: "decrypt",
      status: 400,
      durationMs: Date.now() - start,
      cached: false,
      error: "Invalid token",
      origin: originInfo,
      clientIp,
      userAgent: req.headers["user-agent"] || "",
    });
    res.status(400).json({ error: "Invalid token" });
  }
});

/* ─────────────────────────────
   ADMIN ANALYTICS API
───────────────────────────── */

app.get("/admin/api/stats", requireAdmin, (_req, res) => {
  const uptimeMs = Date.now() - analytics.startedAt;
  const cacheHitRate =
    analytics.counters.total > 0
      ? ((analytics.counters.cacheHits / analytics.counters.total) * 100).toFixed(1)
      : "0.0";

  res.json({
    counters: analytics.counters,
    cacheHitRate: `${cacheHitRate}%`,
    uptimeMs,
    uptimeHuman: formatUptime(uptimeMs),
    startedAt: new Date(analytics.startedAt).toISOString(),
    storedRequests: analytics.requests.length,
    maxStored: MAX_ANALYTICS,
    hourly: analytics.hourly,
    providerNames: PROVIDER_NAMES,
  });
});

app.get("/admin/api/requests", requireAdmin, (req, res) => {
  const {
    type,
    route,
    status,
    origin,
    provider,
    cached,
    search,
    limit = "100",
    offset = "0",
  } = req.query;

  let filtered = analytics.requests;

  if (type) filtered = filtered.filter((r) => r.type === type);
  if (route) filtered = filtered.filter((r) => r.route === route);
  if (status) filtered = filtered.filter((r) => String(r.status) === status);
  if (origin) filtered = filtered.filter((r) => r.origin?.domain?.includes(origin));
  if (provider) {
    filtered = filtered.filter(
      (r) =>
        r.providers?.includes(provider) ||
        r.decryptedProvider === provider
    );
  }
  if (cached === "true") filtered = filtered.filter((r) => r.cached);
  if (cached === "false") filtered = filtered.filter((r) => !r.cached);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.imdb?.toLowerCase().includes(q) ||
        r.tmdb?.toString().includes(q) ||
        r.filename?.toLowerCase().includes(q) ||
        r.fileslug?.toLowerCase().includes(q) ||
        r.origin?.domain?.toLowerCase().includes(q) ||
        r.clientIp?.includes(q)
    );
  }

  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  const off = parseInt(offset, 10) || 0;
  const page = filtered.slice(off, off + lim);

  res.json({
    total: filtered.length,
    limit: lim,
    offset: off,
    requests: page,
  });
});

app.get("/admin/api/requests/:id", requireAdmin, (req, res) => {
  const entry = analytics.requests.find((r) => r.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Request not found" });
  res.json(entry);
});

app.delete("/admin/api/requests", requireAdmin, (_req, res) => {
  analytics.requests.length = 0;
  analytics.counters = {
    total: 0,
    movies: 0,
    series: 0,
    decrypts: 0,
    cacheHits: 0,
    errors: 0,
    byProvider: { strmp2: 0, upnshr: 0, rpmshre: 0 },
    byOrigin: {},
    byRoute: { "/movie": 0, "/series": 0, "/decrypt": 0 },
  };
  analytics.hourly = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    count: 0,
    movies: 0,
    series: 0,
    decrypts: 0,
    errors: 0,
  }));
  res.json({ ok: true, message: "Analytics cleared" });
});

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/* ─────────────────────────────
   START SERVER
───────────────────────────── */

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log("Movie: /movie?imdb=tt0468569");
  console.log("Series: /series?tmdb=93405&season=1&episode=1");
  console.log(`Admin dashboard: http://localhost:${PORT}/admin.html`);
});