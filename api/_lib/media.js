// api/_lib/media.js
// Item-level endpoints: /api/{id}/full and /api/{id}/episodes
//
// All data is fetched from the AniList GraphQL API and shaped into a
// Jikan (MyAnimeList API v4) style response.
//
// Dual-ID support:
//   The input id can be a MyAnimeList id OR an AniList id (the numeric ranges
//   overlap, so auto-detection is needed). Strategy:
//     1. If ?idType=anilist|mal is forced, look up with that exact semantic.
//     2. Otherwise try Media(id: N) first.
//        - Found and its idMal === N -> the number identifies the same show in
//          both databases ("both").
//        - Found but idMal !== N -> the number also exists as a MAL id of a
//          different show ("ambiguous"). We default to the AniList entry and
//          return a `note` telling the consumer how to get the MAL one
//          (?idType=mal).
//        - Not found -> try Media(idMal: N).
//          - Found -> MAL id.
//          - Not found -> 404.
//
// Caching: every response is cached server-side for 4 hours (see _lib/cache.js)
// and additionally served with CDN headers s-maxage=14400.

const { cacheGet, cacheSet, secondsUntilExpiry } = require("./cache");
const { jsonResponse } = require("./anilist");
const J = require("./jikan");

const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const CACHE_TTL_SECONDS = 4 * 60 * 60; // 4 hours
const CDN_CACHE_CONTROL = "public, max-age=0, s-maxage=14400, stale-while-revalidate=14400";
const MAX_PER_PAGE = 50; // AniList's maximum supported perPage

// Tiny lookup used for id-type resolution
const TINY_QUERY = `
query ($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: ANIME) {
    id
    idMal
    title { userPreferred }
  }
}
`;

// Everything needed for the Jikan-style /full payload
const FULL_QUERY = `
query ($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: ANIME) {
    id
    idMal
    title { romaji english native userPreferred }
    synonyms
    description(asHtml: false)
    format
    source
    episodes
    duration
    status
    season
    seasonYear
    countryOfOrigin
    isAdult
    averageScore
    meanScore
    popularity
    favourites
    startDate { year month day }
    endDate { year month day }
    nextAiringEpisode { airingAt episode timeUntilAiring }
    coverImage { extraLarge large medium color }
    bannerImage
    trailer { id site thumbnail }
    genres
    tags { id name category rank isMediaSpoiler isGeneralSpoiler }
    studios { edges { isMain node { id name } } }
    externalLinks { id site url type language color }
    rankings { rank type context year season allTime }
    stats { scoreDistribution { score amount } }
    siteUrl
    airingSchedule(page: 1, perPage: 1) { nodes { episode airingAt } }
  }
}
`;

// Episodes payload: media base + the airing schedules for the requested
// episode window + the tracked schedule total (for pagination).
const EPISODES_QUERY = `
query ($mediaId: Int, $gt: Int, $lt: Int, $pp: Int) {
  Media(id: $mediaId, type: ANIME) {
    id
    idMal
    title { romaji english native userPreferred }
    episodes
    duration
    status
    format
    streamingEpisodes { title thumbnail url site }
    nextAiringEpisode { episode airingAt }
  }
  pageSchedules: Page(page: 1, perPage: $pp) {
    airingSchedules(mediaId: $mediaId, episode_greater: $gt, episode_lesser: $lt, sort: EPISODE) {
      episode
      airingAt
    }
  }
  schedInfo: Media(id: $mediaId, type: ANIME) {
    airingSchedule(page: 1, perPage: 1) {
      pageInfo { total }
      nodes { episode airingAt }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// GraphQL transport
// ---------------------------------------------------------------------------
// Returns { data, errors }. Does NOT throw on GraphQL-level errors (AniList
// aborts sibling root fields when one alias 404s, so callers inspect `data`);
// only network/HTTP failures throw.
async function fetchGraphQL(query, variables) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(ANILIST_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "anilist-my-proxy/1.1 (+vercel)",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      throw new Error(`AniList returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok && !body.data) {
      const errMsg = (body.errors && body.errors[0] && body.errors[0].message) || `AniList API HTTP ${res.status}`;
      const err = new Error(errMsg);
      err.status = res.status === 429 ? 429 : 502;
      throw err;
    }
    return { data: body.data || null, errors: body.errors || null };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTiny(id, idMal) {
  const variables = {};
  if (id != null) variables.id = id;
  if (idMal != null) variables.idMal = idMal;
  const { data } = await fetchGraphQL(TINY_QUERY, variables);
  return (data && data.Media) || null;
}

// ---------------------------------------------------------------------------
// Dual-ID resolution
// ---------------------------------------------------------------------------

async function resolveMedia(inputId, idTypeOverride) {
  if (idTypeOverride === "mal") {
    const m = await fetchTiny(null, inputId);
    if (!m) return null;
    return { mediaId: m.id, idType: "mal", anilistId: m.id, malId: m.idMal ?? inputId };
  }
  if (idTypeOverride === "anilist") {
    const m = await fetchTiny(inputId, null);
    if (!m) return null;
    return { mediaId: m.id, idType: "anilist", anilistId: m.id, malId: m.idMal ?? null };
  }

  // Auto-detection
  const byId = await fetchTiny(inputId, null);
  if (byId) {
    if (byId.idMal === inputId) {
      // Same number identifies the same show in both databases.
      return { mediaId: byId.id, idType: "both", anilistId: byId.id, malId: byId.idMal };
    }
    // The number exists as an AniList id of a show whose MAL id differs.
    // Check whether it ALSO exists as a MAL id (ambiguity).
    const byMal = await fetchTiny(null, inputId);
    const base = { mediaId: byId.id, idType: "anilist", anilistId: byId.id, malId: byId.idMal ?? null };
    if (byMal) {
      base.ambiguous = true;
      base.note =
        `ID ${inputId} exists in both databases: AniList id ${inputId} is "${byId.title.userPreferred}" ` +
        `(MAL id ${byId.idMal ?? "n/a"}), and MAL id ${inputId} is "${byMal.title.userPreferred}" ` +
        `(AniList id ${byMal.id}). Defaulting to the AniList interpretation. ` +
        `Pass ?idType=mal to get the MAL entry instead, or ?idType=anilist to skip this check.`;
    }
    return base;
  }

  const byMal = await fetchTiny(null, inputId);
  if (byMal) {
    return { mediaId: byMal.id, idType: "mal", anilistId: byMal.id, malId: byMal.idMal ?? inputId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response metadata helpers
// ---------------------------------------------------------------------------

function buildDetected(inputId, resolved, idTypeOverride) {
  const detected = {
    inputId,
    idType: resolved.idType,
    anilistId: resolved.anilistId,
    malId: resolved.malId ?? null,
  };
  if (idTypeOverride) detected.forcedBy = `?idType=${idTypeOverride}`;
  if (resolved.ambiguous) {
    detected.ambiguous = true;
    detected.note = resolved.note;
  }
  return detected;
}

function cacheInfo(key, hit) {
  const seconds = secondsUntilExpiry(key);
  return {
    enabled: true,
    ttl_seconds: CACHE_TTL_SECONDS,
    cached: hit,
    expires_in_seconds: hit ? seconds : CACHE_TTL_SECONDS,
  };
}

const SOURCE_LINE = "AniList GraphQL API (https://graphql.anilist.co)";

// ---------------------------------------------------------------------------
// GET /api/{id}/full
// ---------------------------------------------------------------------------

async function handleFull(req, res, inputId) {
  const query = req.query || {};
  const idTypeOverride = normalizeIdType(query.idType);
  const refresh = query.refresh === "true" || query.refresh === "1";
  const cacheKey = `full:in=${inputId}:t=${idTypeOverride || "auto"}`;

  if (!refresh) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      cached.cache = cacheInfo(cacheKey, true);
      return jsonResponse(res, 200, cached, { cacheControl: CDN_CACHE_CONTROL });
    }
  }

  let resolved;
  try {
    resolved = await resolveMedia(inputId, idTypeOverride);
  } catch (err) {
    return anilistError(res, err, inputId);
  }

  if (!resolved) {
    return jsonResponse(res, 404, {
      ok: false,
      status: 404,
      endpoint: "/api/{id}/full",
      error: `Anime not found for id ${inputId}`,
      hint:
        `The id was tried both as an AniList id and as a MyAnimeList id, with no match. ` +
        `Check the id, or force one interpretation with ?idType=anilist / ?idType=mal.`,
      ...(idTypeOverride ? { forcedIdType: idTypeOverride } : {}),
    }, { cacheControl: CDN_CACHE_CONTROL });
  }

  let media;
  try {
    const variables = {};
    if (idTypeOverride === "mal") { variables.idMal = inputId; } 
    else if (idTypeOverride === "anilist") { variables.id = inputId; }
    else {
      // Auto mode: refetch by the resolved AniList id (idType "both" already
      // confirmed idMal === inputId, so id is always correct here).
      variables.id = resolved.mediaId;
    }
    const { data } = await fetchGraphQL(FULL_QUERY, variables);
    media = data && data.Media;
  } catch (err) {
    return anilistError(res, err, inputId);
  }

  if (!media) {
    return jsonResponse(res, 404, {
      ok: false,
      status: 404,
      endpoint: "/api/{id}/full",
      error: `Anime not found for id ${inputId}`,
      hint: `The entry disappeared between resolution and fetch — it may have been removed from AniList.`,
    }, { cacheControl: CDN_CACHE_CONTROL });
  }

  const body = {
    ok: true,
    endpoint: "/api/{id}/full",
    source: SOURCE_LINE,
    detected: buildDetected(inputId, resolved, idTypeOverride),
    cache: cacheInfo(cacheKey, false),
    data: buildFullData(media),
    notes: FULL_NOTES,
  };

  cacheSet(cacheKey, body);
  return jsonResponse(res, 200, body, { cacheControl: CDN_CACHE_CONTROL });
}

const FULL_NOTES = [
  "All fields are sourced from AniList and mapped to Jikan (MyAnimeList API v4) naming.",
  "score is AniList averageScore/10; scored_by is the sum of AniList score distribution votes; members is AniList popularity count; favorites is AniList favourites.",
  "rank / popularity are AniList all-time RATED / POPULAR rankings (they differ from MAL's own rankings).",
  "studios/producers mal_id and url are null because AniList does not expose MAL studio ids; licensors is empty because AniList has no licensor data.",
  "rating is derived from isAdult/genres/tags; AniList does not provide MAL's official age rating (null when there is no confident signal).",
  "opening_themes/ending_themes are not exposed by the AniList GraphQL API and are returned as null.",
];

function buildFullData(media) {
  const tags = media.tags || [];
  const genres = media.genres || [];
  const taxonomies = J.buildTaxonomies(genres, tags, media.studios);
  const isAiring = media.status === "RELEASING";

  // Broadcast: Jikan only populates it for currently-airing shows. Prefer the
  // upcoming broadcast slot; fall back to the most recent tracked slot.
  let broadcast = null;
  if (isAiring) {
    broadcast = J.broadcastFromUnix(
      (media.nextAiringEpisode && media.nextAiringEpisode.airingAt) ||
        (media.airingSchedule && media.airingSchedule.nodes && media.airingSchedule.nodes[0] && media.airingSchedule.nodes[0].airingAt)
    );
  }

  // Rank / popularity from all-time rankings
  let rank = null;
  let popularityRank = null;
  for (const r of media.rankings || []) {
    if (!r.allTime) continue;
    if (r.type === "RATED" && rank === null) rank = r.rank;
    if (r.type === "POPULAR" && popularityRank === null) popularityRank = r.rank;
  }

  // scored_by = total users that rated (score distribution sum)
  let scoredBy = 0;
  for (const d of (media.stats && media.stats.scoreDistribution) || []) scoredBy += d.amount || 0;

  const score = media.averageScore != null ? Math.round((media.averageScore / 10) * 100) / 100 : null;
  const description = cleanDescription(media.description);
  const malId = media.idMal ?? null;

  return {
    mal_id: malId,
    anilist_id: media.id,
    id: media.id,
    url: malId ? `https://myanimelist.net/anime/${malId}` : null,
    anilist_url: media.siteUrl || (media.id ? `https://anilist.co/anime/${media.id}` : null),
    image_url: (media.coverImage && (media.coverImage.large || media.coverImage.extraLarge)) || null,
    trailer: J.buildTrailer(media.trailer),
    approved: !media.isAdult,
    titles: J.buildTitles(media.title || {}, media.synonyms),
    title: (media.title && media.title.userPreferred) || (media.title && media.title.romaji) || null,
    title_english: (media.title && media.title.english) || null,
    title_japanese: (media.title && media.title.native) || null,
    title_synonyms: media.synonyms || [],
    type: J.FORMAT_TO_TYPE[media.format] || null,
    source: J.SOURCE_MAP[media.source] || null,
    episodes: media.episodes ?? null,
    status: J.STATUS_MAP[media.status] || null,
    airing: isAiring,
    aired: J.buildAired(media.startDate, media.endDate),
    duration: J.buildDuration(media.duration, media.format),
    rating: J.deriveRating(media.isAdult, genres, tags),
    score,
    scored_by: scoredBy > 0 ? scoredBy : null,
    rank,
    popularity: popularityRank,
    members: media.popularity ?? null,
    favorites: media.favourites ?? null,
    broadcast,
    synopsis: description,
    description,
    season: media.season ? media.season.toLowerCase() : null,
    year: media.seasonYear ?? null,
    season_string: media.season ? `${media.season.toLowerCase()} ${media.seasonYear ?? ""}`.trim() : null,
    nextAiringEpisode: media.nextAiringEpisode || null,
    countryOfOrigin: media.countryOfOrigin || null,
    averageScore: media.averageScore ?? null,
    meanScore: media.meanScore ?? null,
    producers: taxonomies.producers,
    licensors: taxonomies.licensors,
    studios: taxonomies.studios,
    genres: taxonomies.genres,
    explicit_genres: taxonomies.explicit_genres,
    demographics: taxonomies.demographics,
    themes: taxonomies.themes,
    opening_themes: null,
    ending_themes: null,
    external_links: J.buildExternalLinks(media.externalLinks),
    tags: J.buildTags(tags),
    images: J.buildImages(media.coverImage, media.bannerImage),
  };
}

function cleanDescription(desc) {
  if (!desc) return null;
  return String(desc)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .trim();
}

// ---------------------------------------------------------------------------
// GET /api/{id}/episodes
// ---------------------------------------------------------------------------

async function handleEpisodes(req, res, inputId) {
  const query = req.query || {};
  const idTypeOverride = normalizeIdType(query.idType);
  const refresh = query.refresh === "true" || query.refresh === "1";

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  let perPage = parseInt(query.perPage, 10);
  let perPageNote;
  if (!Number.isFinite(perPage) || perPage <= 0) {
    perPage = MAX_PER_PAGE; // default: AniList's maximum supported page size
  } else if (perPage > MAX_PER_PAGE) {
    perPage = MAX_PER_PAGE;
    perPageNote = `perPage was capped at ${MAX_PER_PAGE} (AniList's maximum supported page size).`;
  }

  const cacheKey = `episodes:in=${inputId}:t=${idTypeOverride || "auto"}:p=${page}:pp=${perPage}`;

  if (!refresh) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      cached.cache = cacheInfo(cacheKey, true);
      return jsonResponse(res, 200, cached, { cacheControl: CDN_CACHE_CONTROL });
    }
  }

  let resolved;
  try {
    resolved = await resolveMedia(inputId, idTypeOverride);
  } catch (err) {
    return anilistError(res, err, inputId);
  }

  if (!resolved) {
    return jsonResponse(res, 404, {
      ok: false,
      status: 404,
      endpoint: "/api/{id}/episodes",
      error: `Anime not found for id ${inputId}`,
      hint:
        `The id was tried both as an AniList id and as a MyAnimeList id, with no match. ` +
        `Check the id, or force one interpretation with ?idType=anilist / ?idType=mal.`,
      ...(idTypeOverride ? { forcedIdType: idTypeOverride } : {}),
    }, { cacheControl: CDN_CACHE_CONTROL });
  }

  let payload;
  try {
    payload = await fetchEpisodesPage(resolved.mediaId, page, perPage);
  } catch (err) {
    return anilistError(res, err, inputId);
  }

  const { media, scheduleByEpisode, newestScheduleEpisode } = payload;

  // Total episodes for pagination: the most generous trustworthy signal wins,
  // because AniList tracks different subsets per source (episode count,
  // streaming episodes, airing schedules, next airing).
  const streamingCount = (media.streamingEpisodes || []).length;
  const lastAired = media.nextAiringEpisode ? Math.max(0, media.nextAiringEpisode.episode - 1) : 0;
  const total = Math.max(
    media.episodes || 0,
    streamingCount,
    newestScheduleEpisode || 0,
    lastAired
  );

  const firstEpisode = (page - 1) * perPage + 1;
  const lastEpisode = page * perPage;

  const titlesByEpisode = new Map();
  for (const se of media.streamingEpisodes || []) {
    const parsed = J.parseStreamingEpisode(se);
    if (parsed && !titlesByEpisode.has(parsed.episode)) {
      titlesByEpisode.set(parsed.episode, { title: parsed.title, thumbnail: se.thumbnail || null, url: se.url || null });
    }
  }

  const data = [];
  if (total > 0 && firstEpisode <= total) {
    for (let ep = firstEpisode; ep <= Math.min(lastEpisode, total); ep++) {
      const se = titlesByEpisode.get(ep);
      const airingAt = scheduleByEpisode[ep] || null;
      data.push({
        mal_id: ep,
        title: (se && se.title) || `Episode ${ep}`,
        title_japanese: null,
        title_romanji: null,
        aired: J.unixToIso(airingAt),
        aired_at: airingAt,
        score: null, // AniList does not expose per-episode user scores
        filler: null, // not available on AniList
        recap: null, // not available on AniList
        duration: media.duration ?? null,
        url: (se && se.url) || null,
        images: se && se.thumbnail
          ? { jpg: { image_url: se.thumbnail, small_image_url: se.thumbnail, large_image_url: se.thumbnail } }
          : null,
        themes: { opening: null, ending: null }, // OP/ED timings are not exposed by AniList
      });
    }
  }

  const lastVisiblePage = Math.max(1, Math.ceil(total / perPage));
  const body = {
    ok: true,
    endpoint: "/api/{id}/episodes",
    source: SOURCE_LINE,
    detected: buildDetected(inputId, resolved, idTypeOverride),
    cache: cacheInfo(cacheKey, false),
    pagination: {
      last_visible_page: lastVisiblePage,
      has_next_page: page * perPage < total,
      current_page: page,
      items: {
        count: data.length,
        total,
        per_page: perPage,
      },
    },
    data,
    notes: [
      "All data is sourced from AniList and shaped like Jikan's /anime/{id}/episodes response.",
      "Episode titles, thumbnails and streaming urls come from AniList streamingEpisodes when tracked.",
      "aired comes from AniList airing schedules (JST broadcast moments); episodes outside the tracked window have null.",
      "per-episode score / filler / recap flags and OP/ED theme start-end times are not exposed by the AniList GraphQL API and are returned as null.",
      "perPage defaults to 50 (AniList's maximum supported page size) and is capped at 50.",
      ...(perPageNote ? [perPageNote] : []),
      ...(total === 0
        ? ["No episode data is tracked for this entry yet (it may not have started airing)."]
        : []),
    ],
  };

  cacheSet(cacheKey, body);
  return jsonResponse(res, 200, body, { cacheControl: CDN_CACHE_CONTROL });
}

async function fetchEpisodesPage(mediaId, page, perPage) {
  const gt = (page - 1) * perPage; // episode_greater (exclusive)
  const lt = page * perPage + 1; // episode_lesser (exclusive)
  const { data } = await fetchGraphQL(EPISODES_QUERY, { mediaId, gt, lt, pp: perPage });

  const media = (data && data.Media) || null;
  if (!media) {
    const err = new Error("Media vanished between resolution and episodes fetch");
    err.status = 404;
    throw err;
  }

  const scheduleByEpisode = {};
  for (const s of (data.pageSchedules && data.pageSchedules.airingSchedules) || []) {
    scheduleByEpisode[s.episode] = s.airingAt;
  }

  // NOTE: AniList's airingSchedule pageInfo.total is unreliable (it can report
  // 500 for a 28-episode show), so we ignore it. Instead we use the newest
  // tracked schedule episode (default nested order is newest-first) as an
  // upper-bound signal; the caller combines it with episodes count,
  // streamingEpisodes length and nextAiringEpisode.
  const schedInfo = (data.schedInfo && data.schedInfo.airingSchedule) || {};
  const newestScheduleEpisode =
    (schedInfo.nodes && schedInfo.nodes[0] && schedInfo.nodes[0].episode) || 0;

  return { media, scheduleByEpisode, newestScheduleEpisode };
}

// ---------------------------------------------------------------------------
// Shared error handling
// ---------------------------------------------------------------------------

function normalizeIdType(value) {
  const v = String(value || "").toLowerCase();
  if (v === "anilist" || v === "al") return "anilist";
  if (v === "mal" || v === "myanimelist") return "mal";
  return null;
}

function anilistError(res, err, inputId) {
  const status = err.status || 500;
  return jsonResponse(res, status, {
    ok: false,
    status,
    inputId,
    error: err.message || "Upstream AniList request failed",
    hint:
      status === 429
        ? "AniList is rate limiting this deployment (cached responses consume no quota — retries succeed once the window resets)."
        : "This proxy fetches from the AniList GraphQL API; the request failed upstream. Retry shortly.",
  }, { cacheControl: CDN_CACHE_CONTROL });
}

module.exports = { handleFull, handleEpisodes };
