// GET /api/staff/{name}          — canonical (AniList "Staff" = any cast member)
// GET /voice-actors/{name}       — alias (vercel.json rewrite -> here, ?alias=voice-actors)
// GET /cast/{name}               — alias (vercel.json rewrite -> here, ?alias=cast)
//
// AniList-style voice-actor / cast-member endpoint: profile + every character
// they voice (with the shows) + their production staff credits.
//
//   /api/staff/Yoshitsugu%20Matsuoka
//   /voice-actors/yoshitsugu-matsuoka   — kebab-case auto-retries as spaces
//   /cast/Rie%20Takahashi
//   /api/staff/106817                   — numeric = exact AniList staff id
//
// PARAMETERS (all optional):
//   page=1            page number for the characterMedia connection
//   perPage=20        1-50 (default 20) — voiced-role entries per page
//   sort=POPULARITY_DESC  comma-separated MediaSort tokens (invalid dropped);
//                     fallback POPULARITY_DESC. Useful: FAVOURITES_DESC, SCORE_DESC
//   mainRoles=true    LOCAL filter: keep only characterRole=MAIN edges
//                     (AniList's characterMedia connection has no server-side
//                     isMain arg — this filters the fetched page and is reported
//                     honestly in `applied.mainRoles` + `pagination_note`)
//   staffPerPage=12   1-25 (default 12) — production-credit entries (staffMedia)
//   refresh=1         bypass both cache reads (response is still re-cached)
//
// RESPONSE (AniList format + proxy meta):
//   { ok, endpoint, cache, applied, count, data: { Staff: {
//       id, name{...}, image, description, favourites, primaryOccupations,
//       gender, age, yearsActive, homeTown, bloodType, dateOfBirth, dateOfDeath,
//       siteUrl,
//       characterMedia: { pageInfo, edges: [ { id, characterRole, characterName,
//           characters: [{ id, name{full native}, image }], node: {...Media} } ] },
//       staffMedia: { pageInfo, edges: [ { id, staffRole, node: {...Media lite} } ] }
//   } } }
//
// NOT FOUND -> HTTP 404, { ok:false, ..., data: { Staff: null } }, no-store.
//
// CACHING: key = "browse v1 | staff | {name-or-id lowercased} | {params}" —
// in-memory 4h TTL + CDN s-maxage=14400 + SWR=86400. ANY parameter/filter
// change = different key = fresh AniList fetch. ?refresh=1 bypasses reads.
// Bonus: /cast/X and /voice-actors/X rewrite to /api/staff/X, so all three
// URL shapes share the SAME cache entry.
const {
  MEDIA_SORTS,
  postGraphql, MEDIA_FIELDS, STAFF_MEDIA_FIELDS,
  cacheGet, cacheSet, cacheKey, cacheInfo, respond, corsPreflight, methodGuard,
  clampInt, isTrue, enumList, cleanVars, lookupEntity,
} = require("../_lib/entity");

const LANDING = "/api/staff";

const STAFF_QUERY = `
query ($id: Int, $search: String, $page: Int, $perPage: Int, $sort: [MediaSort], $staffPerPage: Int) {
  Staff(id: $id, search: $search) {
    id
    name { first middle last full native alternative userPreferred }
    image { large }
    description(asHtml: false)
    favourites
    primaryOccupations
    gender
    age
    yearsActive
    homeTown
    bloodType
    dateOfBirth { year month day }
    dateOfDeath { year month day }
    siteUrl
    characterMedia(page: $page, perPage: $perPage, sort: $sort) {
      pageInfo { total perPage currentPage lastPage hasNextPage }
      edges {
        id
        characterRole
        characterName
        characters {
          id
          name { full native }
          image { large }
        }
        node {
${MEDIA_FIELDS}
        }
      }
    }
    staffMedia(page: 1, perPage: $staffPerPage, type: ANIME) {
      pageInfo { total }
      edges {
        id
        staffRole
        node {
${STAFF_MEDIA_FIELDS}
        }
      }
    }
  }
}
`;

function endpointLabel(rawName) {
  return `${LANDING}/${rawName}`;
}

module.exports = async (req, res) => {
  if (corsPreflight(req, res)) return;
  if (methodGuard(req, res, LANDING)) return;

  const query = req.query || {};
  // Vercel injects the [staff] path segment as req.query.staff (URL-decoded)
  const rawName = String(query.staff || "").trim();
  if (!rawName) {
    return respond(res, 400, {
      ok: false,
      endpoint: LANDING,
      error: "Missing staff/voice-actor name. Use /api/staff/{name} (e.g. /api/staff/Yoshitsugu%20Matsuoka) or a numeric AniList staff id (/api/staff/106817). Aliases: /voice-actors/{name}, /cast/{name}.",
      data: { Staff: null },
    }, "no-store");
  }

  const alias = ["voice-actors", "cast"].includes(query.alias) ? query.alias : null;
  const page = clampInt(query.page, 1, 10000, 1);
  const perPage = clampInt(query.perPage || query.per_page, 1, 50, 20);
  const staffPerPage = clampInt(query.staffPerPage || query.staff_per_page, 1, 25, 12);
  const sort = enumList(query.sort, MEDIA_SORTS) || ["POPULARITY_DESC"];
  const mainRoles = query.mainRoles === undefined || query.mainRoles === "" ? null : isTrue(query.mainRoles);

  const variables = cleanVars({ page, perPage, sort, staffPerPage });

  const identity = /^\d{1,9}$/.test(rawName) ? `id:${rawName}` : rawName.toLowerCase();
  // Canonical endpoint label everywhere (cached + fresh) so /staff, /voice-actors
  // and /cast responses are byte-identical; the serving shape is echoed via
  // applied.alias. The alias + injected path segment are excluded from the
  // cache key so all three URL shapes SHARE one cache entry.
  const endpoint = `${LANDING}/${rawName}`;
  const { alias: _alias, staff: _seg, ...qsOnly } = query;
  const key = cacheKey(["staff", identity], { ...qsOnly, staff: identity });
  const refresh = isTrue(query.refresh);

  // ---- Cache read (shared across /staff, /voice-actors, /cast shapes) ----
  if (!refresh) {
    const cached = cacheGet(key);
    if (cached && cached.body) {
      return respond(res, 200, {
        ok: true,
        endpoint: cached.endpoint,
        ...(alias ? { servedAs: alias } : {}),
        cache: cacheInfo(key, true, cached.builtAt),
        ...cached.body,
      });
    }
  }

  // ---- Fresh fetch ----
  try {
    const lookup = await lookupEntity(
      (vars) => postGraphql(STAFF_QUERY, { ...vars, ...variables }),
      rawName
    );

    if (!lookup.entity || !lookup.entity.Staff) {
      return respond(res, 404, {
        ok: false,
        endpoint,
        cache: cacheInfo(key, false, null),
        error: `No AniList staff member / voice actor found for "${rawName}".`,
        hint: "Search matches AniList staff names case-insensitively (e.g. /api/staff/Yoshitsugu%20Matsuoka). Numeric paths address staff ids directly (/api/staff/106817).",
        data: { Staff: null },
      }, "no-store");
    }

    const staff = lookup.entity.Staff;

    // Optional LOCAL main-roles filter (AniList has no server-side isMain on
    // characterMedia). Applied on the fetched page; pageInfo stays verbatim
    // and the effect is reported honestly.
    let edges = (staff.characterMedia && Array.isArray(staff.characterMedia.edges)) ? staff.characterMedia.edges : [];
    let paginationNote;
    if (mainRoles === true) {
      const before = edges.length;
      edges = edges.filter((e) => e && e.characterRole === "MAIN");
      if (before !== edges.length) {
        paginationNote = `mainRoles=true is a LOCAL filter on the fetched page (${before} -> ${edges.length} entries on this page); AniList's pageInfo/hasNextPage still describe the UNFILTERED connection. Paginate normally and filter per page.`;
      }
    }
    const characterMedia = {
      ...(staff.characterMedia || {}),
      edges,
    };

    const applied = {
      staff: identity,
      resolvedBy: lookup.resolvedBy,
      page,
      perPage,
      sort,
      mainRoles,
      staffPerPage,
    };

    const builtAt = Date.now();
    const body = {
      applied,
      count: edges.length,
      ...(paginationNote ? { pagination_note: paginationNote } : {}),
      data: { Staff: { ...staff, characterMedia } },
    };
    cacheSet(key, { body, endpoint, builtAt });
    return respond(res, 200, {
      ok: true,
      endpoint,
      ...(alias ? { servedAs: alias } : {}),
      cache: cacheInfo(key, false, builtAt),
      ...body,
    });
  } catch (err) {
    console.error("[staff] error:", err.message);
    return respond(res, err.status && err.status >= 400 && err.status < 600 ? err.status : 502, {
      ok: false,
      endpoint: LANDING,
      cache: cacheInfo(key, false, null),
      error: err.message,
      data: { Staff: null },
    }, "no-store");
  }
};
