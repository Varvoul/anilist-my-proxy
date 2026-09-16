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

## Item endpoints (single anime — MAL id OR AniList id)

These accept **either a MyAnimeList id or an AniList id** (auto-detected, since
the numeric ranges overlap) and return data shaped like the
[Jikan](https://jikan.moe) (MyAnimeList API v4) response format. All data is
sourced from AniList.

| Path | Description |
|---|---|
| `/api/{id}/full` | Full anime metadata: titles, images (incl. banner), trailer, mal_id/anilist_id, type, source, episodes, status, airing, aired (prop + string), duration, rating, score, scored_by, rank, popularity, members, favorites, description/synopsis, broadcast (JST), season/year/season_string, nextAiringEpisode, countryOfOrigin, averageScore/meanScore, producers/licensors/studios/genres/explicit_genres/demographics/themes, external_links, tags, title_synonyms |
| `/api/{id}/episodes` | Episode list with titles, thumbnails, streaming url, aired timestamps, duration. Pagination info at the top (`last_visible_page`, `has_next_page`, `current_page`, `items.{count,total,per_page}`) |

Item endpoint query parameters:

| Param | Default | Notes |
|---|---|---|
| `page` | 1 | Episodes page (1-indexed) |
| `perPage` | 50 | Episodes per page — 50 is AniList's maximum supported page size (values above are capped) |
| `idType` | auto | `anilist` or `mal` — force how the numeric id is interpreted |
| `refresh` | false | `true`/`1` bypasses the cache and refetches from AniList |

### ID auto-detection

1. The id is first tried as an AniList id. If the entry's own `idMal` equals
   the number, the id identifies the same show in both databases.
2. If not found (or the numbers map to different shows — rare), the id is
   checked as a MAL id. In the rare ambiguous case the response contains
   `detected.ambiguous: true` with a `note` describing both matches; the
   AniList interpretation is used by default and `?idType=mal` selects the other.

### Caching

Both item endpoints cache responses **server-side for 4 hours** (auto-expiry —
once expired, the next visit fetches fresh data from AniList) and are also
served with CDN headers (`s-maxage=14400, stale-while-revalidate=14400`). Use
`?refresh=1` to force a fresh fetch. Every response reports its cache state in
the `cache` object.

### AniList data limitations (returned as `null`)

AniList's GraphQL API does not expose: MAL's official age-rating string
(`rating` is derived from genres/tags instead), studio MAL ids
(`studios`/`producers` have `mal_id: null`), licensors, opening/ending themes,
per-episode user scores, per-episode OP/ED timings, or filler/recap flags.
These fields are present in the response shape but `null`/empty, and each
response carries `notes` documenting this.

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
  "pagination": { "total": 5000, "currentPage": 1, "lastPage": 250, "hasNextPage": true, "perPage": 20 },
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
