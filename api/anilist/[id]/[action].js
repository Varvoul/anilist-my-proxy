// GET /api/anilist/{anilist_id}/full  and  GET /api/anilist/{anilist_id}/episodes
// Explicit-source item routes: the id is ALWAYS treated as an AniList id.
// This removes the ambiguity of overlapping MAL/AniList id ranges — a single
// deterministic AniList lookup, no ?idType= needed, no ambiguous notes.
//
//   /api/anilist/154587/full       -> Sousou no Frieren (AniList id 154587)
//   /api/anilist/11061/episodes    -> Hunter x Hunter 2011 episode list
//
// Query parameters: page / perPage (episodes), refresh=true|1. See /api landing.
// Responses are cached server-side for 4 hours + CDN s-maxage=14400.
const itemRoute = require("../../_lib/item-route");

module.exports = (req, res) => itemRoute(req, res, "anilist");
