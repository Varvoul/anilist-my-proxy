// GET /api/<category>
// Single dynamic catch-all route that handles all 12 category endpoints.
//
// Why this exists:
//   Vercel's Hobby plan limits a deployment to 12 serverless functions. We had
//   13 (11 category files + index + trending-week-flex), so the deploy failed
//   with `exceeded_serverless_functions_per_deployment`. Consolidating all
//   category endpoints into one dynamic route drops the function count to 2
//   (this file + /api/index.js) and unblocks any future endpoint additions.
//
// How it works:
//   Vercel's file-based routing matches `/api/currently-airing` to this file
//   with `req.query.category = "currently-airing"`. We look up the matching
//   config in CATEGORIES below and delegate to the shared buildHandler.
//
// Adding a new endpoint:
//   1. Add a new entry to CATEGORIES with its defaults.
//   2. (Optional) Add a corresponding doc row in /api/index.js.
//   3. Commit + push. Vercel auto-deploys. No new file needed.
const { buildHandler } = require("./_lib/anilist");

const CATEGORIES = {
  "currently-airing": {
    name: "currently-airing",
    description: "Anime currently broadcasting (status RELEASING, sort POPULARITY_DESC).",
    defaults: { status: "RELEASING", sort: ["POPULARITY_DESC"] },
  },
  "top-airing": {
    name: "top-airing",
    description: "Top-rated currently broadcasting anime (status RELEASING, sort SCORE_DESC).",
    defaults: { status: "RELEASING", sort: ["SCORE_DESC"] },
  },
  "new-releases": {
    name: "new-releases",
    description: "Newest anime by start date (sort START_DATE_DESC) across all statuses.",
    defaults: { sort: ["START_DATE_DESC"] },
  },
  "trending-today": {
    name: "trending-today",
    description: "Anime trending on AniList in the last 24 hours (status RELEASING, sort TRENDING_DESC).",
    defaults: { status: "RELEASING", sort: ["TRENDING_DESC"] },
    applyWindow: "today",
  },
  "trending-week": {
    name: "trending-week",
    description: "Anime released in the last 7 days with status RELEASING, sorted by popularity.",
    defaults: { status: "RELEASING", sort: ["POPULARITY_DESC"] },
    applyWindow: "week",
  },
  "trending-week-flex": {
    name: "trending-week-flex",
    description:
      "Same as /api/trending-week but without the status=RELEASING constraint, so it always returns data even when today isn't a TV premiere week.",
    defaults: { sort: ["POPULARITY_DESC"] },
    applyWindow: "week",
  },
  "trending-month": {
    name: "trending-month",
    description: "Anime released in the last 30 days with status RELEASING, sorted by popularity.",
    defaults: { status: "RELEASING", sort: ["POPULARITY_DESC"] },
    applyWindow: "month",
  },
  "upcoming": {
    name: "upcoming",
    description: "Anime scheduled for future release (status NOT_YET_RELEASED, sort POPULARITY_DESC).",
    defaults: { status: "NOT_YET_RELEASED", sort: ["POPULARITY_DESC"] },
  },
  "recently-completed": {
    name: "recently-completed",
    description: "Recently completed anime (status FINISHED), sorted most-recent-finished to oldest (END_DATE_DESC).",
    defaults: { status: "FINISHED", sort: ["END_DATE_DESC"] },
  },
  "most-favourite": {
    name: "most-favourite",
    description: "Most-favourited anime of all time (sort FAVOURITES_DESC).",
    defaults: { sort: ["FAVOURITES_DESC"] },
  },
  "new-added": {
    name: "new-added",
    description: "Newest entries in AniList's database (sort ID_DESC).",
    defaults: { sort: ["ID_DESC"] },
  },
  "popular": {
    name: "popular",
    description: "Most popular anime of all time (sort POPULARITY_DESC).",
    defaults: { sort: ["POPULARITY_DESC"] },
  },
};

// Vercel passes the route parameter as `req.query.category`.
module.exports = (req, res) => {
  // Vercel may also expose it under req.params depending on the runtime version.
  const categoryKey = (req.query && req.query.category) || (req.params && req.params.category);

  if (!categoryKey || !CATEGORIES[categoryKey]) {
    const valid = Object.keys(CATEGORIES).sort().join(", ");
    const { jsonResponse } = require("./_lib/anilist");
    return jsonResponse(res, 404, {
      ok: false,
      error: `Unknown category: "${categoryKey}".`,
      validCategories: Object.keys(CATEGORIES).sort(),
      hint: `Visit /api for the full list of categories and supported query parameters. Valid: ${valid}`,
    });
  }

  const config = CATEGORIES[categoryKey];
  const handler = buildHandler(config);
  return handler(req, res);
};
