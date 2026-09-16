// GET /api/{id}/full  and  GET /api/{id}/episodes
// Generic item-level routes: the numeric id is auto-detected as a MyAnimeList
// id or an AniList id (see api/_lib/media.js). Explicit-source alternatives:
// /api/mal/{mal_id}/... and /api/anilist/{anilist_id}/... (recommended —
// deterministic, no ambiguity).
//
// Routing note: this lives at api/[category]/[action].js because Vercel
// requires the first dynamic segment name to match the existing
// api/[category].js route ([id] would conflict with [category]).
// Vercel injects the segments as req.query.category + req.query.action.
//
//   /api/11061/full          -> full Jikan-style metadata (HxH 2011; valid as both id types)
//   /api/52991/full          -> MAL id lookup (Sousou no Frieren)
//   /api/11061/episodes      -> episode list, 50 per page (AniList max) by default
//   /api/21/episodes?page=2&perPage=10
//
// Query parameters:
//   idType=anilist|mal   force how the numeric id is interpreted
//   page / perPage       episodes pagination (perPage defaults to 50, max 50)
//   refresh=true|1       bypass the 4-hour cache and refetch from AniList
const itemRoute = require("../_lib/item-route");

module.exports = (req, res) => itemRoute(req, res, null);
