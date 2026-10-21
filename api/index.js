// GET /api
// Lists every available category endpoint in this proxy, plus the shared
// query-parameter schema. Useful as a self-documenting landing page.
const { jsonResponse } = require("./_lib/anilist");

const CATEGORIES = [
  { path: "/api/currently-airing",  defaults: { status: "RELEASING",          sort: ["POPULARITY_DESC"] },  description: "Anime currently broadcasting, sorted by popularity." },
  { path: "/api/top-airing",        defaults: { status: "RELEASING",          sort: ["SCORE_DESC"] },       description: "Top-rated currently broadcasting anime." },
  { path: "/api/new-releases",      defaults: { sort: ["START_DATE_DESC"] },                                description: "Newest premieres by start date, across all statuses." },
  { path: "/api/trending-today",    defaults: { status: "RELEASING",          sort: ["TRENDING_DESC"] },    description: "Trending on AniList in the last 24h." },
  { path: "/api/trending-week",     defaults: { status: "RELEASING",          sort: ["POPULARITY_DESC"] },  description: "Anime released in the last 7 days, sorted by popularity." },
  { path: "/api/trending-week-flex", defaults: { sort: ["POPULARITY_DESC"] },                                 description: "Same as /trending-week but without status=RELEASING — always returns data." },
  { path: "/api/trending-month",    defaults: { status: "RELEASING",          sort: ["POPULARITY_DESC"] },  description: "Anime released in the last 30 days, sorted by popularity." },
  { path: "/api/upcoming",          defaults: { status: "NOT_YET_RELEASED",   sort: ["POPULARITY_DESC"] },  description: "Anime scheduled for future release." },
  { path: "/api/recently-completed", defaults: { status: "FINISHED",          sort: ["END_DATE_DESC"] },    description: "Recently completed anime, newest finished first." },
  { path: "/api/most-favourite",    defaults: { sort: ["FAVOURITES_DESC"] },                                description: "Most favourited anime of all time." },
  { path: "/api/new-added",         defaults: { sort: ["ID_DESC"] },                                         description: "Newest entries added to AniList's database." },
  { path: "/api/popular",           defaults: { sort: ["POPULARITY_DESC"] },                                description: "Most popular anime of all time." },
  { path: "/api/top-rated",         defaults: { sort: ["SCORE_DESC"] },                                     description: "Highest rated anime of all time." },
];

const ITEM_ENDPOINTS = [
  {
    path: "/api/mal/{mal_id}/full",
    description: "Full Jikan-style metadata; the id is explicitly a MyAnimeList id. Recommended — deterministic, no ambiguity between overlapping id ranges.",
    id: "A MyAnimeList id.",
    cache: "Server-side cache with 4h TTL (auto-expires; next visit refetches from AniList) + CDN s-maxage=14400.",
    exampleUsage: [
      "/api/mal/52991/full",
      "/api/mal/11061/full",
    ],
  },
  {
    path: "/api/anilist/{anilist_id}/full",
    description: "Full Jikan-style metadata; the id is explicitly an AniList id. Recommended — deterministic, no ambiguity between overlapping id ranges.",
    id: "An AniList id.",
    cache: "Server-side cache with 4h TTL (auto-expires; next visit refetches from AniList) + CDN s-maxage=14400.",
    exampleUsage: [
      "/api/anilist/154587/full",
      "/api/anilist/11061/full",
    ],
  },
  {
    path: "/api/{id}/full",
    description: "Backward-compatible generic route: full Jikan-style metadata for one anime, id source auto-detected (MAL id or AniList id).",
    id: "A MyAnimeList id OR an AniList id (auto-detected). Force with ?idType=anilist|mal, or prefer the explicit /api/mal/... and /api/anilist/... routes.",
    cache: "Server-side cache with 4h TTL (auto-expires; next visit refetches from AniList) + CDN s-maxage=14400.",
    exampleUsage: [
      "/api/11061/full",
      "/api/52991/full",
      "/api/21/full?idType=mal",
    ],
  },
  {
    path: "/api/mal/{mal_id}/relations",
    description: "All related entries for the anime (prequel, sequel, side story, spin-off, source manga, etc. — everything AniList returns), each with both ids, cover + banner images and AniList-style titles; the id is explicitly a MyAnimeList id.",
    id: "A MyAnimeList id.",
    cache: "Server-side cache with 4h TTL (auto-expires; next visit refetches from AniList) + CDN s-maxage=14400.",
    exampleUsage: [
      "/api/mal/16498/relations",
      "/api/mal/52991/relations",
    ],
  },
  {
    path: "/api/anilist/{anilist_id}/relations",
    description: "All related entries for the anime (prequel, sequel, side story, spin-off, source manga, etc. — everything AniList returns), each with both ids, cover + banner images and AniList-style titles; the id is explicitly an AniList id.",
    id: "An AniList id.",
    cache: "Server-side cache with 4h TTL (auto-expires; next visit refetches from AniList) + CDN s-maxage=14400.",
    exampleUsage: [
      "/api/anilist/16498/relations",
      "/api/anilist/154587/relations",
    ],
  },
  {
    path: "/api/{id}/relations",
    description: "Backward-compatible generic route: all related entries (AniList relations incl. prequel/sequel seasons), id source auto-detected. The same relation entries are also embedded in /full as data.relations + data.seasons.",
    id: "A MyAnimeList id OR an AniList id (auto-detected). Force with ?idType=anilist|mal, or prefer the explicit /api/mal/... and /api/anilist/... routes.",
    cache: "Server-side cache with 4h TTL (auto-expires; next visit refetches from AniList) + CDN s-maxage=14400.",
    exampleUsage: [
      "/api/16498/relations",
      "/api/154587/relations",
    ],
  },
  {
    path: "/api/mal/{mal_id}/episodes",
    description: "Jikan-style episode list; the id is explicitly a MyAnimeList id.",
    id: "A MyAnimeList id.",
    queryParameters: [
      { name: "page",    type: "Int", default: 1,  description: "Page number (1-indexed)." },
      { name: "perPage", type: "Int", default: 50, description: "Episodes per page (1-50; 50 is AniList's maximum supported page size)." },
      { name: "refresh", type: "Bool", default: false, description: "true/1 bypasses the 4h cache and refetches from AniList." },
    ],
    cache: "Server-side cache with 4h TTL (auto-expires; next visit refetches from AniList) + CDN s-maxage=14400.",
    exampleUsage: [
      "/api/mal/11061/episodes",
      "/api/mal/21/episodes?page=2&perPage=10",
    ],
  },
  {
    path: "/api/anilist/{anilist_id}/episodes",
    description: "Jikan-style episode list; the id is explicitly an AniList id.",
    id: "An AniList id.",
    queryParameters: [
      { name: "page",    type: "Int", default: 1,  description: "Page number (1-indexed)." },
      { name: "perPage", type: "Int", default: 50, description: "Episodes per page (1-50; 50 is AniList's maximum supported page size)." },
      { name: "refresh", type: "Bool", default: false, description: "true/1 bypasses the 4h cache and refetches from AniList." },
    ],
    cache: "Server-side cache with 4h TTL (auto-expires; next visit refetches from AniList) + CDN s-maxage=14400.",
    exampleUsage: [
      "/api/anilist/154587/episodes?perPage=5",
      "/api/anilist/11061/episodes",
    ],
  },
  {
    path: "/api/{id}/episodes",
    description: "Backward-compatible generic route: Jikan-style episode list (titles, thumbnails, streaming url, aired times), id source auto-detected.",
    id: "A MyAnimeList id OR an AniList id (auto-detected). Force with ?idType=anilist|mal, or prefer the explicit /api/mal/... and /api/anilist/... routes.",
    queryParameters: [
      { name: "page",    type: "Int", default: 1,  description: "Page number (1-indexed)." },
      { name: "perPage", type: "Int", default: 50, description: "Episodes per page (1-50; 50 is AniList's maximum supported page size)." },
      { name: "idType",  type: "Enum", default: null, description: "anilist or mal — force how the numeric id is interpreted." },
      { name: "refresh", type: "Bool", default: false, description: "true/1 bypasses the 4h cache and refetches from AniList." },
    ],
    cache: "Server-side cache with 4h TTL (auto-expires; next visit refetches from AniList) + CDN s-maxage=14400.",
    exampleUsage: [
      "/api/11061/episodes",
      "/api/21/episodes?page=2&perPage=10",
      "/api/154587/episodes?perPage=5",
    ],
  },
];

const QUERY_PARAMS = [
  { name: "page",            type: "Int",    default: 1,    description: "Page number (1-indexed)." },
  { name: "perPage",         type: "Int",    default: 20,   description: "Items per page (1-50)." },
  { name: "type",            type: "Enum",   default: "ANIME", description: "ANIME or MANGA." },
  { name: "status",          type: "Enum",   default: null, description: "Override endpoint default. One of: FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED, HIATUS." },
  { name: "sort",            type: "String", default: null, description: "Override endpoint default. Comma-separated, e.g. ?sort=SCORE_DESC,POPULARITY_DESC. Valid: ID_DESC, TITLE_ROMAJI_DESC, START_DATE_DESC, END_DATE_DESC, SCORE_DESC, POPULARITY_DESC, FAVOURITES_DESC, TRENDING_DESC." },
  { name: "season",          type: "Enum",   default: null, description: "WINTER, SPRING, SUMMER, FALL." },
  { name: "year",            type: "Int",    default: null, description: "Season year (e.g. 2026). Used together with season." },
  { name: "format",          type: "Enum",   default: null, description: "TV, TV_SHORT, MOVIE, SPECIAL, OVA, ONA, MUSIC." },
  { name: "genre",           type: "String", default: null, description: "Genre name, e.g. ?genre=Action." },
  { name: "minScore",        type: "Int",    default: null, description: "Minimum averageScore (0-100)." },
  { name: "maxScore",        type: "Int",    default: null, description: "Maximum averageScore (0-100)." },
  { name: "minPopularity",   type: "Int",    default: null, description: "Minimum popularity." },
  { name: "startAfter",      type: "Date",   default: null, description: "startDate greater than (YYYY-MM-DD or YYYYMMDD)." },
  { name: "startBefore",     type: "Date",   default: null, description: "startDate less than." },
  { name: "endAfter",        type: "Date",   default: null, description: "endDate greater than." },
  { name: "endBefore",       type: "Date",   default: null, description: "endDate less than." },
  { name: "isAdult",         type: "Bool",   default: false, description: "Include adult content. true / 1 to enable." },
];

const SEARCH_ENDPOINTS = [
  {
    path: "/api/search/anime",
    description: "Full-text anime search on AniList (SEARCH_MATCH ranking). Returns ranked candidates with both ids, titles (romaji/english/native), format, dates, images and siteUrl. Built for the al-ji automation: when a mal_id has no AniList entry, search by the stored title to find the correct AniList entry - the consumer is responsible for verifying the match (exact-title / idMal agreement) before storing anything.",
    queryParameters: [
      { name: "q",       type: "String", required: true, description: "Title text to search for (2-120 characters)." },
      { name: "page",    type: "Int",    default: 1,  description: "Page number (1-indexed)." },
      { name: "perPage", type: "Int",    default: 10, description: "Candidates per page (1-50)." },
    ],
    cache: "CDN cache 30 min (s-maxage=1800); no server-side cache (unbounded query space).",
    exampleUsage: [
      "/api/search/anime?q=cowboy%20bebop",
      "/api/search/anime?q=kimi%20no%20na%20wa&perPage=5",
    ],
  },
];

const SCHEDULE_ENDPOINTS = [
  {
    path: "/api/schedule/{day}",
    description: "Currently-airing anime broadcast schedule separated by broadcast day. `day` = monday..sunday (JST broadcast day, same convention as AniList/MAL), `today` (resolves to the current JST weekday), or `all` (all seven days grouped in one call). Built on AniList's airingSchedules — every entry is a REAL scheduled broadcast carrying the TRUE episode number, unlike MAL/Jikan day schedules where consumers had to estimate episodes from week diffs. Response follows AniList format: data.Page.pageInfo + data.Page.airingSchedules[{ id, airingAt, timeUntilAiring, episode, media{...} }]; /all additionally returns data.Page.days{ monday:[...], ... } + dayInfo.",
    queryParameters: [
      { name: "page",           type: "Int",    default: 1,   description: "Page number (1-indexed)." },
      { name: "per_page",       type: "Int",    default: 500, description: "Items per page (1-500). A single day rarely exceeds ~60 entries." },
      { name: "sort",           type: "Enum",   default: "time", description: "time (chronological), popularity, score, title." },
      { name: "format",         type: "Enum",   default: null, description: "TV, TV_SHORT, OVA, ONA, MOVIE, SPECIAL, MUSIC — one or comma-separated." },
      { name: "genres",         type: "String", default: null, description: "Comma-separated AniList genre names, case-insensitive, ANY-match (e.g. Action,Fantasy)." },
      { name: "min_score",      type: "Int",    default: null, description: "Minimum averageScore (0-100)." },
      { name: "max_score",      type: "Int",    default: null, description: "Maximum averageScore (0-100)." },
      { name: "min_popularity", type: "Int",    default: null, description: "Minimum popularity." },
      { name: "nsfw",           type: "Bool",   default: false, description: "true/1 to INCLUDE adult entries (excluded by default)." },
      { name: "refresh",        type: "Bool",   default: false, description: "1 to bypass cache reads (response is still re-cached)." },
    ],
    cache: "Server-side 4h TTL on the raw 8-day AniList window (all filter variants are computed from the SAME cached window — zero extra AniList calls) + CDN s-maxage=7200, stale-while-revalidate=86400. Prefer the absolute `airingAt` epoch for countdowns; timeUntilAiring can lag on edge hits.",
    exampleUsage: [
      "/api/schedule/monday",
      "/api/schedule/today",
      "/api/schedule/all",
      "/api/schedule/friday?format=TV&min_score=70",
      "/api/schedule/saturday?genres=Action,Comedy&sort=popularity",
    ],
  },
];

const BROWSE_ENDPOINTS = [
  {
    path: "/api/season/{season}/{year}",
    description: "AniList-style seasonal browse: every anime of one season. `season` = WINTER | SPRING | SUMMER | FALL (case-insensitive); also /api/season/current (resolves the current JST season) and /api/season (usage doc). Response: data.Page.pageInfo + data.Page.media[] in verbatim AniList Media shape.",
    queryParameters: [
      { name: "page",        type: "Int",    default: 1,    description: "Page number (1-indexed)." },
      { name: "perPage",     type: "Int",    default: 20,   description: "1-50." },
      { name: "sort",        type: "Enum",   default: "POPULARITY_DESC", description: "Comma-separated MediaSort (invalid tokens dropped). e.g. SCORE_DESC, START_DATE_DESC, TRENDING_DESC, FAVOURITES_DESC." },
      { name: "format",      type: "Enum",   default: null, description: "TV, TV_SHORT, MOVIE, SPECIAL, OVA, ONA, MUSIC (single)." },
      { name: "format_in",   type: "Enum",   default: null, description: "Comma-separated MediaFormat." },
      { name: "status",      type: "Enum",   default: null, description: "FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED, HIATUS (single)." },
      { name: "status_in",   type: "Enum",   default: null, description: "Comma-separated MediaStatus." },
      { name: "genre",       type: "String", default: null, description: "Single AniList genre, canonicalized case-insensitively." },
      { name: "genres",      type: "String", default: null, description: "Comma-separated genres -> AniList genre_in (genre_in also accepted)." },
      { name: "tags",        type: "String", default: null, description: "Comma-separated AniList tag names -> tag_in." },
      { name: "search",      type: "String", default: null, description: "Free-text within the season." },
      { name: "minScore",    type: "Int",    default: null, description: "averageScore_greater (0-100)." },
      { name: "maxScore",    type: "Int",    default: null, description: "averageScore_lesser." },
      { name: "minPopularity", type: "Int",  default: null, description: "popularity_greater." },
      { name: "country",     type: "String", default: null, description: "countryOfOrigin ISO 3166-1 alpha-2 (JP, KR, ...)." },
      { name: "nsfw",        type: "Bool",   default: false, description: "false (default) = SFW (isAdult:false). true = omits the isAdult filter entirely (everything, not adult-only)." },
      { name: "type",        type: "Enum",   default: "ANIME", description: "ANIME | MANGA." },
      { name: "refresh",     type: "Bool",   default: false, description: "1 to bypass cache reads (response is still re-cached)." },
    ],
    cache: "Exact-key TTL cache (path + every normalized param): in-memory 4h (shared store) + CDN s-maxage=14400, stale-while-revalidate=86400. ANY parameter/filter change = new key = fresh AniList fetch. Errors are never cached.",
    exampleUsage: [
      "/api/season/winter/2026",
      "/api/season/current",
      "/api/season/fall/2026?format=TV&sort=POPULARITY_DESC&perPage=10",
      "/api/season/spring/2025?genres=Action,Comedy&minScore=75",
      "/api/season/summer/2024?tags=Isekai&nsfw=true&page=2",
    ],
  },
  {
    path: "/api/studio/{studio}",
    description: "AniList-style studio profile: metadata + the studio's media connection. Text paths search AniList studios case-insensitively (spaces or kebab-case both work — a kebab name auto-retries with spaces); numeric paths address exact AniList studio ids (/api/studio/4 = bones). Response: data.Studio { id, name, favourites, isAnimationStudio, siteUrl, media: { pageInfo, edges: [{ isMainStudio, node: {...full AniList Media} }] } }.",
    queryParameters: [
      { name: "page",     type: "Int",  default: 1,    description: "Page number for the studio's media connection." },
      { name: "perPage",  type: "Int",  default: 20,   description: "1-50." },
      { name: "sort",     type: "Enum", default: "POPULARITY_DESC", description: "Comma-separated MediaSort. Useful: START_DATE_DESC, SCORE_DESC, FAVOURITES_DESC." },
      { name: "isMain",   type: "Bool", default: null, description: "true = only media where the studio is the MAIN animation studio. Default (omitted) = AniList's unfiltered behavior (co-productions included)." },
      { name: "refresh",  type: "Bool", default: false, description: "1 to bypass cache reads (response is still re-cached)." },
    ],
    cache: "Same exact-key TTL cache as /api/season (in-memory 4h + edge s-maxage=14400 + SWR). Any param/filter change = fresh fetch. Not-found (404) responses are never cached.",
    exampleUsage: [
      "/api/studio/bones",
      "/api/studio/Kyoto%20Animation?perPage=5",
      "/api/studio/kyoto-animation?isMain=true",
      "/api/studio/4?sort=START_DATE_DESC",
    ],
  },
  {
    path: "/api/staff/{name}",
    description: "AniList-style voice-actor / cast-member profile: full Staff metadata + characterMedia (every character they voice, with character info + the show) + staffMedia (production credits on anime). Aliases with identical payloads: /voice-actors/{name} and /cast/{name} (Vercel rewrites; all three shapes share one cache entry). Text paths search case-insensitively (kebab-case auto-retries with spaces); numeric paths address exact AniList staff ids (/api/staff/106817).",
    queryParameters: [
      { name: "page",         type: "Int",  default: 1,    description: "Page number for characterMedia (voiced roles)." },
      { name: "perPage",      type: "Int",  default: 20,   description: "1-50 — voiced-role entries per page." },
      { name: "sort",         type: "Enum", default: "POPULARITY_DESC", description: "Comma-separated MediaSort. Useful: FAVOURITES_DESC, SCORE_DESC." },
      { name: "mainRoles",    type: "Bool", default: null, description: "true = keep only characterRole=MAIN edges. LOCAL filter on the fetched page (AniList has no server-side isMain here); effect reported in pagination_note." },
      { name: "staffPerPage", type: "Int",  default: 12,   description: "1-25 — production-credit entries (staffMedia)." },
      { name: "refresh",      type: "Bool", default: false, description: "1 to bypass cache reads (response is still re-cached)." },
    ],
    cache: "Same exact-key TTL cache (in-memory 4h + edge s-maxage=14400 + SWR). Any param/filter change = fresh fetch. Not-found (404) responses are never cached.",
    exampleUsage: [
      "/api/staff/Yoshitsugu%20Matsuoka",
      "/api/staff/106817?mainRoles=true",
      "/voice-actors/rie-takahashi",
      "/cast/Rie%20Takahashi?perPage=10",
    ],
  },
];

module.exports = (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return;
  }
  return jsonResponse(res, 200, {
    ok: true,
    name: "anilist-my-proxy",
    version: "1.5.0",
    description:
      "Categorized AniList proxy. Each /api/<category> endpoint returns paginated anime data with both AniList id and MyAnimeList idMal for every entry. Item endpoints accept a MAL id or an AniList id: explicit-source routes /api/mal/{mal_id}/full|episodes|relations and /api/anilist/{anilist_id}/full|episodes|relations (recommended), or the auto-detecting generic /api/{id}/full, /api/{id}/episodes and /api/{id}/relations. All item data is Jikan (MyAnimeList API v4) style; relations are AniList style.",
    categories: CATEGORIES,
    itemEndpoints: ITEM_ENDPOINTS,
    searchEndpoints: SEARCH_ENDPOINTS,
    scheduleEndpoints: SCHEDULE_ENDPOINTS,
    browseEndpoints: BROWSE_ENDPOINTS,
    queryParameters: QUERY_PARAMS,
    exampleUsage: [
      "/api/schedule/today",
      "/api/search/anime?q=frieren",
      "/api/currently-airing?page=1&perPage=20",
      "/api/top-airing?genre=Action&minScore=80",
      "/api/recently-completed?page=2&perPage=50",
      "/api/trending-week?year=2026&season=SUMMER",
      "/api/popular?sort=SCORE_DESC,POPULARITY_DESC",
      "/api/season/winter/2026?format=TV&sort=POPULARITY_DESC",
      "/api/season/current",
      "/api/studio/bones?isMain=true",
      "/api/staff/Yoshitsugu%20Matsuoka?mainRoles=true",
      "/voice-actors/rie-takahashi",
    ],
    dataSchema:
      "Every entry in the `data` array contains: id (AniList), idMal (MyAnimeList), title, coverImage, bannerImage, episodes, duration, status, season, seasonYear, format, source, averageScore, meanScore, popularity, favourites, startDate, endDate, nextAiringEpisode, genres, studios, siteUrl, trailer.",
  });
};
