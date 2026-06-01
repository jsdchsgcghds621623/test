const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p";

const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const cache = new Map();

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}

function posterUrl(path, size = "w92") {
  if (!path) return null;
  return `${TMDB_IMG}/${size}${path}`;
}

export function isTmdbConfigured() {
  return Boolean(TMDB_API_KEY);
}

export function normalizeImdb(id) {
  if (id == null || id === "") return null;
  const s = String(id).trim().toLowerCase();
  if (s.startsWith("tt")) return s;
  if (/^\d+$/.test(s)) return `tt${s}`;
  return s;
}

async function tmdbGet(path) {
  if (!TMDB_API_KEY) return null;

  const cacheKey = path;
  const hit = cacheGet(cacheKey);
  if (hit !== null) return hit;

  const sep = path.includes("?") ? "&" : "?";
  const url = `${TMDB_BASE}${path}${sep}api_key=${TMDB_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`TMDB ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  cacheSet(cacheKey, data);
  return data;
}

async function findByImdb(imdbId) {
  const imdb = normalizeImdb(imdbId);
  if (!imdb) return null;
  return tmdbGet(`/find/${imdb}?external_source=imdb_id`);
}

function formatMovie(detail, imdbId, findResult) {
  return {
    mediaType: "movie",
    tmdbId: detail.id,
    imdbId: imdbId || findResult?.imdb_id || null,
    title: detail.title,
    originalTitle: detail.original_title,
    year: detail.release_date?.slice(0, 4) || null,
    releaseDate: detail.release_date || null,
    posterUrl: posterUrl(detail.poster_path),
    backdropUrl: posterUrl(detail.backdrop_path, "w780"),
    overview: detail.overview || null,
    runtime: detail.runtime ?? null,
    genres: (detail.genres || []).map((g) => g.name),
    rating: detail.vote_average ?? null,
    voteCount: detail.vote_count ?? null,
    tagline: detail.tagline || null,
    status: detail.status || null,
  };
}

function formatTvShow(show, imdbId) {
  return {
    mediaType: "tv",
    tmdbId: show.id,
    imdbId: imdbId || show.external_ids?.imdb_id || null,
    title: show.name,
    originalTitle: show.original_name,
    year: show.first_air_date?.slice(0, 4) || null,
    firstAirDate: show.first_air_date || null,
    posterUrl: posterUrl(show.poster_path),
    backdropUrl: posterUrl(show.backdrop_path, "w780"),
    overview: show.overview || null,
    genres: (show.genres || []).map((g) => g.name),
    rating: show.vote_average ?? null,
    voteCount: show.vote_count ?? null,
    status: show.status || null,
    seasons: show.number_of_seasons ?? null,
    episodes: show.number_of_episodes ?? null,
    networks: (show.networks || []).map((n) => n.name),
  };
}

function applyEpisode(meta, episode, seasonNum, episodeNum) {
  if (!episode) return meta;
  return {
    ...meta,
    season: {
      number: seasonNum,
      name: episode.season_number != null ? `Season ${episode.season_number}` : null,
    },
    episode: {
      number: episodeNum,
      name: episode.name || null,
      overview: episode.overview || null,
      airDate: episode.air_date || null,
      runtime: episode.runtime ?? null,
      stillUrl: posterUrl(episode.still_path, "w185"),
    },
    displayTitle: meta.title
      ? `${meta.title} · S${seasonNum}E${episodeNum}${episode.name ? ` — ${episode.name}` : ""}`
      : `S${seasonNum}E${episodeNum}`,
  };
}

export async function enrichRequestMeta(entry) {
  if (!TMDB_API_KEY || !entry) return null;

  try {
    if (entry.type === "movie" && entry.imdb) {
      const cacheKey = `meta:movie:${normalizeImdb(entry.imdb)}`;
      const cached = cacheGet(cacheKey);
      if (cached) return cached;

      const find = await findByImdb(entry.imdb);
      const movieHit = find?.movie_results?.[0];
      if (movieHit) {
        const detail = await tmdbGet(`/movie/${movieHit.id}`);
        const meta = {
          ...formatMovie(detail, normalizeImdb(entry.imdb), movieHit),
          displayTitle: detail.title,
        };
        cacheSet(cacheKey, meta);
        return meta;
      }

      const tvHit = find?.tv_results?.[0];
      if (tvHit) {
        const show = await tmdbGet(`/tv/${tvHit.id}`);
        const meta = {
          ...formatTvShow(show, normalizeImdb(entry.imdb)),
          displayTitle: show.name,
        };
        cacheSet(cacheKey, meta);
        return meta;
      }
      return null;
    }

    if (entry.type === "series" && entry.tmdb) {
      const s = parseInt(entry.season, 10);
      const e = parseInt(entry.episode, 10);
      const cacheKey = `meta:tv:${entry.tmdb}:${s}:${e}`;
      const cached = cacheGet(cacheKey);
      if (cached) return cached;

      const show = await tmdbGet(`/tv/${entry.tmdb}`);
      let meta = formatTvShow(show, null);
      meta.displayTitle = show.name;

      if (Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e >= 0) {
        try {
          const ep = await tmdbGet(`/tv/${entry.tmdb}/season/${s}/episode/${e}`);
          meta = applyEpisode(meta, ep, s, e);
        } catch {
          meta = applyEpisode(
            meta,
            { name: null, overview: null, air_date: null, runtime: null, still_path: null },
            s,
            e
          );
        }
      }

      cacheSet(cacheKey, meta);
      return meta;
    }
  } catch (err) {
    return {
      error: err.message || "TMDB lookup failed",
      mediaType: entry.type === "movie" ? "movie" : entry.type === "series" ? "tv" : null,
    };
  }

  return null;
}

export async function enrichRequestsBatch(entries, concurrency = 4) {
  if (!TMDB_API_KEY || !entries.length) {
    return entries.map((row) => ({ ...row, media: null }));
  }

  const out = new Array(entries.length);
  let index = 0;

  async function worker() {
    while (index < entries.length) {
      const i = index++;
      const row = entries[i];
      if (row.media) {
        out[i] = row;
        continue;
      }
      if (row.type === "movie" || row.type === "series") {
        const media = await enrichRequestMeta(row);
        out[i] = { ...row, media };
      } else {
        out[i] = { ...row, media: null };
      }
    }
  }

  const workers = Math.min(concurrency, entries.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
