// api/_lib/anilist.js
// Shared AniList GraphQL client used by every endpoint in this proxy.
//
// Design goals:
//  - Each /api/<category> endpoint maps to one sensible default AniList filter+sort.
//  - All endpoints accept the same optional query parameters for pagination,
//    filtering, sorting, type, score, etc. (as the user requested).
//  - Every response includes both AniList `id` and MyAnimeList `idMal` for each entry.
//  - Response shape is consistent across endpoints so the proxy is easy to consume.

const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";

// -----------------------------------------------------------------------------
// GraphQL query
// -----------------------------------------------------------------------------
// This single query covers all 11 categories — variables decide which subset
// of filters/sorts is actually applied. AniList ignores `null` variables.
const ANILIST_QUERY = `
query (
  $page: Int,
  $perPage: Int,
  $type: MediaType,
  $status: MediaStatus,
  $sort: [MediaSort],
  $season: MediaSeason,
  $seasonYear: Int,
  $format: MediaFormat,
  $genre: String,
  $startDate_greater: FuzzyDateInt,
  $startDate_lesser: FuzzyDateInt,
  $endDate_greater: FuzzyDateInt,
  $endDate_lesser: FuzzyDateInt,
  $averageScore_greater: Int,
  $averageScore_lesser: Int,
  $popularity_greater: Int,
  $isAdult: Boolean
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      total
      currentPage
      lastPage
      hasNextPage
      perPage
    }
    media(
      type: $type,
      status: $status,
      sort: $sort,
      season: $season,
      seasonYear: $seasonYear,
      format: $format,
      genre: $genre,
      startDate_greater: $startDate_greater,
      startDate_lesser: $startDate_lesser,
      endDate_greater: $endDate_greater,
      endDate_lesser: $endDate_lesser,
      averageScore_greater: $averageScore_greater,
      averageScore_lesser: $averageScore_lesser,
      popularity_greater: $popularity_greater,
      isAdult: $isAdult
    ) {
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
    }
  }
}
`;

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------
function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
  res.end(JSON.stringify(body));
  return;
}

// Convert "YYYY-MM-DD" or "YYYYMMDD" to AniList FuzzyDateInt (YYYYMMDD)
function parseFuzzyDateInt(input) {
  if (!input) return null;
  const cleaned = String(input).replace(/-/g, "");
  if (!/^\d{8}$/.test(cleaned)) return null;
  return parseInt(cleaned, 10);
}

// Return a FuzzyDateInt for a date `daysBefore` days before today (UTC)
function fuzzyDateIntDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return parseInt(`${y}${m}${day}`, 10);
}

// -----------------------------------------------------------------------------
// Query parameter parser
// -----------------------------------------------------------------------------
// Reads pagination / filter / sort parameters from `req.url`'s query string.
// Returns a variables object ready to merge into the GraphQL variables.
function parseQueryParams(query) {
  const vars = {
    // Pagination
    page: query.page ? Math.max(1, parseInt(query.page, 10) || 1) : 1,
    perPage: query.perPage
      ? Math.min(50, Math.max(1, parseInt(query.perPage, 10) || 20))
      : 20,

    // Type filter (default ANIME, but endpoints may override)
    type: query.type || "ANIME",

    // Filters
    status: query.status || null,
    season: query.season || null,
    seasonYear: query.year ? parseInt(query.year, 10) : null,
    format: query.format || null,
    genre: query.genre || null,

    // Date filters — accept YYYY-MM-DD or YYYYMMDD
    startDate_greater: parseFuzzyDateInt(query.startDateGreater || query.startAfter),
    startDate_lesser: parseFuzzyDateInt(query.startDateLesser || query.startBefore),
    endDate_greater: parseFuzzyDateInt(query.endDateGreater || query.endAfter),
    endDate_lesser: parseFuzzyDateInt(query.endDateLesser || query.endBefore),

    // Score filters
    averageScore_greater: query.minScore ? parseInt(query.minScore, 10) : null,
    averageScore_lesser: query.maxScore ? parseInt(query.maxScore, 10) : null,

    // Popularity filter (AniList's media filter does not expose a favourites_greater)
    popularity_greater: query.minPopularity ? parseInt(query.minPopularity, 10) : null,

    // Adult content filter (default: exclude adult content)
    isAdult: query.isAdult === "true" || query.isAdult === "1" ? true : false,
  };

  // Sort override — accept comma-separated list e.g. ?sort=SCORE_DESC,POPULARITY_DESC
  if (query.sort) {
    vars.sort = query.sort
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  return vars;
}

// -----------------------------------------------------------------------------
// AniList client
// -----------------------------------------------------------------------------
async function fetchAnilist(variables) {
  const body = JSON.stringify({ query: ANILIST_QUERY, variables });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(ANILIST_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "anilist-my-proxy/1.0 (+vercel)",
      },
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`AniList returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const errMsg = (data.errors && data.errors[0] && data.errors[0].message) || `AniList API HTTP ${res.status}`;
      const err = new Error(errMsg);
      err.status = res.status;
      err.payload = data;
      throw err;
    }

    if (data.errors && data.errors.length) {
      const err = new Error(data.errors[0].message || "AniList GraphQL error");
      err.payload = data;
      throw err;
    }

    return data.data;
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------------------------------------------------------
// Main handler factory
// -----------------------------------------------------------------------------
// Each endpoint calls this with a `category` config (default sort, status, etc.)
// and gets back a Vercel serverless handler.
//
// `category` shape:
//   {
//     name:        "currently-airing",          // for metadata / response
//     description: "Anime currently broadcasting",
//     defaults: {                              // GraphQL variable defaults
//       status: "RELEASING",
//       sort:  ["POPULARITY_DESC"],
//       // optionally: startDate_greater, endDate_greater, etc.
//     },
//     // Optional: apply a window filter (e.g. trending-week adds startDate_greater = 7 days ago)
//     applyWindow: null | "today" | "week" | "month"
//   }
function buildHandler(category) {
  return async (req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.end();
      return;
    }

    if (req.method !== "GET") {
      return jsonResponse(res, 405, {
        ok: false,
        error: "Method not allowed. Use GET.",
      });
    }

    try {
      const query = req.query || {};
      const parsed = parseQueryParams(query);

      // Merge endpoint defaults, then user-provided overrides.
      const defaults = category.defaults || {};
      const variables = {
        page: parsed.page,
        perPage: parsed.perPage,
        type: parsed.type || defaults.type || "ANIME",
        status: parsed.status || defaults.status || null,
        sort: parsed.sort || defaults.sort || ["POPULARITY_DESC"],
        season: parsed.season || defaults.season || null,
        seasonYear: parsed.seasonYear || defaults.seasonYear || null,
        format: parsed.format || defaults.format || null,
        genre: parsed.genre || null,
        startDate_greater:
          parsed.startDate_greater ||
          defaults.startDate_greater ||
          (category.applyWindow === "week"
            ? fuzzyDateIntDaysAgo(7)
            : category.applyWindow === "month"
            ? fuzzyDateIntDaysAgo(30)
            : null),
        startDate_lesser: parsed.startDate_lesser || defaults.startDate_lesser || null,
        endDate_greater: parsed.endDate_greater || defaults.endDate_greater || null,
        endDate_lesser: parsed.endDate_lesser || defaults.endDate_lesser || null,
        averageScore_greater: parsed.averageScore_greater || defaults.averageScore_greater || null,
        averageScore_lesser: parsed.averageScore_lesser || defaults.averageScore_lesser || null,
        popularity_greater: parsed.popularity_greater || defaults.popularity_greater || null,
        isAdult: parsed.isAdult,
      };

      // Remove null/undefined so GraphQL treats them as omitted (some vars are non-nullable
      // but we declare them nullable in the query).
      const cleanVars = {};
      for (const [k, v] of Object.entries(variables)) {
        if (v !== null && v !== undefined && v !== "") cleanVars[k] = v;
      }

      const data = await fetchAnilist(cleanVars);
      const page = data.Page;
      const pageInfo = page.pageInfo;
      const media = page.media;

      // Build the response body
      const body = {
        ok: true,
        category: category.name,
        description: category.description,
        defaults: {
          status: defaults.status || null,
          sort: defaults.sort || null,
          applyWindow: category.applyWindow || null,
        },
        applied: {
          page: cleanVars.page,
          perPage: cleanVars.perPage,
          type: cleanVars.type || "ANIME",
          status: cleanVars.status || null,
          sort: cleanVars.sort || null,
          season: cleanVars.season || null,
          seasonYear: cleanVars.seasonYear || null,
          format: cleanVars.format || null,
          genre: cleanVars.genre || null,
          startDate_greater: cleanVars.startDate_greater || null,
          endDate_greater: cleanVars.endDate_greater || null,
          endDate_lesser: cleanVars.endDate_lesser || null,
          averageScore_greater: cleanVars.averageScore_greater || null,
          averageScore_lesser: cleanVars.averageScore_lesser || null,
        },
        pagination: pageInfo,
        count: media.length,
        data: media,
      };

      // Helpful hint when the user paginated past the end of results.
      // AniList's `total` field is capped at 5000 and can be misleading,
      // so we check the *actual* end-of-data signal: hasNextPage=false AND
      // currentPage > 1 AND no data returned (or currentPage > lastPage).
      const currentPage = pageInfo.currentPage || cleanVars.page;
      const lastPage = pageInfo.lastPage;
      const hasNext = pageInfo.hasNextPage;
      if (
        media.length === 0 &&
        currentPage > 1 &&
        hasNext === false
      ) {
        // AniList's lastPage can be wrong (derived from capped total), so the
        // *previous* page is the most reliable suggestion — it's the last
        // page we know existed and had data, OR if even that was empty, fall
        // back to page 1 which always has data on a non-empty category.
        const prevPage = Math.max(1, currentPage - 1);
        body.hint =
          `Requested page ${currentPage} returned no results because you have paginated past the end of the data. ` +
          `Try ?page=1 (always safe) or ?page=${prevPage} (the previous page, which is likely the last one with data). ` +
          `Tip: trust \`pagination.hasNextPage\` rather than \`lastPage\` — AniList caps \`total\` at 5000, so \`lastPage\` can be inaccurate.`;
      } else if (
        media.length === 0 &&
        currentPage > 1 &&
        lastPage &&
        currentPage > lastPage
      ) {
        body.hint =
          `Requested page ${currentPage} is past the last page (${lastPage}). ` +
          `Try ?page=${lastPage} or ?page=1.`;
      }

      return jsonResponse(res, 200, body);
    } catch (err) {
      console.error(`[${category.name}] error:`, err.message);
      const status = err.status || 500;
      return jsonResponse(res, status, {
        ok: false,
        category: category.name,
        error: err.message,
        ...(err.payload ? { details: err.payload } : {}),
      });
    }
  };
}

module.exports = {
  ANILIST_QUERY,
  fetchAnilist,
  parseQueryParams,
  buildHandler,
  fuzzyDateIntDaysAgo,
  parseFuzzyDateInt,
  jsonResponse,
};
