// GET /api/popular
// Most popular anime of all time (sort POPULARITY_DESC).
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "popular",
  description: "Most popular anime of all time (sort POPULARITY_DESC).",
  defaults: {
    sort: ["POPULARITY_DESC"],
  },
});
