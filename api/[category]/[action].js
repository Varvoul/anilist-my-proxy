// GET /api/{id}/full  and  GET /api/{id}/episodes
// Item-level endpoints for a single anime, addressed by either a MyAnimeList
// id or an AniList id (auto-detected — see api/_lib/media.js).
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
//   idType=anilist|mal   force how the numeric id is interpreted (disambiguates
//                        the rare case where the number exists in both databases)
//   page / perPage       episodes pagination (perPage defaults to 50, max 50)
//   refresh=true|1       bypass the 4-hour cache and refetch from AniList
//
// Responses are cached server-side for 4 hours (auto-expiring) and also carry
// CDN cache headers (s-maxage=14400).
const { handleFull, handleEpisodes } = require("../_lib/media");

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return;
  }

  if (req.method !== "GET") {
    const { jsonResponse } = require("../_lib/anilist");
    return jsonResponse(res, 405, {
      ok: false,
      error: "Method not allowed. Use GET.",
    });
  }

  const idRaw = (req.query && req.query.category) || (req.params && req.params.category);
  const actionRaw = (req.query && req.query.action) || (req.params && req.params.action) || "";
  const action = String(actionRaw).toLowerCase();

  const id = Number.parseInt(idRaw, 10);
  if (!Number.isInteger(id) || id <= 0) {
    const { jsonResponse } = require("../_lib/anilist");
    return jsonResponse(res, 400, {
      ok: false,
      status: 400,
      error: `Invalid anime id: "${idRaw}".`,
      hint: "Provide a positive integer — either a MyAnimeList id or an AniList id. Example: /api/11061/full",
    });
  }

  if (action === "full") return handleFull(req, res, id);
  if (action === "episodes") return handleEpisodes(req, res, id);

  const { jsonResponse } = require("../_lib/anilist");
  return jsonResponse(res, 404, {
    ok: false,
    status: 404,
    error: `Unknown action: "${actionRaw}".`,
    validActions: ["full", "episodes"],
    hint:
      "Try /api/{id}/full for full anime metadata or /api/{id}/episodes for the episode list. " +
      "Visit /api for the category endpoints.",
  });
};
