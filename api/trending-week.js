// GET /api/trending-week
// AniList's TRENDING sort is a 24-hour window, so to approximate "trending this week"
// we apply a `startDate_greater` filter for the past 7 days and sort by popularity
// (a strong proxy for sustained interest over a week).
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "trending-week",
  description:
    "Anime released in the last 7 days, sorted by popularity desc (week-trending proxy).",
  defaults: {
    status: "RELEASING",
    sort: ["POPULARITY_DESC"],
  },
  applyWindow: "week",
});
