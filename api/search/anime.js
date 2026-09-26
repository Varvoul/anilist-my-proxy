// api/search/anime.js
// GET /api/search/anime?q=<text>&page=1&perPage=10
//
// Full-text anime search on AniList. Built for the al-ji backfill pipeline: when a
// DB row's mal_id cannot be resolved upstream (no AniList entry carries that idMal),
// the automation searches by the row's stored title to find the correct AniList
// entry — but ONLY stores anything when the match is exact (100% confidence gate is
// enforced by the consumer; this endpoint just returns ranked candidates).
//
// Response shape follows the proxy envelope: { ok, endpoint, source, query, pagination, count, data }.
// `pagination` is AniList's verbatim pageInfo for the search result set.
// Caching: CDN-level only (s-maxage=1800). No server-side cache here on purpose —
// the query space is unbounded and the shared cache's fixed 4h TTL would be too
// sticky for search results.
const { jsonResponse } = require("../_lib/anilist");

const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const SOURCE_LINE = "AniList GraphQL API (https://graphql.anilist.co)";
const CDN_CACHE_CONTROL = "public, max-age=60, s-maxage=1800";

const SEARCH_QUERY = `
query ($q: String, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(search: $q, type: ANIME, sort: [SEARCH_MATCH]) {
      id
      idMal
      title { romaji english native userPreferred }
      format
      episodes
      duration
      status
      season
      seasonYear
      startDate { year month day }
      endDate { year month day }
      coverImage { large }
      bannerImage
      synonyms
      averageScore
      siteUrl
    }
  }
}
`;

async function postGraphql(query, variables, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 15000);
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
    try { data = JSON.parse(text); } catch {
      throw new Error(`AniList returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].message) || `AniList API HTTP ${res.status}`;
      const err = new Error(msg); err.status = res.status; err.payload = data; throw err;
    }
    if (data.errors && data.errors.length) {
      const err = new Error(data.errors[0].message || "AniList GraphQL error"); err.payload = data; throw err;
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
    return jsonResponse(res, 405, { ok: false, endpoint: "/api/search/anime", error: "Method not allowed. Use GET." }, { cacheControl: "no-store" });
  }

  const query = req.query || {};
  const qRaw = String(query.q ?? "").trim();
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const perPage = Math.min(50, Math.max(1, parseInt(query.perPage, 10) || 10));

  if (!qRaw) {
    return jsonResponse(res, 400, {
      ok: false, endpoint: "/api/search/anime",
      error: 'Missing required query parameter "q" (the title text to search for).',
      hint: 'Example: /api/search/anime?q=cowboy%20bebop&perPage=10',
    }, { cacheControl: "no-store" });
  }
  if (qRaw.length < 2 || qRaw.length > 120) {
    return jsonResponse(res, 400, {
      ok: false, endpoint: "/api/search/anime",
      error: `Query text must be between 2 and 120 characters (got ${qRaw.length}).`,
    }, { cacheControl: "no-store" });
  }

  try {
    const data = await postGraphql(SEARCH_QUERY, { q: qRaw, page, perPage }, 15000);
    const pg = data.Page || {};
    const media = Array.isArray(pg.media) ? pg.media : [];

    const body = {
      ok: true,
      endpoint: "/api/search/anime",
      source: SOURCE_LINE,
      query: { q: qRaw, page, perPage },
      pagination: pg.pageInfo || null,
      count: media.length,
      data: media,
      note: "Candidates are ranked by AniList SEARCH_MATCH. Consumers must verify identity before storing (exact-title match / idMal agreement).",
    };
    return jsonResponse(res, 200, body, { cacheControl: CDN_CACHE_CONTROL });
  } catch (err) {
    console.error("[search/anime] error:", err.message);
    return jsonResponse(res, err.status || 500, {
      ok: false, endpoint: "/api/search/anime", error: err.message,
      ...(err.payload ? { details: err.payload } : {}),
    }, { cacheControl: "no-store" });
  }
};
