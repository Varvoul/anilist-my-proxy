// GET /api/season/{season}/{year}
// Thin wrapper — ALL season logic lives in api/_lib/season.js so the
// /api/season/current shape can be served by the same code through the
// api/[category]/[action].js catch-all without costing another serverless
// function (this deployment sits at the Vercel Hobby 12-function cap).
//
// ROUTING LESSON (2026-10-21, live prod): an api/season/[[...params]].js
// optional catch-all worked right after deploy, then Vercel's router began
// answering NOT_FOUND for every 2-segment path on the SAME deployment —
// plain [param] segment files (schedule/[day], studio/[studio], staff/[staff])
// never exhibited this. Keep this route boring.
const seasonHandler = require("../../_lib/season");

module.exports = (req, res) => seasonHandler(req, res, [req.query.season, req.query.year]);
