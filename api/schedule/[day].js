// GET /api/schedule/{day}
// Custom "currently airing" broadcast schedule, separated by broadcast day.
//
//   /api/schedule/monday ... /api/schedule/sunday   — one weekday each
//   /api/schedule/today                             — resolves to the current JST weekday
//   /api/schedule/all                               — all seven days in one call (site widget)
//
// DATA SOURCE (owner spec 2026-10-20): AniList's own airingSchedules, NOT a
// weekly template. Every entry is a REAL scheduled broadcast with the TRUE
// episode number (`episode` field) — unlike MAL/Jikan /schedule/{day} where the
// consumer had to GUESS the episode from aired-from week diffs ("count_match")
// and got wrong numbers. Each item follows AniList's AiringSchedule shape
// verbatim: { id, airingAt, timeUntilAiring, episode, media{...} }.
//
// DAY SEMANTICS: "Monday" = the broadcast day in Japan Standard Time
// (UTC+9, no DST) — the same convention AniList's own media.broadcast uses and
// the same one MAL/Jikan schedules use. For each weekday the endpoint serves
// the NEXT occurrence of that JST weekday (today included when today IS that
// weekday). Because every RELEASING anime's next episode is always scheduled
// within the next 7 days, a single rolling window
//       [JST midnight today,  +8 days)
// contains exactly one upcoming airing per weekday per show — so all seven
// days are always populated. Episodes that aired earlier TODAY are still
// listed on today's card (window starts at JST midnight, not "now").
//
// FILTERS / PARAMETERS (all optional):
//   page=1            page number (1-indexed)
//   per_page=500      items per page (1-500; a day rarely exceeds ~60 entries)
//   sort=time         time (default, chronological) | popularity | score | title
//   format=TV         one or comma-separated: TV, TV_SHORT, OVA, ONA, MOVIE, SPECIAL, MUSIC
//   genres=Action     comma-separated AniList genre names, case-insensitive (ANY-match)
//   min_score=75      minimum averageScore (0-100)
//   max_score=100     maximum averageScore (0-100)
//   min_popularity=0  minimum popularity
//   nsfw=false        true/1 to INCLUDE adult entries (default: excluded)
//   refresh=1         bypass the cache read (response is still re-cached)
//
// RESPONSE (AniList format): `data.Page.pageInfo` + `data.Page.airingSchedules`
// exactly like an AniList GraphQL reply, plus the proxy's conventional
// ok/cache/applied meta at the top (same convention as every endpoint here).
// For /all, `data.Page.days` groups the same items per weekday
// ({ monday: [...], ... }) with `data.Page.dayInfo` carrying each day's JST
// date + count.
//
// CACHING (owner spec "ttl cache, proper time you chose"):
//   - Server-side: the raw 8-day AniList window is fetched ONCE and cached in
//     the shared in-memory cache with a 4-hour TTL (same store as the rest of
//     this proxy). Filters/sort/pagination are applied per-request on the
//     cached window, so every filter variant is served from the SAME cached
//     upstream data with zero extra AniList calls.
//   - CDN: s-maxage=7200 + stale-while-revalidate=86400 so Vercel's edge serves
//     repeat requests globally across cold starts. `timeUntilAiring` is
//     recomputed live per request from the cached absolute `airingAt`, but on
//     an EDGE hit it can lag by up to the edge TTL — consumers should prefer
//     the absolute `airingAt` epoch for countdowns.
//   - Freshness note: a 4h/2h TTL means an episode that just aired can keep
//     appearing as "upcoming" for at most that long. Absolute airingAt never
//     lies — render state from it.
const { cacheGet, cacheSet, TTL_MS } = require("../_lib/cache");

const LANDING_PATH = "/api/schedule";
const WINDOW_DAYS = 8;            // rolling window length (days)
const ANILIST_PAGE_SIZE = 50;     // AniList hard cap per page
const MAX_ANILIST_PAGES = 25;     // 25*50 = 1250 entries — far above any real week
const FETCH_TIMEOUT_MS = 15000;

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const JST_OFFSET_SEC = 9 * 3600;  // Asia/Tokyo has no DST — fixed +09:00

const SORTS = {
  time: (a, b) => a.airingAt - b.airingAt,
  popularity: (a, b) => (b.media.popularity || 0) - (a.media.popularity || 0),
  score: (a, b) => (b.media.averageScore || 0) - (a.media.averageScore || 0),
  title: (a, b) => titleOf(a.media).localeCompare(titleOf(b.media)),
};

function titleOf(m) {
  const t = m && m.title;
  return (t && (t.romaji || t.english || t.userPreferred || t.native)) || "";
}

// -----------------------------------------------------------------------------
// JST helpers
// -----------------------------------------------------------------------------
// Epoch (seconds) of JST midnight "today". Adding JST_OFFSET shifts the frame
// so plain UTC getters read JST wall-clock; subtracting it converts back.
function jstMidnightTodaySec(nowMs) {
  const shifted = new Date((nowMs || Date.now()) + JST_OFFSET_SEC * 1000);
  const midnightShiftedMs = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()
  );
  return Math.floor((midnightShiftedMs - JST_OFFSET_SEC * 1000) / 1000);
}

// 0=monday .. 6=sunday for an epoch (seconds) interpreted in JST.
function jstWeekdayIndex(epochSec) {
  const shifted = new Date((epochSec + JST_OFFSET_SEC) * 1000);
  return (shifted.getUTCDay() + 6) % 7;
}

// "YYYY-MM-DD" (JST calendar date) for an epoch (seconds).
function jstDateStr(epochSec) {
  return new Date((epochSec + JST_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

// Epoch (seconds) of the next occurrence of `dayIdx` (0=mon) at/after `fromSec`.
function nextOccurrenceSec(dayIdx, fromSec) {
  for (let i = 0; i < 8; i++) {
    const t = fromSec + i * 86400;
    if (jstWeekdayIndex(t) === dayIdx) return t;
  }
  return fromSec;
}

// -----------------------------------------------------------------------------
// AniList GraphQL client (self-contained; mirrors _lib/anilist postGraphql)
// -----------------------------------------------------------------------------
const SCHEDULE_QUERY = `
query ($start: Int, $end: Int, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
      id
      airingAt
      episode
      media {
        id
        idMal
        title { romaji english native userPreferred }
        description(asHtml: false)
        coverImage { extraLarge large medium color }
        bannerImage
        format
        status
        episodes
        duration
        season
        seasonYear
        countryOfOrigin
        averageScore
        meanScore
        popularity
        favourites
        genres
        isAdult
        studios(isMain: true) { nodes { id name } }
        siteUrl
        trailer { id site thumbnail }
        nextAiringEpisode { airingAt episode timeUntilAiring }
      }
    }
  }
}
`;

async function postGraphql(variables) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "anilist-my-proxy/1.0 (+vercel)",
      },
      body: JSON.stringify({ query: SCHEDULE_QUERY, variables }),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`AniList returned non-JSON response (status ${res.status}): ${text.slice(0, 160)}`);
    }
    if (!res.ok || (data.errors && data.errors.length)) {
      const msg = (data.errors && data.errors[0] && data.errors[0].message) || `AniList HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data.data;
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------------------------------------------------------
// Rolling-window fetch + cache
// -----------------------------------------------------------------------------
const WINDOW_KEY = "schedule_window_v1";

async function fetchWindowItems(startSec, endSec) {
  // ⚠️ AniList's pageInfo for airingSchedules reports CAPPED garbage
  // (total=5000, lastPage=100) regardless of the real data size (~3 pages per
  // 8-day window), so lastPage must NEVER be trusted here. Instead: fetch page
  // 1 alone, then small batches of 3 sequential pages, stopping as soon as a
  // batch ends on a partial (<50) or empty page. A real 8-day window converges
  // in 3-4 requests total, which also keeps us far below AniList's rate limit
  // (a naive trust-lastPage loop fires ~99 parallel requests and gets 429'd).
  const all = [];
  let fetchedUpTo = 0;
  let exhausted = false;
  let sawAnyEntries = false;

  while (!exhausted && fetchedUpTo < MAX_ANILIST_PAGES) {
    const batchSize = fetchedUpTo === 0 ? 1 : 3;
    const batch = [];
    for (let i = 1; i <= batchSize; i++) batch.push(fetchedUpTo + i);

    const results = await Promise.allSettled(
      batch.map((p) => postGraphql({ start: startSec, end: endSec, page: p, perPage: ANILIST_PAGE_SIZE }))
    );
    fetchedUpTo += batch.length;

    const okResults = results.filter((r) => r.status === "fulfilled");
    if (!okResults.length) {
      if (!sawAnyEntries) throw new Error("AniList schedule fetch failed: all pages in first batch errored");
      break; // transient failure mid-walk — keep what we have
    }
    for (const r of okResults) {
      const scheds = (r.value && r.value.Page && r.value.Page.airingSchedules) || [];
      all.push(...scheds);
      if (scheds.length) sawAnyEntries = true;
    }

    const last = okResults[okResults.length - 1];
    const lastCount = ((last.value && last.value.Page && last.value.Page.airingSchedules) || []).length;
    const lastHasNext = !!(last.value && last.value.Page && last.value.Page.pageInfo && last.value.Page.pageInfo.hasNextPage);
    if (lastCount < ANILIST_PAGE_SIZE || !lastHasNext) exhausted = true;
    else if (!exhausted) await new Promise((r) => setTimeout(r, 250)); // pace between rounds
  }

  // Sanity: an 8-day window always contains scheduled broadcasts. An empty
  // result means upstream misbehaved — fail instead of caching a poison pill.
  if (!all.length) throw new Error("AniList schedule window came back empty");

  // Chronological order + drop malformed/duplicate schedule entries.
  all.sort((a, b) => (a.airingAt || 0) - (b.airingAt || 0));
  const seen = new Set();
  const out = [];
  for (const it of all) {
    if (!it || !it.media || !it.media.id) continue;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

// Returns the cached window { items, fetchedAt, start, end, hit } — throws on
// upstream failure (handler converts to 500 with no-store).
async function getWindow(refresh) {
  if (!refresh) {
    const cached = cacheGet(WINDOW_KEY);
    if (cached && Array.isArray(cached.items) && cached.items.length) {
      return { ...cached, hit: true };
    }
  }
  // AniList airingAt_greater is STRICT — queried as-is, an entry airing at
  // exactly 00:00:00 JST (a very common late-night broadcast slot, e.g. BLEACH)
  // would fall outside the window of the very day it belongs to. Pull the
  // query start back by 1 second so the midnight instant is included; the
  // weekday grouping (jstWeekdayIndex) still buckets it correctly.
  const winStart = jstMidnightTodaySec(Date.now());
  const startSec = winStart - 1;
  const endSec = winStart + WINDOW_DAYS * 86400;
  const items = await fetchWindowItems(startSec, endSec);
  const win = { items, fetchedAt: Date.now(), start: winStart, end: endSec };
  cacheSet(WINDOW_KEY, win);
  return { ...win, hit: false };
}

function windowCacheInfo(win) {
  const builtAt = win.fetchedAt || Date.now();
  const expiresAt = builtAt + TTL_MS;
  const now = Date.now();
  return {
    enabled: true,
    layer: "schedule-window (8-day AniList airingSchedules; filters are applied per-request on this cached window)",
    key: WINDOW_KEY,
    hit: !!win.hit,
    cached_at: new Date(builtAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    age_seconds: Math.max(0, Math.floor((now - builtAt) / 1000)),
    ttl_seconds: Math.max(0, Math.floor((expiresAt - now) / 1000)),
    ttl_total_seconds: Math.floor(TTL_MS / 1000),
    window_start: new Date(win.start * 1000).toISOString(),
    window_end: new Date(win.end * 1000).toISOString(),
    window_entries: win.items.length,
    edge: "exact-URL edge cache (s-maxage=7200, stale-while-revalidate=86400); ?refresh=1 bypasses both reads",
  };
}

// -----------------------------------------------------------------------------
// Per-request shaping (dedup → filter → sort → paginate) on the cached window
// -----------------------------------------------------------------------------
// One airing per media per weekday: the earliest in the window (= the upcoming
// broadcast for that weekday; for today's weekday it keeps episodes that aired
// earlier today, since the window starts at JST midnight).
function itemsForDay(win, dayIdx) {
  const byMedia = new Map();
  for (const it of win.items) {
    if (jstWeekdayIndex(it.airingAt) !== dayIdx) continue;
    const key = it.media.id;
    const prev = byMedia.get(key);
    if (!prev || it.airingAt < prev.airingAt) byMedia.set(key, it);
  }
  return [...byMedia.values()];
}

function applyFilters(items, q) {
  let out = items;
  const nsfw = q.nsfw === "true" || q.nsfw === "1" || q.adult === "true" || q.adult === "1";
  if (!nsfw) out = out.filter((it) => !it.media.isAdult);

  if (q.format) {
    const wanted = new Set(
      String(q.format).toUpperCase().split(",").map((s) => s.trim()).filter(Boolean)
    );
    out = out.filter((it) => wanted.has(String(it.media.format || "").toUpperCase()));
  }

  if (q.genres) {
    const wanted = String(q.genres)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (wanted.length) {
      out = out.filter((it) =>
        (it.media.genres || []).some((g) => wanted.includes(String(g).toLowerCase()))
      );
    }
  }

  const minScore = parseInt(q.min_score || q.minScore, 10);
  if (Number.isFinite(minScore)) {
    out = out.filter((it) => (it.media.averageScore || 0) >= minScore);
  }
  const maxScore = parseInt(q.max_score || q.maxScore, 10);
  if (Number.isFinite(maxScore)) {
    out = out.filter((it) => (it.media.averageScore || 0) <= maxScore);
  }
  const minPop = parseInt(q.min_popularity || q.minPopularity, 10);
  if (Number.isFinite(minPop)) {
    out = out.filter((it) => (it.media.popularity || 0) >= minPop);
  }
  return out;
}

function sortItems(items, q) {
  const key = String(q.sort || "time").toLowerCase();
  const cmp = SORTS[key] || SORTS.time;
  return items.slice().sort(cmp);
}

// Fresh AiringSchedule objects (cached raw entries are never mutated;
// timeUntilAiring is recomputed live from the absolute airingAt).
function toAiringSchedule(it) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: it.id,
    airingAt: it.airingAt,
    timeUntilAiring: Math.max(0, (it.airingAt || 0) - nowSec),
    episode: it.episode,
    media: it.media,
  };
}

function paginate(items, q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const perPage = Math.min(500, Math.max(1, parseInt(q.per_page || q.perPage, 10) || 500));
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return {
    slice,
    pageInfo: {
      total,
      perPage,
      currentPage: page,
      lastPage,
      hasNextPage: page < lastPage,
    },
  };
}

function appliedEcho(q) {
  return {
    day: q.__day || undefined,
    page: Math.max(1, parseInt(q.page, 10) || 1),
    per_page: Math.min(500, Math.max(1, parseInt(q.per_page || q.perPage, 10) || 500)),
    sort: String(q.sort || "time").toLowerCase(),
    format: q.format || null,
    genres: q.genres || null,
    min_score: q.min_score || q.minScore || null,
    max_score: q.max_score || q.maxScore || null,
    min_popularity: q.min_popularity || q.minPopularity || null,
    nsfw: q.nsfw === "true" || q.nsfw === "1" || q.adult === "true" || q.adult === "1",
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return respond(res, 405, { ok: false, endpoint: LANDING_PATH, error: "Method not allowed. Use GET." }, "no-store");
  }

  const q = req.query || {};
  const refresh = String(q.refresh || "") === "1" || String(q.refresh || "").toLowerCase() === "true";

  // Resolve the requested day.
  const rawDay = String(req.query.day || "").toLowerCase();
  let day = rawDay;
  if (day === "today") {
    day = DAYS[jstWeekdayIndex(jstMidnightTodaySec(Date.now()))];
  }
  const isAll = day === "all";
  if (!isAll && !DAYS.includes(day)) {
    return respond(res, 400, {
      ok: false,
      endpoint: LANDING_PATH,
      error: `Invalid day "${q.day || ""}". Use one of: ${DAYS.join(", ")}, today, all.`,
    }, "no-store");
  }
  q.__day = day;

  try {
    const win = await getWindow(refresh);
    const cache = windowCacheInfo(win);
    const cacheCtl = "public, max-age=60, s-maxage=7200, stale-while-revalidate=86400";

    if (isAll) {
      // ── /api/schedule/all — all seven days, grouped ──
      const days = {};
      const dayInfo = {};
      let grandTotal = 0;
      for (let i = 0; i < 7; i++) {
        const name = DAYS[i];
        const filtered = sortItems(applyFilters(itemsForDay(win, i), q), q);
        days[name] = filtered.map(toAiringSchedule);
        dayInfo[name] = {
          date_jst: jstDateStr(nextOccurrenceSec(i, win.start)),
          count: filtered.length,
        };
        grandTotal += filtered.length;
      }
      return respond(res, 200, {
        ok: true,
        endpoint: `${LANDING_PATH}/all`,
        cache,
        week: {
          timezone: "Asia/Tokyo",
          utc_offset: "+09:00",
          window_start_jst: jstDateStr(win.start),
          window_end_jst: jstDateStr(win.end - 1),
          total_airing_entries: grandTotal,
        },
        applied: appliedEcho(q),
        data: {
          Page: {
            pageInfo: { days: 7, total: grandTotal },
            dayInfo,
            days,
          },
        },
      }, cacheCtl);
    }

    // ── /api/schedule/{weekday} — single day, AniList Page shape ──
    const dayIdx = DAYS.indexOf(day);
    const filtered = sortItems(applyFilters(itemsForDay(win, dayIdx), q), q);
    const { slice, pageInfo } = paginate(filtered, q);
    const dayStart = nextOccurrenceSec(dayIdx, win.start);

    return respond(res, 200, {
      ok: true,
      endpoint: `${LANDING_PATH}/${day}`,
      cache,
      day: {
        name: day,
        date_jst: jstDateStr(dayStart),
        timezone: "Asia/Tokyo",
        utc_offset: "+09:00",
        semantics: "next occurrence of this JST broadcast weekday (today included when today IS this weekday)",
        window_start_jst: jstDateStr(win.start),
        window_end_jst: jstDateStr(win.end - 1),
      },
      applied: appliedEcho(q),
      count: slice.length,
      data: {
        Page: {
          pageInfo,
          airingSchedules: slice.map(toAiringSchedule),
        },
      },
    }, cacheCtl);
  } catch (err) {
    console.error("[schedule] error:", err.message);
    return respond(res, err.status || 500, {
      ok: false,
      endpoint: LANDING_PATH,
      error: err.message,
    }, "no-store");
  }
};

function respond(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", cacheControl || "public, max-age=60, s-maxage=7200, stale-while-revalidate=86400");
  res.end(JSON.stringify(body));
  return;
}
