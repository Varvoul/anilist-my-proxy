// GET /api/trending-today
// AniList's TRENDING sort reflects activity over the last 24 hours. We further
// scope to status=RELEASING to surface anime people are actively watching today.
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "trending-today",
  description: "Anime trending on AniList in the last 24 hours (status RELEASING, sort TRENDING_DESC).",
  defaults: {
    status: "RELEASING",
    sort: ["TRENDING_DESC"],
  },
  applyWindow: "today",
});
