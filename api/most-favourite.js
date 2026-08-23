// GET /api/most-favourite
// Anime ordered by favourites count (most favourited first), across all statuses.
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "most-favourite",
  description: "Most-favourited anime of all time (sort FAVOURITES_DESC).",
  defaults: {
    sort: ["FAVOURITES_DESC"],
  },
});
