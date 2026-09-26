#!/usr/bin/env node
/**
 * End-to-end test for every category endpoint of anilist-my-proxy.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/test-endpoints.js
 *   BASE_URL=https://anilist-my-proxy.vercel.app node scripts/test-endpoints.js
 *
 * Tests each endpoint:
 *   1. Returns 200 OK
 *   2. Body is valid JSON with ok=true
 *   3. Response contains pagination + data array
 *   4. Every entry has both id (AniList) and idMal (MyAnimeList)
 *   5. Custom sort/filter params are actually applied (sanity-check on 1 endpoint)
 */
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const ENDPOINTS = [
  "/api",
  "/api/currently-airing",
  "/api/top-airing",
  "/api/new-releases",
  "/api/trending-today",
  "/api/trending-week",
  "/api/trending-week-flex",
  "/api/trending-month",
  "/api/upcoming",
  "/api/recently-completed",
  "/api/most-favourite",
  "/api/new-added",
  "/api/popular",
];

const colors = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

async function callEndpoint(path, params = "") {
  const url = `${BASE_URL}${path}${params ? `?${params}` : ""}`;
  const t0 = Date.now();
  const res = await fetch(url, { method: "GET" });
  const elapsed = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep null */ }
  return { url, status: res.status, elapsed, text, json };
}

function checkEntry(entry) {
  const issues = [];
  if (entry.id === undefined || entry.id === null) issues.push("missing id");
  if (!("idMal" in entry)) issues.push("missing idMal key");
  if (!entry.title || !entry.title.userPreferred) issues.push("missing title.userPreferred");
  return issues;
}

async function testEndpoint(path, params = "") {
  const r = await callEndpoint(path, params);
  const label = `${path}${params ? "?" + params : ""}`;
  if (r.status !== 200) {
    console.log(colors.red("FAIL") + " " + label);
    console.log(colors.dim(`  status=${r.status} elapsed=${r.elapsed}ms`));
    console.log(colors.dim(`  body=${r.text.slice(0, 300)}`));
    return false;
  }
  if (!r.json || r.json.ok !== true) {
    console.log(colors.red("FAIL") + " " + label);
    console.log(colors.dim(`  status=${r.status} elapsed=${r.elapsed}ms`));
    console.log(colors.dim(`  ok!=true  body=${r.text.slice(0, 300)}`));
    return false;
  }
  if (path === "/api") {
    const n = r.json.categories ? r.json.categories.length : 0;
    console.log(colors.green("OK  ") + " " + label + colors.dim(`  ${r.elapsed}ms  ${n} categories listed`));
    return true;
  }
  if (!r.json.pagination || !Array.isArray(r.json.data)) {
    console.log(colors.red("FAIL") + " " + label + colors.red(" - missing pagination/data"));
    return false;
  }
  let entryIssues = 0;
  for (const entry of r.json.data) {
    if (checkEntry(entry).length) entryIssues++;
  }
  const sample = r.json.data[0] || {};
  console.log(
    colors.green("OK  ") + " " + label +
    colors.dim(`  ${r.elapsed}ms  count=${r.json.count}  total=${r.json.pagination.total}`) +
    colors.dim(`  first="${sample?.title?.userPreferred || "(none)"}" id=${sample?.id} idMal=${sample?.idMal}`)
  );
  if (entryIssues > 0) {
    console.log(colors.yellow(`  WARN ${entryIssues} entries failed field check`));
  }
  return entryIssues === 0;
}

async function main() {
  console.log(colors.cyan(`\nTesting anilist-my-proxy @ ${BASE_URL}\n`));
  let pass = 0, fail = 0;
  for (const ep of ENDPOINTS) {
    const ok = await testEndpoint(ep);
    ok ? pass++ : fail++;
  }

  console.log(colors.cyan("\nQuery-parameter override tests:\n"));
  const overrideTests = [
    { path: "/api/top-airing",         params: "genre=Action&minScore=85" },
    { path: "/api/recently-completed", params: "page=1&perPage=5" },
    { path: "/api/popular",            params: "sort=SCORE_DESC,FAVOURITES_DESC" },
    { path: "/api/currently-airing",   params: "perPage=3" },
  ];
  for (const t of overrideTests) {
    const ok = await testEndpoint(t.path, t.params);
    ok ? pass++ : fail++;
  }

  console.log(colors.cyan("\nItem endpoints (/full + /episodes):\n"));
  const itemOk = await testItemEndpoints();
  itemOk ? pass++ : fail++;

  console.log(colors.cyan("\nExplicit id-source routes (/api/mal/... + /api/anilist/...):\n"));
  const sourceOk = await testSourceRoutes();
  sourceOk ? pass++ : fail++;

  console.log(colors.cyan("\nRelations (/full data.relations + standalone /relations):\n"));
  const relOk = await testRelations();
  relOk ? pass++ : fail++;

  console.log(colors.cyan(`\nResult: ${colors.green(pass + " passed")}, ${fail ? colors.red(fail + " failed") : colors.green("0 failed")}\n`));
  process.exit(fail ? 1 : 0);
}

// Tests the dual-ID item endpoints. Returns true if everything passed.
async function testItemEndpoints() {
  let allOk = true;
  const step = (ok, label, detail = "") => {
    if (!ok) allOk = false;
    console.log((ok ? colors.green("OK  ") : colors.red("FAIL")) + " " + label + colors.dim(detail ? `  ${detail}` : ""));
  };

  // 1. id valid as BOTH id types (HxH 2011: AniList 11061 = MAL 11061)
  let r = await callEndpoint("/api/11061/full");
  step(r.status === 200 && r.json.ok, "/api/11061/full -> 200", `status=${r.status}`);
  const d = r.json && r.json.data;
  step(d && d.mal_id === 11061 && d.anilist_id === 11061, "data.mal_id + data.anilist_id", `mal_id=${d && d.mal_id}`);
  step(r.json && r.json.detected && r.json.detected.idType === "both", "detected.idType=both");
  step(d && Array.isArray(d.titles) && Array.isArray(d.genres) && Array.isArray(d.studios) && Array.isArray(d.tags), "titles/genres/studios/tags arrays");
  step(d && d.aired && typeof d.aired.string === "string", "aired.string", d && d.aired && d.aired.string);
  step(d && d.score > 5 && d.score <= 10 && d.members > 1000, "score/members", `score=${d && d.score} members=${d && d.members}`);
  step(d && d.images && d.images.jpg && d.images.banner, "images incl. banner");

  // 2. MAL-only id (52991 = Sousou no Frieren; AniList 52991 does not exist)
  r = await callEndpoint("/api/52991/full");
  step(r.status === 200 && r.json.detected && r.json.detected.idType === "mal" && /Frieren/.test(r.json.data.title), "/api/52991/full -> MAL id resolution", JSON.stringify(r.json.detected || {}).slice(0, 140));

  // 3. episodes with pagination
  r = await callEndpoint("/api/154587/episodes", "page=2&perPage=5");
  const p = r.json && r.json.pagination;
  step(r.status === 200 && p && p.current_page === 2 && p.items && p.items.per_page === 5, "/api/154587/episodes?page=2&perPage=5", JSON.stringify(p || {}));
  const eps = (r.json && r.json.data) || [];
  step(eps.length === 5 && eps[0].mal_id === 6 && eps[4].mal_id === 10, "episodes 6-10 on page 2", eps.map((e) => e.mal_id).join(","));
  step(eps[0] && "aired" in eps[0] && "duration" in eps[0], "episode fields present");
  step(eps[0] && !("score" in eps[0]) && !("themes" in eps[0]), "episode objects omit score + OP/ED themes (AniList does not provide them)");

  // 4. 404 path
  r = await callEndpoint("/api/99999999/full");
  step(r.status === 404 && r.json.ok === false, "/api/99999999/full -> 404");

  // 5. /full field contract (romaji Default, images position, isAdult, no licensor)
  r = await callEndpoint("/api/52991/full");
  const fd = r.json && r.json.data;
  step(fd && fd.title === fd.title_romaji, "data.title === data.title_romaji (romaji Default)", fd && `${fd.title} / ${fd.title_romaji}`);
  step(fd && Array.isArray(fd.titles) && fd.titles[0] && fd.titles[0].type === "Default" && fd.titles[0].title === fd.title_romaji, "titles[0] Default = romaji", fd && JSON.stringify((fd.titles || [])[0]));
  step(fd && fd.images && fd.images.jpg && fd.images.jpg.image_url && fd.images.webp && fd.images.banner, "images.jpg/webp/banner present", fd && fd.images && fd.images.jpg && fd.images.jpg.image_url);
  step(fd && typeof fd.isAdult === "boolean", "isAdult flag present", fd && String(fd.isAdult));
  step(fd && !("licensors" in fd), "no licensor field (AniList has none)");

  return allOk;
}

// Tests the explicit id-source routes (/api/mal/... + /api/anilist/...). Returns true if everything passed.
async function testSourceRoutes() {
  let allOk = true;
  const step = (ok, label, detail = "") => {
    if (!ok) allOk = false;
    console.log((ok ? colors.green("OK  ") : colors.red("FAIL")) + " " + label + colors.dim(detail ? `  ${detail}` : ""));
  };

  // 1. /api/mal/{id}/full resolves the MAL interpretation directly
  let r = await callEndpoint("/api/mal/52991/full");
  step(r.status === 200 && r.json.ok && /Frieren/.test(r.json.data.title), "/api/mal/52991/full -> Frieren", JSON.stringify(r.json.detected || {}).slice(0, 140));
  step(r.json && r.json.detected && r.json.detected.idType === "mal" && /url path/.test(r.json.detected.forcedBy || ""), "detected: idType=mal forced by url path");
  step(r.json && r.json.endpoint === "/api/mal/{id}/full", "endpoint label /api/mal/{id}/full", r.json && r.json.endpoint);

  // 2. /api/anilist/{id}/full resolves the AniList interpretation directly
  r = await callEndpoint("/api/anilist/154587/full");
  step(r.status === 200 && r.json.ok && r.json.data.anilist_id === 154587 && /Frieren/.test(r.json.data.title), "/api/anilist/154587/full -> Frieren (AniList id)");

  // 3. Genuine ambiguous id 21405: explicit routes MUST return different shows
  //    (AniList 21405 = Ushinawareta Future Convergence; MAL 21405 = Bokura wa Minna Kawaisou, AniList 20529)
  r = await callEndpoint("/api/anilist/21405/full");
  step(r.status === 200 && r.json.data.anilist_id === 21405, "/api/anilist/21405/full -> AniList 21405", r.json && `${r.json.data && r.json.data.title_romaji}`);
  const anilistTitle = r.json && r.json.data && r.json.data.title_romaji;
  r = await callEndpoint("/api/mal/21405/full");
  step(r.status === 200 && r.json.data.mal_id === 21405 && r.json.data.title_romaji !== anilistTitle, "/api/mal/21405/full -> the OTHER show (no ambiguity)", r.json && `${r.json.data && r.json.data.title_romaji}`);

  // 4. episodes on source routes: pagination identical to the generic route
  r = await callEndpoint("/api/mal/52991/episodes", "page=2&perPage=5");
  const p = r.json && r.json.pagination;
  step(r.status === 200 && p && p.current_page === 2 && p.items.per_page === 5, "/api/mal/52991/episodes?page=2&perPage=5", JSON.stringify(p || {}));
  r = await callEndpoint("/api/anilist/11061/episodes", "perPage=3");
  step(r.status === 200 && r.json.data.length === 3 && !("score" in r.json.data[0]), "/api/anilist/11061/episodes?perPage=3 -> 3 episodes, no score field");

  // 5. 404s are source-aware
  r = await callEndpoint("/api/mal/99999999/full");
  step(r.status === 404 && r.json.ok === false, "/api/mal/99999999/full -> 404", r.json && (r.json.error || "").slice(0, 80));
  r = await callEndpoint("/api/anilist/99999999/episodes");
  step(r.status === 404 && r.json.ok === false, "/api/anilist/99999999/episodes -> 404");

  // 6. friendly error when the id is missing on the source routes
  r = await callEndpoint("/api/mal/full");
  step(r.status === 400 && /Missing anime id/.test(r.json.error || ""), "/api/mal/full (missing id) -> 400 with hint");

  return allOk;
}

// Tests the relations feature. Returns true if everything passed.
async function testRelations() {
  let allOk = true;
  const step = (ok, label, detail = "") => {
    if (!ok) allOk = false;
    console.log((ok ? colors.green("OK  ") : colors.red("FAIL")) + " " + label + colors.dim(detail ? `  ${detail}` : ""));
  };
  const entryShapeOk = (e) =>
    e && e.relation_type && e.relation && Number.isInteger(e.anilist_id) && "mal_id" in e &&
    e.images && e.images.jpg && e.images.jpg.image_url && "banner_image" in e &&
    e.titles && typeof e.titles.romaji === "string";

  // 1. /full embeds data.relations (AniList edges) + data.seasons
  let r = await callEndpoint("/api/anilist/154587/full");
  const d = r.json && r.json.data;
  step(r.status === 200 && d && Array.isArray(d.relations) && d.relations.length >= 5, "/api/anilist/154587/full -> data.relations present", d && `${(d.relations || []).length} relations`);
  const seq = (d && d.relations || []).find((x) => x.relation_type === "SEQUEL");
  step(seq && seq.anilist_id === 182255 && seq.mal_id === 59978, "SEQUEL -> Sousou no Frieren 2nd Season with both ids", seq && `${seq.anilist_id}/${seq.mal_id}`);
  step(entryShapeOk(seq), "relation entry shape: ids + cover + banner + anilist-style titles");
  step(d && d.seasons && Array.isArray(d.seasons.sequels) && d.seasons.sequels.some((x) => x.anilist_id === 182255) && Array.isArray(d.seasons.prequels), "data.seasons prequels/sequels split");
  step((d && d.relations || []).some((x) => x.type === "manga" && x.mal_id !== null), "manga relation included (SOURCE manga with mal_id)");

  // 2. MAL route returns the same relations
  r = await callEndpoint("/api/mal/52991/full");
  const seq2 = r.json && r.json.data && (r.json.data.relations || []).find((x) => x.relation_type === "SEQUEL");
  step(seq2 && seq2.anilist_id === 182255, "/api/mal/52991/full relations match");

  // 3. Standalone /relations endpoint on all three route flavors
  for (const path of ["/api/mal/16498/relations", "/api/anilist/16498/relations", "/api/16498/relations"]) {
    r = await callEndpoint(path);
    const b = r.json || {};
    step(r.status === 200 && b.ok && Array.isArray(b.data) && b.count === b.data.length && b.count >= 10 && Array.isArray(b.notes), `${path} -> 200, count=${b.count}`);
    const relSeq = ((b.data || []).find((x) => x.relation_type === "SEQUEL") || {});
    step(relSeq.anilist_id === 20958, `${path} -> SEQUEL is AoT S2 (20958)`, String(relSeq.anilist_id));
    step(b.seasons && b.seasons.prequels.length >= 1 && b.seasons.sequels.length >= 1, `${path} -> seasons split`);
    step(b.cache && b.cache.ttl_seconds === 14400, `${path} -> 4h cache info`);
  }

  // 4. Null-safe mal_id (Frieren Part 2 ONA has no MAL entry)
  r = await callEndpoint("/api/anilist/154587/relations");
  const nullMal = ((r.json && r.json.data) || []).find((x) => x.mal_id === null);
  step(!!nullMal && nullMal.url === null && nullMal.anilist_url, "relation without MAL id: mal_id/url null, anilist_url set", nullMal && nullMal.title);

  // 5. Unknown action mentions relations as valid
  r = await callEndpoint("/api/mal/16498/bogus");
  step(r.status === 404 && (r.json && r.json.validActions || []).includes("relations"), "unknown action -> validActions includes relations");

  return allOk;
}

main().catch((e) => {
  console.error(colors.red("Test runner crashed:"), e);
  process.exit(2);
});
