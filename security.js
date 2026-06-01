import fs from "fs/promises";
import path from "path";

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const MAX_PER_WINDOW = parseInt(process.env.RATE_LIMIT_MAX || "45", 10);
const AUTO_BLOCK_WINDOW_MS = parseInt(process.env.AUTO_BLOCK_WINDOW_MS || "300000", 10);
const AUTO_BLOCK_MAX = parseInt(process.env.AUTO_BLOCK_MAX || "100", 10);

const blocked = new Map();
const hitTimestamps = new Map();
let persistPath = null;
let persistTimer = null;

export function normalizeIp(ip) {
  if (!ip || ip === "unknown") return null;
  let s = String(ip).trim();
  if (s.startsWith("::ffff:")) s = s.slice(7);
  return s;
}

function schedulePersist() {
  if (!persistPath) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const list = [...blocked.values()];
      await fs.mkdir(path.dirname(persistPath), { recursive: true });
      await fs.writeFile(persistPath, JSON.stringify(list, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to persist blocked IPs:", err.message);
    }
  }, 400);
}

export async function initSecurity(baseDir) {
  persistPath = path.join(baseDir, "data", "blocked-ips.json");

  const envBlocked = (process.env.BLOCKED_IPS || "")
    .split(",")
    .map((s) => normalizeIp(s.trim()))
    .filter(Boolean);

  for (const ip of envBlocked) {
    blocked.set(ip, {
      ip,
      reason: "Blocked via BLOCKED_IPS env",
      blockedAt: new Date().toISOString(),
      blockedBy: "env",
    });
  }

  try {
    const raw = await fs.readFile(persistPath, "utf8");
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const row of list) {
        const ip = normalizeIp(row.ip);
        if (!ip) continue;
        blocked.set(ip, {
          ip,
          reason: row.reason || "Blocked",
          blockedAt: row.blockedAt || new Date().toISOString(),
          blockedBy: row.blockedBy || "manual",
        });
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Blocked IP load error:", err.message);
    }
  }

  console.log(`Security: ${blocked.size} blocked IP(s), rate limit ${MAX_PER_WINDOW}/${WINDOW_MS / 1000}s`);
}

export function isBlocked(ip) {
  const n = normalizeIp(ip);
  return n ? blocked.has(n) : false;
}

export function blockIp(ip, reason = "Blocked by admin", blockedBy = "manual") {
  const n = normalizeIp(ip);
  if (!n) return null;

  const record = {
    ip: n,
    reason: String(reason).slice(0, 500),
    blockedAt: new Date().toISOString(),
    blockedBy,
  };
  blocked.set(n, record);
  schedulePersist();
  return record;
}

export function unblockIp(ip) {
  const n = normalizeIp(ip);
  if (!n) return false;
  const ok = blocked.delete(n);
  if (ok) schedulePersist();
  return ok;
}

export function listBlocked() {
  return [...blocked.values()].sort(
    (a, b) => new Date(b.blockedAt) - new Date(a.blockedAt)
  );
}

function pruneTimestamps(times, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (times.length && times[0] < cutoff) times.shift();
  return times;
}

function countInWindow(times, windowMs) {
  const cutoff = Date.now() - windowMs;
  return times.filter((t) => t >= cutoff).length;
}

export function checkStreamAccess(ip) {
  const n = normalizeIp(ip);
  if (!n) {
    return { ok: false, status: 403, error: "Access denied", code: "INVALID_IP" };
  }

  if (blocked.has(n)) {
    return {
      ok: false,
      status: 403,
      error: "IP blocked",
      code: "BLOCKED",
      blocked: blocked.get(n),
    };
  }

  let times = hitTimestamps.get(n);
  if (!times) {
    times = [];
    hitTimestamps.set(n, times);
  }

  pruneTimestamps(times, AUTO_BLOCK_WINDOW_MS);
  times.push(Date.now());

  const inShortWindow = countInWindow(times, WINDOW_MS);
  if (inShortWindow > MAX_PER_WINDOW) {
    return {
      ok: false,
      status: 429,
      error: "Too many requests — slow down",
      code: "RATE_LIMIT",
      retryAfterSec: Math.ceil(WINDOW_MS / 1000),
    };
  }

  if (times.length >= AUTO_BLOCK_MAX) {
    const record = blockIp(
      n,
      `Auto-blocked: ${times.length}+ requests in ${AUTO_BLOCK_WINDOW_MS / 60000} min`,
      "auto"
    );
    return {
      ok: false,
      status: 403,
      error: "IP blocked for scraping",
      code: "AUTO_BLOCKED",
      blocked: record,
    };
  }

  return { ok: true };
}

export function getSecurityConfig() {
  return {
    rateLimitWindowSec: WINDOW_MS / 1000,
    rateLimitMax: MAX_PER_WINDOW,
    autoBlockWindowSec: AUTO_BLOCK_WINDOW_MS / 1000,
    autoBlockMax: AUTO_BLOCK_MAX,
    blockedCount: blocked.size,
  };
}

export function getIpHitCount(ip) {
  const n = normalizeIp(ip);
  if (!n) return 0;
  const times = hitTimestamps.get(n);
  if (!times) return 0;
  return countInWindow(times, AUTO_BLOCK_WINDOW_MS);
}
