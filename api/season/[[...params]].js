// GET /api/season/{season}/{year}   (+ /api/season/current, + /api/season)
// AniList-style seasonal anime browse endpoint.
//
//   /api/season/winter/2026        — case-insensitive: WINTER|SPRING|SUMMER|FALL
//   /api/season/WINTER/2026?...    — same, with any filters below
//   /api/season/current            — resolves the current JST season/year
//   /api/season                    — this usage doc
//
// Built as ONE optional catch-all function (api/season/[[...params]].js) to
// conserve serverless functions — this deployment sits near the Vercel Hobby
// 12-function cap (see api/[category].js header).
//
// PARAMETERS / FILTERS (AniList Media query args, all optional):
//   page=1               1-indexed page
//   perPage=20           1-50 (AniList's hard cap)
//   sort=POPULARITY_DESC comma-separated MediaSort tokens (invalid ones are
//                        dropped; falls back to POPULARITY_DESC). Examples:
//                        SCORE_DESC, START_DATE_DESC, TRENDING_DESC, FAVOURITES_DESC
//   format=TV            single MediaFormat: TV, TV_SHORT, MOVIE, SPECIAL, OVA, ONA, MUSIC
//   format_in=TV,ONA     multiple MediaFormat
//   status=RELEASING     single MediaStatus: FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED, HIATUS
//   status_in=RELEASING,HIATUS
//   genre=Action         single AniList genre (canonicalized, case-insensitive)
//   genres=Action,Comedy multiple genres (AniList genre_in) — `genre_in` also accepted
//   tags=Time Loop,Isekai  comma-separated AniList tag names (AniList tag_in)
//   search=frieren       free-text within the season
//   minScore=70          averageScore_greater (0-100)
//   maxScore=90          averageScore_lesser
//   minPopularity=1000   popularity_greater
//   country=JP           countryOfOrigin (ISO 3166-1 alpha-2)
//   startDateGreater=2026-01-01  (or YYYYMMDD) — FuzzyDateInt window filters
//   startDateLesser= / endDateGreater= / endDateLesser=
//   nsfw=false           default: isAdult=false is sent (SFW only).
//                        nsfw=true OMITS the isAdult filter (everything, not adult-only)
//   type=ANIME           ANIME (default) or MANGA
//   refresh=1            bypass both cache reads (response is still re-cached)
//
// RESPONSE (AniList format + proxy meta, same convention as /api/schedule):
//   { ok, endpoint, cache, applied, count, data: { Page: { pageInfo, media } } }
//   pageInfo is AniList's verbatim block. Known upstream quirk: AniList caps
//   `total` at 5000 / stretches lastPage on some filter combos — trust
//   hasNextPage for termination, exactly like AniList's own clients do.
//
// CACHING (owner spec: TTL cache, param/filter change = fresh data):
//   key = "browse v1 | season | {SEASON}|{YEAR} | {normalized params}"
//   (season uppercased; ?refresh excluded). In-memory 4h TTL (shared store) +
//   CDN s-maxage=14400 + stale-while-revalidate=86400.
const {
  SEASONS, MEDIA_SORTS, MEDIA_FORMATS, MEDIA_STATUSES,
  postGraphql, MEDIA_FIELDS,
  cacheGet, cacheSet, cacheKey, cacheInfo, respond, corsPreflight, methodGuard,
  clampInt, isTrue, enumList, firstEnum, genreVars, tagIn, parseFuzzyDateInt, cleanVars,
  currentSeasonJST,
} = require("../_lib/entity");

const LANDING = "/api/season";
const YEAR_MIN = 1960;
const YEAR_MAX = 2100;

const SEASON_QUERY = `
query (
  $page: Int, $perPage: Int, $type: MediaType, $season: MediaSeason, $seasonYear: Int,
  $sort: [MediaSort], $format: MediaFormat, $format_in: [MediaFormat],
  $status: MediaStatus, $status_in: [MediaStatus], $genre: String, $genre_in: [String],
  $tag_in: [String], $search: String, $averageScore_greater: Int, $averageScore_lesser: Int,
  $popularity_greater: Int, $isAdult: Boolean, $countryOfOrigin: CountryCode,
  $startDate_greater: FuzzyDateInt, $startDate_lesser: FuzzyDateInt,
  $endDate_greater: FuzzyDateInt, $endDate_lesser: FuzzyDateInt
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(
      season: $season, seasonYear: $seasonYear, type: $type, sort: $sort,
      format: $format, format_in: $format_in, status: $status, status_in: $status_in,
      genre: $genre, genre_in: $genre_in, tag_in: $tag_in, search: $search,
      averageScore_greater: $averageScore_greater, averageScore_lesser: $averageScore_lesser,
      popularity_greater: $popularity_greater, isAdult: $isAdult,
      countryOfOrigin: $countryOfOrigin,
      startDate_greater: $startDate_greater, startDate_lesser: $startDate_lesser,
      endDate_greater: $endDate_greater, endDate_lesser: $endDate_lesser
    ) {
${MEDIA_FIELDS}
    }
  }
}
`;

function usage(res) {
  return respond(res, 200, {
    ok: true,
    endpoint: LANDING,
    usage: {
      shape: [
        "GET /api/season/{season}/{year}   e.g. /api/season/winter/2026",
        "GET /api/season/current           resolves the current JST season/year",
      ],
      seasons: SEASONS,
      filters: {
        page: "1-indexed page",
        perPage: "1-50 (default 20)",
        sort: "comma-separated MediaSort (default POPULARITY_DESC)",
        format: "single MediaFormat",
        format_in: "comma-separated MediaFormat",
        status: "single MediaStatus",
        status_in: "comma-separated MediaStatus",
        genre: "single AniList genre (canonicalized)",
        genres: "comma-separated genres -> AniList genre_in",
        tags: "comma-separated AniList tag names -> tag_in",
        search: "free-text within the season",
        minScore: "averageScore_greater (0-100)",
        maxScore: "averageScore_lesser",
        minPopularity: "popularity_greater",
        country: "countryOfOrigin ISO code (JP, ...)",
        nsfw: "false (default, SFW) | true (omit the isAdult filter entirely)",
        type: "ANIME (default) | MANGA",
        refresh: "1 = bypass cache reads (response still re-cached)",
      },
      sorts: MEDIA_SORTS,
      formats: MEDIA_FORMATS,
      statuses: MEDIA_STATUSES,
      examples: [
        "/api/season/winter/2026",
        "/api/season/current",
        "/api/season/fall/2026?format=TV&sort=POPULARITY_DESC&perPage=10",
        "/api/season/spring/2025?genres=Action,Comedy&minScore=75",
        "/api/season/summer/2024?tags=Isekai&nsfw=true&page=2",
      ],
      cache: "Exact-key TTL cache: in-memory 4h + edge s-maxage=14400. ANY parameter/filter change = new key = fresh AniList fetch. ?refresh=1 bypasses both.",
    },
  });
}

function badRequest(res, error, hint) {
  return respond(res, 400, {
    ok: false,
    endpoint: LANDING,
    error,
    ...(hint ? { hint } : {}),
    data: { Page: null },
  }, "no-store");
}

module.exports = async (req, res) => {
  if (corsPreflight(req, res)) return;
  if (methodGuard(req, res, LANDING)) return;

  const query = req.query || {};
  // Optional catch-all segments: /api/season -> [] ; /api/season/current -> ["current"]
  // /api/season/winter/2026 -> ["winter","2026"] (Vercel injects req.query.params)
  const segs = Array.isArray(query.params) ? query.params : query.params ? [query.params] : [];

  if (!segs.length) return usage(res);

  let season;
  let year;
  let isCurrent = false;

  if (segs.length === 1 && String(segs[0]).toLowerCase() === "current") {
    const cur = currentSeasonJST(clockMsSafe());
    season = cur.season;
    year = cur.year;
    isCurrent = true;
  } else if (segs.length === 2) {
    const sRaw = String(segs[0] || "").trim().toUpperCase();
    if (!SEASONS.includes(sRaw)) {
      return badRequest(res, `Invalid season "${decodeURIComponent(String(segs[0] || ""))}". Use one of: ${SEASONS.join(", ")} (case-insensitive), or /api/season/current.`);
    }
    const yRaw = String(segs[1] || "");
    if (!/^\d{1,4}$/.test(yRaw)) {
      return badRequest(res, `Invalid year "${yRaw}". Use a 4-digit year, e.g. /api/season/${sRaw.toLowerCase()}/2026.`);
    }
    year = parseInt(yRaw, 10);
    if (year < YEAR_MIN || year > YEAR_MAX) {
      return badRequest(res, `Year ${year} out of range (${YEAR_MIN}-${YEAR_MAX}).`);
    }
    season = sRaw;
  } else {
    return badRequest(res, "Expected /api/season/{season}/{year} or /api/season/current.", "e.g. /api/season/winter/2026, /api/season/current");
  }

  // ---- Parse + validate filters (locally, before burning an upstream call) ----
  const page = clampInt(query.page, 1, 10000, 1);
  const perPage = clampInt(query.perPage || query.per_page, 1, 50, 20);

  const sort = enumList(query.sort, MEDIA_SORTS) || ["POPULARITY_DESC"];
  const format = query.format ? firstEnum(query.format, MEDIA_FORMATS) : null;
  if (query.format && !format) {
    return badRequest(res, `Invalid format "${query.format}". Allowed: ${MEDIA_FORMATS.join(", ")}.`);
  }
  const format_in = enumList(query.format_in, MEDIA_FORMATS);
  if (query.format_in && !format_in) {
    return badRequest(res, `Invalid format_in "${query.format_in}". Allowed: ${MEDIA_FORMATS.join(", ")}.`);
  }
  const status = query.status ? firstEnum(query.status, MEDIA_STATUSES) : null;
  if (query.status && !status) {
    return badRequest(res, `Invalid status "${query.status}". Allowed: ${MEDIA_STATUSES.join(", ")}.`);
  }
  const status_in = enumList(query.status_in, MEDIA_STATUSES);
  if (query.status_in && !status_in) {
    return badRequest(res, `Invalid status_in "${query.status_in}". Allowed: ${MEDIA_STATUSES.join(", ")}.`);
  }
  const country = query.country || query.countryOfOrigin || null;
  if (country && !/^[A-Za-z]{2}$/.test(String(country))) {
    return badRequest(res, `Invalid country "${country}". Use an ISO 3166-1 alpha-2 code, e.g. JP.`);
  }
  const typeList = query.type ? enumList(query.type, ["ANIME", "MANGA"]) : null;
  if (query.type && !typeList) {
    return badRequest(res, `Invalid type "${query.type}". Allowed: ANIME, MANGA.`);
  }
  const type = typeList ? typeList[0] : "ANIME";

  // nsfw semantics: default SFW (isAdult:false sent). nsfw=true OMITS the
  // isAdult variable entirely -> everything (AniList returns adult + non-adult),
  // NOT "adult only" — that is the intuitive "include adult content" reading.
  const nsfw = isTrue(query.nsfw) || isTrue(query.adult);
  const { genre, genre_in } = genreVars(query);

  const variables = cleanVars({
    page,
    perPage,
    type,
    season,
    seasonYear: year,
    sort,
    format,
    format_in,
    status,
    status_in,
    genre,
    genre_in,
    tag_in: tagIn(query),
    search: query.search || null,
    averageScore_greater: query.minScore || query.min_score ? clampInt(query.minScore || query.min_score, 0, 100, null) : null,
    averageScore_lesser: query.maxScore || query.max_score ? clampInt(query.maxScore || query.max_score, 0, 100, null) : null,
    popularity_greater: query.minPopularity || query.min_popularity ? clampInt(query.minPopularity || query.min_popularity, 0, null, null) : null,
    isAdult: nsfw ? null : false,
    countryOfOrigin: country ? String(country).toUpperCase() : null,
    startDate_greater: parseFuzzyDateInt(query.startDateGreater || query.startDate_greater),
    startDate_lesser: parseFuzzyDateInt(query.startDateLesser || query.startDate_lesser),
    endDate_greater: parseFuzzyDateInt(query.endDateGreater || query.endDate_greater),
    endDate_lesser: parseFuzzyDateInt(query.endDateLesser || query.endDate_lesser),
  });

  const refresh = isTrue(query.refresh);
  const endpoint = `${LANDING}/${isCurrent ? "current" : `${season.toLowerCase()}/${year}`}`;
  // Path segments are already captured (normalized) in the key's identity part —
  // exclude the raw injected segments so /winter and /WINTER share one entry.
  const { params: _segs, ...qsOnly } = query;
  const key = cacheKey(["season", isCurrent ? "current" : `${season}|${year}`], qsOnly);

  // ---- Cache read (exact key; any param/filter change misses by design) ----
  if (!refresh) {
    const cached = cacheGet(key);
    if (cached && cached.body) {
      return respond(res, 200, {
        ok: true,
        endpoint: cached.endpoint,
        cache: cacheInfo(key, true, cached.builtAt),
        ...cached.body,
      });
    }
  }

  // ---- Fresh fetch ----
  try {
    const result = await postGraphql(SEASON_QUERY, variables);
    const pageData = result && result.payload && result.payload.Page;
    if (!pageData) throw new Error("AniList returned no Page payload");
    const media = Array.isArray(pageData.media) ? pageData.media : [];

    const applied = {
      season,
      seasonYear: year,
      ...(isCurrent ? { resolvedFrom: "current (JST clock)" } : {}),
      type: variables.type,
      page,
      perPage,
      sort,
      format: variables.format || null,
      format_in: variables.format_in || null,
      status: variables.status || null,
      status_in: variables.status_in || null,
      genre: variables.genre || null,
      genre_in: variables.genre_in || null,
      tag_in: variables.tag_in || null,
      search: variables.search || null,
      minScore: variables.averageScore_greater || null,
      maxScore: variables.averageScore_lesser || null,
      minPopularity: variables.popularity_greater || null,
      country: variables.countryOfOrigin || null,
      nsfw,
      dateFilters: {
        startDate_greater: variables.startDate_greater || null,
        startDate_lesser: variables.startDate_lesser || null,
        endDate_greater: variables.endDate_greater || null,
        endDate_lesser: variables.endDate_lesser || null,
      },
    };

    const builtAt = Date.now();
    const body = {
      applied,
      count: media.length,
      data: { Page: { pageInfo: pageData.pageInfo, media } },
    };
    cacheSet(key, { body, endpoint, builtAt });
    return respond(res, 200, {
      ok: true,
      endpoint,
      cache: cacheInfo(key, false, builtAt),
      ...body,
    });
  } catch (err) {
    console.error("[season] error:", err.message);
    return respond(res, err.status && err.status >= 400 && err.status < 600 ? err.status : 502, {
      ok: false,
      endpoint: LANDING,
      cache: cacheInfo(key, false, null),
      error: err.message,
      data: { Page: null },
    }, "no-store");
  }
};

// Clock seam (kept tiny so tests could inject a fixed date if ever needed)
function clockMsSafe() {
  return Date.now();
}
