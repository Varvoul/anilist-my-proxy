// api/_lib/jikan.js
// Mapping helpers that convert AniList GraphQL data into Jikan (MyAnimeList
// API v4) style response fields. Pure functions only — no I/O here.
//
// Everything the proxy returns is sourced from AniList. Where AniList has no
// equivalent for a Jikan field (e.g. MAL's official age rating string, studio
// MAL ids), the value is `null` and the endpoint documents that limitation.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

// AniList format enum -> Jikan `type` string
const FORMAT_TO_TYPE = {
  TV: "TV",
  TV_SHORT: "TV",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music",
};

// AniList source enum -> Jikan `source` string
const SOURCE_MAP = {
  ORIGINAL: "Original",
  MANGA: "Manga",
  LIGHT_NOVEL: "Light novel",
  NOVEL: "Novel",
  WEB_NOVEL: "Web novel",
  VISUAL_NOVEL: "Visual novel",
  VIDEO_GAME: "Video game",
  GAME: "Game",
  DOUJINSHI: "Doujinshi",
  ANIME: "Anime",
  COMIC: "Comic",
  LIVE_ACTION: "Live action",
  MULTIMEDIA_PROJECT: "Multimedia project",
  PICTURE_BOOK: "Picture book",
  OTHER: "Other",
};

// AniList status enum -> Jikan `status` string
const STATUS_MAP = {
  FINISHED: "Finished Airing",
  RELEASING: "Currently Airing",
  NOT_YET_RELEASED: "Not yet aired",
  CANCELLED: "Cancelled",
  HIATUS: "On Hiatus",
};

// AniList genres that MAL classifies as explicit genres
const EXPLICIT_GENRES = new Set(["Ecchi", "Erotica", "Hentai"]);

// AniList genre -> MAL genre id (used to build Jikan-style mal_id + url)
const GENRE_MAL_IDS = {
  Action: 1,
  Adventure: 2,
  Comedy: 4,
  Drama: 8,
  Fantasy: 10,
  Horror: 14,
  Mystery: 7,
  Romance: 22,
  "Sci-Fi": 24,
  "Slice of Life": 36,
  Sports: 30,
  Supernatural: 37,
  Thriller: 41,
  "Boys Love": 28,
  "Girls Love": 26,
  Hentai: 12,
  Erotica: 49,
  Ecchi: 9,
  "Award Winning": 46,
  Gourmet: 47,
  "Avant Garde": 5,
};

// AniList "genres" that MAL treats as themes (moved out of `genres`)
const GENRE_AS_THEME = {
  "Mahou Shoujo": 62,
  Mecha: 18,
  Music: 19,
  Psychological: 40,
};

// Well-known AniList tag names -> MAL theme ids (best-effort; null otherwise)
const TAG_THEME_MAL_IDS = {
  Demons: 6,
  Historical: 13,
  Mecha: 18,
  Music: 19,
  Parody: 20,
  Samurai: 21,
  School: 23,
  "Super Power": 31,
  Space: 29,
  Vampire: 32,
  Harem: 35,
  Military: 38,
  Psychological: 40,
  "Mahou Shoujo": 62,
  Isekai: 62, // MAL lists Isekai under theme id 62 (Mahou Shoujo namespace split is ambiguous) -> kept null-safe below
};
delete TAG_THEME_MAL_IDS.Isekai; // uncertain mapping — safer to return null

// AniList demographic tags -> MAL demographic ids
const DEMOGRAPHIC_MAL_IDS = {
  Shounen: 57,
  Shoujo: 25,
  Seinen: 42,
  Josei: 43,
  Kids: 15,
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function malGenreUrl(id, name) {
  if (id === null || id === undefined) return null;
  const slug = String(name).replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
  return `https://myanimelist.net/anime/genre/${id}/${slug}`;
}

function malTypeEntry(malId, name, type = "anime") {
  return { mal_id: malId ?? null, type, name, url: malId != null ? malGenreUrl(malId, name) : null };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// AniList FuzzyDate { year, month, day } -> ISO string "1998-04-03T00:00:00+00:00"
function fuzzyToIso(fuzzy) {
  if (!fuzzy || !fuzzy.year) return null;
  return `${fuzzy.year}-${pad2(fuzzy.month || 1)}-${pad2(fuzzy.day || 1)}T00:00:00+00:00`;
}

// AniList FuzzyDate -> Jikan string fragment "Apr 3, 1998"
function fuzzyToFriendly(fuzzy) {
  if (!fuzzy || !fuzzy.year) return null;
  const year = fuzzy.year;
  if (!fuzzy.month) return String(year);
  const month = MONTHS[fuzzy.month - 1] || "?";
  if (!fuzzy.day) return `${month} ${year}`;
  return `${month} ${fuzzy.day}, ${year}`;
}

// Jikan `aired` object
function buildAired(startDate, endDate) {
  const fromIso = fuzzyToIso(startDate);
  const toIso = fuzzyToIso(endDate);
  const fromStr = fuzzyToFriendly(startDate);
  const toStr = fuzzyToFriendly(endDate);

  let string;
  if (!fromStr && !toStr) string = "Not available";
  else if (fromStr && toStr) string = fromStr === toStr ? fromStr : `${fromStr} to ${toStr}`;
  else if (fromStr) string = `${fromStr} to ?`;
  else string = `? to ${toStr}`;

  return {
    from: fromIso,
    to: toIso,
    prop: {
      from: {
        day: startDate && startDate.day ? startDate.day : null,
        month: startDate && startDate.month ? startDate.month : null,
        year: startDate && startDate.year ? startDate.year : null,
      },
      to: {
        day: endDate && endDate.day ? endDate.day : null,
        month: endDate && endDate.month ? endDate.month : null,
        year: endDate && endDate.year ? endDate.year : null,
      },
    },
    string,
  };
}

// Jikan `duration` string
function buildDuration(duration, format) {
  if (!duration && duration !== 0) return null;
  if (format === "MOVIE" && duration >= 60) {
    const h = Math.floor(duration / 60);
    const m = duration % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }
  return `${duration} min per ep`;
}

// Broadcast info derived from an airing unix timestamp (AniList airing times
// correspond to the actual JST broadcast moment).
function broadcastFromUnix(unix) {
  if (!unix) return null;
  const jst = new Date((unix + 9 * 3600) * 1000);
  const day = WEEKDAYS_PLURAL[jst.getUTCDay()];
  const time = `${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())}`;
  return {
    string: `${day} at ${time} (JST)`,
    timezone: "Asia/Tokyo",
    day,
    time,
  };
}

// ISO timestamp (Jikan style, UTC) from an airing unix timestamp
function unixToIso(unix) {
  if (!unix) return null;
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

// ---------------------------------------------------------------------------
// Media-ish builders
// ---------------------------------------------------------------------------

// Jikan's Default title is the romaji title. AniList's `userPreferred` can
// differ (e.g. Chinese-origin shows where it is the English title), so romaji
// always wins here — falling back to userPreferred when romaji is absent.
function buildTitles(title, synonyms) {
  const titles = [];
  const romaji = title.romaji || title.userPreferred || null;
  if (romaji) titles.push({ type: "Default", title: romaji });
  const seen = new Set();
  for (const t of titles) seen.add(t.title);
  if (title.english && !seen.has(title.english)) {
    seen.add(title.english);
    titles.push({ type: "English", title: title.english });
  }
  if (title.native && !seen.has(title.native)) {
    seen.add(title.native);
    titles.push({ type: "Japanese", title: title.native });
  }
  for (const syn of synonyms || []) {
    if (seen.has(syn)) continue; // don't repeat romaji/english/native as Synonym
    seen.add(syn);
    titles.push({ type: "Synonym", title: syn });
  }
  return titles;
}

function buildImages(coverImage, bannerImage) {
  if (!coverImage) return null;
  // extraLarge is AniList's highest-quality cover and is used as the default
  // image_url, matching how Jikan serves MAL's largest standard cover.
  const jpg = {
    image_url: coverImage.extraLarge || coverImage.large || null,
    small_image_url: coverImage.medium || null,
    large_image_url: coverImage.extraLarge || coverImage.large || null,
  };
  return {
    jpg,
    webp: jpg,
    banner: {
      large: bannerImage || null,
      small: bannerImage || null,
    },
  };
}

function buildTrailer(trailer) {
  if (!trailer || !trailer.id) return null;
  const base = { thumbnail: trailer.thumbnail || null };
  if (trailer.site === "youtube") {
    return {
      youtube_id: trailer.id,
      url: `https://youtube.com/watch?v=${trailer.id}`,
      embed_url: `https://www.youtube.com/embed/${trailer.id}?enablejsapi=1&wmode=opaque&autoplay=1`,
      images: {
        image_url: trailer.thumbnail || `https://img.youtube.com/vi/${trailer.id}/hqdefault.jpg`,
        small_image_url: `https://img.youtube.com/vi/${trailer.id}/mqdefault.jpg`,
        medium_image_url: `https://img.youtube.com/vi/${trailer.id}/hqdefault.jpg`,
        maximum_image_url: trailer.thumbnail || `https://img.youtube.com/vi/${trailer.id}/maxresdefault.jpg`,
      },
      ...base,
    };
  }
  if (trailer.site === "dailymotion") {
    return {
      youtube_id: null,
      url: `https://www.dailymotion.com/video/${trailer.id}`,
      embed_url: `https://www.dailymotion.com/embed/video/${trailer.id}`,
      images: {
        image_url: trailer.thumbnail || null,
        small_image_url: trailer.thumbnail || null,
        medium_image_url: trailer.thumbnail || null,
        maximum_image_url: trailer.thumbnail || null,
      },
      ...base,
    };
  }
  return {
    youtube_id: null,
    url: null,
    embed_url: null,
    images: {
      image_url: trailer.thumbnail || null,
      small_image_url: trailer.thumbnail || null,
      medium_image_url: trailer.thumbnail || null,
      maximum_image_url: trailer.thumbnail || null,
    },
    ...base,
  };
}

// MAL age-rating approximation. AniList does not expose MAL's official rating,
// so we derive a best-effort value; null when there is no confident signal.
function deriveRating(isAdult, genres, tags) {
  if (isAdult) return "Rx - Hentai";
  const tagNames = new Set((tags || []).map((t) => t.name));
  if ((genres || []).includes("Ecchi") || tagNames.has("Ecchi") || tagNames.has("Nudity") || tagNames.has("Erotica")) {
    return "R+ - Mild Nudity";
  }
  if (tagNames.has("Gore") || tagNames.has("Violence")) {
    return "R - 17+ (violence & profanity)";
  }
  return null;
}

// Jikan-style arrays: producers / licensors / studios / genres /
// explicit_genres / demographics / themes
function buildTaxonomies(genres, tags, studioEdges) {
  const genresOut = [];
  const explicitOut = [];
  const themesOut = [];
  const seenThemes = new Set();

  const addTheme = (name, malId) => {
    if (!name || seenThemes.has(name)) return;
    seenThemes.add(name);
    themesOut.push(malTypeEntry(malId ?? null, name));
  };

  for (const genre of genres || []) {
    if (GENRE_AS_THEME[genre] !== undefined) {
      addTheme(genre, GENRE_AS_THEME[genre]);
      continue;
    }
    if (EXPLICIT_GENRES.has(genre)) {
      explicitOut.push(malTypeEntry(GENRE_MAL_IDS[genre] ?? null, genre));
      continue;
    }
    genresOut.push(malTypeEntry(GENRE_MAL_IDS[genre] ?? null, genre));
  }

  for (const tag of tags || []) {
    const category = tag.category || "";
    if (category === "Demographic" && DEMOGRAPHIC_MAL_IDS[tag.name] !== undefined) continue; // handled below
    if (category.startsWith("Theme")) addTheme(tag.name, TAG_THEME_MAL_IDS[tag.name] ?? null);
  }

  const demographicsOut = [];
  for (const tag of tags || []) {
    if (tag.category === "Demographic" && DEMOGRAPHIC_MAL_IDS[tag.name] !== undefined) {
      demographicsOut.push(malTypeEntry(DEMOGRAPHIC_MAL_IDS[tag.name], tag.name));
    }
  }

  // Studios: AniList `studios(isMain: true)` = animation studios; the rest are
  // production companies (≈ MAL producers). AniList does not expose MAL ids
  // for studios, so mal_id/url are null.
  const studiosOut = [];
  const producersOut = [];
  for (const edge of (studioEdges && studioEdges.edges) || []) {
    const node = edge && edge.node;
    if (!node) continue;
    const entry = { mal_id: null, type: "anime", name: node.name, url: null };
    if (edge.isMain) studiosOut.push(entry);
    else producersOut.push(entry);
  }

  // NOTE: no licensors array — AniList has no licensor data at all, so the
  // field is omitted entirely instead of returning a meaningless empty list.
  return {
    genres: genresOut,
    explicit_genres: explicitOut,
    themes: themesOut,
    demographics: demographicsOut,
    producers: producersOut,
    studios: studiosOut,
  };
}

function buildExternalLinks(links) {
  return (links || []).map((l) => ({
    name: l.site || null,
    url: l.url || null,
    mal_id: null,
    type: (l.type || "STREAMING").toLowerCase(),
  }));
}

function buildTags(tags) {
  return (tags || []).map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category || null,
    rank: t.rank ?? null,
    is_spoiler: !!(t.isMediaSpoiler || t.isGeneralSpoiler),
  }));
}

// "Episode 5 - Some Title" -> { episode: 5, title: "Some Title" }
function parseStreamingEpisode(se) {
  const raw = (se && se.title) || "";
  const m = raw.match(/^\s*Episode\s+(\d+)\s*(?:[-–—:]\s*(.*))?$/i);
  if (m) {
    return { episode: parseInt(m[1], 10), title: (m[2] && m[2].trim()) || `Episode ${m[1]}` };
  }
  return null;
}

module.exports = {
  FORMAT_TO_TYPE,
  SOURCE_MAP,
  STATUS_MAP,
  fuzzyToIso,
  fuzzyToFriendly,
  buildAired,
  buildDuration,
  broadcastFromUnix,
  unixToIso,
  buildTitles,
  buildImages,
  buildTrailer,
  deriveRating,
  buildTaxonomies,
  buildExternalLinks,
  buildTags,
  parseStreamingEpisode,
  malTypeEntry,
};
