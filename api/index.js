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
  { path: "/api/trending-month",    defaults: { status: "RELEASING",          sort: ["POPULARITY_DESC"] },  description: "Anime released in the last 30 days, sorted by popularity." },
  { path: "/api/upcoming",          defaults: { status: "NOT_YET_RELEASED",   sort: ["POPULARITY_DESC"] },  description: "Anime scheduled for future release." },
  { path: "/api/recently-completed", defaults: { status: "FINISHED",          sort: ["END_DATE_DESC"] },    description: "Recently completed anime, newest finished first." },
  { path: "/api/most-favourite",    defaults: { sort: ["FAVOURITES_DESC"] },                                description: "Most favourited anime of all time." },
  { path: "/api/new-added",         defaults: { sort: ["ID_DESC"] },                                         description: "Newest entries added to AniList's database." },
  { path: "/api/popular",           defaults: { sort: ["POPULARITY_DESC"] },                                description: "Most popular anime of all time." },
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
    version: "1.0.0",
    description:
      "Categorized AniList proxy. Each /api/<category> endpoint returns paginated anime data with both AniList id and MyAnimeList idMal for every entry.",
    categories: CATEGORIES,
    queryParameters: QUERY_PARAMS,
    exampleUsage: [
      "/api/currently-airing?page=1&perPage=20",
      "/api/top-airing?genre=Action&minScore=80",
      "/api/recently-completed?page=2&perPage=50",
      "/api/trending-week?year=2026&season=SUMMER",
      "/api/popular?sort=SCORE_DESC,POPULARITY_DESC",
    ],
    dataSchema:
      "Every entry in the `data` array contains: id (AniList), idMal (MyAnimeList), title, coverImage, bannerImage, episodes, duration, status, season, seasonYear, format, source, averageScore, meanScore, popularity, favourites, startDate, endDate, nextAiringEpisode, genres, studios, siteUrl, trailer.",
  });
};
