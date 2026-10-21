// GET /api/studio/{studio}
// AniList-style studio browse endpoint.
//
//   /api/studio/bones              — case-insensitive AniList search
//   /api/studio/Kyoto%20Animation  — spaces work (URL-encoded)
//   /api/studio/kyoto-animation    — kebab-case works (auto retry dashes->spaces)
//   /api/studio/4                  — numeric = exact AniList studio id
//
// PARAMETERS (all optional):
//   page=1            page number for the studio's media connection
//   perPage=20        1-50 (default 20)
//   sort=POPULARITY_DESC  comma-separated MediaSort tokens (invalid dropped;
//                     fallback POPULARITY_DESC). Useful: START_DATE_DESC,
//                     SCORE_DESC, FAVOURITES_DESC, TRENDING_DESC
//   isMain=true       only media where this studio is the MAIN animation studio
//                     (default: no filter — co-productions included, AniList's
//                     own unfiltered behavior)
//   refresh=1         bypass both cache reads (response is still re-cached)
//
// RESPONSE (AniList format + proxy meta):
//   { ok, endpoint, cache, applied, count, data: { Studio: { id, name,
//     favourites, isAnimationStudio, siteUrl, media: { pageInfo, edges: [
//     { isMainStudio, node: { ...full AniList Media } } ] } } } }
//   pageInfo is AniList's verbatim block. Known upstream quirk: AniList caps /
//   stretches pageInfo totals on studio connections (a studio with ~500 media
//   reports total=500 at perPage=3 but lastPage=166 = 498) — trust hasNextPage.
//
// NOT FOUND -> HTTP 404, { ok:false, ..., error, data: { Studio: null } },
// no-store (AniList's own "Not Found." search-miss semantics, normalized).
//
// CACHING: key = "browse v1 | studio | {name-or-id lowercased} | {params}" —
// in-memory 4h TTL (shared store) + CDN s-maxage=14400 + SWR=86400.
// ANY parameter/filter change = different key = fresh AniList fetch.
// ?refresh=1 bypasses both cache reads.
const {
  MEDIA_SORTS,
  postGraphql, MEDIA_FIELDS,
  cacheGet, cacheSet, cacheKey, cacheInfo, respond, corsPreflight, methodGuard,
  clampInt, isTrue, enumList, cleanVars, lookupEntity,
} = require("../_lib/entity");

const LANDING = "/api/studio";

const STUDIO_QUERY = `
query ($id: Int, $search: String, $page: Int, $perPage: Int, $sort: [MediaSort], $isMain: Boolean) {
  Studio(id: $id, search: $search) {
    id
    name
    favourites
    isAnimationStudio
    siteUrl
    media(page: $page, perPage: $perPage, sort: $sort, isMain: $isMain) {
      pageInfo { total perPage currentPage lastPage hasNextPage }
      edges {
        isMainStudio
        node {
${MEDIA_FIELDS}
        }
      }
    }
  }
}
`;

module.exports = async (req, res) => {
  if (corsPreflight(req, res)) return;
  if (methodGuard(req, res, LANDING)) return;

  const query = req.query || {};
  // Vercel injects the [studio] path segment as req.query.studio (URL-decoded)
  const rawName = String(query.studio || "").trim();
  if (!rawName) {
    return respond(res, 400, {
      ok: false,
      endpoint: LANDING,
      error: "Missing studio name. Use /api/studio/{studio_name} (e.g. /api/studio/bones) or a numeric AniList studio id (/api/studio/4).",
      data: { Studio: null },
    }, "no-store");
  }

  const page = clampInt(query.page, 1, 10000, 1);
  const perPage = clampInt(query.perPage || query.per_page, 1, 50, 20);
  const sort = enumList(query.sort, MEDIA_SORTS) || ["POPULARITY_DESC"];
  const isMainParam = query.isMain;
  const isMain = isMainParam === undefined || isMainParam === null || isMainParam === ""
    ? null
    : isTrue(isMainParam);

  const variables = cleanVars({
    page,
    perPage,
    sort,
    ...(isMain !== null ? { isMain } : {}),
  });

  const identity = /^\d{1,9}$/.test(rawName) ? `id:${rawName}` : rawName.toLowerCase();
  const endpoint = `${LANDING}/${rawName}`;
  const key = cacheKey(["studio", identity], { ...query, studio: identity });
  const refresh = isTrue(query.refresh);

  // ---- Cache read ----
  if (!refresh) {
    const cached = cacheGet(key);
    if (cached && cached.body) {
      return respond(res, 200, {
        ok: true,
        endpoint: cached.endpoint,
        cache: cacheInfo(key, true, cached.builtAt),
        ...cached.body,
      });
    }
  }

  // ---- Fresh fetch ----
  try {
    const lookup = await lookupEntity(
      (vars) => postGraphql(STUDIO_QUERY, { ...vars, ...variables }),
      rawName
    );

    if (!lookup.entity || !lookup.entity.Studio) {
      return respond(res, 404, {
        ok: false,
        endpoint,
        cache: cacheInfo(key, false, null),
        error: `No AniList studio found for "${rawName}".`,
        hint: "Search matches AniList studio names case-insensitively (e.g. /api/studio/bones, /api/studio/MAPPA). Numeric paths address studio ids directly (/api/studio/4 = bones).",
        data: { Studio: null },
      }, "no-store");
    }

    const studio = lookup.entity.Studio;
    const edges = (studio.media && Array.isArray(studio.media.edges)) ? studio.media.edges : [];

    const applied = {
      studio: identity,
      resolvedBy: lookup.resolvedBy,
      page,
      perPage,
      sort,
      isMain: variables.isMain !== undefined ? variables.isMain : null,
    };

    const builtAt = Date.now();
    const body = {
      applied,
      count: edges.length,
      data: { Studio: studio },
    };
    cacheSet(key, { body, endpoint, builtAt });
    return respond(res, 200, {
      ok: true,
      endpoint,
      cache: cacheInfo(key, false, builtAt),
      ...body,
    });
  } catch (err) {
    console.error("[studio] error:", err.message);
    return respond(res, err.status && err.status >= 400 && err.status < 600 ? err.status : 502, {
      ok: false,
      endpoint: LANDING,
      cache: cacheInfo(key, false, null),
      error: err.message,
      data: { Studio: null },
    }, "no-store");
  }
};
