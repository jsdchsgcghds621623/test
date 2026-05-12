import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Player 1 Proxy (strmp2 / p2pplay) ───────────────────────────────────────
// The provider requires the referer to be their own domain, not localhost.
// This proxy forwards the request with the correct headers.
app.get("/proxy/strmp2", async (req, res) => {
  try {
    const { id, w = 1280, h = 720 } = req.query;

    if (!id) {
      return res.status(400).json({ error: "Missing 'id' query parameter" });
    }

    const targetUrl = `https://multimovies.p2pplay.pro/api/v1/video?id=${encodeURIComponent(id)}&w=${w}&h=${h}&r=multimovies.p2pplay.pro`;

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://multimovies.p2pplay.pro/",
        Origin: "https://multimovies.p2pplay.pro",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream returned ${response.status}`,
        upstream: targetUrl,
      });
    }

    // Forward content-type from upstream
    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    // Stream the body back to client
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("[strmp2 proxy error]", err.message);
    res.status(500).json({ error: "Proxy request failed", details: err.message });
  }
});

// ─── Embed URL helper (returns the iframe src for each player) ────────────────
// Frontend can call this to get the correct embed URL for a given provider + id
app.get("/api/embed-url", (req, res) => {
  const { provider, id } = req.query;

  const PROVIDER_BASES = {
    strmp2: "https://multimovies.p2pplay.pro/#",
    upnshr: "https://server1.uns.bio/#",
    rpmshre: "https://multimovies.rpmhub.site/#",
  };

  if (!provider || !PROVIDER_BASES[provider]) {
    return res.status(400).json({
      error: "Invalid provider. Use: strmp2 | upnshr | rpmshre",
    });
  }
  if (!id) {
    return res.status(400).json({ error: "Missing 'id' parameter" });
  }

  const url = `${PROVIDER_BASES[provider]}${encodeURIComponent(id)}`;
  res.json({ provider, id, url });
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`   Proxy: GET /proxy/strmp2?id=movie_tt0468569`);
  console.log(`   Embed: GET /api/embed-url?provider=strmp2&id=movie_tt0468569`);
});