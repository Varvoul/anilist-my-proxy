# anilist-my-proxy

A categorized AniList GraphQL proxy deployed as Vercel serverless functions.

Every endpoint returns paginated anime data with **both the AniList `id` and the MyAnimeList `idMal`** for each entry, plus rich metadata (title, scores, popularity, favourites, start/end dates, next airing episode, genres, studios, trailer).

## Endpoints

| Path | Default status | Default sort | Description |
|---|---|---|---|
| `/api/currently-airing` | RELEASING | POPULARITY_DESC | Anime currently broadcasting |
| `/api/top-airing` | RELEASING | SCORE_DESC | Top-rated currently broadcasting |
| `/api/new-releases` | — | START_DATE_DESC | Newest premieres by start date |
| `/api/trending-today` | RELEASING | TRENDING_DESC | Trending on AniList in the last 24h |
| `/api/trending-week` | RELEASING | POPULARITY_DESC | Released in last 7 days, sorted by popularity |
| `/api/trending-week-flex` | — | POPULARITY_DESC | Same as `/trending-week` but without `status=RELEASING` — always returns data |
| `/api/trending-month` | RELEASING | POPULARITY_DESC | Released in last 30 days, sorted by popularity |
| `/api/upcoming` | NOT_YET_RELEASED | POPULARITY_DESC | Scheduled for future release |
| `/api/recently-completed` | FINISHED | END_DATE_DESC | Most-recently-finished → oldest |
| `/api/most-favourite` | — | FAVOURITES_DESC | All-time most favourited |
| `/api/new-added` | — | ID_DESC | Newest entries in AniList's database |
| `/api/popular` | — | POPULARITY_DESC | All-time most popular |
| `/api` | — | — | Self-documenting landing page listing all categories & params |

## Item endpoints (single anime)

Item endpoints come in two flavors. **Explicit id-source routes are recommended**
— the URL itself says which database the id belongs to, so lookups are a single
deterministic AniList query with no ambiguity (MAL and AniList id ranges
overlap). The older generic routes auto-detect the id source and remain
available for backward compatibility. All data is shaped like the
[Jikan](https://jikan.moe) (MyAnimeList API v4) response format and sourced
from AniList.

| Path | Description |
|---|---|
| `/api/mal/{mal_id}/full` | Full anime metadata; the id is always treated as a **MyAnimeList** id |
| `/api/anilist/{anilist_id}/full` | Full anime metadata; the id is always treated as an **AniList** id |
| `/api/{id}/full` | Backward-compatible generic route — id source auto-detected (`?idType=anilist\|mal` to force) |
| `/api/mal/{mal_id}/relations` | **All related entries** (prequel/sequel seasons, side stories, spin-offs, source manga…); id is a **MyAnimeList** id |
| `/api/anilist/{anilist_id}/relations` | All related entries; id is an **AniList** id |
| `/api/{id}/relations` | Backward-compatible generic route — id source auto-detected |
| `/api/mal/{mal_id}/episodes` | Episode list; the id is always treated as a **MyAnimeList** id |
| `/api/anilist/{anilist_id}/episodes` | Episode list; the id is always treated as an **AniList** id |
| `/api/{id}/episodes` | Backward-compatible generic route — id source auto-detected |

`/full` payload: titles (romaji as Default + explicit `title_romaji`), images
right after `url` (jpg/webp cover formats incl. extraLarge + banner), trailer,
mal_id/anilist_id, url/anilist_url, type, source, episodes, status, airing,
aired (prop + string), duration, rating + isAdult, score, scored_by, rank,
popularity, members, favorites, description/synopsis, broadcast (JST),
season/year/season_string, nextAiringEpisode, countryOfOrigin,
averageScore/meanScore, producers/studios/genres/explicit_genres/demographics/themes,
**relations + seasons**, external_links, tags, title_synonyms.

### Relations (prequel / sequel / all related entries)

`/full` embeds two extra blocks, and a standalone `/api/{source}/{id}/relations`
endpoint returns the same list without the heavy metadata:

- **`relations`** — *every* relation AniList returns, one flat entry per AniList
  relation edge (raw `relation_type` enums from AniList's relationType v2:
  `PREQUEL`, `SEQUEL`, `SIDE_STORY`, `SPIN_OFF`, `SOURCE`, `ADAPTATION`,
  `SUMMARY`, `CHARACTER`, `ALTERNATIVE`, `PARENT`, `OTHER` — plus a friendly
  `relation` label).
- **`seasons`** — convenience split of the prequel/sequel chain, sorted
  chronologically (`seasons.prequels[]`, `seasons.sequels[]`), so season
  ordering is available without re-sorting by the consumer.

Every relation entry is self-contained and AniList style:

```jsonc
{
  "relation_type": "SEQUEL",          // raw AniList enum (relationType v2)
  "relation": "Sequel",               // friendly label
  "mal_id": 59978,                    // MyAnimeList id of the related entry (null when not on MAL)
  "anilist_id": 182255,               // AniList id of the related entry
  "id": 182255,
  "type": "anime",                    // "anime" or "manga" (manga = e.g. the SOURCE manga)
  "media_type": "ANIME",              // raw AniList type enum
  "format": "TV",
  "url": "https://myanimelist.net/anime/59978",   // null when mal_id is null
  "anilist_url": "https://anilist.co/anime/182255",
  "title": "Sousou no Frieren 2nd Season",        // romaji default, same as /full
  "titles": { "romaji": "…", "english": "…", "native": "…", "userPreferred": "…" },
  "title_english": "…", "title_japanese": "…", "title_synonyms": ["…"],
  "images": { "jpg": {…}, "webp": {…}, "banner": { "large": …, "small": … } },
  "image_url": "https://s4.anilist.co/…",        // extraLarge cover
  "banner_image": "https://s4.anilist.co/…",
  "cover_color": "#7ca3c6",
  "status": "Finished Airing",         // Jikan wording for anime; manga uses its own status
  "episodes": 24,                      // anime only; manga entries carry chapters/volumes instead
  "duration": "24 min per ep",
  "season": "winter", "year": 2026,
  "score": 8.6, "averageScore": 86,
  "popularity": 118000, "favorites": 5400,
  "genres": ["Adventure", "Drama", "Fantasy"],
  "isAdult": false
}
```

Example: `/api/anilist/154587/relations` (Sousou no Frieren) returns its source
manga, the ●● no Mahou side stories, the 2nd-season sequel and more — whatever
AniList tracks for that entry, including entries whose `mal_id` is `null`.

`/episodes` payload: pagination info at the top (`last_visible_page`,
`has_next_page`, `current_page`, `items.{count,total,per_page}`) followed by
episodes with titles, thumbnails, streaming url, aired timestamps and duration.

Item endpoint query parameters:

| Param | Default | Notes |
|---|---|---|
| `page` | 1 | Episodes page (1-indexed) |
| `perPage` | 50 | Episodes per page — 50 is AniList's maximum supported page size (values above are capped) |
| `idType` | auto | generic routes only: `anilist` or `mal` — force how the numeric id is interpreted |
| `refresh` | false | `true`/`1` bypasses the cache and refetches from AniList |

### ID auto-detection (generic routes only)

1. The id is first tried as an AniList id. If the entry's own `idMal` equals
   the number, the id identifies the same show in both databases.
2. If not found (or the numbers map to different shows — rare), the id is
   checked as a MAL id. In the rare ambiguous case the response contains
   `detected.ambiguous: true` with a `note` describing both matches; the
   AniList interpretation is used by default and `?idType=mal` selects the other.

The explicit-source routes never have this problem: `/api/mal/21405/...` and
`/api/anilist/21405/...` each return exactly one well-defined show.

### Caching

All item endpoints cache responses **server-side for 4 hours** (auto-expiry —
once expired, the next visit fetches fresh data from AniList) and are also
served with CDN headers (`s-maxage=14400, stale-while-revalidate=14400`). Use
`?refresh=1` to force a fresh fetch. Every response reports its cache state in
the `cache` object. Cache keys are isolated per route, so `/api/mal/52991/full`
and `/api/anilist/154587/full` resolve independently.

### AniList data limitations

AniList's GraphQL API does not expose: MAL's official age-rating string (only
the `isAdult` flag — `rating` is a best-effort derivation from genres/tags and
is `null` when there is no confident signal), studio MAL ids
(`studios`/`producers` have `mal_id: null`), opening/ending themes, per-episode
user scores, or per-episode OP/ED timings.

Fields with **no AniList source at all are omitted entirely** rather than
null-filled: there is no `licensors` field in `/full`, and episode objects in
`/episodes` have no `score` or OP/ED timing fields. Filler/recap flags stay
`null` for Jikan-shape compatibility. Each response carries `notes`
documenting this.

## Query parameters (supported by every category endpoint)

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | Int | 1 | Page number |
| `perPage` | Int | 20 | Items per page (1–50) |
| `type` | Enum | ANIME | ANIME or MANGA |
| `status` | Enum | endpoint default | FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED, HIATUS |
| `sort` | String | endpoint default | Comma-separated, e.g. `?sort=SCORE_DESC,POPULARITY_DESC` |
| `season` | Enum | — | WINTER, SPRING, SUMMER, FALL |
| `year` | Int | — | e.g. `2026` |
| `format` | Enum | — | TV, TV_SHORT, MOVIE, SPECIAL, OVA, ONA, MUSIC |
| `genre` | String | — | e.g. `?genre=Action` |
| `minScore` | Int | — | Minimum averageScore (0–100) |
| `maxScore` | Int | — | Maximum averageScore (0–100) |
| `minPopularity` | Int | — | Minimum popularity |
| `startAfter` | Date | — | `startDate >` (YYYY-MM-DD or YYYYMMDD) |
| `startBefore` | Date | — | `startDate <` |
| `endAfter` | Date | — | `endDate >` |
| `endBefore` | Date | — | `endDate <` |
| `isAdult` | Bool | false | Set `true` or `1` to include adult content |
| `rawPagination` | Bool | false | Set `true` to return AniList's verbatim (capped) pageInfo instead of the exact pagination |

## Pagination (accurate by default)

AniList's own `pageInfo` is approximate: `total` is hard-capped at 5000 and
`lastPage` at 250, and past the end of the data `total` silently degrades to
`(page-1) * perPage`. Reading page 1 of `/api/currently-airing` therefore
reports `total: 5000 / lastPage: 250` even though the category truly ends at
page 9 with 171 entries — the numbers contradict each other across pages.

This proxy fixes that. The `pagination` block keeps AniList's exact field
shape but now carries **true, self-consistent values**:

- `total` — real number of entries matching the filters
- `lastPage` — real last page that contains data (`ceil(total / perPage)`)
- `hasNextPage` — reliable end-of-data signal
- `currentPage`, `perPage` — echo of the request

Responses also include `pagination_source` (`"exact"` or `"anilist-raw"`) and
`pagination_probes` (how many id-only AniList probes were used; `0` when the
current page alone was enough to compute everything). If probes fail or exceed
their time/probe budget, the response falls back to AniList's verbatim pageInfo
with a `pagination_note` explaining why — the endpoint never breaks because of
this. Pass `?rawPagination=true` if you specifically want AniList's raw block.

## Example calls

```
/api/currently-airing?page=1&perPage=20
/api/top-airing?genre=Action&minScore=80
/api/recently-completed?page=2&perPage=50
/api/trending-week?year=2026&season=SUMMER
/api/popular?sort=SCORE_DESC,POPULARITY_DESC
```

## Response shape

```jsonc
{
  "ok": true,
  "category": "currently-airing",
  "description": "...",
  "defaults": { "status": "RELEASING", "sort": ["POPULARITY_DESC"], "applyWindow": null },
  "applied": { "page": 1, "perPage": 20, "type": "ANIME", "status": "RELEASING", "sort": ["POPULARITY_DESC"], ... },
  "pagination": { "total": 171, "currentPage": 1, "lastPage": 9, "hasNextPage": true, "perPage": 20 },
  "pagination_source": "exact",
  "pagination_probes": 7,
  "count": 20,
  "data": [
    {
      "id": 21,                    // AniList ID
      "idMal": 21,                 // MyAnimeList ID
      "title": { "romaji": "ONE PIECE", "english": "ONE PIECE", "native": "ONE PIECE", "userPreferred": "ONE PIECE" },
      "coverImage": { ... },
      "episodes": 1175,
      "status": "RELEASING",
      "averageScore": 87,
      "popularity": 743285,
      "favourites": 109378,
      "startDate": { "year": 1999, "month": 10, "day": 20 },
      "endDate": null,
      "nextAiringEpisode": { "airingAt": 1787494560, "episode": 1175, "timeUntilAiring": 13714 },
      "genres": ["Action", "Adventure", ...],
      "studios": { "nodes": [{ "id": 18, "name": "Toei Animation", "isAnimationStudio": true }] },
      "siteUrl": "https://anilist.co/anime/21"
    }
    // ... 19 more
  ]
}
```

## Architecture

- **Runtime**: Vercel Node.js serverless functions (zero config — files in `/api` become endpoints).
- **No dependencies** — uses Node's built-in `fetch` (Node 18+) and `url` module.
- Each endpoint file is ~15 lines and delegates to a shared `_lib/anilist.js` helper that builds the GraphQL query, parses query parameters, and shapes the response.
- CORS-enabled + cached at the edge (`Cache-Control: public, max-age=60, s-maxage=300`).

## Local development

```bash
npm i -g vercel
vercel dev   # serves /api/* at http://localhost:3000
```

## License

MIT
