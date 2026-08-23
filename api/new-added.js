// GET /api/new-added
// Anime most recently added to AniList's database (sort ID_DESC, since AniList
// assigns incrementing IDs).
const { buildHandler } = require("./_lib/anilist");

module.exports = buildHandler({
  name: "new-added",
  description: "Newest entries in AniList's database (sort ID_DESC).",
  defaults: {
    sort: ["ID_DESC"],
  },
});
