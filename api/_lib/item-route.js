// api/_lib/item-route.js
// Shared handler for the three item-level route files:
//   api/[category]/[action].js   -> /api/{id}/full|episodes|relations            (auto-detect)
//   api/mal/[id]/[action].js     -> /api/mal/{mal_id}/full|episodes|relations    (forced source)
//   api/anilist/[id]/[action].js -> /api/anilist/{anilist_id}/...                (forced source)
//
// Vercel injects path segments as req.query.* : [id] -> req.query.id,
// [category] -> req.query.category, [action] -> req.query.action.
const { handleFull, handleEpisodes, handleRelations } = require("./media");
const { jsonResponse } = require("./anilist");

module.exports = async function itemRoute(req, res, source) {
  // source: null (generic route, auto-detect) | "mal" | "anilist"
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return;
  }

  // HEAD is treated like GET (Node suppresses the body automatically), so
  // cache headers / CORS are consistent for HEAD probes too.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return jsonResponse(res, 405, {
      ok: false,
      error: "Method not allowed. Use GET.",
    });
  }

  const idRaw =
    (req.query && (req.query.id ?? req.query.category)) ||
    (req.params && (req.params.id ?? req.params.category)) ||
    "";
  const actionRaw =
    (req.query && req.query.action) || (req.params && req.params.action) || "";
  const action = String(actionRaw).toLowerCase();

  // Friendly nudge when someone uses the source word where an id is expected
  // (e.g. /api/mal/full — the id was forgotten on the explicit-source routes).
  if (!source && (idRaw === "mal" || idRaw === "anilist")) {
    return jsonResponse(res, 400, {
      ok: false,
      status: 400,
      error: `Missing anime id after "/api/${idRaw}".`,
      hint:
        `Explicit-source routes look like /api/${idRaw}/{id}/full, /api/${idRaw}/{id}/episodes and /api/${idRaw}/{id}/relations ` +
        `(e.g. /api/${idRaw === "mal" ? "mal" : "anilist"}/${idRaw === "mal" ? "52991" : "154587"}/full). ` +
        `Or use the auto-detecting /api/{id}/full with a numeric id.`,
    });
  }

  const id = Number.parseInt(idRaw, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse(res, 400, {
      ok: false,
      status: 400,
      error: `Invalid anime id: "${idRaw}".`,
      hint: source
        ? `Provide a positive integer ${source === "mal" ? "MyAnimeList" : "AniList"} id. Example: /api/${source}/11061/full`
        : "Provide a positive integer — either a MyAnimeList id or an AniList id. Example: /api/11061/full. Explicit-source routes: /api/mal/{mal_id}/full and /api/anilist/{anilist_id}/full.",
    });
  }

  if (action === "full") return handleFull(req, res, id, source);
  if (action === "episodes") return handleEpisodes(req, res, id, source);
  if (action === "relations") return handleRelations(req, res, id, source);

  return jsonResponse(res, 404, {
    ok: false,
    status: 404,
    error: `Unknown action: "${actionRaw}".`,
    validActions: ["full", "episodes", "relations"],
    hint:
      `Try /api/${source ? `${source}/{id}` : "{id}"}/full for full anime metadata, ` +
      `/api/${source ? `${source}/{id}` : "{id}"}/episodes for the episode list, or ` +
      `/api/${source ? `${source}/{id}` : "{id}"}/relations for prequel/sequel/all related entries. ` +
      "Visit /api for all endpoints.",
  });
};
