// GET /api/{category}/{action} catch-all — serves the generic numeric-item
// routes (/api/{id}/full, /api/{id}/episodes, /api/{id}/relations — see
// _lib/item-route.js) AND delegates the /api/season/{one-segment} shapes:
//
//   /api/season/current      -> current JST season/year (via _lib/season.js)
//   /api/season/winter       -> 400 with the usage hint (missing year)
//
// (The full /api/season/{season}/{year} route is api/season/[season]/[year].js,
// a plain 2-dynamic-segment file — optional catch-alls proved unreliable.)
const itemRoute = require("../_lib/item-route");
const seasonHandler = require("../_lib/season");

module.exports = (req, res) => {
  if (req.query.category === "season") {
    return seasonHandler(req, res, req.query.action ? [req.query.action] : []);
  }
  return itemRoute(req, res, null);
};
