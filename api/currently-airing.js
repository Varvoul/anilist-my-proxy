// GET /api/currently-airing
// Anime that are broadcasting right now (status=RELEASING), default sort by popularity.
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "currently-airing",
  description: "Anime currently broadcasting (status RELEASING), default sort by popularity desc.",
  defaults: {
    status: "RELEASING",
    sort: ["POPULARITY_DESC"],
  },
});
