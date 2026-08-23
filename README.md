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
| `/api/trending-month` | RELEASING | POPULARITY_DESC | Released in last 30 days, sorted by popularity |
| `/api/upcoming` | NOT_YET_RELEASED | POPULARITY_DESC | Scheduled for future release |
| `/api/recently-completed` | FINISHED | END_DATE_DESC | Most-recently-finished → oldest |
| `/api/most-favourite` | — | FAVOURITES_DESC | All-time most favourited |
| `/api/new-added` | — | ID_DESC | Newest entries in AniList's database |
| `/api/popular` | — | POPULARITY_DESC | All-time most popular |
| `/api` | — | — | Self-documenting landing page listing all categories & params |

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
