// GET /api/trending-month
// Same idea as trending-week but for the past 30 days.
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "trending-month",
  description:
    "Anime released in the last 30 days, sorted by popularity desc (month-trending proxy).",
  defaults: {
    status: "RELEASING",
    sort: ["POPULARITY_DESC"],
  },
  applyWindow: "month",
});
