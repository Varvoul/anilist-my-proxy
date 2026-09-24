// Unit tests for computeExactPagination — pure logic, mock probe, no network.
// Run: node scripts/test-pagination.js
const { computeExactPagination, ANILIST_PAGE_CAP } = require("../api/_lib/anilist");

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${extra ? " :: " + JSON.stringify(extra) : ""}`); }
}

// Build a mock probe: describe the dataset as pages 1..lastPageFull (full) +
// one partial page (lastPartial with `partialCount` items). Any page beyond → 0.
function mockDataset(pp, lastPageFull, partialCount, failAfter = Infinity) {
  let calls = 0;
  const probePage = async (vars, page) => {
    calls++;
    if (calls > failAfter) return { ok: false, error: "mock outage" };
    if (page < 1 || page > lastPageFull + (partialCount > 0 ? 1 : 0)) return { ok: true, count: 0 };
    if (page <= lastPageFull) return { ok: true, count: pp };
    return { ok: true, count: partialCount };
  };
  return { probePage, getCalls: () => calls };
}

(async () => {
  const pp = 20;

  // ---- 1. Partial page = authoritative end (airing p9: 11 items -> 171/9/false)
  {
    const ds = mockDataset(pp, 8, 11);
    const r = await computeExactPagination(
      { total: 171, currentPage: 9, lastPage: 9, hasNextPage: false, perPage: pp },
      new Array(11).fill({ id: 1 }),
      { page: 9, perPage: pp },
      ds.probePage
    );
    check("partial page: total", r.pagination.total === 171, r.pagination);
    check("partial page: lastPage", r.pagination.lastPage === 9, r.pagination);
    check("partial page: hasNextPage false", r.pagination.hasNextPage === false);
    check("partial page: zero probes", r.probes === 0, r.probes);
    check("partial page: shape (5 keys)", Object.keys(r.pagination).sort().join(",") === "currentPage,hasNextPage,lastPage,perPage,total");
  }

  // ---- 2. Full page + hasNextPage=true, mid-dataset (upcoming p1, end at 248 full + 13 partial)
  {
    const ds = mockDataset(pp, 247, 13); // pages 1..247 full, 248 has 13
    const r = await computeExactPagination(
      { total: 5000, currentPage: 1, lastPage: 250, hasNextPage: true, perPage: pp },
      new Array(pp).fill({ id: 1 }),
      { page: 1, perPage: pp },
      ds.probePage
    );
    check("full page bisect: total", r.pagination.total === 247 * pp + 13, r.pagination);
    check("full page bisect: lastPage", r.pagination.lastPage === 248, r.pagination);
    check("full page bisect: hasNextPage true", r.pagination.hasNextPage === true);
    check("full page bisect: probe count sane", r.probes <= 9 && r.probes >= 5, r.probes);
  }

  // ---- 3. Full page + hasNextPage=false (total is exact multiple of perPage)
  {
    const ds = mockDataset(pp, 5, 0);
    const r = await computeExactPagination(
      { total: 5000, currentPage: 5, lastPage: 250, hasNextPage: false, perPage: pp },
      new Array(pp).fill({ id: 1 }),
      { page: 5, perPage: pp },
      ds.probePage
    );
    check("full+Hfalse: total", r.pagination.total === 100, r.pagination);
    check("full+Hfalse: lastPage", r.pagination.lastPage === 5, r.pagination);
    check("full+Hfalse: zero probes", r.probes === 0);
  }

  // ---- 4. Empty page past the end (upcoming p250) -> bisect backward
  {
    const ds = mockDataset(pp, 247, 13);
    const r = await computeExactPagination(
      { total: 4980, currentPage: 250, lastPage: 250, hasNextPage: false, perPage: pp },
      [],
      { page: 250, perPage: pp },
      ds.probePage
    );
    check("empty page: total", r.pagination.total === 247 * pp + 13, r.pagination);
    check("empty page: lastPage", r.pagination.lastPage === 248, r.pagination);
    check("empty page: hasNextPage false", r.pagination.hasNextPage === false);
  }

  // ---- 5. Empty page 1 (empty category)
  {
    const ds = mockDataset(pp, 0, 0);
    const r = await computeExactPagination(
      { total: 0, currentPage: 1, lastPage: 1, hasNextPage: false, perPage: pp },
      [],
      { page: 1, perPage: pp },
      ds.probePage
    );
    check("empty category: 0/0/false", r.pagination.total === 0 && r.pagination.lastPage === 0 && r.pagination.hasNextPage === false, r.pagination);
    check("empty category: zero probes", r.probes === 0);
  }

  // ---- 6. Full page at the hard cap (N=250, hasNextPage=true) -> no probes, cap values
  {
    const ds = mockDataset(pp, ANILIST_PAGE_CAP, 0);
    const r = await computeExactPagination(
      { total: 5000, currentPage: 250, lastPage: 250, hasNextPage: true, perPage: pp },
      new Array(pp).fill({ id: 1 }),
      { page: 250, perPage: pp },
      ds.probePage
    );
    check("cap page: total", r.pagination.total === ANILIST_PAGE_CAP * pp, r.pagination);
    check("cap page: lastPage", r.pagination.lastPage === ANILIST_PAGE_CAP, r.pagination);
    check("cap page: hasNextPage true", r.pagination.hasNextPage === true);
    check("cap page: zero probes", r.probes === 0);
  }

  // ---- 7. Probe outage mid-bisect -> throws (caller must fall back to raw)
  {
    const ds = mockDataset(pp, 247, 13, 2); // fails from 3rd probe on
    let threw = false;
    try {
      await computeExactPagination(
        { total: 5000, currentPage: 1, lastPage: 250, hasNextPage: true, perPage: pp },
        new Array(pp).fill({ id: 1 }),
        { page: 1, perPage: pp },
        ds.probePage
      );
    } catch (e) { threw = true; }
    check("probe outage: throws for fallback", threw);
  }

  // ---- 8. Contradictory pageInfo: partial page but hasNextPage=true -> throws
  {
    const ds = mockDataset(pp, 8, 11);
    let threw = false;
    try {
      await computeExactPagination(
        { total: 5000, currentPage: 9, lastPage: 250, hasNextPage: true, perPage: pp },
        new Array(11).fill({ id: 1 }),
        { page: 9, perPage: pp },
        ds.probePage
      );
    } catch (e) { threw = true; }
    check("contradictory partial+Htrue: throws", threw);
  }

  // ---- 9. Contradictory: full page, H=true, but every later page empty -> throws
  {
    const ds = mockDataset(pp, 1, 0); // only page 1 has data
    let threw = false;
    try {
      await computeExactPagination(
        { total: 5000, currentPage: 1, lastPage: 250, hasNextPage: true, perPage: pp },
        new Array(pp).fill({ id: 1 }),
        { page: 1, perPage: pp },
        ds.probePage
      );
    } catch (e) { threw = true; }
    check("contradictory Htrue+empty-later: throws", threw);
  }

  // ---- 10. Deep empty page probe count is bounded (~log2)
  {
    const ds = mockDataset(pp, 247, 13);
    await computeExactPagination(
      { total: 4980, currentPage: 250, lastPage: 250, hasNextPage: false, perPage: pp },
      [],
      { page: 250, perPage: pp },
      ds.probePage
    );
    check("empty p250: probes <= 9", ds.getCalls() <= 9, ds.getCalls());
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
