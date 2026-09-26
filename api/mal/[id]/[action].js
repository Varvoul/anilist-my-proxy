// GET /api/mal/{mal_id}/full, /episodes  and  /relations
// Explicit-source item routes: the id is ALWAYS treated as a MyAnimeList id.
// This removes the ambiguity of overlapping MAL/AniList id ranges — a single
// deterministic AniList lookup, no ?idType= needed, no ambiguous notes.
//
//   /api/mal/52991/full       -> Sousou no Frieren (MAL id 52991)
//   /api/mal/11061/relations  -> Hunter x Hunter 2011 related entries
//
// Query parameters: page / perPage (episodes), refresh=true|1. See /api landing.
// Responses are cached server-side for 4 hours + CDN s-maxage=14400.
const itemRoute = require("../../_lib/item-route");

module.exports = (req, res) => itemRoute(req, res, "mal");
