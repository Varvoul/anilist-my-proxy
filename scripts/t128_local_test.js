#!/usr/bin/env node
// t128 — local end-to-end test of the three new browse endpoints against the
// REAL AniList API, using the same Vercel-style req/query injection as prod
// (path segments arrive as req.query.<param>; catch-all as req.query.params[]).
//
// Usage: node scripts/t128_local_test.js
const assert = require("assert");

const seasonHandler = require("../api/_lib/season.js");
const studioHandler = require("../api/studio/[studio].js");
const staffHandler = require("../api/staff/[staff].js");
const indexHandler = require("../api/index.js");
const catActionHandler = require("../api/[category]/[action].js");

let PASS = 0;
let FAIL = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; failures.push(name + (extra ? ` :: ${extra}` : "")); console.log(`  ❌ ${name}${extra ? " :: " + extra : ""}`); }
}

function makeReq(query) {
  return { method: "GET", url: "http://local/test", query: query || {} };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b; this.ended = true; },
  };
  return res;
}

async function call(handler, query) {
  const res = makeRes();
  await handler(makeReq(query), res);
  let body = null;
  try { body = JSON.parse(res.body); } catch (e) { /* leave null */ }
  return { status: res.statusCode, headers: res.headers, body };
}

// Season lib takes explicit segs (mirrors how Vercel injects path segments:
// [season]/[year].js passes [season, year]; the [category]/[action] catch-all
// passes [action] for 1-segment shapes)
async function callSeason(segs, query) {
  const res = makeRes();
  await seasonHandler(makeReq(query || {}), res, segs);
  let body = null;
  try { body = JSON.parse(res.body); } catch (e) { /* leave null */ }
  return { status: res.statusCode, headers: res.headers, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Preflight: wait out AniList's occasional full-API disablements
  for (let i = 1; i <= 10; i++) {
    const probe = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: "query { Page(page:1, perPage:1) { media(id: 1) { id } } }" }),
    });
    const pj = await probe.json().catch(() => null);
    const disabled = !pj || (pj.errors && /disabled/i.test(pj.errors[0]?.message || ""));
    if (!disabled) { console.log(`preflight: AniList healthy (attempt ${i})`); break; }
    console.log(`preflight: AniList disabled (attempt ${i}) — waiting 30s`);
    if (i === 10) { console.error("AniList still down after 5 min — rerun later (NOT a code bug)"); process.exit(3); }
    await sleep(30000);
  }

  console.log("\n=== SEASON ===");
  {
    const r = await callSeason(["winter", "2026"]);
    ok("WINTER/2026 -> 200", r.status === 200, `got ${r.status}`);
    ok("data.Page present", !!(r.body && r.body.data && r.body.data.Page));
    ok("data.Page.media array", Array.isArray(r.body && r.body.data && r.body.data.Page.media));
    ok("pageInfo present", !!(r.body && r.body.data.Page.pageInfo && r.body.data.Page.pageInfo.total !== undefined));
    const m = (r.body.data.Page.media || [])[0];
    ok("media[0] AniList shape (id/title/coverImage)", !!m && m.id !== undefined && !!m.title && !!m.coverImage);
    ok("applied.season=WINTER, year=2026", r.body.applied.season === "WINTER" && r.body.applied.seasonYear === 2026);
    ok("cache.hit=false on first", r.body.cache.hit === false, JSON.stringify(r.body.cache));
    ok("cache-control edge header", (r.headers["cache-control"] || "").includes("s-maxage=14400"));

    // cache read: exact same request again (in-memory, same process)
    const r2 = await callSeason(["winter", "2026"]);
    ok("repeat -> cache.hit=true", r2.body.cache.hit === true);
    ok("repeat -> same count", r2.body.count === r.body.count);

    // case normalization: /WINTER/2026 shares the same cache entry
    const r3 = await callSeason(["WINTER", "2026"]);
    ok("/WINTER case-insensitive shares cache", r3.body.cache.hit === true);

    // param change -> fresh fetch (new key)
    const r4 = await callSeason(["winter", "2026"], { perPage: "3", sort: "SCORE_DESC" });
    ok("param change -> cache.hit=false", r4.body.cache.hit === false);
    ok("perPage=3 honored", r4.body.count <= 3);
    const scores = (r4.body.data.Page.media || []).map((x) => x.averageScore || 0);
    ok("sort=SCORE_DESC descending", scores.every((s, i) => i === 0 || scores[i - 1] >= s), JSON.stringify(scores));
    ok("applied echoes sort", Array.isArray(r4.body.applied.sort) && r4.body.applied.sort[0] === "SCORE_DESC");

    // filters
    const r5 = await callSeason(["spring", "2025"], { format: "TV", genres: "action,comedy", minScore: "70", perPage: "10" });
    ok("filtered -> 200", r5.status === 200);
    const ms = r5.body.data.Page.media || [];
    ok("all format=TV", ms.every((x) => x.format === "TV"), JSON.stringify([...new Set(ms.map((x) => x.format))]));
    ok("all contain Action or Comedy genre", ms.every((x) => (x.genres || []).some((g) => ["Action", "Comedy"].includes(g))));
    ok("all minScore>=70", ms.every((x) => (x.averageScore || 0) >= 70));

    // nsfw default vs nsfw=true (applied echo only — data diff not assertable reliably)
    const r6 = await callSeason(["fall", "2026"], { nsfw: "true", perPage: "5" });
    ok("nsfw=true applied echo", r6.body.applied.nsfw === true);

    // current
    const rc = await callSeason(["current"]);
    ok("/current via [category]/[action] catch-all too", (await call(catActionHandler, { category: "season", action: "current" })).status === 200);
    ok("/current -> 200", rc.status === 200);
    ok("/current resolves JST season (2026-10 => FALL 2026)", rc.body.applied.season === "FALL" && rc.body.applied.seasonYear === 2026, JSON.stringify(rc.body.applied));
    ok("/current resolvedFrom note", /current/i.test(rc.body.applied.resolvedFrom || ""));

    // usage doc
    const ru = await callSeason([]);
    ok("/api/season bare -> usage 200", ru.status === 200 && !!ru.body.usage);

    // bad requests
    const rb1 = await callSeason(["notaseason", "2026"]);
    ok("bad season -> 400", rb1.status === 400, `got ${rb1.status}`);
    ok("bad season -> data.Page null", rb1.body.data && rb1.body.data.Page === null);
    const rb2 = await callSeason(["winter", "abcd"]);
    ok("bad year -> 400", rb2.status === 400);
    const rb3 = await callSeason(["winter", "1850"]);
    ok("year out of range -> 400", rb3.status === 400);
    const rb4 = await callSeason(["winter", "2026"], { format: "TELEVISION" });
    ok("bad format -> 400 (no upstream burn)", rb4.status === 400 && /Allowed:/.test(rb4.body.error || ""));
    const rb5 = await callSeason(["winter", "2026"], { status: "AIRING" });
    ok("bad status -> 400", rb5.status === 400);
    const rb6 = await callSeason(["winter", "2026", "extra"]);
    ok("too many segments -> 400", rb6.status === 400);
    const rb7 = await callSeason(["winter"]);
    ok("season without year -> 400 usage hint", rb7.status === 400 && /api\/season/.test(rb7.body?.error || ""));
  }

  console.log("\n=== STUDIO ===");
  {
    const r = await call(studioHandler, { studio: "bones" });
    ok("bones -> 200", r.status === 200, `got ${r.status}`);
    const st = r.body && r.body.data && r.body.data.Studio;
    ok("data.Studio present", !!st && st.id !== undefined);
    ok("studio name matched", /bones/i.test(st && st.name || ""));
    ok("media.edges array with isMainStudio + node", Array.isArray(st && st.media && st.media.edges) && st.media.edges.length > 0 && st.media.edges[0].node.id !== undefined && typeof st.media.edges[0].isMainStudio === "boolean");
    ok("media node AniList shape", !!st.media.edges[0].node.title && !!st.media.edges[0].node.coverImage);
    ok("applied.studio identity", r.body.applied.studio === "bones");
    ok("cache miss first", r.body.cache.hit === false);

    const r2 = await call(studioHandler, { studio: "Bones" });
    ok("case-insensitive shares cache", r2.body.cache.hit === true);

    const r3 = await call(studioHandler, { studio: "bones", isMain: "true", sort: "SCORE_DESC", perPage: "5" });
    ok("isMain+sort -> fresh fetch", r3.body.cache.hit === false);
    ok("perPage honored", r3.body.count <= 5);
    ok("applied.isMain=true", r3.body.applied.isMain === true);

    const r4 = await call(studioHandler, { studio: "4" });
    ok("numeric id /4 -> bones", r4.status === 200 && /bones/i.test(r4.body.data.Studio.name));

    const r5 = await call(studioHandler, { studio: "kyoto-animation" });
    ok("kebab-case resolves (dash retry)", r5.status === 200 && /kyoto/i.test(r5.body.data.Studio.name), r5.body.error);
    ok("resolvedBy reports how it resolved", /search|dash/.test(r5.body.applied.resolvedBy || ""), r5.body.applied.resolvedBy);

    const r6 = await call(studioHandler, { studio: "Xyzzy Nonexistent Studio 99999" });
    ok("not found -> 404 + data.Studio null", r6.status === 404 && r6.body.data.Studio === null && r6.body.ok === false, `got ${r6.status}`);
    ok("404 not cached (no-store)", (r6.headers["cache-control"] || "").includes("no-store"));

    const r7 = await call(studioHandler, {});
    ok("missing name -> 400", r7.status === 400);
  }

  console.log("\n=== STAFF ===");
  {
    const r = await call(staffHandler, { staff: "Yoshitsugu Matsuoka" });
    ok("Matsuoka -> 200", r.status === 200, `got ${r.status} ${r.body && r.body.error}`);
    const st = r.body && r.body.data && r.body.data.Staff;
    ok("data.Staff present with name.full", !!st && !!st.name && !!st.name.full);
    ok("profile fields (image/occupations/dob)", !!st.image && Array.isArray(st.primaryOccupations) && !!st.dateOfBirth);
    const cm = st && st.characterMedia;
    ok("characterMedia.edges with role+characters+node", Array.isArray(cm && cm.edges) && cm.edges.length > 0 && typeof cm.edges[0].characterRole === "string" && Array.isArray(cm.edges[0].characters) && cm.edges[0].node.id !== undefined);
    ok("character has name+image", !!cm.edges[0].characters[0].name && !!cm.edges[0].characters[0].image);
    ok("staffMedia present", Array.isArray(st.staffMedia && st.staffMedia.edges));
    ok("cache miss first", r.body.cache.hit === false);

    const r2 = await call(staffHandler, { staff: "yoshitsugu matsuoka" });
    ok("case-insensitive shares cache", r2.body.cache.hit === true);

    const r3 = await call(staffHandler, { staff: "Yoshitsugu Matsuoka", mainRoles: "true", perPage: "8" });
    ok("mainRoles -> fresh fetch", r3.body.cache.hit === false);
    const edges = r3.body.data.Staff.characterMedia.edges;
    ok("mainRoles -> all MAIN", edges.every((e) => e.characterRole === "MAIN"), JSON.stringify([...new Set(edges.map((e) => e.characterRole))]));
    ok("pagination_note honest", /LOCAL filter/.test(r3.body.pagination_note || ""));

    const r4 = await call(staffHandler, { staff: "106817" });
    ok("numeric id -> same person", r4.status === 200 && r4.body.data.Staff.name.full === "Yoshitsugu Matsuoka");

    // alias shape shares the same cache entry (alias excluded from key)
    const r5 = await call(staffHandler, { staff: "Yoshitsugu Matsuoka", alias: "cast" });
    ok("alias=cast shares cache entry", r5.body.cache.hit === true, JSON.stringify(r5.body.cache));
    ok("servedAs echoes cast shape", r5.body.servedAs === "cast", JSON.stringify(r5.body.servedAs));

    const r6 = await call(staffHandler, { staff: "yoshitsugu-matsuoka" });
    ok("kebab-case resolves (dash retry)", r6.status === 200 && !!r6.body.data.Staff.name.full, r6.body.error);

    const r7 = await call(staffHandler, { staff: "Zzzqq Notaperson 424242" });
    ok("not found -> 404 + data.Staff null", r7.status === 404 && r7.body.data.Staff === null, `got ${r7.status}`);

    const r8 = await call(staffHandler, {});
    ok("missing name -> 400", r8.status === 400);
  }

  console.log("\n=== INDEX DOCS ===");
  {
    const r = await call(indexHandler, {});
    ok("version bumped 1.5.0", r.body.version === "1.5.0");
    ok("browseEndpoints listed (3)", Array.isArray(r.body.browseEndpoints) && r.body.browseEndpoints.length === 3);
    const paths = (r.body.browseEndpoints || []).map((x) => x.path).join(",");
    ok("browse paths documented", /season/.test(paths) && /studio/.test(paths) && /staff/.test(paths));
  }

  console.log(`\n========== RESULT: ${PASS} pass, ${FAIL} fail ==========`);
  if (FAIL) { failures.forEach((f) => console.log("  FAIL: " + f)); process.exit(1); }
})().catch((e) => { console.error("HARNESS CRASH:", e); process.exit(2); });
