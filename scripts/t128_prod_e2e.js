#!/usr/bin/env node
// t128 — production E2E for the three new browse endpoints on
// https://anilist-my-proxy.vercel.app (commit 48960f4, dpl_FVhrvvTnRbfJ1iXUKrB2LF9HG3tt).
//
// Covers: response shapes, filters, cache headers (edge HIT/MISS), param-change
// fresh-fetch behavior, refresh bypass, error handling, alias rewrites, and a
// regression smoke on pre-existing endpoints.
const BASE = "https://anilist-my-proxy.vercel.app";

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; failures.push(name + (extra ? ` :: ${extra}` : "")); console.log(`  ❌ ${name}${extra ? " :: " + extra : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BASE + path, { headers: { Accept: "application/json" } });
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body,
    edge: res.headers.get("x-vercel-cache"),
  };
}

(async () => {
  console.log(`\n=== PROD E2E against ${BASE} ===\n`);

  // Preflight: AniList occasionally disables its API entirely ("severe
  // stability issues", HTTP 403). Wait for recovery (max ~4 min) instead of
  // producing a garbage run.
  for (let i = 1; i <= 8; i++) {
    const probe = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: "query { Page(page:1, perPage:1) { media(id: 1) { id } } }" }),
    });
    const pj = await probe.json().catch(() => null);
    const disabled = !pj || (pj.errors && /disabled/i.test(pj.errors[0]?.message || ""));
    if (!disabled) { console.log(`preflight: AniList healthy (attempt ${i})`); break; }
    console.log(`preflight: AniList disabled/flapping (attempt ${i}) — waiting 30s`);
    if (i === 8) { console.error("AniList still down after 4 min — aborting run (NOT a proxy bug)"); process.exit(3); }
    await sleep(30000);
  }
  console.log("");

  console.log("--- SEASON ---");
  {
    const r = await get("/api/season/winter/2026");
    ok("WINTER/2026 -> 200", r.status === 200, `got ${r.status} ${JSON.stringify(r.body || {}).slice(0, 200)}`);
    ok("data.Page.media[] + pageInfo", Array.isArray(r.body?.data?.Page?.media) && !!r.body?.data?.Page?.pageInfo);
    const m = r.body?.data?.Page?.media?.[0];
    ok("AniList Media shape", !!m && m.id !== undefined && !!m.title?.romaji && !!m.coverImage?.large && m.season === "WINTER" && m.seasonYear === 2026);
    ok("applied.season echo", r.body?.applied?.season === "WINTER" && r.body?.applied?.seasonYear === 2026);
    ok("cache block present (hit flag boolean)", typeof r.body?.cache?.hit === "boolean");
    ok("edge header present", !!r.edge, `x-vercel-cache=${r.edge}`);
    ok("CORS *", r.headers["access-control-allow-origin"] === "*");
    await sleep(400);

    const r2 = await get("/api/season/winter/2026");
    ok("repeat -> edge HIT (cached at CDN)", r2.edge === "HIT", `x-vercel-cache=${r2.edge}`);
    ok("repeat -> same count", r2.body?.count === r.body?.count);
    await sleep(400);

    const r3 = await get("/api/season/winter/2026?perPage=5&sort=SCORE_DESC");
    ok("param change -> 200 fresh variant", r3.status === 200 && r3.body?.cache?.hit === false, `edge=${r3.edge} cache.hit=${r3.body?.cache?.hit}`);
    ok("perPage=5 honored", (r3.body?.count || 0) <= 5);
    const scores = (r3.body?.data?.Page?.media || []).map((x) => x.averageScore || 0);
    ok("SCORE_DESC descending", scores.every((s, i) => i === 0 || scores[i - 1] >= s), JSON.stringify(scores));
    await sleep(400);

    const r4 = await get("/api/season/spring/2025?format=TV&genres=action,comedy&minScore=70&perPage=10");
    ok("filters -> 200", r4.status === 200);
    const ms = r4.body?.data?.Page?.media || [];
    ok("all TV", ms.every((x) => x.format === "TV"));
    ok("all Action|Comedy", ms.every((x) => (x.genres || []).some((g) => g === "Action" || g === "Comedy")));
    ok("all score>=70", ms.every((x) => (x.averageScore || 0) >= 70));
    await sleep(400);

    const rc = await get("/api/season/current");
    ok("/current -> FALL 2026 (JST)", rc.status === 200 && rc.body?.applied?.season === "FALL" && rc.body?.applied?.seasonYear === 2026, JSON.stringify(rc.body?.applied || {}));
    await sleep(400);

    const ru = await get("/api/season");
    ok("/api/season bare -> usage doc", ru.status === 200 && !!ru.body?.usage && Array.isArray(ru.body?.usage?.sorts));
    await sleep(400);

    const rb1 = await get("/api/season/notaseason/2026");
    ok("bad season -> 400", rb1.status === 400 && rb1.body?.data?.Page === null);
    const rb2 = await get("/api/season/winter/abcd");
    ok("bad year -> 400", rb2.status === 400);
    const rb3 = await get("/api/season/winter/2026?format=TELEVISION");
    ok("bad format -> 400 (local validation)", rb3.status === 400 && /Allowed:/.test(rb3.body?.error || ""));
    const rb4 = await get("/api/season/winter/2026?sort=NOT_A_SORT");
    ok("bad sort -> falls back to POPULARITY_DESC (lenient)", rb4.status === 200 && rb4.body?.applied?.sort?.[0] === "POPULARITY_DESC");
    await sleep(400);

    const rf = await get("/api/season/winter/2026?refresh=1&perPage=3");
    ok("refresh=1 -> 200 + cache.hit=false", rf.status === 200 && rf.body?.cache?.hit === false, `cache.hit=${rf.body?.cache?.hit}`);
  }

  console.log("--- STUDIO ---");
  {
    const r = await get("/api/studio/bones");
    ok("bones -> 200", r.status === 200, `got ${r.status}`);
    const st = r.body?.data?.Studio;
    ok("data.Studio + media.edges{isMainStudio,node}", !!st?.id && Array.isArray(st?.media?.edges) && typeof st?.media?.edges?.[0]?.isMainStudio === "boolean" && st.media.edges[0].node?.id !== undefined);
    ok("full AniList Media node", !!st?.media?.edges?.[0]?.node?.title?.romaji && !!st?.media?.edges?.[0]?.node?.coverImage?.large);
    ok("studio meta (favourites/isAnimationStudio/siteUrl)", st ? (st.favourites !== undefined && typeof st.isAnimationStudio === "boolean" && /anilist\.co\/studio/.test(st.siteUrl || "")) : false, "Studio null (upstream outage?)");
    await sleep(400);

    const r2 = await get("/api/studio/bones");
    ok("repeat -> edge HIT", r2.edge === "HIT", `x-vercel-cache=${r2.edge}`);

    const r3 = await get("/api/studio/bones?isMain=true&sort=START_DATE_DESC&perPage=5");
    ok("isMain+sort variant -> fresh (edge MISS)", r3.status === 200 && r3.body?.cache?.hit === false && r3.edge !== "HIT", `edge=${r3.edge}`);
    ok("perPage=5 + applied.isMain", (r3.body?.count || 0) <= 5 && r3.body?.applied?.isMain === true);
    await sleep(400);

    const r4 = await get("/api/studio/4");
    ok("numeric id /4 -> bones", r4.status === 200 && /bones/i.test(r4.body?.data?.Studio?.name || ""));
    await sleep(400);

    const r5 = await get("/api/studio/kyoto-animation");
    ok("kebab-case resolves", r5.status === 200 && /kyoto/i.test(r5.body?.data?.Studio?.name || ""), r5.body?.error);
    await sleep(400);

    const r6 = await get("/api/studio/Xyzzy%20Nonexistent%20Studio%2099999");
    ok("not found -> 404 + data.Studio null", r6.status === 404 && r6.body?.data?.Studio === null && r6.body?.ok === false);
    ok("404 no-store", (r6.headers["cache-control"] || "").includes("no-store"));
  }

  console.log("--- STAFF + ALIASES ---");
  {
    const r = await get(`/api/staff/${encodeURIComponent("Yoshitsugu Matsuoka")}`);
    ok("Matsuoka -> 200", r.status === 200, `got ${r.status}`);
    const st = r.body?.data?.Staff;
    ok("data.Staff profile", !!st?.id && !!st?.name?.full && !!st?.image?.large && Array.isArray(st?.primaryOccupations));
    ok("characterMedia edges (role+characters+node)", Array.isArray(st?.characterMedia?.edges) && st.characterMedia.edges.length > 0 && typeof st.characterMedia.edges[0].characterRole === "string" && Array.isArray(st.characterMedia.edges[0].characters) && st.characterMedia.edges[0].node?.id !== undefined);
    ok("character has name+image", !!st.characterMedia.edges[0].characters[0]?.name?.full && !!st.characterMedia.edges[0].characters[0]?.image?.large);
    ok("staffMedia credits present", Array.isArray(st?.staffMedia?.edges) && st.staffMedia.edges.length > 0 && typeof st.staffMedia.edges[0].staffRole === "string");
    await sleep(400);

    const r2 = await get(`/api/staff/${encodeURIComponent("Yoshitsugu Matsuoka")}?mainRoles=true&perPage=10`);
    ok("mainRoles -> all MAIN edges", r2.status === 200 && (r2.body?.data?.Staff?.characterMedia?.edges || []).every((e) => e.characterRole === "MAIN"));
    ok("mainRoles -> honest pagination_note", /LOCAL filter/.test(r2.body?.pagination_note || ""));
    await sleep(400);

    const r3 = await get("/api/staff/106817");
    ok("numeric id -> same person", r3.status === 200 && r3.body?.data?.Staff?.name?.full === "Yoshitsugu Matsuoka");
    await sleep(400);

    const r4 = await get("/cast/Rie%20Takahashi");
    ok("/cast rewrite -> 200", r4.status === 200 && !!r4.body?.data?.Staff?.id, `got ${r4.status} ${JSON.stringify(r4.body || {}).slice(0, 150)}`);
    ok("/cast servedAs echo", r4.body?.servedAs === "cast" || r4.body?.cache?.hit === true, `servedAs=${r4.body?.servedAs}`); // servedAs on fresh; frozen body keeps it on edge hit
    await sleep(400);

    const r5 = await get("/voice-actors/yoshitsugu-matsuoka");
    ok("/voice-actors kebab rewrite -> 200 same person", r5.status === 200 && r5.body?.data?.Staff?.name?.full === "Yoshitsugu Matsuoka", r5.body?.error);
    await sleep(400);

    const r6 = await get("/api/staff/Zzzqq%20Notaperson%20424242");
    ok("staff not found -> 404 + data.Staff null", r6.status === 404 && r6.body?.data?.Staff === null);
  }

  console.log("--- DOCS + REGRESSION SMOKE ---");
  {
    const idx = await get("/api");
    ok("/api -> version 1.5.0", idx.body?.version === "1.5.0");
    ok("browseEndpoints documented (3)", Array.isArray(idx.body?.browseEndpoints) && idx.body.browseEndpoints.length === 3);

    const sch = await get("/api/schedule/all");
    ok("regression: /api/schedule/all still 200", sch.status === 200 && sch.body?.ok === true && !!sch.body?.data?.Page?.days, `got ${sch.status}`);
    await sleep(400);

    const cat = await get("/api/currently-airing?perPage=3");
    ok("regression: /api/currently-airing still 200", cat.status === 200 && cat.body?.ok === true && (cat.body?.data || []).length > 0, `got ${cat.status}`);

    const root = await fetch(BASE + "/");
    ok("regression: / still serves landing", root.status === 200);
  }

  console.log(`\n========== PROD RESULT: ${PASS} pass, ${FAIL} fail ==========`);
  if (FAIL) { failures.forEach((f) => console.log("  FAIL: " + f)); process.exit(1); }
})().catch((e) => { console.error("E2E CRASH:", e); process.exit(2); });
