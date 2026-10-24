// api/_lib/entity.js
// Shared plumbing for the "browse" endpoints (season / studio / staff):
//
//   /api/season/{season}/{year}   (+ /api/season/current)
//   /api/studio/{studio}
//   /api/staff/{name}             (+ /voice-actors/{name}, /cast/{name} rewrites)
//
// Design (owner spec 2026-10-21: "AniList style response, AniList filters,
// TTL cache — but a parameter/filter change must fetch fresh data"):
//
//   - Response shape follows the house convention used by /api/schedule:
//     proxy meta (ok / endpoint / cache / applied / count) at the top, the
//     verbatim AniList payload nested under `data.Page` / `data.Studio` /
//     `data.Staff` — exactly the objects AniList's own GraphQL replies carry.
//
//   - Caching is EXACT-URL keyed (same scheme as /api/anime/recommendations):
//     the cache key is the request path + every query parameter in normalized
//     (sorted, refresh-stripped) order. ANY parameter or filter change —
//     page, perPage, sort, format, genre, isMain, mainRoles, ... — produces a
//     different key and therefore fetches fresh data from AniList, then caches
//     that exact variant. Two layers:
//       * in-memory Map, 4h TTL (shared _lib/cache.js store; warm instances)
//       * Vercel edge CDN, s-maxage=14400 + stale-while-revalidate=86400
//         (per-URL, survives cold starts, serves repeat consumers globally)
//     ?refresh=1 bypasses both cache reads (response is still re-cached).
//
//   - AniList enums are validated locally (400 with the allowed list) so bad
//     input never burns an upstream request or gets GraphQL gibberish back.

const { cacheGet, cacheSet, TTL_MS } = require("./cache");

const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const FETCH_TIMEOUT_MS = 12000;
const CACHE_CONTROL = "public, max-age=60, s-maxage=14400, stale-while-revalidate=86400";

// -----------------------------------------------------------------------------
// Enums (AniList schema, verified via introspection 2026-10-21)
// -----------------------------------------------------------------------------
const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
const MEDIA_SORTS = [
  "ID", "ID_DESC", "TITLE_ROMAJI", "TITLE_ROMAJI_DESC", "TITLE_ENGLISH",
  "TITLE_ENGLISH_DESC", "TITLE_NATIVE", "TITLE_NATIVE_DESC", "TYPE", "TYPE_DESC",
  "FORMAT", "FORMAT_DESC", "START_DATE", "START_DATE_DESC", "END_DATE",
  "END_DATE_DESC", "SCORE", "SCORE_DESC", "POPULARITY", "POPULARITY_DESC",
  "TRENDING", "TRENDING_DESC", "EPISODES", "EPISODES_DESC", "DURATION",
  "DURATION_DESC", "STATUS", "STATUS_DESC", "UPDATED_AT", "UPDATED_AT_DESC",
  "SEARCH_MATCH", "FAVOURITES", "FAVOURITES_DESC",
];
const MEDIA_FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"];
const MEDIA_STATUSES = ["FINISHED", "RELEASING", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"];

// Canonical AniList genre names (same resolution as /api/anime/recommendations)
const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror",
  "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance",
  "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
];

// -----------------------------------------------------------------------------
// Media field selections
// -----------------------------------------------------------------------------
// MEDIA_FIELDS is copied verbatim from the category endpoints' selection in
// _lib/anilist.js so every endpoint in this proxy returns identically-shaped
// Media objects (id, idMal, title, coverImage, nextAiringEpisode, studios, ...).
const MEDIA_FIELDS = `
      id
      idMal
      title { romaji english native userPreferred }
      description(asHtml: false)
      coverImage { large extraLarge medium color }
      bannerImage
      episodes
      duration
      status
      season
      seasonYear
      format
      source
      countryOfOrigin
      averageScore
      meanScore
      popularity
      favourites
      isAdult
      startDate { year month day }
      endDate { year month day }
      nextAiringEpisode { airingAt episode timeUntilAiring }
      genres
      synonyms
      tags { id name rank isMediaSpoiler }
      studios(isMain: true) { nodes { id name isAnimationStudio } }
      siteUrl
      trailer { id site thumbnail }
`;

// Lighter selection for staffMedia (production credits — secondary payload)
const STAFF_MEDIA_FIELDS = `
      id
      idMal
      title { romaji english native userPreferred }
      coverImage { large color }
      bannerImage
      format
      status
      episodes
      season
      seasonYear
      averageScore
      genres
      siteUrl
      nextAiringEpisode { airingAt episode }
`;

// -----------------------------------------------------------------------------
// GraphQL client (single retry on 429/5xx; search-miss 404 returns null)
// -----------------------------------------------------------------------------
async function postGraphql(query, variables, timeoutMs) {
  const attempt = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(ANILIST_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "anilist-my-proxy/1.0 (+vercel)",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        const err = new Error(`AniList returned non-JSON response (status ${res.status}): ${text.slice(0, 160)}`);
        err.status = res.status || 502;
        err.retryable = res.status >= 500;
        throw err;
      }
      // Search-miss: AniList answers HTTP 404 with errors[] + data.{Entity}:null.
      // That is a definitive "not in the database" — surface as null (NOT an
      // error) so callers can run fallbacks and answer 404 themselves.
      if (res.status === 404 && data && data.errors && data.errors.length) {
        return { notFound: true };
      }
      if (!res.ok || (data.errors && data.errors.length)) {
        const msg = (data.errors && data.errors[0] && data.errors[0].message) || `AniList HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        err.payload = data && data.errors ? data.errors : undefined;
        throw err;
      }
      return { payload: data.data };
    } finally {
      clearTimeout(timeout);
    }
  };

  let first;
  try {
    first = await attempt();
  } catch (err) {
    if (!err.retryable) throw err;
    // One polite retry for 429/5xx (AniList is occasionally flaky / rate-limits
    // bursts). Fixed short backoff so we stay well inside the function timeout.
    await new Promise((r) => setTimeout(r, 1200));
    return await attempt();
  }
  return first;
}

// -----------------------------------------------------------------------------
// Cache helpers — exact-URL keying (any param change = new key = fresh fetch)
// -----------------------------------------------------------------------------
function sortedParamString(query) {
  const params = Object.entries(query || {})
    .filter(([k]) => k !== "refresh")
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(params).toString();
}

// Path params (season/year/studio/staff name) are normalized (case/spacing) so
// /studio/Bones and /studio/bones share one entry. The `refresh` param is
// excluded — it bypasses the cache read, it does not create a new variant.
function cacheKey(parts, query) {
  return `browse v1 | ${parts.join(" | ")} | ${sortedParamString(query)}`;
}

function cacheInfo(key, hit, builtAt) {
  const now = Date.now();
  const base = {
    enabled: true,
    key,
    ttl_total_seconds: Math.floor(TTL_MS / 1000),
    strategy: "exact-key TTL cache (path + normalized params) — ANY parameter/filter change = new key = fresh AniList fetch",
    edge: "exact-URL edge cache (s-maxage=14400, stale-while-revalidate=86400); ?refresh=1 bypasses both cache reads",
  };
  if (!hit || !builtAt) return { ...base, hit: false };
  const expiresAt = builtAt + TTL_MS;
  return {
    ...base,
    hit: true,
    cached_at: new Date(builtAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    age_seconds: Math.max(0, Math.floor((now - builtAt) / 1000)),
    ttl_seconds: Math.max(0, Math.floor((expiresAt - now) / 1000)),
  };
}

function respond(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", cacheControl || CACHE_CONTROL);
  res.end(JSON.stringify(body));
  return;
}

function corsPreflight(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return true;
  }
  return false;
}

function methodGuard(req, res, landingPath) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    respond(res, 405, { ok: false, endpoint: landingPath, error: "Method not allowed. Use GET." }, "no-store");
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Parameter parsing helpers
// -----------------------------------------------------------------------------
function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isTrue(v) {
  return v === "true" || v === "1" || v === "yes";
}

function enumList(raw, allowed, { dropInvalid = true } = {}) {
  if (!raw) return null;
  const toks = String(raw).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const ok = toks.filter((t) => allowed.includes(t));
  if (!ok.length) {
    if (dropInvalid) return null;
    return null;
  }
  return ok;
}

function firstEnum(raw, allowed) {
  const list = enumList(raw, allowed);
  return list ? list[0] : null;
}

function canonGenre(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!s) return null;
  const hit = GENRES.find((g) => g.toLowerCase() === s || g.toLowerCase().replace(/-/g, "") === s.replace(/-/g, ""));
  return hit || null;
}

function genreVars(query) {
  // genre=Action (single) | genre=Action,Comedy or genres=... (multi -> genre_in)
  // t133: `genre_in` is documented as accepted (season.js header) but was never
  // parsed — honor it too, comma-separated canonical genre names.
  const raw = query.genre || query.genres || query.genre_in || null;
  if (!raw) return { genre: null, genre_in: null };
  const parts = String(raw).split(",").map(canonGenre).filter(Boolean);
  if (parts.length === 1) return { genre: parts[0], genre_in: null };
  if (parts.length > 1) return { genre: null, genre_in: parts };
  return { genre: null, genre_in: null };
}

function tagIn(query) {
  const raw = query.tag_in || query.tags || query.tag || null;
  if (!raw) return null;
  const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

// "YYYY-MM-DD" | "YYYYMMDD" -> AniList FuzzyDateInt (same rule as _lib/anilist)
function parseFuzzyDateInt(input) {
  if (!input) return null;
  const cleaned = String(input).replace(/-/g, "");
  if (!/^\d{8}$/.test(cleaned)) return null;
  return parseInt(cleaned, 10);
}

function cleanVars(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) out[k] = v;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Entity lookup (Studio / Staff) with dash->space fallback
// -----------------------------------------------------------------------------
// `runOne(vars)` executes the caller's entity query and returns
// { notFound: true } | { payload: { <root>: {...} } } via postGraphql.
// Numeric names resolve by exact id; text names search. If the search misses
// and the name contains dashes, one retry with dashes->spaces is made
// (kebab-case slugs like "kyoto-animation" or "yoshitsugu-matsuoka" resolve).
async function lookupEntity(runOne, rawName) {
  const decoded = String(rawName || "").trim();
  const isNumeric = /^\d{1,9}$/.test(decoded);
  const id = isNumeric ? parseInt(decoded, 10) : null;
  const search = isNumeric ? null : decoded;

  let res = await runOne(id ? { id } : { search });
  if (res && res.payload) return { entity: res.payload, resolvedBy: id ? "id" : "search", retried: false };

  if (!id && search && /-/.test(search)) {
    res = await runOne({ search: search.replace(/-+/g, " ").trim() });
    if (res && res.payload) return { entity: res.payload, resolvedBy: "search (dashes->spaces)", retried: true };
  }
  return { entity: null, resolvedBy: id ? "id" : "search", retried: false };
}

// JST season resolver (anime industry clock — the same +09:00 convention the
// /api/schedule endpoint uses). Seasons flip on the 1st of Jan/Apr/Jul/Oct JST.
function currentSeasonJST(nowMs) {
  const JST = 9 * 3600 * 1000;
  const d = new Date((nowMs || Date.now()) + JST);
  const m = d.getUTCMonth() + 1; // 1..12
  const y = d.getUTCFullYear();
  if (m <= 3) return { season: "WINTER", year: y };
  if (m <= 6) return { season: "SPRING", year: y };
  if (m <= 9) return { season: "SUMMER", year: y };
  return { season: "FALL", year: y };
}

module.exports = {
  // cache primitives (re-exported so route files single-import from here)
  cacheGet, cacheSet, TTL_MS,
  // enums
  SEASONS, MEDIA_SORTS, MEDIA_FORMATS, MEDIA_STATUSES,
  // graphql
  postGraphql, MEDIA_FIELDS, STAFF_MEDIA_FIELDS,
  // cache + http
  cacheKey, cacheInfo, respond, corsPreflight, methodGuard, CACHE_CONTROL,
  // params
  clampInt, isTrue, enumList, firstEnum, genreVars, tagIn, parseFuzzyDateInt, cleanVars,
  // entity + season
  lookupEntity, currentSeasonJST,
};
