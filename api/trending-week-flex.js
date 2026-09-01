// GET /api/trending-week-flex
// Same as /api/trending-week but WITHOUT the strict status=RELEASING filter.
//
// Why this endpoint exists:
//   /api/trending-week requires status=RELEASING AND startDate > 7 days ago.
//   TV anime only premiere in 4 specific weeks of the year (Jan/Apr/Jul/Oct),
//   so unless today is in the first week of a new season, the strict endpoint
//   returns 0 results for most format filters.
//
//   This relaxed variant keeps the 7-day window + POPULARITY_DESC sort, but
//   allows ANY status (RELEASING, FINISHED, etc.) so it always returns the
//   anime that started airing in the last 7 days — including short ONAs,
//   music videos, and specials that aired and ended quickly.
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "trending-week-flex",
  description:
    "Anime released in the last 7 days, sorted by popularity desc. Same as /api/trending-week but without the status=RELEASING constraint, so it always returns results.",
  defaults: {
    // No status filter — allow any status.
    sort: ["POPULARITY_DESC"],
  },
  applyWindow: "week",
});
