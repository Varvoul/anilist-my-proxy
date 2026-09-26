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

// AniList's hard cap: page > 250 is rejected with HTTP 400 ("Page depth exceeds
// maximum allowed for API requests (5000 entries)"). Data can never span more
// than 250 pages, which bounds every pagination probe below.
const ANILIST_PAGE_CAP = 250;

// Wall-clock guard for the extra probes used to compute exact pagination.
// Typical AniList round-trip is 300-600 ms; worst case (8 bisect probes) stays
// well inside Vercel Hobby's function timeout. On breach we fall back to
// AniList's verbatim pageInfo rather than failing the request.
const PAGINATION_PROBE_BUDGET_MS = 5000;
const PAGINATION_PROBE_TIMEOUT_MS = 4500;
// log2(250) ≈ 8 — one full binary search over AniList's page cap.
const PAGINATION_MAX_PROBES = 8;

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
function jsonResponse(res, status, body, opts) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Category endpoints keep the 5-minute cache; item endpoints (/full,
  // /episodes) pass their own 4-hour CDN cache policy via `opts.cacheControl`.
  res.setHeader(
    "Cache-Control",
    (opts && opts.cacheControl) || "public, max-age=60, s-maxage=300"
  );
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
// Minimal probe query — used ONLY to locate the true end of a category's data.
// Asks for nothing but media ids so each probe is as cheap as possible.
// IMPORTANT: it must apply the EXACT same media filters as the main query
// (status, sort, isAdult, date windows, ...) or the detected end page would
// describe a different dataset than the one being served.
// -----------------------------------------------------------------------------
const PROBE_QUERY = `
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
    }
  }
}
`;

// -----------------------------------------------------------------------------
// AniList client
// -----------------------------------------------------------------------------
async function postGraphql(query, variables, timeoutMs) {
  const body = JSON.stringify({ query, variables });

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

async function fetchAnilist(variables) {
  return postGraphql(ANILIST_QUERY, variables, 15000);
}

// -----------------------------------------------------------------------------
// Exact pagination
// -----------------------------------------------------------------------------
// WHY THIS EXISTS
//   AniList's own pageInfo is approximate and inconsistent:
//     - `total` is hard-capped at 5000 and `lastPage` at 250 whenever the real
//       numbers would exceed them (e.g. airing pages 1-8 report 5000/250 even
//       though the category truly ends at page 9 with 171 entries).
//     - On pages past the end, `total` silently degrades to (page-1)*perPage
//       (e.g. upcoming page 249 reports 4960, page 250 reports 4980).
//   So a consumer reading `total`/`lastPage` from page 1 cannot trust them:
//   the numbers contradict what later pages report. This module computes the
//   TRUE values while keeping AniList's exact response shape.
//
// HOW
//   - Partial page (0 < items < perPage): authoritative end — total =
//     (page-1)*perPage + items, lastPage = page. Zero extra requests.
//   - Full page + hasNextPage=false: the category size is an exact multiple of
//     perPage — total = page*perPage, lastPage = page. Zero extra requests.
//   - Full page + hasNextPage=true, or empty page: binary-search AniList for
//     the last page that still returns items (bounded by ANILIST_PAGE_CAP).
//     Each probe asks only for media ids with the SAME filters as the main
//     query, is time-boxed, and capped at PAGINATION_MAX_PROBES requests.
//   - Any probe failure / budget breach: fall back to AniList's verbatim
//     pageInfo so the endpoint never breaks because of this enhancement.
//
// `probePage(variables, page)` must return { ok, count } for the given page
// using the caller's media filters. Injectable for unit tests.
async function computeExactPagination(pageInfo, media, cleanVars, probePage) {
  const pp = cleanVars.perPage || 20;
  const N = pageInfo.currentPage || cleanVars.page || 1;
  const C = Array.isArray(media) ? media.length : 0;
  const H = pageInfo.hasNextPage;

  const deadline = Date.now() + PAGINATION_PROBE_BUDGET_MS;
  let probes = 0;

  async function probe(page) {
    if (probes >= PAGINATION_MAX_PROBES) throw new Error(`probe budget exceeded (${PAGINATION_MAX_PROBES} probes)`);
    if (Date.now() > deadline) throw new Error('pagination probe time budget exhausted');
    probes += 1;
    const r = await probePage(cleanVars, page);
    if (!r.ok) throw new Error(`probe page ${page} failed: ${r.error || 'unknown'}`);
    return r.count;
  }

  // Last page in [lo, hi] that still returns items, or null if none does.
  async function lastNonEmptyPage(lo, hi) {
    let best = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const count = await probe(mid);
      if (count > 0) { best = { page: mid, count }; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return best;
  }

  const finish = (total, lastPage, hasNextPage) => ({
    pagination: { total, currentPage: N, lastPage, hasNextPage, perPage: pp },
    probes,
  });

  if (C === 0 && N <= 1) return finish(0, 0, false);           // category is empty

  if (C === 0) {
    // Past the end: find the real last page between 1 and N-1.
    const L = await lastNonEmptyPage(1, N - 1);
    if (!L) return finish(0, 0, false);
    return finish((L.page - 1) * pp + L.count, L.page, false);
  }

  if (C < pp) {
    // Partial page = authoritative end of data. (AniList never returns a short
    // page mid-dataset; if hasNextPage ever contradicts this, fall back.)
    if (H === true) throw new Error('ambiguous pageInfo: partial page with hasNextPage=true');
    return finish((N - 1) * pp + C, N, false);
  }

  // Full page (C === pp)
  if (H === false) return finish(N * pp, N, false);            // exact multiple of perPage
  if (N >= ANILIST_PAGE_CAP) return finish(N * pp, N, true);   // hard cap reached; deeper data is unreachable

  const L = await lastNonEmptyPage(N + 1, ANILIST_PAGE_CAP);
  if (!L) throw new Error('contradictory pageInfo: hasNextPage=true but no later page has items');
  return finish((L.page - 1) * pp + L.count, L.page, true);
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
        // When a window filter is applied, also cap the upper bound at "tomorrow"
        // so we only get anime that have ACTUALLY started airing in the window
        // (excludes upcoming premieres that haven't begun yet). For the strict
        // trending-week / trending-month endpoints this is a no-op because their
        // status=RELEASING filter already excludes NOT_YET_RELEASED, but for
        // trending-week-flex (which has no status filter) it's essential.
        startDate_lesser:
          parsed.startDate_lesser ||
          defaults.startDate_lesser ||
          (category.applyWindow ? fuzzyDateIntDaysAgo(-1) : null),
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

      // -------------------------------------------------------------------
      // Pagination — exact & self-consistent by default.
      // AniList's raw pageInfo caps total at 5000 / lastPage at 250 and
      // degrades past the end of data, so `total` and `lastPage` read from
      // page 1 contradict what pages 9/249/250 report. We compute the TRUE
      // values (same field names/shape) with a handful of cheap id-only
      // probes; `?rawPagination=true` restores the verbatim AniList block.
      // -------------------------------------------------------------------
      let pagination = pageInfo;
      let pagination_source = "anilist-raw (verbatim; pass ?rawPagination=true to force)";
      let pagination_probes;
      let pagination_note;
      if (String(query.rawPagination || "").toLowerCase() !== "true") {
        try {
          const ex = await computeExactPagination(pageInfo, media, cleanVars, probePageFor);
          pagination = ex.pagination;
          pagination_source = "exact";
          pagination_probes = ex.probes;
        } catch (e) {
          pagination_note = `exact pagination unavailable (${(e && e.message) || e}) — reporting AniList's raw pageInfo`;
        }
      }

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
        pagination,
        pagination_source,
        ...(pagination_probes !== undefined ? { pagination_probes } : {}),
        ...(pagination_note ? { pagination_note } : {}),
        count: media.length,
        data: media,
      };

      // Helpful hint when the user paginated past the end of results.
      // With exact pagination in place, total/lastPage can be trusted.
      const currentPage = pagination.currentPage || cleanVars.page;
      const lastPage = pagination.lastPage;
      if (media.length === 0 && currentPage > 1) {
        body.hint =
          `Requested page ${currentPage} returned no results because it is past the end of the data. ` +
          `This category has total=${pagination.total} entries across lastPage=${lastPage} (perPage=${pagination.perPage}). ` +
          `Try ?page=${Math.max(1, lastPage)} or ?page=1.`;
      } else if (media.length === 0 && currentPage <= 1) {
        body.hint = "This category currently has no entries for the applied filters.";
      } else if (pagination_source !== "exact" && media.length > 0) {
        body.hint =
          "Pagination shown is AniList's raw pageInfo (total/lastPage are capped or approximate). " +
          "Exact values could not be computed right now — retry shortly for pagination_source=exact.";
      }

      return jsonResponse(res, 200, body);
    } catch (err) {
      console.error(`[${category.name}] error:`, err.message);
      const status = err.status || 500;
      // Never CDN-cache error responses: a transient AniList 429/5xx (or the
      // depth-cap 400) must not stick at the edge for s-maxage=300 and get
      // replayed to every consumer for 5 minutes.
      return jsonResponse(res, status, {
        ok: false,
        category: category.name,
        error: err.message,
        ...(err.payload ? { details: err.payload } : {}),
      }, { cacheControl: "no-store" });
    }
  };
}

async function probePageFor(variables, page) {
  try {
    const data = await postGraphql(PROBE_QUERY, { ...variables, page }, PAGINATION_PROBE_TIMEOUT_MS);
    const items = data && data.Page && Array.isArray(data.Page.media) ? data.Page.media : null;
    if (!items) return { ok: false, error: "malformed probe response" };
    return { ok: true, count: items.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  ANILIST_QUERY,
  ANILIST_PAGE_CAP,
  fetchAnilist,
  parseQueryParams,
  buildHandler,
  computeExactPagination,
  probePageFor,
  fuzzyDateIntDaysAgo,
  parseFuzzyDateInt,
  jsonResponse,
};
