// GET /api/recently-completed
// Anime that finished airing (status FINISHED), default sort by END_DATE_DESC
// so most-recently-finished shows up first, older ones later — exactly as requested.
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "recently-completed",
  description:
    "Recently completed anime (status FINISHED), sorted most-recent-finished → oldest (END_DATE_DESC).",
  defaults: {
    status: "FINISHED",
    sort: ["END_DATE_DESC"],
  },
});
