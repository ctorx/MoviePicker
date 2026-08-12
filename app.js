"use strict";

const APP_VERSION = "2.35.0";

// ---------- State (localStorage) ----------

const store = {
  load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

// A search is for the session it was made in unless you say otherwise: the
// rating cap, the year and every advanced filter start blank next time,
// rather than a setting from days ago quietly shaping tonight's picks. The
// toggle in Settings is how you say otherwise (see saveSearch).
// Whatever an older version left alongside the key is read past and dropped.
const savedSettings = store.load("mp_settings", {});
let settings = {
  apiKey: String(savedSettings.apiKey || ""),
  rememberSearch: !!savedSettings.rememberSearch,
};
let lists = store.load("mp_lists", {});
normalizeLists();

function normalizeLists() {
  // v1 called the blocked list "never".
  if (lists.never) {
    lists.blocked = { ...lists.never, ...(lists.blocked || {}) };
    delete lists.never;
  }
  // Favorites became the watchlist in v2.20; same list, clearer name.
  if (lists.favorites) {
    lists.watchlist = { ...lists.favorites, ...(lists.watchlist || {}) };
    delete lists.favorites;
  }
  // Skips used to be tracked; they're ephemeral now.
  delete lists.skipped;
  for (const name of ["watchlist", "seen", "blocked"]) {
    if (!lists[name] || typeof lists[name] !== "object") lists[name] = {};
  }
  // Marking a movie seen only started taking it off the watchlist recently,
  // so older data has movies on both — and the watchlist is what feeds them
  // back into the rotation.
  let changed = false;
  for (const id of Object.keys(lists.watchlist)) {
    if (lists.seen[id] || lists.blocked[id]) {
      delete lists.watchlist[id];
      changed = true;
    }
  }
  if (changed) saveLists();
}

function saveSettings() {
  store.save("mp_settings", {
    apiKey: settings.apiKey,
    rememberSearch: settings.rememberSearch,
  });
}
function saveLists() { store.save("mp_lists", lists); }

// Session-only search filters (advanced is off by default on every start).
const search = {
  query: "", // a title or word to look up; switches the pool off discover
  queryMode: "title", // "title", or "anything" for titles plus topic tags
  relatedId: null, // rotating through one movie's recommendations
  relatedTitle: "",
  browse: "", // "popular" or "recent" — a ready-made list instead of a search
  maxCert: "", // highest US rating allowed; "" is no limit
  fromYear: null,
  advanced: false,
  genres: new Set(),
  genreMode: "all", // "all" = must have every selected genre, "any" = at least one
  actors: "",
  actorIds: [],
  actorNames: [],
  director: "",
  directorIds: [],
  directorNames: [],
  composer: "",
  composerIds: [],
  composerNames: [],
  studios: "",
  studioIds: [],
  studioNames: [],
  medium: "", // production format, one at a time (see MEDIUMS)
  obscurity: "known", // how far below the popularity floor picks may go (see OBSCURITY)
  providers: new Set(), // streaming services picks must be available on (see PROVIDERS)
  budget: "", // MONEY range key, "" = any
  revenue: "",
  englishOnly: false,
  includeSeen: false, // lists are held out of picks unless asked for
  includeWatchlist: false,
  maxRuntime: 0, // 0 = no limit
};

// What a kept search is made of, and what each value has to look like coming
// back. Storage can hold anything — an old version's shape, a half-written
// entry — and a filter of the wrong type would misfire with nothing on screen
// to explain it, so anything that doesn't fit keeps its default instead.
//
// A ready-made rotation isn't in here: popular, recent and one movie's
// recommendations are somewhere you went, not a search you set up, so they
// never overwrite the search being kept.
const SAVED_SEARCH = {
  query: "text", queryMode: "text",
  maxCert: "text", fromYear: "year", advanced: "flag",
  genreMode: "text", medium: "text", obscurity: "text",
  actors: "text", actorIds: "list", actorNames: "list",
  director: "text", directorIds: "list", directorNames: "list",
  composer: "text", composerIds: "list", composerNames: "list",
  studios: "text", studioIds: "list", studioNames: "list",
  budget: "text", revenue: "text",
  englishOnly: "flag", includeSeen: "flag", includeWatchlist: "flag",
  maxRuntime: "count",
};

function saveSearch() {
  if (!settings.rememberSearch) return;
  const out = { genres: [...search.genres], providers: [...search.providers] };
  for (const k of Object.keys(SAVED_SEARCH)) out[k] = search[k];
  store.save("mp_search", out);
}

function forgetSearch() { store.save("mp_search", null); }

function restoreSearch() {
  if (!settings.rememberSearch) return;
  const saved = store.load("mp_search", null);
  if (!saved || typeof saved !== "object") return;
  for (const [k, kind] of Object.entries(SAVED_SEARCH)) {
    const v = saved[k];
    if (kind === "list") { if (Array.isArray(v)) search[k] = v; }
    else if (kind === "flag") search[k] = !!v;
    else if (kind === "count") { if (Number.isFinite(v)) search[k] = v; }
    else if (kind === "year") { if (v === null || Number.isFinite(v)) search[k] = v; }
    else if (typeof v === "string") search[k] = v;
  }
  // Genre ids go straight onto a TMDB request, and a service that no longer
  // exists is one nothing will ever match.
  search.genres = new Set((saved.genres || []).filter(Number.isFinite));
  search.providers = new Set(
    (saved.providers || []).filter((k) => PROVIDERS.some((p) => p.key === k))
  );
}

// ---------- TMDB API ----------

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";
const IMG_SMALL = "https://image.tmdb.org/t/p/w154";

function tmdbFetch(path, params = {}) {
  const url = new URL(TMDB + path);
  const key = settings.apiKey.trim();
  const opts = {};
  if (key.startsWith("eyJ")) {
    // v4 Read Access Token
    opts.headers = { Authorization: "Bearer " + key };
  } else {
    params.api_key = key;
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, opts).then((res) => {
    if (res.status === 401) throw new Error("TMDB rejected the API key. Check it in Settings.");
    if (!res.ok) throw new Error("TMDB request failed (" + res.status + ").");
    return res.json();
  });
}

// Everything a pick needs to be verified and rendered, in one request.
function fetchMovie(id) {
  return tmdbFetch("/movie/" + id, {
    append_to_response: "credits,videos,release_dates,keywords,watch/providers",
  });
}

// US certifications allowed for the youngest viewer's age.
const CERT_RANK = { G: 0, PG: 1, "PG-13": 2, R: 3, "NC-17": 4 };

function certOf(m) {
  const us = (m.release_dates?.results || []).find((r) => r.iso_3166_1 === "US");
  const withCert = (us?.release_dates || []).find((d) => d.certification);
  return withCert ? withCert.certification : "";
}

// TMDB's certification.lte filter leaks unrated and miscertified titles, so
// every pick is re-checked against the movie's real US certification below.
// No cap means no check. With one, a movie TMDB has no US rating for is left
// out: an unknown rating can't be shown to have cleared the bar.
function certAllowed(m) {
  if (!search.maxCert) return true;
  const cert = certOf(m);
  return cert in CERT_RANK && CERT_RANK[cert] <= CERT_RANK[search.maxCert];
}

// ---------- Production format ----------

// TMDB has no field for how a movie was made, so every format except live
// action rides on its keyword tags — a format matches any one of its keywords.
// The ids and their pool sizes (under this app's vote floors) were checked
// against TMDB on 2026-08-09; the comment on each line is the keyword's name,
// which is what to re-resolve against /search/keyword if one ever goes quiet.
//
// Coverage is contributor-supplied and uneven: a format finds the movies TMDB
// has tagged, not every movie that qualifies.
const MEDIUMS = [
  // Live action is the one that needs no keywords: it's "not animated", and
  // without_genres is its own parameter, so it ANDs cleanly with the rest.
  { key: "live", label: "Live action", withoutGenre: 16 }, // ~8100
  { key: "animated", label: "Animated", withGenre: 16 }, // ~1400
  { key: "stopmotion", label: "Stop motion", keywordIds: [
    10121,  // stop motion
    358482, // stop motion animation
    378665, // stopmotion
    197065, // claymation
    290380, // puppet animation
    214793, // cutout animation
    254209, // pixilation
  ] }, // ~47
  { key: "handdrawn", label: "Hand-drawn", keywordIds: [
    367675, // traditional animation
    234662, // hand drawn animation
    243752, // cel animation
    366485, // 2d animation
    11237,  // rotoscoping
  ] }, // ~17
  { key: "cgi", label: "CGI", keywordIds: [
    10159,  // computer animation
    278823, // 3d animation
    196544, // motion capture
  ] }, // ~388
  { key: "anime", label: "Anime", keywordIds: [210024] }, // anime, ~240
  { key: "mixed", label: "Mixed media", keywordIds: [
    209220, // live action and animation
    267537, // mixed media
  ] }, // ~67
  { key: "puppets", label: "Puppets", keywordIds: [
    6300,   // puppet
    11691,  // puppetry
    263312, // puppets
  ] }, // ~30
  { key: "foundfootage", label: "Found footage", keywordIds: [163053] }, // ~69
  { key: "silent", label: "Silent", keywordIds: [154802] }, // silent film, ~41
  { key: "bw", label: "Black & white", keywordIds: [
    12999,  // black and white
    363676, // black-and-white
  ] }, // ~263
];

const mediumByKey = (key) => MEDIUMS.find((m) => m.key === key);

function mediumParams(p) {
  const m = mediumByKey(search.medium);
  if (!m) return;
  if (m.withoutGenre) p.without_genres = String(m.withoutGenre);
  if (m.keywordIds) p.with_keywords = m.keywordIds.join("|"); // any of them
  if (m.withGenre) {
    // Animation is a genre, so it shares with_genres with the genre chips.
    // TMDB honours mixed precedence — "35|12,16" is (comedy or adventure)
    // AND animated — so the format ANDs on cleanly in either genre mode.
    const chosen = [...search.genres].join(search.genreMode === "any" ? "|" : ",");
    p.with_genres = chosen ? chosen + "," + m.withGenre : String(m.withGenre);
  }
}

// The keyword tags a discover search matched on, re-checked against a loaded
// movie (for title results and injected watchlist picks, which skip discover).
function mediumOk(movie) {
  const m = mediumByKey(search.medium);
  if (!m) return true;
  const genres = (movie.genres || []).map((g) => g.id);
  if (m.withoutGenre && genres.includes(m.withoutGenre)) return false;
  if (m.withGenre && !genres.includes(m.withGenre)) return false;
  if (m.keywordIds) {
    const tags = (movie.keywords?.keywords || []).map((k) => k.id);
    if (!m.keywordIds.some((id) => tags.includes(id))) return false;
  }
  return true;
}

// ---------- Money ----------

// Discover can't filter on budget or box office — there is no parameter for
// either — so both are checked on the loaded movie instead. TMDB stores an
// unknown figure as 0, which is why a range never matches one: a movie with no
// budget on record isn't a movie made for under a million.
const BUDGET_RANGES = [
  { key: "u1", label: "Under $1M", min: 1, max: 1e6 },
  { key: "1-10", label: "$1M – $10M", min: 1e6, max: 1e7 },
  { key: "10-50", label: "$10M – $50M", min: 1e7, max: 5e7 },
  { key: "50-100", label: "$50M – $100M", min: 5e7, max: 1e8 },
  { key: "100-200", label: "$100M – $200M", min: 1e8, max: 2e8 },
  { key: "o200", label: "Over $200M", min: 2e8, max: 0 },
];

const REVENUE_RANGES = [
  { key: "u1", label: "Under $1M", min: 1, max: 1e6 },
  { key: "1-10", label: "$1M – $10M", min: 1e6, max: 1e7 },
  { key: "10-50", label: "$10M – $50M", min: 1e7, max: 5e7 },
  { key: "50-100", label: "$50M – $100M", min: 5e7, max: 1e8 },
  { key: "100-500", label: "$100M – $500M", min: 1e8, max: 5e8 },
  { key: "500-1000", label: "$500M – $1B", min: 5e8, max: 1e9 },
  { key: "o1000", label: "Over $1B", min: 1e9, max: 0 },
];

const rangeByKey = (ranges, key) => ranges.find((r) => r.key === key);

const budgetRange = () => rangeByKey(BUDGET_RANGES, search.budget);
const revenueRange = () => rangeByKey(REVENUE_RANGES, search.revenue);

function inMoneyRange(value, range) {
  if (!range) return true;
  if (!value) return false; // 0 means "not on record", not "nothing"
  if (range.min && value < range.min) return false;
  if (range.max && value >= range.max) return false;
  return true;
}

function moneyOk(m) {
  if (!search.advanced) return true;
  return inMoneyRange(m.budget, budgetRange()) && inMoneyRange(m.revenue, revenueRange());
}

// A range that only big films can satisfy is worth reordering the pool for.
function moneySorted() {
  const big = (r) => r && r.min >= 1e8;
  return search.advanced && (big(budgetRange()) || big(revenueRange()));
}

// Pages a random pick may sample. A revenue-sorted pool keeps its matches at
// the front, so sampling has to stay there — page 200 of 300 is past them all.
const MONEY_SORT_PAGES = 25;

// TMDB publishes nothing about dubbing — no audio tracks, no dub availability —
// so "not foreign" can only mean the movie's own language.
function englishOk(m) {
  if (!search.advanced || !search.englishOnly) return true;
  return m.original_language === "en";
}

function studioOk(m) {
  if (!search.advanced || !search.studioIds.length) return true;
  // Co-productions list several studios; one match is enough.
  return (m.production_companies || []).some((c) => search.studioIds.includes(c.id));
}

// How obscure a pick is allowed to get.
//
// TMDB holds over a million movies, and most of them are shorts, festival
// entries and straight-to-video titles with a handful of votes. A vote floor
// is what keeps a pick watchable, but it's the user's call, so it's a setting
// rather than a rule — the trade-off is spelled out on the search screen.
//
// Depth is the other half of it, and the reason the loosest setting still
// works. Picks come from a random page of a list sorted by popularity, so how
// far down that list we're willing to reach decides what turns up. Sampled
// against TMDB on 2026-08-12 (comedy, PG-13, 2010 and newer): with the strict
// floor, page 25 of 44 was still all well-known films; with no floor at all,
// page 25 was fine, page 50 was a quarter no-name titles and page 150 was
// almost nothing else. So the weaker the floor, the shallower we sample.
const OBSCURITY = [
  { key: "known", label: "Well-known movies only", votes: 200, score: 6, depth: 300 },
  { key: "lesser", label: "Include lesser-known movies", votes: 25, score: 0, depth: 50 },
  { key: "any", label: "Anything at all", votes: 0, score: 0, depth: 40 },
];

// An advanced filter like any other: switching the box off puts the default
// floor back, and so do the ready-made lists, which aren't a search to narrow.
const obscurityLevel = () =>
  (search.advanced && OBSCURITY.find((o) => o.key === search.obscurity)) || OBSCURITY[0];

// Streaming services, with TMDB's ids for them (checked for the US region on
// 2026-08-12). TMDB lists 291 providers, most of them single-subject channels
// nobody subscribes to; these are the ones worth a chip. A service can be sold
// direct and as a channel inside someone else's store, and TMDB gives each of
// those its own id, so one service is a list of ids.
const PROVIDERS = [
  { key: "netflix", label: "Netflix", ids: [8, 1796] },
  { key: "prime", label: "Prime Video", ids: [9, 2100] },
  { key: "disney", label: "Disney+", ids: [337] },
  { key: "hulu", label: "Hulu", ids: [15] },
  { key: "max", label: "HBO Max", ids: [1899, 1825] },
  { key: "appletv", label: "Apple TV+", ids: [350, 2243] },
  { key: "paramount", label: "Paramount+", ids: [2616, 2303, 582, 633] },
  { key: "peacock", label: "Peacock", ids: [386, 387, 2553] },
  { key: "starz", label: "Starz", ids: [43, 1794, 1855, 634] },
  { key: "amc", label: "AMC+", ids: [526, 528, 635, 1854] },
  { key: "shudder", label: "Shudder", ids: [99, 204, 2049] },
  { key: "criterion", label: "Criterion", ids: [258] },
  { key: "britbox", label: "BritBox", ids: [151, 197, 1852] },
  { key: "crunchyroll", label: "Crunchyroll", ids: [283, 1968] },
  { key: "tubi", label: "Tubi", ids: [73] },
  { key: "pluto", label: "Pluto TV", ids: [300] },
  { key: "roku", label: "Roku Channel", ids: [207] },
  { key: "plex", label: "Plex", ids: [538, 2077] },
  { key: "kanopy", label: "Kanopy", ids: [191] },
  { key: "hoopla", label: "Hoopla", ids: [212] },
];

// TMDB's availability data is per country, and the rest of the app is already
// US-only (certifications come from there too).
const WATCH_REGION = "US";
// Included with a subscription, free, or free with ads — never rent or buy.
const WATCH_TYPES = "flatrate|free|ads";

function providerIds() {
  const ids = [];
  for (const p of PROVIDERS) if (search.providers.has(p.key)) ids.push(...p.ids);
  return ids;
}

function providerLabels() {
  return PROVIDERS.filter((p) => search.providers.has(p.key)).map((p) => p.label);
}

// Where a movie can be watched at no extra cost, deduplicated: a service that
// sells itself twice over is still one place to watch.
function watchOptions(m) {
  const region = (m["watch/providers"]?.results || {})[WATCH_REGION] || {};
  const all = [...(region.flatrate || []), ...(region.free || []), ...(region.ads || [])];
  return [...new Map(all.map((p) => [p.provider_id, p])).values()];
}

// Discover filters by service server-side. A title search, a related list and
// a browse list don't, so the loaded movie gets checked against the same set.
function providerOk(m) {
  if (!search.advanced || !search.providers.size) return true;
  const want = new Set(providerIds());
  return watchOptions(m).some((p) => want.has(p.provider_id));
}

function discoverParams(page) {
  const floor = obscurityLevel();
  const p = {
    sort_by: "popularity.desc",
    include_adult: "false",
    page: String(page),
  };
  // Enough votes that the score means something, and a floor that keeps picks
  // watchable. Discover applies these; a subject search applies them itself.
  if (floor.votes) p["vote_count.gte"] = String(floor.votes);
  if (floor.score) p["vote_average.gte"] = String(floor.score);
  if (search.maxCert) {
    p.certification_country = "US";
    p["certification.lte"] = search.maxCert;
  }
  if (search.fromYear) p["primary_release_date.gte"] = search.fromYear + "-01-01";
  if (search.advanced) {
    if (search.genres.size) {
      // TMDB reads a comma as AND and a pipe as OR. Every other filter
      // (cast, crew, runtime, year, certification) is a separate parameter,
      // so it still ANDs with whichever genre mode is in play.
      p.with_genres = [...search.genres].join(search.genreMode === "any" ? "|" : ",");
    }
    if (search.actorIds.length) p.with_cast = search.actorIds.join(",");
    const crewIds = [...search.directorIds, ...search.composerIds];
    if (crewIds.length) p.with_crew = crewIds.join(",");
    if (search.actorIds.length || crewIds.length) {
      // Personal filmographies are small; the popularity floors would empty
      // them out. Only ever loosens — a level set below this keeps its own.
      if (floor.votes > 10) p["vote_count.gte"] = "10";
      delete p["vote_average.gte"];
    }
    // A film matches if the studio is any one of its production companies,
    // and if several were typed, any one of those counts.
    if (search.studioIds.length) p.with_companies = search.studioIds.join("|");
    // Any one of the chosen services will do, and rentals don't count.
    const provs = providerIds();
    if (provs.length) {
      p.with_watch_providers = provs.join("|");
      p.watch_region = WATCH_REGION;
      p.with_watch_monetization_types = WATCH_TYPES;
    }
    if (search.englishOnly) p.with_original_language = "en";
    if (search.maxRuntime) p["with_runtime.lte"] = String(search.maxRuntime);
    mediumParams(p);

    // Money is filtered on the loaded movie, so a demanding range would
    // otherwise mean rejecting picks one at a time through a pool sorted by
    // popularity. Ordering by takings puts the matches at the front instead.
    if (moneySorted()) p.sort_by = "revenue.desc";
  }
  return p;
}

// with_crew matches any crew role, so confirm the actual job on each pick.
function crewOk(m) {
  if (!search.advanced) return true;
  const crew = m.credits?.crew || [];
  if (search.directorIds.length &&
      !crew.some((c) => c.job === "Director" && search.directorIds.includes(c.id))) {
    return false;
  }
  if (search.composerIds.length &&
      !crew.some((c) => search.composerIds.includes(c.id) && /composer|music/i.test(c.job || ""))) {
    return false;
  }
  return true;
}

// Every filter discover normally applies server-side, re-checked against a
// fully loaded movie. Needed wherever a candidate didn't come from discover:
// injected watchlist picks, and title searches (/search/movie takes no filters).
function matchesSearch(m) {
  if (!certAllowed(m)) return false;
  const year = parseInt((m.release_date || "").slice(0, 4), 10);
  if (search.fromYear && !(year >= search.fromYear)) return false;
  if (!search.advanced) return true;
  if (search.genres.size) {
    const ids = (m.genres || []).map((g) => g.id);
    const want = [...search.genres];
    const ok = search.genreMode === "any"
      ? want.some((g) => ids.includes(g))
      : want.every((g) => ids.includes(g));
    if (!ok) return false;
  }
  if (search.maxRuntime && m.runtime && m.runtime > search.maxRuntime) return false;
  if (!mediumOk(m) || !moneyOk(m) || !englishOk(m) || !studioOk(m) || !providerOk(m)) return false;
  const cast = m.credits?.cast || [];
  if (!search.actorIds.every((id) => cast.some((c) => c.id === id))) return false;
  return crewOk(m);
}

// What a discover result still has to prove: its real certification, the exact
// crew job behind a with_crew hit, and the money figures discover can't filter.
function verifyPick(m) {
  return certAllowed(m) && crewOk(m) && moneyOk(m);
}

// Order means nothing in a pool that gets shuffled, but what's in it does.
// Neither TMDB's search nor its recommendations carry a quality floor, so
// this applies whichever one the search asked for.
function worthWatching(movies) {
  const floor = obscurityLevel();
  if (!floor.votes && !floor.score) return movies;
  const worth = movies.filter(
    (m) => (m.vote_count || 0) >= floor.votes && (m.vote_average || 0) >= floor.score
  );
  return worth.length ? worth : movies;
}

// ---------- Query lookups ----------

// Discover has no query parameter, so a typed query goes through /search/movie
// and is ordered here instead: closest matches first, and within equally close
// matches oldest to newest, so a series plays in the order it was released.
//
// "Anything" mode widens that. TMDB's search covers titles only — there is no
// endpoint that searches descriptions — so the width comes from its keyword
// tags, which is where "movies about X" actually lives in TMDB's data. The
// description still counts for ordering: a movie whose overview mentions the
// word ranks above one that only carries the tag.

const broadSearch = () => !!search.query && search.queryMode === "anything";

// Naming a movie is asking for that movie. Whether it's already on a list
// doesn't come into it — being told there are no matches for a title you can
// see in your own watchlist would just look broken.
const titleLookup = () => !!search.query && search.queryMode === "title";

// Either of these replaces discover with a pool of its own.
const fixedPool = () => !!search.query || !!search.relatedId || !!search.browse;

function titleWords(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ");
}

function startsWithWords(words, prefix) {
  return prefix.every((w, i) => words[i] === w);
}

// 0 = the title is exactly the query, 1 = it opens with it ("Harry Potter
// and…"), 2 = it contains it ("…World of Harry Potter"), 3 = TMDB matched it
// some looser way (a typo, an alternate title).
function titleRank(title, query) {
  const t = titleWords(title || "");
  const q = titleWords(query);
  if (!q[0]) return 3;
  if (startsWithWords(t, q)) return t.length === q.length ? 0 : 1;
  for (let i = 1; i <= t.length - q.length; i++) {
    if (startsWithWords(t.slice(i), q)) return 2;
  }
  return 3;
}

function byMatchThenRelease(query) {
  return (a, b) => {
    const rank = titleRank(a.title, query) - titleRank(b.title, query);
    if (rank) return rank;
    // Undated entries sort last rather than leading the series.
    return (a.release_date || "9999").localeCompare(b.release_date || "9999");
  };
}

// Where the word was found weights popularity rather than overriding it.
// Ranking strictly by where it matched buries every tagged movie behind the
// full run of obscure titles that happen to contain the word — search
// "zombie" and 28 Days Later lands past forty of them, which reads as a search
// that never left the titles at all.
// Sorting needs the whole result set, so it's fetched once per query and kept:
// stepping through a series costs one request per movie, not five. In broad
// mode the filters shape the tag half of the pool, so they belong in the key.
function queryPoolKey() {
  if (search.browse) return "browse:" + search.browse + ":" + search.maxCert;
  if (search.relatedId) return "related:" + search.relatedId;
  return broadSearch()
    ? "any:" + search.query.toLowerCase() + ":" + JSON.stringify(discoverParams(1))
    : "title:" + search.query.toLowerCase();
}

let queryPool = { key: null, movies: [], total: 0, done: true };

// The tags TMDB knows for this word — "zombie", "time travel", "dystopia".
//
// A tag can be broader than what was typed ("zombie apocalypse" for "zombie")
// or narrower ("dystopia" for "dystopian"), so containment counts both ways.
// Requiring the tag to contain the word is what made "dystopian" find nothing
// at all: TMDB files those under "dystopia". The length floor is what keeps
// the reverse direction honest — without it "time travel" would match a bare
// "time" tag and drag in everything under it. Both sides are stripped of
// punctuation first, so "post-apocalyptic" and "post apocalyptic" agree.
const TAG_MIN_LEN = 5;

function tagMatchesTerm(name, term) {
  const tag = titleWords(name).join(" ");
  const q = titleWords(term).join(" ");
  if (!tag || !q) return false;
  return tag.includes(q) || (q.includes(tag) && tag.length >= TAG_MIN_LEN);
}

// TMDB matches the query as a substring of the tag's name, so a word can never
// turn up the tag it was derived from: asking for "dystopian" is exactly how
// you miss "dystopia" — the tag holding Mad Max, Dune and Interstellar, 93
// movies since 2010, against none under every "dystopian" tag combined.
// Trimming the word back a couple of letters surfaces both spellings, and the
// filter above discards whatever else the shorter query drags in.
const STEM_MIN_LEN = 6;

async function topicKeywordIds(term) {
  const queries = [term];
  if (term.length >= STEM_MIN_LEN) queries.push(term.slice(0, -2));
  const found = new Map();
  for (const query of queries) {
    try {
      const r = await tmdbFetch("/search/keyword", { query });
      for (const k of r.results || []) {
        if (tagMatchesTerm(k.name, term)) found.set(k.id, k.name);
      }
    } catch {
      // Titles alone still make a pool.
    }
  }
  // Shortest name first: the broadest tag holds by far the most movies, and
  // only a handful of ids are worth putting on the request.
  return [...found.entries()]
    .sort((a, b) => a[1].length - b[1].length)
    .slice(0, 5)
    .map(([id]) => id);
}

const RECENT_MONTHS = 6;

// The request behind whichever ready-made list is showing.
function browsePage(page) {
  if (search.browse !== "recent") {
    return ["/movie/popular", { page: String(page) }];
  }
  const until = new Date();
  const from = new Date(until.getFullYear(), until.getMonth() - RECENT_MONTHS, until.getDate());
  const day = (d) => d.toISOString().slice(0, 10);
  const params = {
    include_adult: "false",
    sort_by: "popularity.desc",
    "primary_release_date.gte": day(from),
    "primary_release_date.lte": day(until),
    // Low enough for a new release, high enough to sift — unless the search
    // asked to see more obscure things, in which case that wins.
    "vote_count.gte": String(Math.min(50, obscurityLevel().votes)),
    page: String(page),
  };
  if (search.maxCert) {
    params.certification_country = "US";
    params["certification.lte"] = search.maxCert;
  }
  return ["/discover/movie", params];
}

// A pool loads a few pages before the first pick and more as you swipe, so a
// search runs out when TMDB does rather than when the opening fetch did.
// Pages are 20 movies, so the cap below is 500 of them.
const POOL_MAX_PAGES = 25;
const POOL_TOP_UP = 3; // pages pulled in at a time once it starts running low
const POOL_LOW_WATER = 15; // unseen movies left before topping up
const POOL_TOP_UPS_PER_PICK = 3; // stops a heavily filtered pool loading all night

// Sources are read in order and each knows when it's spent. A subject search
// has two: TMDB's title matches, then the movies tagged with that topic.
function poolSource(fetch, maxPages) {
  return { fetch, maxPages, page: 0, done: false, total: 0 };
}

// How many of a source's movies this search could ever reach: what TMDB says
// it holds, or as deep as we're willing to page, whichever runs out first.
const sourceReach = (src) => Math.min(src.total, src.maxPages * 20);

// Pulls pages from the first source with any left. Returns false if a newer
// pick has started, in which case the pool is left exactly as it was.
async function growPool(pool, pages, token) {
  for (let i = 0; i < pages; i++) {
    const src = pool.sources.find((s) => !s.done);
    if (!src) break;
    const data = await src.fetch(src.page + 1);
    if (token !== pickToken) return false;
    src.page++;
    src.total = data.total_results || 0;
    if (src.page >= Math.min(data.total_pages || 1, src.maxPages)) src.done = true;
    for (const m of data.results || []) {
      if (pool.ids.has(m.id)) continue;
      pool.ids.add(m.id);
      pool.from.set(m.id, src);
      pool.raw.push(m);
    }
  }
  pool.done = pool.sources.every((s) => s.done);
  pool.finish(pool);
  return true;
}

async function ensureQueryPool(token) {
  const key = queryPoolKey();
  if (queryPool.key === key) return true;

  const pool = {
    key, raw: [], ids: new Set(), from: new Map(), movies: [], total: 0,
    sources: [], done: false, opening: 4, finish: null,
  };

  if (search.browse) {
    // Ready-made lists. Popular is TMDB's own; recent is a discover search
    // over the last few months, because TMDB's now_playing list isn't what
    // its name suggests — it hands back films years old alongside this
    // month's.
    pool.sources.push(poolSource((p) => tmdbFetch(...browsePage(p)), POOL_MAX_PAGES));
    pool.finish = (pl) => {
      pl.movies = pl.raw;
      pl.total = sourceReach(pl.sources[0]);
    };
  } else if (search.relatedId) {
    // TMDB's own recommendations: what people who liked this one went on to
    // like. The tail gets thin, so this one usually stops on its own.
    pool.opening = 3;
    pool.sources.push(poolSource(
      (p) => tmdbFetch("/movie/" + search.relatedId + "/recommendations", { page: String(p) }),
      POOL_MAX_PAGES
    ));
    pool.finish = (pl) => {
      pl.movies = worthWatching(pl.raw.filter((m) => m.id !== search.relatedId));
      pl.total = pl.movies.length;
    };
  } else {
    const titleFetch = (p) =>
      tmdbFetch("/search/movie", {
        query: search.query,
        include_adult: "false",
        page: String(p),
      });

    if (!broadSearch()) {
      // A title walks a whole series in release order, so it takes the tail.
      pool.opening = 5;
      pool.sources.push(poolSource(titleFetch, POOL_MAX_PAGES));
      pool.finish = (pl) => {
        pl.movies = pl.raw.slice().sort(byMatchThenRelease(search.query));
        pl.total = sourceReach(pl.sources[0]);
      };
    } else {
      // A subject needs only TMDB's best title matches — past those it's
      // padding that would sort to the bottom anyway. The tagged movies are
      // where the depth is, so that's the source that keeps going.
      const titleSrc = poolSource(titleFetch, 3);
      pool.sources.push(titleSrc);
      pool.opening = 7;
      const ids = await topicKeywordIds(search.query);
      if (token !== pickToken) return false;
      if (ids.length) {
        pool.sources.push(poolSource(
          // The current filters apply, except with_keywords, which the topic
          // takes over — a chosen format is still checked on each pick.
          (p) => tmdbFetch("/discover/movie",
            { ...discoverParams(p), with_keywords: ids.join("|") }),
          POOL_MAX_PAGES
        ));
      }
      pool.finish = (pl) => {
        // Title results carry no quality floor of their own, so a subject
        // search would otherwise mix Interstellar with forty straight-to-video
        // films that happen to have the word in the title.
        pl.movies = worthWatching(pl.raw);
        // What the search can reach: every tagged movie TMDB has, plus the
        // title matches good enough to keep. Counting all the title hits
        // instead would promise hundreds the floor is about to throw out.
        const tags = pl.sources[1];
        const kept = pl.movies.filter((m) => pl.from.get(m.id) === titleSrc).length;
        pl.total = (tags ? sourceReach(tags) : 0) + kept;
      };
    }
  }

  if (!(await growPool(pool, pool.opening, token))) return false;
  queryPool = pool;
  return true;
}

async function pickFromQuery(token) {
  if (!(await ensureQueryPool(token))) return;

  if (announceCount) {
    announceCount = false;
    if (queryPool.total > 0) {
      showToast(
        queryPool.total.toLocaleString() + (queryPool.total === 1 ? " match" : " matches"),
        null,
        2000
      );
    }
  }

  // Saved, seen or blocked, it's spoken for and stays out of the picks — but
  // never out of a title lookup, which is someone asking for one movie by name.
  const excluded = titleLookup() ? new Set() : excludedIds();
  const pickable = () => queryPool.movies.filter((m) => m.poster_path && !excluded.has(m.id));
  let usable = pickable();
  let unseen = usable.filter((m) => !sessionShown.has(m.id));

  // Running low with more to be had: top the pool up before it bottoms out.
  // The count guards a pool being emptied faster than it fills — a search
  // whose every match is already on a list would otherwise page to the end.
  for (let i = 0; i < POOL_TOP_UPS_PER_PICK; i++) {
    if (queryPool.done || unseen.length >= POOL_LOW_WATER) break;
    const before = queryPool.raw.length;
    if (!(await growPool(queryPool, POOL_TOP_UP, token))) return;
    if (queryPool.raw.length === before) break;
    usable = pickable();
    unseen = usable.filter((m) => !sessionShown.has(m.id));
  }

  if (!usable.length) {
    showPickError(
      search.browse ? "Nothing left in that list to show you."
      : search.relatedId ? 'Nothing left that TMDB relates to "' + search.relatedTitle + '".'
      : 'No movies found for "' + search.query + '". Check the spelling, or try fewer words.');
    return;
  }
  let fresh = unseen;
  if (!fresh.length) {
    // Been through them all this session — start over.
    sessionShown.clear();
    fresh = usable.filter((m) => m.id !== lastShownId);
  }
  // A title walks its series in release order. A subject has no order to walk,
  // so it's shuffled — the same word shouldn't hand back the same movie first
  // every time it's searched.
  if (broadSearch() || search.relatedId || search.browse) shuffle(fresh);

  for (const movie of fresh) {
    const details = await fetchMovie(movie.id);
    if (token !== pickToken) return;
    sessionShown.add(movie.id); // rejected ones too, so we don't refetch them
    if (!matchesSearch(details)) continue;
    servePick(details);
    return;
  }
  showPickError("You've been through every match for this search. Try widening it.");
}

function searchSummary() {
  const bits = [];
  if (search.browse === "popular") bits.push("popular right now");
  if (search.browse === "recent") bits.push("out in the last " + RECENT_MONTHS + " months");
  if (search.relatedId) bits.push('like "' + search.relatedTitle + '"');
  if (search.query) {
    bits.push((broadSearch() ? 'about "' : 'matching "') + search.query + '"');
  }
  if (search.maxCert) bits.push("rated " + search.maxCert + " or under");
  if (search.fromYear) bits.push(search.fromYear + " and newer");
  if (search.advanced) {
    if (search.genres.size && genreCache) {
      const names = genreCache.filter((g) => search.genres.has(g.id)).map((g) => g.name);
      bits.push(names.join(search.genreMode === "any" ? " or " : " + "));
    }
    if (search.medium) bits.push(mediumByKey(search.medium).label.toLowerCase());
    if (search.obscurity !== "known") bits.push(obscurityLevel().label.toLowerCase());
    if (search.providers.size) bits.push("on " + providerLabels().join(" or "));
    if (search.actorNames.length) bits.push("with " + search.actorNames.join(" & "));
    if (search.directorNames.length) bits.push("directed by " + search.directorNames.join(" & "));
    if (search.composerNames.length) bits.push("music by " + search.composerNames.join(" & "));
    if (search.studioNames.length) bits.push("from " + search.studioNames.join(" or "));
    if (budgetRange()) bits.push("budget " + budgetRange().label.toLowerCase());
    if (revenueRange()) bits.push("box office " + revenueRange().label.toLowerCase());
    if (search.englishOnly) bits.push("English-language");
    if (search.includeSeen) bits.push("including ones you've seen");
    if (search.includeWatchlist) bits.push("including your watchlist");
    if (search.maxRuntime) bits.push("under " + runtimeText(search.maxRuntime));
  }
  return bits.join(" · ");
}

let genreCache = null;
async function ensureGenres() {
  if (!genreCache) genreCache = (await tmdbFetch("/genre/movie/list")).genres || [];
  return genreCache;
}

// ---------- Picking ----------

// Blocked is always out. Seen and the watchlist are too, unless the search
// asks for them back.
function excludedIds() {
  const ids = [...Object.keys(lists.blocked)];
  if (!search.includeSeen) ids.push(...Object.keys(lists.seen));
  if (!search.includeWatchlist) ids.push(...Object.keys(lists.watchlist));
  return new Set(ids.map(Number));
}

let lastShownId = null; // keeps a literal skip from re-serving the same movie immediately
const sessionShown = new Set(); // everything shown since the last search change

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let pickToken = 0; // ignore stale responses when the user re-searches mid-load
let announceCount = false; // show a result-count toast after the next fetch (new searches only)

async function pickMovie() {
  const token = ++pickToken;
  if (!$("card").hidden) {
    $("card").classList.add("loading");
  } else {
    showPickState("loading");
  }
  try {
    if (fixedPool()) return await pickFromQuery(token);

    const excluded = excludedIds();
    const first = await tmdbFetch("/discover/movie", discoverParams(1));
    if (token !== pickToken) return;

    if (announceCount) {
      announceCount = false;
      if (first.total_results > 0) {
        showToast(
          first.total_results.toLocaleString() +
            (first.total_results === 1 ? " match" : " matches"),
          null,
          2000
        );
      }
    }

    if (first.total_results === 0) {
      showPickError("No movies match: " + searchSummary() + ". Try relaxing a filter.");
      return;
    }

    // Small pools: random pages would repeat movies after a few skips.
    // Walk the entire result set instead, never repeating until it's spent.
    if (first.total_results < 100) {
      const pool = [];
      const checked = new Set(); // details already fetched during this pick
      const maxPages = Math.min(first.total_pages, 5);

      // Serves the first candidate that survives its details check.
      // "served" | "stale" (a newer pick started) | "none"
      const walk = async (candidates) => {
        for (const movie of candidates) {
          if (checked.has(movie.id)) continue;
          checked.add(movie.id);
          const details = await fetchMovie(movie.id);
          if (token !== pickToken) return "stale";
          sessionShown.add(movie.id); // cert-rejected too, so we don't refetch them
          if (!verifyPick(details)) continue;
          servePick(details);
          return "served";
        }
        return "none";
      };

      // Pages are pulled in only as far as the walk actually needs them.
      for (let p = 1; p <= maxPages; p++) {
        const data = p === 1 ? first : await tmdbFetch("/discover/movie", discoverParams(p));
        if (token !== pickToken) return;
        pool.push(...data.results.filter((m) => !excluded.has(m.id) && m.poster_path));
        if (await walk(pool.filter((m) => !sessionShown.has(m.id))) !== "none") return;
      }

      // Whole pool seen this session — start the cycle over.
      sessionShown.clear();
      checked.clear();
      if (await walk(pool.filter((m) => m.id !== lastShownId)) !== "none") return;

      showPickError("You've been through everything that matches this search. Try widening it.");
      return;
    }

    // How deep into the list a random page may land. TMDB caps discover at 500
    // pages and we stay well inside that; with a weak vote floor, popularity is
    // the only thing keeping picks watchable, so the level sets how far to go.
    const totalPages = Math.min(
      first.total_pages,
      moneySorted() ? MONEY_SORT_PAGES : obscurityLevel().depth
    );
    const tried = new Set();

    for (let attempt = 0; attempt < 10; attempt++) {
      let page = 1 + Math.floor(Math.random() * totalPages);
      while (tried.has(page) && tried.size < totalPages) {
        page = 1 + Math.floor(Math.random() * totalPages);
      }
      tried.add(page);

      const data = page === 1 ? first : await tmdbFetch("/discover/movie", discoverParams(page));
      if (token !== pickToken) return;
      const candidates = shuffle(
        data.results.filter((m) => !excluded.has(m.id) && m.id !== lastShownId && m.poster_path)
      );

      // Verify the real certification before accepting a candidate (see certAllowed).
      for (const movie of candidates.slice(0, 5)) {
        const details = await fetchMovie(movie.id);
        if (token !== pickToken) return;
        if (!verifyPick(details)) continue;
        servePick(details);
        return;
      }
    }

    showPickError("Looks like you've been through everything that matches! Try widening the search.");
  } catch (err) {
    if (token !== pickToken) return;
    showPickError(err.message || "Something went wrong. Check your connection.");
  }
}

// Opening a movie from a list goes to its details. The entry pushed here is
// the loading spinner standing in for them; once they arrive it becomes the
// details screen rather than pushing a second entry, so one press back from
// there is the list it was opened from.
async function openMovieById(id) {
  const token = ++pickToken; // cancel any in-flight pick
  showPickState("loading");
  navPush("movie");
  try {
    const details = await fetchMovie(id);
    if (token !== pickToken) return;
    renderMovie(details);
    infoFrom = openListName || "";
    openInfo(true);
  } catch (err) {
    if (token !== pickToken) return;
    showPickError(err.message || "Couldn't load that movie.");
  }
}

// ---------- Rendering ----------

const $ = (id) => document.getElementById(id);

let current = null; // the movie on screen
let infoFrom = ""; // the list the details were opened from, if any

function show(screen) {
  for (const s of ["screen-setup", "screen-pick"]) $(s).hidden = s !== screen;
  const onSetup = screen === "screen-setup";
  $("btnSearch").hidden = onSetup;
  $("btnMenu").hidden = onSetup;
}

function showPickState(state) {
  $("loading").hidden = state !== "loading";
  $("pickError").hidden = state !== "error";
  $("card").hidden = state !== "movie";
  $("card").classList.remove("loading");
}

function showPickError(msg) {
  $("pickErrorMsg").textContent = msg;
  showPickState("error");
}

function runtimeText(mins) {
  if (!mins) return "";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function metaParts(m) {
  const year = (m.release_date || "").slice(0, 4);
  const parts = [];
  if (year) parts.push(year);
  const rt = runtimeText(m.runtime);
  if (rt) parts.push(rt);
  if (m.vote_average) parts.push("★ " + m.vote_average.toFixed(1));
  return parts;
}

function fillMeta(el, m) {
  el.textContent = "";
  const cert = certOf(m);
  if (cert) {
    const b = document.createElement("span");
    b.className = "cert";
    b.textContent = cert;
    el.appendChild(b);
  }
  el.appendChild(document.createTextNode(metaParts(m).join(" · ")));
}

// Every movie shown is kept, so stepping back through the picks doesn't
// refetch them. Bounded — a long session would otherwise hold hundreds.
const movieCache = new Map();
const MOVIE_CACHE_MAX = 80;

function rememberMovie(m) {
  movieCache.delete(m.id); // re-insert so the freshest sit at the end
  movieCache.set(m.id, m);
  if (movieCache.size > MOVIE_CACHE_MAX) {
    movieCache.delete(movieCache.keys().next().value);
  }
}

// A pick is somewhere you've been: it takes a history entry of its own, so
// back returns to the movie before it and, eventually, to whatever started
// the rotation — a search, a list, or another movie's details.
function servePick(details) {
  renderMovie(details);
  navPushMovie(details.id);
}

// Back to a movie already shown. Cached ones are instant; one that has aged
// out of the cache is fetched again.
async function restoreMovie(id) {
  const token = ++pickToken; // a pick still loading is no longer wanted
  const cached = movieCache.get(id);
  if (cached) {
    renderMovie(cached);
    return;
  }
  showPickState("loading");
  try {
    const details = await fetchMovie(id);
    if (token !== pickToken) return;
    renderMovie(details);
  } catch (err) {
    if (token !== pickToken) return;
    showPickError(err.message || "Couldn't load that movie.");
  }
}

function renderMovie(m) {
  rememberMovie(m);
  current = m;
  sessionShown.add(m.id);

  $("poster").src = m.poster_path ? IMG + m.poster_path : "";
  $("poster").alt = m.title + " poster";
  $("movieTitle").textContent = m.title;
  fillMeta($("movieMeta"), m);
  $("movieGenres").textContent = (m.genres || []).map((g) => g.name).join(" · ");
  refreshWatchMark();

  showPickState("movie");
  resetSwipe();
  applyInfoLayout();
}

// Flexbox guarantees cover, info, and buttons all fit — the poster is the
// only piece that shrinks. If a long info block squeezes it too far, move
// the info into the translucent panel on the cover so the poster can grow.
function applyInfoLayout() {
  const card = $("card");
  const info = $("movieInfo");
  card.classList.remove("info-overlay");
  const area = $("swipeArea");
  if (info.parentElement !== area) area.appendChild(info);
  requestAnimationFrame(() => {
    const wrap = document.querySelector(".poster-wrap");
    if (wrap.offsetHeight < window.innerHeight * 0.45) {
      card.classList.add("info-overlay");
      wrap.appendChild(info);
    }
  });
}

window.addEventListener("resize", () => {
  if (current && !$("card").hidden) applyInfoLayout();
});

function refreshWatchMark() {
  $("btnWatch").classList.toggle("active", !!(current && lists.watchlist[current.id]));
}

function listEntry(m) {
  return {
    title: m.title,
    year: (m.release_date || "").slice(0, 4),
    poster: m.poster_path || null,
  };
}

// The watchlist records when each movie was saved.
function addToWatchlist(m) {
  lists.watchlist[m.id] = { ...listEntry(m), added: Date.now() };
}

function markCurrent(listName, thenPick = true) {
  if (!current) return;
  lists[listName][current.id] = listEntry(current);
  // Blocked or watched settles it either way, so it comes off the watchlist.
  delete lists.watchlist[current.id];
  saveLists();
  refreshCounts();
  lastShownId = current.id;
  current = null;
  if (thenPick) pickMovie();
}

// A literal skip: nothing is stored, the movie stays in the rotation.
function skipCurrent() {
  if (!current) return;
  lastShownId = current.id;
  current = null;
  pickMovie();
}

function toggleWatchlist() {
  if (!current) return;
  if (lists.watchlist[current.id]) {
    delete lists.watchlist[current.id];
  } else {
    addToWatchlist(current);
  }
  saveLists();
  refreshCounts();
  refreshWatchMark();
}

function refreshCounts() {
  const n = (o) => Object.keys(o).length;
  $("cntWatchlist").textContent = n(lists.watchlist) || "";
  $("cntSeen").textContent = n(lists.seen) || "";
  $("cntBlocked").textContent = n(lists.blocked) || "";
}

// ---------- Navigation (URL hash <-> overlays) ----------
// Every overlay gets a history entry (#search, #info, #settings, #menu,
// #list-*, #trailer, #rate) so the browser/phone back button closes it instead
// of exiting the app. The hash is the single source of truth for what's open.
//
// #movie is the odd one: it opens no overlay, it closes them all. Opening a
// movie from a list shows the card, and the entry is what lets the back button
// return to the list it came from.

const MODALS = ["modalSearch", "modalInfo", "modalList", "modalSettings", "modalRate"];

function navPush(frag) {
  if (location.hash === "#" + frag) {
    applyHash();
    return;
  }
  const depth = (history.state && history.state.depth) || 0;
  history.pushState({ depth: depth + 1 }, "", "#" + frag);
  applyHash();
}

// Swaps what the current entry points at instead of adding one, so a screen
// that stands in for another while it loads doesn't cost a second back press.
function navReplace(frag) {
  const depth = (history.state && history.state.depth) || 0;
  history.replaceState({ depth }, "", "#" + frag);
  applyHash();
}

// A pick's own entry, named by the movie it shows so back can restore it.
// The entry that starts a rotation is a placeholder — the loading spinner
// standing in for a movie not chosen yet — and the first pick takes it over
// rather than stacking on top, so back from that first movie reaches whatever
// started it: the search screen, a list, another movie's details.
function navPushMovie(id) {
  const st = history.state || {};
  const depth = st.depth || 0;
  const placeholder = !st.movieId && (location.hash === "#movie" || depth === 0);
  if (placeholder) {
    history.replaceState({ depth, movieId: id }, "", "#movie");
  } else {
    history.pushState({ depth: depth + 1, movieId: id }, "", "#movie");
  }
  applyHash();
}

function navBack() {
  if (((history.state && history.state.depth) || 0) > 0) history.back();
}

function setShown(id, shown) {
  const el = $(id);
  if (shown && el.hidden) {
    el.hidden = false;
    el.scrollTop = 0;
  } else if (!shown) {
    el.hidden = true;
  }
}

function applyHash() {
  const raw = location.hash.replace(/^#/, "");
  // The rating sheet floats over whatever opened it, so that screen stays put
  // behind it — the seen list keeps its place while a rating is given.
  const h = raw === "rate" ? ratingUnder : raw;
  const rating = raw === "rate" && !!ratingTarget;
  const ratingClosed = !rating && !!ratingTarget;
  setShown("modalRate", rating);
  if (ratingClosed) closeRating();
  document.body.classList.toggle("drawer-open", h === "menu");

  // Where the open list is sitting, banked before anything moves it, so
  // opening a movie and coming back lands on the same row.
  const listEl = $("modalList");
  if (!listEl.hidden && openListName) listScroll[openListName] = listEl.scrollTop;

  const listName = h.startsWith("list-") ? h.slice(5) : null;
  if (listName && LIST_LABELS[listName]) {
    if (openListName !== listName) {
      openListName = listName;
      $("listTitle").textContent = LIST_LABELS[listName];
    }
    setShown("modalList", true); // unhidden first, or the scroll won't take
    buildListTools();
    renderList();
    listEl.scrollTop = listScroll[listName] || 0;
  } else {
    setShown("modalList", false);
  }

  setShown("modalSearch", h === "search");
  setShown("modalSettings", h === "settings");
  // A trailer started from the card has no info screen behind it to reveal.
  setShown("modalInfo", h === "info" || (h === "trailer" && trailerFromInfo));

  // No player mounted means this isn't a live trailer entry (a stale hash);
  // leave the overlay closed rather than showing an empty black screen.
  if (h === "trailer" && $("trailerFrameWrap").firstChild) {
    $("trailerOverlay").hidden = false; // player was mounted by openTrailer
  } else if (!$("trailerOverlay").hidden) {
    closeTrailerUI();
  }

  document.body.classList.toggle("no-scroll", MODALS.some((id) => !$(id).hidden));

  // Stepping back through the picks: the entry says which movie it showed.
  // Not when a rating sheet has just closed, though. Marking a movie seen
  // clears the card and holds the next pick until the sheet goes; the entry
  // still names the movie just rated, and restoring it here would both put it
  // back on screen and cancel the pick that was waiting on the sheet.
  const wantId = history.state && history.state.movieId;
  if (!ratingClosed && wantId && (!current || current.id !== wantId)) restoreMovie(wantId);
}

window.addEventListener("popstate", applyHash);

document.querySelectorAll(".modal-close").forEach((btn) => {
  btn.addEventListener("click", navBack);
});

$("btnInfoBack").addEventListener("click", navBack);

// Watched it and Remove, on the details of something on the watchlist. Both
// finish by going back to the list — the movie has just left it, so there's
// nothing on the details screen still worth reading.
// The movie on screen as it sits on the list the details came from.
function listEntryOnShow() {
  const id = current && current.id;
  const list = infoFrom && lists[infoFrom];
  const entry = id != null && list && list[id];
  return entry ? { id, entry } : null;
}

$("btnWatchedIt").addEventListener("click", () => {
  const on = listEntryOnShow();
  if (on) markSeenFromWatchlist(on.id, on.entry, navBack);
});

$("btnRemoveFromList").addEventListener("click", () => {
  const on = listEntryOnShow();
  if (!on) return;
  removeFromList(infoFrom, String(on.id), on.entry);
  navBack();
});

$("btnMenu").addEventListener("click", () => {
  refreshCounts();
  navPush("menu");
});
$("drawerOverlay").addEventListener("click", navBack);

// ---------- Search ----------

function buildRuntimeOptions() {
  const sel = $("selRuntime");
  sel.innerHTML = "";
  const any = document.createElement("option");
  any.value = "";
  any.textContent = "No limit";
  sel.appendChild(any);
  for (let mins = 60; mins <= 240; mins += 15) {
    const o = document.createElement("option");
    o.value = String(mins);
    o.textContent = runtimeText(mins);
    sel.appendChild(o);
  }
  sel.value = search.maxRuntime ? String(search.maxRuntime) : "";
}

function renderQueryMode() {
  for (const btn of $("queryMode").querySelectorAll(".seg-btn")) {
    btn.classList.toggle("active", btn.dataset.qmode === search.queryMode);
  }
  $("queryModeHint").textContent = broadSearchMode()
    ? "Anything: titles plus TMDB's topic tags, with anything whose description "
      + "mentions the word ranked above the rest."
    : "Title: closest matches first, then oldest to newest — \"Harry Potter\" "
      + "walks the series in order. Finds movies already on your lists.";
}

$("queryMode").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  search.queryMode = btn.dataset.qmode;
  renderQueryMode();
});

// The mode as chosen on the form, before a query has been typed.
const broadSearchMode = () => search.queryMode === "anything";

function renderGenreMode() {
  for (const btn of $("genreMode").querySelectorAll(".seg-btn")) {
    btn.classList.toggle("active", btn.dataset.mode === search.genreMode);
  }
  $("genreModeHint").textContent =
    search.genreMode === "any"
      ? "Any: a movie needs at least one of the selected genres."
      : "All: a movie must have every selected genre. Picking several narrows it fast.";
}

$("genreMode").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  search.genreMode = btn.dataset.mode;
  renderGenreMode();
});

// One format at a time: each maps to a different discover parameter, and
// TMDB can't OR across parameters, so a multi-select would quietly turn into
// an AND and return nothing. Tapping the active chip clears it.
function renderMediumChips() {
  const box = $("mediumChips");
  box.innerHTML = "";
  for (const m of MEDIUMS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = m.label;
    chip.classList.toggle("active", search.medium === m.key);
    chip.addEventListener("click", () => {
      search.medium = search.medium === m.key ? "" : m.key;
      for (const other of box.querySelectorAll(".chip")) other.classList.remove("active");
      chip.classList.toggle("active", search.medium === m.key);
    });
    box.appendChild(chip);
  }
}

// Several at once, and any one of them will do: the question is what's
// watchable tonight, not what's on every service you pay for.
function renderProviderChips() {
  const box = $("providerChips");
  box.innerHTML = "";
  for (const p of PROVIDERS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = p.label;
    chip.classList.toggle("active", search.providers.has(p.key));
    chip.addEventListener("click", () => {
      if (search.providers.has(p.key)) search.providers.delete(p.key);
      else search.providers.add(p.key);
      chip.classList.toggle("active");
    });
    box.appendChild(chip);
  }
}

function buildObscurityOptions() {
  const sel = $("selObscurity");
  sel.innerHTML = "";
  for (const o of OBSCURITY) {
    const opt = document.createElement("option");
    opt.value = o.key;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = search.obscurity;
}

function buildMoneyOptions(id, ranges, current) {
  const sel = $(id);
  sel.innerHTML = "";
  const any = document.createElement("option");
  any.value = "";
  any.textContent = "Any";
  sel.appendChild(any);
  for (const r of ranges) {
    const o = document.createElement("option");
    o.value = r.key;
    o.textContent = r.label;
    sel.appendChild(o);
  }
  sel.value = current;
}

async function renderGenreChips() {
  const box = $("genreChips");
  try {
    const genres = await ensureGenres();
    box.innerHTML = "";
    for (const g of genres) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = g.name;
      chip.classList.toggle("active", search.genres.has(g.id));
      chip.addEventListener("click", () => {
        if (search.genres.has(g.id)) search.genres.delete(g.id);
        else search.genres.add(g.id);
        chip.classList.toggle("active");
      });
      box.appendChild(chip);
    }
  } catch {
    box.innerHTML = '<p class="hint">Couldn\'t load genres. Check your connection.</p>';
  }
}

// Back to a first-run search: everything the two screens can set, basic and
// advanced alike. It doesn't run the search — the form is left cleared for
// the user to add to and apply.
function resetSearch() {
  search.query = "";
  search.queryMode = "title";
  search.relatedId = null;
  search.advanced = false;
  search.genres.clear();
  search.genreMode = "all";
  search.medium = "";
  search.obscurity = "known";
  search.providers.clear();
  search.actors = ""; search.actorIds = []; search.actorNames = [];
  search.director = ""; search.directorIds = []; search.directorNames = [];
  search.composer = ""; search.composerIds = []; search.composerNames = [];
  search.studios = ""; search.studioIds = []; search.studioNames = [];
  search.budget = "";
  search.revenue = "";
  search.englishOnly = false;
  search.includeSeen = false;
  search.includeWatchlist = false;
  search.maxRuntime = 0;
  // Age and year outlive the session, so clearing them has to stick even if
  // the user closes the search screen without applying.
  search.maxCert = "";
  search.fromYear = null;
  search.browse = "";
  // A reset is the other way to stop a kept search from following you around.
  forgetSearch();
  fillSearchForm();
  showToast("Search reset to defaults", null, 2000);
}

function fillSearchForm() {
  $("inpQuery").value = search.query;
  renderQueryMode();
  $("selMaxCert").value = search.maxCert;
  $("inpYear").value = search.fromYear || "";
  $("chkAdvanced").checked = search.advanced;
  $("advancedBox").hidden = !search.advanced;
  $("inpActors").value = search.actors;
  $("inpDirector").value = search.director;
  $("inpComposer").value = search.composer;
  $("inpStudio").value = search.studios;
  $("chkEnglish").checked = search.englishOnly;
  $("chkIncludeSeen").checked = search.includeSeen;
  $("chkIncludeWatchlist").checked = search.includeWatchlist;
  buildRuntimeOptions();
  buildObscurityOptions();
  buildMoneyOptions("selBudget", BUDGET_RANGES, search.budget);
  buildMoneyOptions("selRevenue", REVENUE_RANGES, search.revenue);
  renderGenreMode();
  if (search.advanced) {
    renderGenreChips();
    renderMediumChips();
    renderProviderChips();
  }
  $("searchError").hidden = true;
}

function openSearch() {
  fillSearchForm();
  navPush("search");
}

$("btnPopular").addEventListener("click", () => startBrowse("popular"));
$("btnRecent").addEventListener("click", () => startBrowse("recent"));
$("btnResetSearch").addEventListener("click", resetSearch);
$("btnSearch").addEventListener("click", openSearch);
$("btnErrorSearch").addEventListener("click", openSearch);

$("chkAdvanced").addEventListener("change", () => {
  $("advancedBox").hidden = !$("chkAdvanced").checked;
  if ($("chkAdvanced").checked) {
    renderGenreChips();
    renderMediumChips();
    renderProviderChips();
  }
});

async function resolveCompanies(namesText) {
  const names = namesText.split(",").map((s) => s.trim()).filter(Boolean);
  const ids = [];
  const resolved = [];
  const missing = [];
  for (const name of names) {
    const r = await tmdbFetch("/search/company", { query: name });
    const hits = r.results || [];
    // Company search is fuzzy and studio names repeat across subsidiaries, so
    // an exact name wins over TMDB's own ordering.
    const hit = hits.find((c) => c.name.toLowerCase() === name.toLowerCase()) || hits[0];
    if (hit) {
      ids.push(hit.id);
      resolved.push(hit.name);
    } else {
      missing.push(name);
    }
  }
  return { ids, resolved, missing };
}

async function resolveActors(namesText) {
  const names = namesText.split(",").map((s) => s.trim()).filter(Boolean);
  const ids = [];
  const resolved = [];
  const missing = [];
  for (const name of names) {
    const r = await tmdbFetch("/search/person", { query: name });
    const hit = (r.results || [])[0];
    if (hit) {
      ids.push(hit.id);
      resolved.push(hit.name);
    } else {
      missing.push(name);
    }
  }
  return { ids, resolved, missing };
}

$("btnApplySearch").addEventListener("click", async () => {
  const errEl = $("searchError");
  errEl.hidden = true;

  const thisYear = new Date().getFullYear();
  const year = $("inpYear").value.trim() ? parseInt($("inpYear").value, 10) : null;

  if (year !== null && (!Number.isFinite(year) || year < 1930 || year > thisYear)) {
    errEl.textContent = `Enter a year between 1930 and ${thisYear}, or leave it blank for all time.`;
    errEl.hidden = false;
    return;
  }

  search.query = $("inpQuery").value.trim();
  // A search of one's own leaves any ready-made rotation behind.
  search.relatedId = null;
  search.browse = "";
  search.advanced = $("chkAdvanced").checked;
  const btn = $("btnApplySearch");
  btn.disabled = true;
  try {
    if (search.advanced) {
      search.maxCert = $("selMaxCert").value;
      search.fromYear = year;
      search.actors = $("inpActors").value;
      search.director = $("inpDirector").value;
      search.composer = $("inpComposer").value;
      search.studios = $("inpStudio").value;
      search.obscurity = $("selObscurity").value;
      search.budget = $("selBudget").value;
      search.revenue = $("selRevenue").value;
      search.englishOnly = $("chkEnglish").checked;
      search.includeSeen = $("chkIncludeSeen").checked;
      search.includeWatchlist = $("chkIncludeWatchlist").checked;
      search.maxRuntime = $("selRuntime").value ? parseInt($("selRuntime").value, 10) : 0;
      const actors = await resolveActors(search.actors);
      const directors = await resolveActors(search.director);
      const composers = await resolveActors(search.composer);
      const studios = await resolveCompanies(search.studios);
      const missing = [
        ...actors.missing, ...directors.missing, ...composers.missing, ...studios.missing,
      ];
      if (missing.length) {
        errEl.textContent = "Couldn't find: " + missing.join(", ");
        errEl.hidden = false;
        return;
      }
      search.actorIds = actors.ids;
      search.actorNames = actors.resolved;
      search.directorIds = directors.ids;
      search.directorNames = directors.resolved;
      search.composerIds = composers.ids;
      search.composerNames = composers.resolved;
      search.studioIds = studios.ids;
      search.studioNames = studios.resolved;
    } else {
      // The box is where these live now, so an unticked box means no cap and
      // no year — never a limit still in force that nothing on screen shows.
      search.maxCert = "";
      search.fromYear = null;
      search.includeSeen = false;
      search.includeWatchlist = false;
      search.obscurity = "known";
      search.providers.clear();
      search.actorIds = [];
      search.actorNames = [];
      search.directorIds = [];
      search.directorNames = [];
      search.composerIds = [];
      search.composerNames = [];
      search.studioIds = [];
      search.studioNames = [];
    }
    saveSearch();
    sessionShown.clear();
    announceCount = true;
    // Not navBack: the search screen stays in history, so back from the
    // rotation it starts returns to it.
    navPush("movie");
    show("screen-pick");
    pickMovie();
  } catch (err) {
    errEl.textContent = err.message || "Search failed. Check your connection.";
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- More info ----------

function openInfo(replace) {
  if (!current) return;
  const m = current;
  $("infoTitle").textContent = m.title;
  $("infoPoster").src = m.poster_path ? IMG_SMALL + m.poster_path : "";
  $("infoPoster").alt = m.title + " poster";
  fillMeta($("infoMeta"), m);
  $("infoGenres").textContent = (m.genres || []).map((g) => g.name).join(" · ");
  $("infoOverview").textContent = m.overview || "No description available.";

  const crew = m.credits?.crew || [];
  const crewPeople = (job) => crew.filter((c) => c.job === job);

  // Tapping a name searches its whole catalogue — a person's filmography or a
  // studio's output (all time, age 21).
  const personLink = (kind) => (p) => {
    const s = document.createElement("span");
    s.className = "person-link";
    s.textContent = p.name;
    s.addEventListener("click", () => forceSearchFor(kind, p.id, p.name));
    return s;
  };
  const linkedNames = (people, kind) => {
    const frag = document.createElement("span");
    people.forEach((p, i) => {
      if (i) frag.append(", ");
      frag.appendChild(personLink(kind)(p));
    });
    return frag;
  };
  const nameList = (el, prefix, people, kind) => {
    el.textContent = "";
    if (!people.length) return;
    if (prefix) el.append(prefix);
    people.forEach((p, i) => {
      if (i) el.append(", ");
      el.appendChild(personLink(kind)(p));
    });
  };

  const directors = crewPeople("Director");
  nameList($("infoDirector"), "Directed by: ", directors, "director");
  nameList($("infoCast"), "Starring: ", (m.credits?.cast || []).slice(0, 10), "actor");

  const money = (n) =>
    n >= 1e6 ? "$" + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M" : "$" + n.toLocaleString();
  const rows = [];
  // Where it can be watched without paying on top, from TMDB's JustWatch feed.
  // Silence means TMDB has no US listing, which isn't the same as nowhere.
  const watch = watchOptions(m);
  if (watch.length) {
    rows.push(["Streaming", watch.map((p) => p.provider_name).slice(0, 6).join(", ")]);
  }
  const writers = [...new Set(
    [...crewPeople("Screenplay"), ...crewPeople("Writer")].map((c) => c.name)
  )];
  if (writers.length) rows.push(["Written by", writers.slice(0, 4).join(", ")]);
  const composers = crewPeople("Original Music Composer");
  if (composers.length) rows.push(["Music", linkedNames(composers, "composer")]);
  const countries = (m.production_countries || []).map((c) => c.name);
  if (countries.length) rows.push(["Country", countries.join(", ")]);
  if (m.budget) rows.push(["Budget", money(m.budget)]);
  if (m.revenue) rows.push(["Box office", money(m.revenue)]);
  const studios = (m.production_companies || []).slice(0, 3);
  if (studios.length) rows.push(["Studio", linkedNames(studios, "studio")]);

  const extra = $("infoExtra");
  extra.textContent = "";
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "extra-row";
    const k = document.createElement("span");
    k.className = "extra-k";
    k.textContent = label;
    const v = document.createElement("span");
    if (typeof value === "string") v.textContent = value;
    else v.appendChild(value);
    row.append(k, v);
    extra.appendChild(row);
  }

  trailerKey = trailerKeyFor(m);
  $("btnTrailer").hidden = !trailerKey;
  // TMDB hands us the exact IMDb id, so the Parents Guide is a real deep link.
  $("lnkIMDb").hidden = !m.imdb_id;
  if (m.imdb_id) {
    $("lnkIMDb").href = "https://www.imdb.com/title/" + m.imdb_id + "/parentalguide";
  }
  // Actions for the list the details were opened from, while the movie is
  // still on it.
  const onWatchlist = infoFrom === "watchlist" && !!lists.watchlist[m.id];
  const onSeen = infoFrom === "seen" && !!lists.seen[m.id];
  $("btnWatchedIt").hidden = !onWatchlist;
  $("btnRemoveFromList").hidden = !(onWatchlist || onSeen);
  $("listActions").hidden = !(onWatchlist || onSeen);

  if (replace) navReplace("info");
  else navPush("info");
}

// The details screen's way into a rotation of TMDB's recommendations for the
// movie on show. The advanced filters are switched off rather than cleared —
// they'd narrow an already narrow pool to nothing — but the age rating and
// year stay, since those were set deliberately and one of them is why the
// picks are safe for whoever is watching.
// The two ready-made rotations from the search screen.
function startBrowse(kind) {
  search.query = "";
  search.relatedId = null;
  search.browse = kind;
  search.advanced = false; // a curated list isn't a search to be narrowed
  sessionShown.clear();
  announceCount = true;
  navPush("movie"); // the search screen stays behind it
  show("screen-pick");
  pickMovie();
}

function startRelated(m) {
  search.browse = "";
  search.query = "";
  search.advanced = false;
  search.relatedId = m.id;
  search.relatedTitle = m.title;
  sessionShown.clear();
  announceCount = true;
  navPush("movie"); // the details screen stays behind it
  show("screen-pick");
  pickMovie();
}

// A name tap in the info screen becomes a fresh advanced search for just that
// person or studio: all time (blank year), blank age (21), no other filters.
function forceSearchFor(kind, id, name) {
  search.advanced = true;
  search.query = "";
  search.queryMode = "title";
  search.relatedId = null;
  search.browse = "";
  search.genres.clear();
  search.genreMode = "all";
  search.medium = "";
  search.obscurity = "known";
  search.providers.clear();
  search.budget = "";
  search.revenue = "";
  search.englishOnly = false;
  search.includeSeen = false;
  search.includeWatchlist = false;
  search.maxRuntime = 0;
  search.actors = ""; search.actorIds = []; search.actorNames = [];
  search.director = ""; search.directorIds = []; search.directorNames = [];
  search.composer = ""; search.composerIds = []; search.composerNames = [];
  search.studios = ""; search.studioIds = []; search.studioNames = [];
  if (kind === "actor") {
    search.actors = name; search.actorIds = [id]; search.actorNames = [name];
  } else if (kind === "director") {
    search.director = name; search.directorIds = [id]; search.directorNames = [name];
  } else if (kind === "studio") {
    search.studios = name; search.studioIds = [id]; search.studioNames = [name];
  } else {
    search.composer = name; search.composerIds = [id]; search.composerNames = [name];
  }
  search.maxCert = "";
  search.fromYear = null;
  saveSearch(); // tapping a name sets up a real search, so it's the one to keep
  sessionShown.clear();
  announceCount = true;
  navPush("movie"); // whatever was on screen stays behind it
  show("screen-pick");
  pickMovie();
}


// ---------- Trailer player ----------

// Embedded player instead of a YouTube link so we can go fullscreen and
// (where the browser allows it — Android, not iOS) lock landscape.
//
// The player lives in an iframe that is built on open and removed on close.
// That is not tidiness: pointing an *existing* iframe at a new src is a
// navigation, and it leaves a stray entry in the page's history — two per
// trailer, once for the video and once for the teardown. Those entries share
// our URL, so a back press would land on one and appear to do nothing, and the
// Back button would need extra taps to reach the card. A freshly inserted
// iframe's first load replaces instead of pushing, and discarding the element
// takes its history with it.
let trailerKey = null;
let trailerFromInfo = false; // which screen the trailer sits on top of

function mountTrailer(key) {
  const frame = document.createElement("iframe");
  frame.title = "Trailer";
  frame.allow = "autoplay; fullscreen; encrypted-media";
  frame.allowFullscreen = true;
  // youtube-nocookie serves the player without tracking cookies and keeps the
  // view out of the viewer's YouTube watch history.
  frame.src =
    "https://www.youtube-nocookie.com/embed/" + key +
    "?autoplay=1&playsinline=1&rel=0";
  $("trailerFrameWrap").replaceChildren(frame);
}

function trailerKeyFor(m) {
  const vids = m?.videos?.results || [];
  const trailer =
    vids.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ||
    vids.find((v) => v.site === "YouTube" && v.type === "Trailer") ||
    vids.find((v) => v.site === "YouTube");
  return trailer ? trailer.key : null;
}

async function openTrailer(key) {
  if (!key) return;
  mountTrailer(key);
  $("lnkTrailerYT").href = "https://www.youtube.com/watch?v=" + key;
  navPush("trailer");
  const overlay = $("trailerOverlay");
  try {
    if (overlay.requestFullscreen) await overlay.requestFullscreen();
    else if (overlay.webkitRequestFullscreen) overlay.webkitRequestFullscreen();
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock("landscape");
    }
  } catch {
    // Fullscreen or orientation lock refused — the overlay still covers the viewport.
  }
}

// Visual teardown only — navigation state is handled by the hash.
function closeTrailerUI() {
  $("trailerOverlay").hidden = true;
  $("trailerFrameWrap").replaceChildren(); // stops playback and drops its history
  try {
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
  } catch {}
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

$("btnRelated").addEventListener("click", () => {
  if (current) startRelated(current);
});

$("btnTrailer").addEventListener("click", () => {
  trailerFromInfo = true;
  openTrailer(trailerKey);
});
$("btnCloseTrailer").addEventListener("click", navBack);

// Leaving fullscreen by gesture should close the trailer too. Keyed off the
// hash, not the overlay: when the *hash* is what closed the trailer, fullscreen
// exits as part of the teardown and must not bounce us back a second time.
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && location.hash === "#trailer") navBack();
});

// ---------- Card actions & swiping ----------

$("btnWatch").addEventListener("click", toggleWatchlist);

// Right = watchlist, left = block, up = skip, down = seen.
// A tap (no drag) on the poster opens More info; a double tap plays the trailer.
const swipeArea = $("swipeArea");
const BADGES = ["badgeWatch", "badgeSkip", "badgeSeen", "badgeBlock"];
let drag = null;

function resetSwipe() {
  swipeArea.style.transition = "";
  swipeArea.style.transform = "";
  for (const b of BADGES) $(b).style.opacity = 0;
}

function swipeOut(axis, dir, done) {
  swipeArea.style.transition = "transform 0.25s ease-out";
  swipeArea.style.transform =
    axis === "x" ? `translateX(${dir * 120}%)` : `translateY(${dir * 120}%)`;
  setTimeout(() => {
    resetSwipe();
    done();
  }, 250);
}

swipeArea.addEventListener("pointerdown", (e) => {
  if (!current || $("card").classList.contains("loading")) return;
  if (e.target.closest("button")) return;
  drag = {
    x: e.clientX,
    y: e.clientY,
    id: e.pointerId,
    active: false,
    axis: null,
    tap: !!e.target.closest(".poster-wrap"),
  };
});

swipeArea.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.active) {
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
      drag.active = true;
      drag.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      try { swipeArea.setPointerCapture(drag.id); } catch {}
    }
    return;
  }
  const fade = (v) => Math.min(1, Math.max(0, v / 90));
  if (drag.axis === "x") {
    swipeArea.style.transform = `translateX(${dx}px)`;
    $("badgeWatch").style.opacity = fade(dx);
    $("badgeBlock").style.opacity = fade(-dx);
  } else {
    swipeArea.style.transform = `translateY(${dy}px)`;
    $("badgeSkip").style.opacity = fade(-dy);
    $("badgeSeen").style.opacity = fade(dy);
  }
});

function snapBack() {
  swipeArea.style.transition = "transform 0.2s ease-out";
  swipeArea.style.transform = "";
  for (const b of BADGES) $(b).style.opacity = 0;
  setTimeout(() => { swipeArea.style.transition = ""; }, 200);
}

let tapTimer = null;

function handleTap() {
  if (tapTimer) {
    // Second tap within the window: play the trailer instead.
    clearTimeout(tapTimer);
    tapTimer = null;
    const key = trailerKeyFor(current);
    if (key) {
      trailerFromInfo = false;
      openTrailer(key);
    } else {
      showToast("No trailer available for this one.");
    }
  } else {
    tapTimer = setTimeout(() => {
      tapTimer = null;
      infoFrom = ""; // straight from the card, not from a list
      openInfo();
    }, 300);
  }
}

function endDrag(e) {
  if (!drag) return;
  const wasActive = drag.active;
  const wasTap = drag.tap && !drag.active;
  const axis = drag.axis;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag = null;

  if (!wasActive) {
    if (wasTap && current) handleTap();
    return;
  }

  if (axis === "x" && dx > 90) {
    swipeOut("x", 1, () => {
      // Saved again even when it's already on the list: this is how a movie
      // that came back around gets put off for another day rather than
      // silently doing nothing.
      if (current) {
        addToWatchlist(current);
        saveLists();
        refreshCounts();
      }
      current = null;
      pickMovie();
    });
  } else if (axis === "x" && dx < -90) {
    const blocked = current;
    const wasSaved = lists.watchlist[blocked.id]; // markCurrent drops it
    swipeOut("x", -1, () => {
      markCurrent("blocked");
      // Blocking is easy to hit by accident on a fling; offer a way back.
      showToast(`Blocked "${blocked.title}"`, () => {
        delete lists.blocked[blocked.id];
        if (wasSaved) lists.watchlist[blocked.id] = wasSaved;
        saveLists();
        refreshCounts();
      });
    });
  } else if (axis === "y" && dy < -90) {
    swipeOut("y", -1, skipCurrent);
  } else if (axis === "y" && dy > 90) {
    const watched = current;
    const wasSaved = watched && lists.watchlist[watched.id];
    swipeOut("y", 1, () => {
      // Filed as seen straight away, so a dismissed rating still counts — but
      // the next movie is held back until the sheet closes, leaving the one
      // being rated on screen behind it instead of the next one.
      markCurrent("seen", false);
      const entry = watched && lists.seen[watched.id];
      if (!entry) return pickMovie();
      openRating(watched.id, entry, pickMovie, () => {
        // Swiped down by mistake: undo the filing, put it back on the
        // watchlist if that's where it came from, and show it again rather
        // than moving on to the next movie.
        delete lists.seen[watched.id];
        if (wasSaved) lists.watchlist[watched.id] = wasSaved;
        saveLists();
        refreshCounts();
        renderMovie(watched);
      });
    });
  } else {
    snapBack();
  }
}

swipeArea.addEventListener("pointerup", endDrag);
swipeArea.addEventListener("pointercancel", endDrag);

// ---------- Star ratings ----------

// Ratings live on the seen entry as `rating` (1–5). An entry without one is
// simply unrated — every seen movie from before this existed reads that way.
const STAR_PATH =
  "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";
const STAR_SVG = (filled) =>
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR_PATH + '"' +
  (filled ? ' fill="currentColor"/>' : ' fill="none" stroke="currentColor" stroke-width="1.7"/>') +
  "</svg>";

// Filled up to `rating`, hollow after it — five hollow stars when unrated.
// With onPick each star is its own button; without it the strip is display
// only and the caller decides what a tap on the whole thing does.
function renderStars(box, rating, onPick) {
  box.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement(onPick ? "button" : "span");
    star.className = "star" + (i <= rating ? " on" : "");
    star.innerHTML = STAR_SVG(i <= rating);
    if (onPick) {
      star.type = "button";
      star.setAttribute("aria-label", i === 1 ? "1 star" : i + " stars");
      // On the finger this takes the rating the moment the star is touched.
      // A click needs the touch to land and lift on the same element, and a
      // thumb rolls a few pixels — on a target this size that was landing
      // outside often enough to need a second go.
      star.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        onPick(i);
      });
    }
    box.appendChild(star);
  }
}

let ratingTarget = null; // { id, entry } being rated
let ratingUnder = ""; // hash of the screen the sheet opened over
let ratingAfter = null; // held until the sheet closes — see the swipe handler
let ratingUndo = null; // how to take the "seen" back, where that's an option
let ratingPicked = false; // a second pointer event mustn't navigate back twice

// However the sheet is dismissed — a star, Skip, or the back button — whatever
// was waiting on it runs now.
function closeRating() {
  const after = ratingAfter;
  ratingTarget = null;
  ratingAfter = null;
  ratingUndo = null;
  // Off the popstate turn that closed the sheet. What follows is often another
  // navigation — back to the list the movie came from — and browsers are not
  // uniformly happy about being asked to navigate from inside a popstate.
  if (after) setTimeout(after, 0);
}

// `undo` is offered only where there's something to take back: a swipe that
// filed the movie as seen. Rating one already on the seen list has nothing to
// undo, so the link stays hidden there.
function openRating(id, entry, after, undo) {
  ratingTarget = { id: String(id), entry };
  ratingPicked = false;
  ratingAfter = after || null;
  ratingUndo = undo || null;
  $("btnRateOops").hidden = !undo;
  ratingUnder = location.hash.replace(/^#/, "");
  $("rateMovie").textContent = entry.title + (entry.year ? " (" + entry.year + ")" : "");
  renderStars($("rateStars"), entry.rating || 0, (n) => {
    if (ratingPicked || !ratingTarget) return;
    ratingPicked = true;
    const seen = lists.seen[ratingTarget.id];
    if (seen) {
      seen.rating = n;
      saveLists();
    }
    navBack();
  });
  navPush("rate");
}

$("btnRateSkip").addEventListener("click", navBack);

// Backing out replaces whatever the sheet was going to do next: instead of
// moving on to another movie, it puts this one back the way it was.
$("btnRateOops").addEventListener("click", () => {
  if (ratingPicked || !ratingTarget || !ratingUndo) return;
  ratingPicked = true;
  ratingAfter = ratingUndo;
  navBack();
});

// ---------- Saved lists (drawer) ----------

const LIST_LABELS = {
  watchlist: "Watchlist",
  seen: "Seen",
  blocked: "Blocked",
};

let openListName = null;
const listScroll = {}; // where each list was left, by list name

document.querySelectorAll(".drawer-item[data-list]").forEach((btn) => {
  btn.addEventListener("click", () => navPush("list-" + btn.dataset.list));
});

$("drawerSettings").addEventListener("click", () => openSettings());

// Sorting and filtering are per list and last the session, the way a list's
// scroll position does — the watchlist keeping its own order while seen keeps
// another is less surprising than one setting following you between them.
const listSort = {};
const listFilter = {};

const SORTS = [
  { key: "", label: "Order added" },
  { key: "title-az", label: "By title A–Z" },
  { key: "title-za", label: "By title Z–A" },
  { key: "year-old", label: "By year — oldest first" },
  { key: "year-new", label: "By year — newest first" },
  { key: "rating-high", label: "Highest rated", seenOnly: true },
  { key: "rating-low", label: "Lowest rated", seenOnly: true },
];

const rowTitle = (r) => r[1].title || "";
const rowYear = (r) => parseInt(r[1].year, 10) || 0;
const rowRating = (r) => r[1].rating || 0;
const byTitle = (a, b) => rowTitle(a).localeCompare(rowTitle(b), undefined, { sensitivity: "base" });

function sortRows(rows, mode) {
  const out = [...rows];
  if (mode === "title-az") out.sort(byTitle);
  else if (mode === "title-za") out.sort((a, b) => byTitle(b, a));
  else if (mode === "year-old") out.sort((a, b) => rowYear(a) - rowYear(b) || byTitle(a, b));
  else if (mode === "year-new") out.sort((a, b) => rowYear(b) - rowYear(a) || byTitle(a, b));
  else if (mode === "rating-high") out.sort((a, b) => rowRating(b) - rowRating(a) || byTitle(a, b));
  else if (mode === "rating-low") {
    // An unrated movie isn't the lowest rated one; it has no rating at all,
    // so those sit at the end of either direction.
    out.sort((a, b) => {
      const ra = rowRating(a), rb = rowRating(b);
      if (!ra !== !rb) return ra ? -1 : 1;
      return ra - rb || byTitle(a, b);
    });
  }
  return out;
}

// The sort choices for the list on screen, and the filter box as it was left.
function buildListTools() {
  const sel = $("selListSort");
  sel.innerHTML = "";
  for (const s of SORTS) {
    if (s.seenOnly && openListName !== "seen") continue;
    const o = document.createElement("option");
    o.value = s.key;
    o.textContent = s.label;
    sel.appendChild(o);
  }
  sel.value = listSort[openListName] || "";
  const term = listFilter[openListName] || "";
  $("inpListFilter").value = term;
  $("listFilterWrap").hidden = !term;
  $("btnListFilter").classList.toggle("active", !!term);
}

function renderList() {
  const ul = $("listItems");
  // Emptying the element scrolls it to the top, so removing a row or coming
  // back from a rating would otherwise throw the reader back to the start.
  const at = $("modalList").scrollTop;
  ul.innerHTML = "";
  const entries = Object.entries(lists[openListName]);
  const term = (listFilter[openListName] || "").trim().toLowerCase();
  const matching = term
    ? entries.filter(([, e]) => (e.title || "").toLowerCase().includes(term))
    : entries;
  const rows = sortRows(matching, listSort[openListName] || "");

  $("listEmpty").textContent = entries.length
    ? "Nothing here matches “" + term + "”."
    : "Nothing here yet.";
  $("listEmpty").hidden = rows.length > 0;
  for (const [id, entry] of rows) {
    ul.appendChild(buildRow(id, entry));
  }
  $("modalList").scrollTop = at;
}

$("selListSort").addEventListener("change", () => {
  listSort[openListName] = $("selListSort").value;
  $("modalList").scrollTop = 0; // a new order is a new list to read
  renderList();
});

// The box appears on the icon and goes away with it, taking the filter with
// it — a list left quietly filtered behind a hidden box reads as a lost list.
$("btnListFilter").addEventListener("click", () => {
  const wrap = $("listFilterWrap");
  const opening = wrap.hidden;
  wrap.hidden = !opening;
  $("btnListFilter").classList.toggle("active", opening);
  if (opening) {
    $("inpListFilter").focus();
  } else {
    listFilter[openListName] = "";
    $("inpListFilter").value = "";
    renderList();
  }
});

$("inpListFilter").addEventListener("input", () => {
  listFilter[openListName] = $("inpListFilter").value;
  $("modalList").scrollTop = 0;
  renderList();
});

$("btnClearFilter").addEventListener("click", () => {
  listFilter[openListName] = "";
  $("inpListFilter").value = "";
  $("inpListFilter").focus();
  renderList();
});

// Moves the entry across, keeping its title, year and poster, then asks for a
// rating the same way swiping down does.
function markSeenFromWatchlist(id, entry, after) {
  lists.seen[id] = { ...entry };
  delete lists.watchlist[id];
  saveLists();
  refreshCounts();
  renderList();
  openRating(id, lists.seen[id], after);
}

function buildRow(id, entry) {
  const li = document.createElement("li");
  li.className = "movie-row";

  const inner = document.createElement("div");
  inner.className = "row-inner";

  const img = document.createElement("img");
  img.src = entry.poster ? IMG_SMALL + entry.poster : "icons/icon.svg";
  img.alt = "";
  img.draggable = false;
  const text = document.createElement("div");
  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = entry.title;
  const year = document.createElement("div");
  year.className = "row-year";
  year.textContent = entry.year || "";
  text.append(title, year);

  // Seen movies carry a rating; the strip shows it and opens the sheet to
  // change it, so it must not also count as a tap on the row.
  if (openListName === "seen") {
    const stars = document.createElement("div");
    stars.className = "stars row-stars";
    renderStars(stars, entry.rating || 0, null);
    stars.addEventListener("click", (e) => {
      e.stopPropagation();
      openRating(id, entry);
    });
    text.appendChild(stars);
  }

  inner.append(img, text);

  // A row's own action, which must not also count as a tap on the row.
  const rowAction = (label, onTap) => {
    const btn = document.createElement("button");
    btn.className = "row-action";
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onTap();
    });
    inner.appendChild(btn);
  };
  // Watched it after all: the movie moves over to seen and is rated there and
  // then.
  if (openListName === "watchlist") {
    rowAction("Seen", () => markSeenFromWatchlist(id, entry));
  }
  if (openListName === "seen") {
    rowAction("Remove", () => removeFromList("seen", id, entry));
  }

  li.appendChild(inner);

  // Tap opens the movie; a horizontal drag past the threshold removes it.
  let rowDrag = null;
  let swiped = false;

  li.addEventListener("pointerdown", (e) => {
    rowDrag = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false };
    swiped = false;
  });
  li.addEventListener("pointermove", (e) => {
    if (!rowDrag) return;
    const dx = e.clientX - rowDrag.x;
    const dy = e.clientY - rowDrag.y;
    if (!rowDrag.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        rowDrag.active = true;
        try { li.setPointerCapture(rowDrag.id); } catch {}
      } else if (Math.abs(dy) > 10) {
        rowDrag = null;
      }
      return;
    }
    inner.style.transform = `translateX(${Math.min(0, dx)}px)`;
    li.classList.toggle("removing", dx < -70);
  });
  const endRowDrag = (e) => {
    if (!rowDrag) return;
    const wasActive = rowDrag.active;
    const dx = e.clientX - rowDrag.x;
    rowDrag = null;
    if (!wasActive) return;
    swiped = true;
    if (dx < -70) {
      inner.style.transition = "transform 0.2s ease-out";
      inner.style.transform = "translateX(-110%)";
      setTimeout(() => removeFromList(openListName, id, entry), 180);
    } else {
      inner.style.transition = "transform 0.2s ease-out";
      inner.style.transform = "";
      li.classList.remove("removing");
      setTimeout(() => { inner.style.transition = ""; }, 200);
    }
  };
  li.addEventListener("pointerup", endRowDrag);
  li.addEventListener("pointercancel", endRowDrag);
  li.addEventListener("click", () => {
    if (swiped) return;
    openMovieById(id);
  });

  return li;
}

function removeFromList(name, id, entry) {
  delete lists[name][id];
  saveLists();
  refreshCounts();
  renderList();
  showToast(`Removed "${entry.title}"`, () => {
    lists[name][id] = entry;
    saveLists();
    refreshCounts();
    if (openListName === name && !$("modalList").hidden) renderList();
  });
}

// ---------- Toast ----------

let toastTimer = null;

function showToast(msg, undoFn, ms = 5000) {
  const toast = $("toast");
  $("toastMsg").textContent = msg;
  $("btnUndo").hidden = !undoFn;
  $("btnUndo").onclick = undoFn
    ? () => { hideToast(); undoFn(); }
    : null;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
}

// ---------- Settings ----------

function openSettings() {
  $("inpKeySettings").value = settings.apiKey;
  $("chkRememberSearch").checked = settings.rememberSearch;
  $("keyStatus").hidden = true;
  $("updateStatus").hidden = true;
  $("btnApplyUpdate").hidden = true;
  $("versionText").textContent = "v" + APP_VERSION;
  navPush("settings");
}

// Switching it on keeps whatever search is running right now, rather than
// waiting for the next one to be applied. Switching it off forgets it.
$("chkRememberSearch").addEventListener("change", () => {
  settings.rememberSearch = $("chkRememberSearch").checked;
  saveSettings();
  if (settings.rememberSearch) saveSearch();
  else forgetSearch();
  showToast(
    settings.rememberSearch
      ? "Your search will be waiting next time"
      : "Searches will last the session only",
    null,
    2500
  );
});

$("btnSaveKeySettings").addEventListener("click", async () => {
  const status = $("keyStatus");
  const key = $("inpKeySettings").value.trim();
  if (!key) {
    status.textContent = "Paste a key first.";
    status.hidden = false;
    return;
  }
  const prev = settings.apiKey;
  settings.apiKey = key;
  status.textContent = "Checking…";
  status.hidden = false;
  try {
    await tmdbFetch("/configuration");
    saveSettings();
    status.textContent = "Key saved.";
  } catch (err) {
    settings.apiKey = prev;
    status.textContent = err.message;
  }
});

// Export / import

$("btnExport").addEventListener("click", () => {
  const data = {
    app: "movie-picker",
    version: APP_VERSION,
    exported: new Date().toISOString(),
    settings,
    lists,
    savedSearch: store.load("mp_search", null),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "movie-picker-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("btnImport").addEventListener("click", () => $("fileImport").click());

$("fileImport").addEventListener("change", async () => {
  const file = $("fileImport").files[0];
  $("fileImport").value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== "object" || !data.settings || !data.lists) {
      throw new Error("bad shape");
    }
    settings = {
      apiKey: String(data.settings.apiKey || ""),
      rememberSearch: !!data.settings.rememberSearch,
    };
    lists = data.lists;
    normalizeLists();
    saveSettings();
    saveLists();
    // A search only travels with a backup that was keeping one. The reload
    // below is what puts it back on the form.
    if (settings.rememberSearch && data.savedSearch) store.save("mp_search", data.savedSearch);
    else forgetSearch();
    showToast("Import complete — reloading…");
    setTimeout(() => location.reload(), 900);
  } catch {
    showToast("That file isn't a Movie Picker backup.");
  }
});

// App updates (service worker)

let reloadingForUpdate = false;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) location.reload();
  });
}

$("btnCheckUpdate").addEventListener("click", async () => {
  const status = $("updateStatus");
  const applyBtn = $("btnApplyUpdate");
  applyBtn.hidden = true;
  status.textContent = "Checking…";
  status.hidden = false;

  if (!("serviceWorker" in navigator)) {
    status.textContent = "Updates aren't supported in this browser.";
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      status.textContent = "Offline support isn't active yet. Reload once and try again.";
      return;
    }
    await reg.update();

    // A fresh worker may still be installing; give it a moment.
    if (reg.installing) {
      await new Promise((resolve) => {
        reg.installing.addEventListener("statechange", function onState() {
          if (this.state === "installed" || this.state === "activated") {
            this.removeEventListener("statechange", onState);
            resolve();
          }
        });
      });
    }

    if (reg.waiting) {
      status.textContent = "Update available!";
      applyBtn.hidden = false;
      applyBtn.onclick = () => {
        reloadingForUpdate = true;
        reg.waiting.postMessage({ type: "SKIP_WAITING" });
        status.textContent = "Updating…";
        applyBtn.hidden = true;
      };
    } else {
      status.textContent = "You're on the latest version (v" + APP_VERSION + ").";
    }
  } catch {
    status.textContent = "Couldn't check for updates. Are you online?";
  }
});

// ---------- First-run setup ----------

$("btnSaveKey").addEventListener("click", async () => {
  const key = $("inpKey").value.trim();
  const errEl = $("setupError");
  errEl.hidden = true;
  if (!key) {
    errEl.textContent = "Paste your TMDB API key first.";
    errEl.hidden = false;
    return;
  }
  settings.apiKey = key;
  $("btnSaveKey").disabled = true;
  try {
    await tmdbFetch("/configuration"); // validates the key
    saveSettings();
    show("screen-pick");
    openSearch();
  } catch (err) {
    settings.apiKey = "";
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    $("btnSaveKey").disabled = false;
  }
});

$("btnRetry").addEventListener("click", pickMovie);

// ---------- Boot ----------

// Start with a clean history baseline: no overlay open, depth 0.
history.replaceState({ depth: 0 }, "", location.pathname + location.search);

refreshCounts();
// Before the first pick, so a kept search is the one that runs.
restoreSearch();

if (!settings.apiKey) {
  show("screen-setup");
} else {
  // Blank age/year have sensible defaults now, so always start picking.
  show("screen-pick");
  pickMovie();
}
