// GET /api/upcoming
// Anime scheduled to air in the future (status NOT_YET_RELEASED), default sort
// by popularity so the most-anticipated upcoming titles appear first.
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "upcoming",
  description: "Anime scheduled for future release (status NOT_YET_RELEASED, sort POPULARITY_DESC).",
  defaults: {
    status: "NOT_YET_RELEASED",
    sort: ["POPULARITY_DESC"],
  },
});
