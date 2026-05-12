import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));

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
        name:
          {
            strmp2: "StreamP2P",
            upnshr: "UpnShare",
            rpmshre: "RpmShare",
          }[provider] || provider,
      };
    }
  }

  return streams;
}

/* ─────────────────────────────
   ROUTES
───────────────────────────── */

app.get("/movie", async (req, res) => {
  const { imdb } = req.query;
  if (!imdb) return res.status(400).json({ error: "imdb required" });

  try {
    const movie = await getMovieSlug(imdb);
    const mresult = await resolveEmbed(movie.fileslug);
    const streams = buildStreamUrls(mresult);

    res.json({
      type: "movie",
      imdb,
      filename: movie.filename,
      fsize: movie.fsize,
      fileslug: movie.fileslug,
      streams: encryptStreams(streams),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/series", async (req, res) => {
  const { tmdb, season, episode } = req.query;

  if (!tmdb || !season || !episode) {
    return res.status(400).json({ error: "missing params" });
  }

  try {
    const ep = await getSeriesSlug(tmdb, season, episode);
    const mresult = await resolveEmbed(ep.fileslug);
    const streams = buildStreamUrls(mresult);

    res.json({
      type: "series",
      tmdb,
      season: Number(season),
      episode: Number(episode),
      filename: ep.filename,
      fsize: ep.fsize,
      fileslug: ep.fileslug,
      streams: encryptStreams(streams),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────
   DECRYPT
───────────────────────────── */

app.post("/decrypt", (req, res) => {
  const { token, apiKey } = req.body;

  if (!token || !apiKey) {
    return res.status(400).json({ error: "token and apiKey required" });
  }

  if (apiKey !== DECRYPT_API_KEY) {
    return res.status(403).json({ error: "Invalid API key" });
  }

  try {
    const url = decryptUrl(token);
    res.json({ url });
  } catch {
    res.status(400).json({ error: "Invalid token" });
  }
});

/* ─────────────────────────────
   START SERVER
───────────────────────────── */

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log("Movie: /movie?imdb=tt0468569");
  console.log("Series: /series?tmdb=93405&season=1&episode=1");
});
