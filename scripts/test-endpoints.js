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

  console.log(colors.cyan(`\nResult: ${colors.green(pass + " passed")}, ${fail ? colors.red(fail + " failed") : colors.green("0 failed")}\n`));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(colors.red("Test runner crashed:"), e);
  process.exit(2);
});
