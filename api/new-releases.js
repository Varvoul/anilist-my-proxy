// GET /api/new-releases
// Anime ordered by most recent start date (newest first). Useful for catching
// brand-new premieres across all statuses.
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "new-releases",
  description: "Newest anime by start date (sort START_DATE_DESC) across all statuses.",
  defaults: {
    sort: ["START_DATE_DESC"],
  },
});
