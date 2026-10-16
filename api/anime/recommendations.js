// GET /api/anime/recommendations
// Anime recommendation feed with TWO modes, built as the fallback-chain
// recommendation source for ruristream info pages (Water Temple + Sunken
// Treasures) and any other consumer:
//
//   MODE "listing" (default) — filtered/paginated anime list straight from
//   AniList's Page.media query. Default sort = POPULARITY_DESC ("famous
//   ones first"). Supports the shared filter set:
//     page, perPage (1-50, default 20), genre (single AniList genre name OR
//     comma-separated multi-genre, case-insensitive), sort (whitelisted
//     MediaSort tokens), format, status, season, year (seasonYear),
//     minScore/maxScore (0-100), minPopularity, isAdult (default false = SFW),
//     refresh=1 (skip cache read, still re-cache).
//
//   MODE "for-media" — recommendations FOR one specific anime (what Water
//     Temple needs). Params: for_anilist_id=<id> OR for_mal_id=<mal id>,
//     plus page/perPage. AniList returns its own rating-sorted recommendation
//     nodes; each node is mapped to the recommended Media object with its
//     recommendation rating attached. sfw=true (default) drops adult entries.
//
// RESPONSE ORDER (owner spec 2026-10-16): cache information is reported at
// the TOP of the body, BEFORE the pagination info. Then the applied
// params/filters echo, then pagination, then `data` (AniList Media shape).
//
// CACHING (owner spec): the cache key is the FULL request URL (path + every
// query parameter, normalized order). ANY change — page, perPage, filter,
// sort — produces a different key and fetches from AniList live, then caches
// that exact variant. Server-side in-memory Map with 4h TTL (shared with the
// rest of this proxy) + CDN s-maxage=14400 so Vercel's edge serves the same
// per-URL cache globally across cold starts. ?refresh=1 bypasses the read.
const { cacheGet, cacheSet, TTL_MS } = require("../_lib/cache");
const {
  ANILIST_QUERY,
  fetchAnilist,
  computeExactPagination,
  probePageFor,
  jsonResponse,
  parseFuzzyDateInt,
} = require("../_lib/anilist");

const LANDING_PATH = "/api/anime/recommendations";

// Canonical AniList genre names (case-insensitive resolution)
const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror",
  "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance",
  "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
];
function canonGenre(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!s) return null;
  const hit = GENRES.find((g) => g.toLowerCase() === s || g.toLowerCase().replace(/-/g, "") === s.replace(/-/g, ""));
  return hit || null;
}

const SORTS = new Set([
  "POPULARITY_DESC", "POPULARITY_ASC", "SCORE_DESC", "SCORE_ASC",
  "TRENDING_DESC", "FAVOURITES_DESC", "START_DATE_DESC", "END_DATE_DESC",
]);

// Per-media recommendations query — AniList's own rating-sorted nodes mapped
// to the recommended Media shape.
const RECS_FOR_MEDIA_QUERY = `
query ($alId: Int, $malId: Int, $page: Int, $perPage: Int) {
  Media(id: $alId, idMal: $malId, type: ANIME) {
    id
    idMal
    title { romaji english native userPreferred }
    recommendations(sort: RATING_DESC, page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage perPage }
      nodes {
        rating
        mediaRecommendation {
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
          averageScore
          meanScore
          popularity
          favourites
          genres
          isAdult
          siteUrl
        }
      }
    }
  }
}
`;

function cacheInfo(key, hit, builtAt) {
  const now = Date.now();
  if (!hit || !builtAt) {
    return { enabled: true, hit: false, key, ttl_seconds: Math.floor(TTL_MS / 1000) };
  }
  const expiresAt = builtAt + TTL_MS;
  return {
    enabled: true,
    hit: true,
    key,
    cached_at: new Date(builtAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    age_seconds: Math.max(0, Math.floor((now - builtAt) / 1000)),
    ttl_seconds: Math.max(0, Math.floor((expiresAt - now) / 1000)),
  };
}

function cacheKeyFrom(req) {
  const u = new URL(req.url, "http://x");
  const params = new URLSearchParams(u.searchParams);
  params.delete("refresh");
  const sorted = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = new URLSearchParams(sorted).toString();
  return `GET ${u.pathname}${qs ? "?" + qs : ""}`;
}

function parseListingParams(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const perPage = Math.min(50, Math.max(1, parseInt(query.perPage, 10) || 20));

  // genre — single or comma-separated multi (resolved to canonical names)
  let genre = null;
  let genre_in = null;
  if (query.genre) {
    const parts = String(query.genre).split(",").map(canonGenre).filter(Boolean);
    if (parts.length === 1) genre = parts[0];
    else if (parts.length > 1) genre_in = parts;
  }

  let sort = ["POPULARITY_DESC"];
  if (query.sort) {
    const toks = String(query.sort).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const ok = toks.filter((t) => SORTS.has(t));
    if (ok.length) sort = ok;
  }

  const vars = {
    page,
    perPage,
    type: "ANIME",
    status: query.status ? String(query.status).toUpperCase() : null,
    season: query.season ? String(query.season).toUpperCase() : null,
    seasonYear: query.year ? parseInt(query.year, 10) : null,
    format: query.format ? String(query.format).toUpperCase() : null,
    genre,
    genre_in,
    sort,
    startDate_greater: parseFuzzyDateInt(query.startDateGreater),
    startDate_lesser: parseFuzzyDateInt(query.startDateLesser),
    endDate_greater: parseFuzzyDateInt(query.endDateGreater),
    endDate_lesser: parseFuzzyDateInt(query.endDateLesser),
    averageScore_greater: query.minScore ? parseInt(query.minScore, 10) : null,
    averageScore_lesser: query.maxScore ? parseInt(query.maxScore, 10) : null,
    popularity_greater: query.minPopularity ? parseInt(query.minPopularity, 10) : null,
    isAdult: query.isAdult === "true" || query.isAdult === "1",
  };
  const clean = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) clean[k] = v;
  }
  return clean;
}

async function buildListing(query) {
  const cleanVars = parseListingParams(query);
  const data = await fetchAnilist(cleanVars);
  const pageInfo = data.Page.pageInfo;
  const media = data.Page.media;

  let pagination = pageInfo;
  let pagination_source = "anilist-raw";
  try {
    const ex = await computeExactPagination(pageInfo, media, cleanVars, probePageFor);
    pagination = ex.pagination;
    pagination_source = "exact";
  } catch (e) { /* fall back to raw pageInfo */ }

  const applied = { ...cleanVars };
  delete applied.page;
  delete applied.perPage;
  return {
    applied,
    pagination: { ...pagination, currentPage: pagination.currentPage || cleanVars.page, perPage: cleanVars.perPage },
    pagination_source,
    count: media.length,
    data: media,
    hint:
      media.length === 0
        ? `No entries for the applied filters. ${query.page > 1 ? "You may be past the last page." : "Try relaxing genre/format/status/score."}`
        : undefined,
  };
}

async function buildForMedia(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const perPage = Math.min(25, Math.max(1, parseInt(query.perPage, 10) || 20));
  const alId = query.for_anilist_id ? parseInt(query.for_anilist_id, 10) : null;
  const malId = query.for_mal_id ? parseInt(query.for_mal_id, 10) : null;
  const sfw = !(query.sfw === "false" || query.sfw === "0");
  if (!alId && !malId) {
    const err = new Error("for-media mode needs for_anilist_id or for_mal_id");
    err.status = 400;
    throw err;
  }

  const data = await fetchAnilist2(RECS_FOR_MEDIA_QUERY, { alId, malId, page, perPage });
  const media = data && data.Media;
  if (!media || !media.id) {
    const err = new Error(`No anime found for ${alId ? `anilist id ${alId}` : `mal id ${malId}`}`);
    err.status = 404;
    throw err;
  }
  const rec = media.recommendations || {};
  const nodes = (rec.nodes || []).map((n) => ({
    ...(n.mediaRecommendation || {}),
    recommendation_rating: n.rating,
  })).filter((m) => m && m.id);
  const visible = sfw ? nodes.filter((m) => !m.isAdult) : nodes;

  return {
    applied: {
      for_anilist_id: alId || null,
      for_mal_id: malId || null,
      sfw,
    },
    media: { id: media.id, idMal: media.idMal, title: media.title },
    pagination: rec.pageInfo || { total: visible.length, currentPage: page, lastPage: 1, hasNextPage: false, perPage },
    pagination_source: "anilist-raw",
    count: visible.length,
    data: visible,
    hint: visible.length === 0 ? "AniList has no recommendations recorded for this anime yet." : undefined,
  };
}

// Local POST wrapper (keeps this file self-contained; mirrors _lib/anilist postGraphql)
async function fetchAnilist2(query, variables) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "anilist-my-proxy/1.0 (+vercel)" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok || (data.errors && data.errors.length)) {
      const msg = (data.errors && data.errors[0] && data.errors[0].message) || `AniList HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data.data;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return jsonResponse(res, 405, { ok: false, error: "Method not allowed. Use GET." });
  }

  const query = req.query || {};
  const refresh = String(query.refresh || "") === "1" || String(query.refresh || "").toLowerCase() === "true";
  const mode = query.for_anilist_id || query.for_mal_id ? "for-media" : "listing";
  const key = cacheKeyFrom(req);

  const finish = (status, body, cacheCtl) =>
    jsonResponse(res, status, body, { cacheControl: cacheCtl || "public, max-age=60, s-maxage=14400" });

  // 1) cache read (exact full-URL key) unless ?refresh
  if (!refresh) {
    const cached = cacheGet(key);
    if (cached && cached.body) {
      return finish(200, {
        ok: true,
        endpoint: LANDING_PATH,
        mode: cached.mode,
        cache: cacheInfo(key, true, cached.builtAt),
        ...(cached.body),
      });
    }
  }

  // 2) live fetch
  try {
    const built = mode === "for-media" ? await buildForMedia(query) : await buildListing(query);
    const builtAt = Date.now();
    cacheSet(key, { body: built, mode, builtAt });
    return finish(200, {
      ok: true,
      endpoint: LANDING_PATH,
      mode,
      cache: cacheInfo(key, false, builtAt),
      ...built,
    });
  } catch (err) {
    console.error("[anime/recommendations] error:", err.message);
    return finish(err.status || 500, {
      ok: false,
      endpoint: LANDING_PATH,
      mode,
      cache: cacheInfo(key, false, null),
      error: err.message,
    }, "no-store");
  }
};
