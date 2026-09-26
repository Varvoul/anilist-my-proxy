// api/_lib/cache.js
// Server-side in-memory cache with a fixed 4-hour TTL and automatic expiry.
//
// How expiry works:
//   - Every entry stores an absolute `expiresAt` timestamp (set + TTL).
//   - `cacheGet()` returns null AND deletes the entry once it is expired, so the
//     next visit triggers a fresh fetch from AniList.
//   - A periodic sweep (`pruneExpired`) also evicts expired entries in the
//     background whenever the map grows, so memory stays bounded on warm
//     lambda instances.
//
// Serverless caveats (documented honestly):
//   - The Map lives inside a single serverless instance. Warm invocations share
//     it; cold starts start with an empty cache (and immediately re-populate).
//   - Responses from these endpoints also carry CDN cache headers
//     (`s-maxage=14400`), so Vercel's edge network serves the 4-hour cache
//     globally even across cold starts. The two layers complement each other.

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_ENTRIES = 1000; // safety bound per instance

const store = new Map(); // key -> { value, expiresAt, createdAt, lastAccessedAt }

function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  // Auto-expiry: treat as a miss and delete so the next fetch is fresh.
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  entry.lastAccessedAt = Date.now();
  return entry.value;
}

function cacheSet(key, value) {
  if (store.size >= MAX_ENTRIES) pruneExpired();
  // Still full after pruning? Drop the ~25% least-recently-used entries.
  if (store.size >= MAX_ENTRIES) evictOldest(Math.ceil(MAX_ENTRIES / 4));
  store.set(key, {
    value,
    expiresAt: Date.now() + TTL_MS,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  });
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.expiresAt) store.delete(key);
  }
}

function evictOldest(count) {
  const sorted = [...store.entries()].sort(
    (a, b) => (a[1].lastAccessedAt || a[1].createdAt) - (b[1].lastAccessedAt || b[1].createdAt)
  );
  for (let i = 0; i < count && i < sorted.length; i++) store.delete(sorted[i][0]);
}

function secondsUntilExpiry(key) {
  const entry = store.get(key);
  if (!entry) return 0;
  return Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
}

function stats() {
  const now = Date.now();
  let live = 0;
  let expired = 0;
  for (const entry of store.values()) {
    if (now >= entry.expiresAt) expired++;
    else live++;
  }
  return { entries: store.size, live, expiredNotYetSwept: expired, ttlSeconds: TTL_MS / 1000 };
}

module.exports = { cacheGet, cacheSet, secondsUntilExpiry, stats, TTL_MS };
