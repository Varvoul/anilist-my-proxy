// GET /api/top-airing
// Top-rated currently broadcasting anime, default sort by score desc.
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "top-airing",
  description: "Top-rated currently broadcasting anime (status RELEASING, sort SCORE_DESC).",
  defaults: {
    status: "RELEASING",
    sort: ["SCORE_DESC"],
  },
});
