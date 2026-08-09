"use strict";

const APP_VERSION = "2.16.0";

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

// Only the API key, age, and year survive restarts. Advanced filters are per-session.
let settings = store.load("mp_settings", { apiKey: "", age: null, fromYear: null });
let lists = store.load("mp_lists", {});
normalizeLists();

function normalizeLists() {
  // v1 called the blocked list "never".
  if (lists.never) {
    lists.blocked = { ...lists.never, ...(lists.blocked || {}) };
    delete lists.never;
  }
  // Skips used to be tracked; they're ephemeral now.
  delete lists.skipped;
  for (const name of ["favorites", "seen", "blocked"]) {
    if (!lists[name] || typeof lists[name] !== "object") lists[name] = {};
  }
}

function saveSettings() { store.save("mp_settings", settings); }
function saveLists() { store.save("mp_lists", lists); }

// Session-only search filters (advanced is off by default on every start).
const search = {
  title: "", // a name to look up; switches the pool to /search/movie
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
  medium: "", // production format, one at a time (see MEDIUMS)
  maxRuntime: 150,
};

function effectiveAge() {
  return settings.age || 21; // blank age searches as an adult-but-not-R+ default
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
    append_to_response: "credits,videos,release_dates,keywords",
  });
}

// US certifications allowed for the youngest viewer's age.
const CERT_RANK = { G: 0, PG: 1, "PG-13": 2, R: 3, "NC-17": 4 };

function certForAge(age) {
  if (age < 8) return "G";
  if (age < 13) return "PG";
  if (age < 17) return "PG-13";
  return "R";
}

function certOf(m) {
  const us = (m.release_dates?.results || []).find((r) => r.iso_3166_1 === "US");
  const withCert = (us?.release_dates || []).find((d) => d.certification);
  return withCert ? withCert.certification : "";
}

// TMDB's certification.lte filter leaks unrated and miscertified titles, so
// every pick is re-checked against the movie's real US certification below.
function certAllowed(m) {
  if (effectiveAge() >= 17) return true;
  const cert = certOf(m);
  const max = CERT_RANK[certForAge(effectiveAge())];
  return cert in CERT_RANK && CERT_RANK[cert] <= max;
}

// ---------- Production format ----------

// TMDB has no field for how a movie was made, so every format except live
// action rides on its keyword tags. Keyword ids aren't stable enough to hard
// code, so the names below are resolved against TMDB at runtime and a chip
// only appears once its keywords come back — if TMDB doesn't know a name, the
// option quietly isn't offered.
//
// Coverage is contributor-supplied and uneven: a format finds the movies TMDB
// has tagged, not every movie that qualifies.
const MEDIUMS = [
  // Live action is the one that doesn't need keywords: it's "not animated",
  // and without_genres is its own parameter, so it ANDs cleanly with the rest.
  { key: "live", label: "Live action", withoutGenre: 16 },
  { key: "stopmotion", label: "Stop motion", keywords: ["stop motion", "claymation"] },
  { key: "mixed", label: "Mixed media", keywords: ["live action and animation"] },
  { key: "handdrawn", label: "Hand-drawn", keywords: ["traditional animation", "hand drawn animation"] },
  { key: "cgi", label: "CGI", keywords: ["computer animation", "cgi animation"] },
  { key: "anime", label: "Anime", keywords: ["anime"] },
  { key: "puppets", label: "Puppets", keywords: ["puppet", "puppetry"] },
  { key: "silent", label: "Silent", keywords: ["silent film"] },
  { key: "bw", label: "Black & white", keywords: ["black and white"] },
];

const mediumByKey = (key) => MEDIUMS.find((m) => m.key === key);

// Resolved once per session. Exact name matches only — TMDB's keyword search
// is fuzzy, and a near miss would put a chip on screen that filters to junk.
let mediumsReady = null;

function resolveKeyword(name) {
  return tmdbFetch("/search/keyword", { query: name })
    .then((r) => (r.results || []).filter((k) => k.name.toLowerCase() === name).map((k) => k.id))
    .catch(() => []); // one dud name shouldn't cost the rest of the list
}

function ensureMediums() {
  if (!mediumsReady) {
    mediumsReady = Promise.all(
      MEDIUMS.filter((m) => m.keywords).map(async (m) => {
        const found = await Promise.all(m.keywords.map(resolveKeyword));
        m.keywordIds = [...new Set(found.flat())];
      })
    ).then(() => {
      const available = MEDIUMS.filter((m) => !m.keywords || m.keywordIds.length);
      // Nothing at all resolving means the network was down, not that TMDB
      // dropped every keyword — drop the cache so the next open retries.
      if (available.length <= 1) mediumsReady = null;
      return available;
    });
  }
  return mediumsReady;
}

function mediumParams(p) {
  const m = mediumByKey(search.medium);
  if (!m) return;
  if (m.withoutGenre) p.without_genres = String(m.withoutGenre);
  if (m.keywordIds?.length) p.with_keywords = m.keywordIds.join("|"); // any of them
}

// The keyword tags a discover search matched on, re-checked against a loaded
// movie (for title results and injected favorites, which skip discover).
function mediumOk(movie) {
  const m = mediumByKey(search.medium);
  if (!m) return true;
  if (m.withoutGenre && (movie.genres || []).some((g) => g.id === m.withoutGenre)) return false;
  if (m.keywordIds?.length) {
    const tags = (movie.keywords?.keywords || []).map((k) => k.id);
    if (!m.keywordIds.some((id) => tags.includes(id))) return false;
  }
  return true;
}

function discoverParams(page) {
  const p = {
    certification_country: "US",
    "certification.lte": certForAge(effectiveAge()),
    sort_by: "popularity.desc",
    include_adult: "false",
    "vote_count.gte": "200",   // enough votes that the score means something
    "vote_average.gte": "6",   // quality floor so picks are watchable
    page: String(page),
  };
  if (settings.fromYear) p["primary_release_date.gte"] = settings.fromYear + "-01-01";
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
      // Personal filmographies are small; the popularity floors would empty them out.
      p["vote_count.gte"] = "10";
      delete p["vote_average.gte"];
      if (effectiveAge() >= 17) {
        // The certification join excludes anything TMDB has no US rating for,
        // which guts person searches. Adults don't need it (picks are verified).
        delete p.certification_country;
        delete p["certification.lte"];
      }
    }
    if (search.maxRuntime) p["with_runtime.lte"] = String(search.maxRuntime);
    mediumParams(p);
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
// injected favorites, and title searches (/search/movie takes no filters).
function matchesSearch(m) {
  if (!certAllowed(m)) return false;
  const year = parseInt((m.release_date || "").slice(0, 4), 10);
  if (settings.fromYear && !(year >= settings.fromYear)) return false;
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
  if (!mediumOk(m)) return false;
  const cast = m.credits?.cast || [];
  if (!search.actorIds.every((id) => cast.some((c) => c.id === id))) return false;
  return crewOk(m);
}

// ---------- Title lookups ----------

// Discover has no query parameter, so a title goes through /search/movie and
// is ordered here instead: closest matches first, and within equally close
// matches oldest to newest, so a series plays in the order it was released.

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

// Sorting by date needs the whole result set, so it's fetched once per query
// and kept: stepping through a series costs one request per movie, not five.
let titlePool = { query: null, movies: [], total: 0 };

async function ensureTitlePool(token) {
  if (titlePool.query === search.title) return true;
  const fetchPage = (page) =>
    tmdbFetch("/search/movie", {
      query: search.title,
      include_adult: "false",
      page: String(page),
    });

  const first = await fetchPage(1);
  if (token !== pickToken) return false;
  const movies = [...first.results];
  for (let p = 2; p <= Math.min(first.total_pages, 5); p++) {
    const data = await fetchPage(p);
    if (token !== pickToken) return false;
    movies.push(...data.results);
  }
  movies.sort(byMatchThenRelease(search.title));
  titlePool = { query: search.title, movies, total: first.total_results };
  return true;
}

async function pickFromTitle(token) {
  if (!(await ensureTitlePool(token))) return;

  if (announceCount) {
    announceCount = false;
    if (titlePool.total > 0) {
      showToast(
        titlePool.total.toLocaleString() + (titlePool.total === 1 ? " match" : " matches"),
        null,
        2000
      );
    }
  }

  // Nothing is held back from a title lookup — a movie already sitting in a
  // list can still be found by name.
  const usable = titlePool.movies.filter((m) => m.poster_path);
  if (!usable.length) {
    showPickError(
      'No movies found for "' + search.title + '". Check the spelling, or try fewer words.'
    );
    return;
  }
  let fresh = usable.filter((m) => !sessionShown.has(m.id));
  if (!fresh.length) {
    // Been through them all this session — start the series over.
    sessionShown.clear();
    fresh = usable.filter((m) => m.id !== lastShownId);
  }

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
  if (search.title) bits.push('matching "' + search.title + '"');
  if (effectiveAge() < 17) bits.push("rated " + certForAge(effectiveAge()) + " or under");
  if (settings.fromYear) bits.push(settings.fromYear + " and newer");
  if (search.advanced) {
    if (search.genres.size && genreCache) {
      const names = genreCache.filter((g) => search.genres.has(g.id)).map((g) => g.name);
      bits.push(names.join(search.genreMode === "any" ? " or " : " + "));
    }
    if (search.medium) bits.push(mediumByKey(search.medium).label.toLowerCase());
    if (search.actorNames.length) bits.push("with " + search.actorNames.join(" & "));
    if (search.directorNames.length) bits.push("directed by " + search.directorNames.join(" & "));
    if (search.composerNames.length) bits.push("music by " + search.composerNames.join(" & "));
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

function excludedIds() {
  return new Set(
    [
      ...Object.keys(lists.favorites),
      ...Object.keys(lists.seen),
      ...Object.keys(lists.blocked),
    ].map(Number)
  );
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

// Favorites are excluded from discover results, so every FAVORITE_EVERY-th
// pick hands one back deliberately: a random favorite instead of a new movie.
// It still has to satisfy the current search, so a favorite only turns up
// where it would have been a legitimate result anyway.
const FAVORITE_EVERY = 20;
const FAVORITE_TRIES = 5; // details fetches spent looking for a qualifying one
let picksServed = 0;

function servePick(details) {
  picksServed++;
  renderMovie(details);
}

// During a title lookup a favorite has to be one of the movies that lookup
// found — TMDB's own answer to "does this match", typos and all.
function eligibleForInjection(id) {
  if (!search.title) return true;
  return titlePool.query === search.title && titlePool.movies.some((m) => m.id === id);
}

// "rendered" | "stale" (a newer pick started) | "none" (fall back to discover)
async function tryFavoritePick(token) {
  // The stored year is enough to drop the obvious misses before spending a
  // request on them; everything else needs the full movie.
  const ids = shuffle(
    Object.entries(lists.favorites)
      .filter(([id, e]) =>
        Number(id) !== lastShownId &&
        eligibleForInjection(Number(id)) &&
        (!settings.fromYear || parseInt(e.year, 10) >= settings.fromYear))
      .map(([id]) => Number(id))
  );
  for (const id of ids.slice(0, FAVORITE_TRIES)) {
    let details;
    try {
      details = await fetchMovie(id);
    } catch {
      continue; // dead id or a network blip — a normal pick still gets a movie
    }
    if (token !== pickToken) return "stale";
    if (!matchesSearch(details)) continue;
    servePick(details);
    showToast("One from your favorites ❤", null, 2500);
    return "rendered";
  }
  return "none";
}

async function pickMovie() {
  const token = ++pickToken;
  if (!$("card").hidden) {
    $("card").classList.add("loading");
  } else {
    showPickState("loading");
  }
  try {
    // Not on the first pick of a new search — that one belongs to the search,
    // and owns the result-count toast.
    if (!announceCount &&
        (picksServed + 1) % FAVORITE_EVERY === 0 &&
        Object.keys(lists.favorites).length) {
      const outcome = await tryFavoritePick(token);
      if (outcome !== "none") return;
    }

    if (search.title) return await pickFromTitle(token);

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
          if (!certAllowed(details) || !crewOk(details)) continue;
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

    // TMDB caps discover at 500 pages; stay well inside it.
    const totalPages = Math.min(first.total_pages, 300);
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
        if (!certAllowed(details) || !crewOk(details)) continue;
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

async function openMovieById(id) {
  const token = ++pickToken; // cancel any in-flight pick
  showPickState("loading");
  navHome();
  try {
    const details = await fetchMovie(id);
    if (token !== pickToken) return;
    renderMovie(details);
  } catch (err) {
    if (token !== pickToken) return;
    showPickError(err.message || "Couldn't load that movie.");
  }
}

// ---------- Rendering ----------

const $ = (id) => document.getElementById(id);

let current = null; // the movie on screen

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

function renderMovie(m) {
  current = m;
  sessionShown.add(m.id);

  $("poster").src = m.poster_path ? IMG + m.poster_path : "";
  $("poster").alt = m.title + " poster";
  $("movieTitle").textContent = m.title;
  fillMeta($("movieMeta"), m);
  $("movieGenres").textContent = (m.genres || []).map((g) => g.name).join(" · ");
  refreshHeart();

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

function refreshHeart() {
  $("btnFav").classList.toggle("active", !!(current && lists.favorites[current.id]));
}

function listEntry(m) {
  return {
    title: m.title,
    year: (m.release_date || "").slice(0, 4),
    poster: m.poster_path || null,
  };
}

function markCurrent(listName) {
  if (!current) return;
  lists[listName][current.id] = listEntry(current);
  saveLists();
  refreshCounts();
  lastShownId = current.id;
  current = null;
  pickMovie();
}

// A literal skip: nothing is stored, the movie stays in the rotation.
function skipCurrent() {
  if (!current) return;
  lastShownId = current.id;
  current = null;
  pickMovie();
}

function toggleFavorite() {
  if (!current) return;
  if (lists.favorites[current.id]) {
    delete lists.favorites[current.id];
  } else {
    lists.favorites[current.id] = listEntry(current);
  }
  saveLists();
  refreshCounts();
  refreshHeart();
}

function refreshCounts() {
  const n = (o) => Object.keys(o).length;
  $("cntFavorites").textContent = n(lists.favorites) || "";
  $("cntSeen").textContent = n(lists.seen) || "";
  $("cntBlocked").textContent = n(lists.blocked) || "";
}

// ---------- Navigation (URL hash <-> overlays) ----------
// Every overlay gets a history entry (#search, #info, #settings, #menu,
// #list-*, #trailer) so the browser/phone back button closes it instead of
// exiting the app. The hash is the single source of truth for what's open.

const MODALS = ["modalSearch", "modalInfo", "modalList", "modalSettings"];

function navPush(frag) {
  if (location.hash === "#" + frag) {
    applyHash();
    return;
  }
  const depth = (history.state && history.state.depth) || 0;
  history.pushState({ depth: depth + 1 }, "", "#" + frag);
  applyHash();
}

function navBack() {
  if (((history.state && history.state.depth) || 0) > 0) history.back();
}

// Pop every overlay entry at once (e.g. opening a movie from a list).
function navHome() {
  const depth = (history.state && history.state.depth) || 0;
  if (depth > 0) history.go(-depth);
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
  const h = location.hash.replace(/^#/, "");
  document.body.classList.toggle("drawer-open", h === "menu");

  const listName = h.startsWith("list-") ? h.slice(5) : null;
  if (listName && LIST_LABELS[listName]) {
    if (openListName !== listName) {
      openListName = listName;
      $("listTitle").textContent = LIST_LABELS[listName];
    }
    renderList();
    setShown("modalList", true);
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
}

window.addEventListener("popstate", applyHash);

document.querySelectorAll(".modal-close").forEach((btn) => {
  btn.addEventListener("click", navBack);
});

$("btnInfoBack").addEventListener("click", navBack);

$("btnMenu").addEventListener("click", () => {
  refreshCounts();
  navPush("menu");
});
$("drawerOverlay").addEventListener("click", navBack);

// ---------- Search ----------

function updateCertHint() {
  const age = parseInt($("inpAge").value, 10);
  $("certHint").textContent = Number.isFinite(age) && age > 0
    ? `Movies rated up to ${certForAge(age)} will be included.`
    : "Blank = 21 (movies rated up to R).";
}

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
async function renderMediumChips() {
  const box = $("mediumChips");
  try {
    const available = await ensureMediums();
    box.innerHTML = "";
    for (const m of available) {
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
  } catch {
    box.innerHTML = '<p class="hint">Couldn\'t load formats. Check your connection.</p>';
  }
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

function openSearch() {
  $("inpTitle").value = search.title;
  $("inpAge").value = settings.age || "";
  $("inpYear").value = settings.fromYear || "";
  $("chkAdvanced").checked = search.advanced;
  $("advancedBox").hidden = !search.advanced;
  $("inpActors").value = search.actors;
  $("inpDirector").value = search.director;
  $("inpComposer").value = search.composer;
  buildRuntimeOptions();
  renderGenreMode();
  if (search.advanced) {
    renderGenreChips();
    renderMediumChips();
  }
  updateCertHint();
  $("searchError").hidden = true;
  navPush("search");
}

$("btnSearch").addEventListener("click", openSearch);
$("btnErrorSearch").addEventListener("click", openSearch);
$("inpAge").addEventListener("input", updateCertHint);

$("chkAdvanced").addEventListener("change", () => {
  $("advancedBox").hidden = !$("chkAdvanced").checked;
  if ($("chkAdvanced").checked) {
    renderGenreChips();
    renderMediumChips();
  }
});

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
  const age = $("inpAge").value.trim() ? parseInt($("inpAge").value, 10) : null;
  const year = $("inpYear").value.trim() ? parseInt($("inpYear").value, 10) : null;

  if (age !== null && (!Number.isFinite(age) || age < 1 || age > 120)) {
    errEl.textContent = "Enter the youngest viewer's age (1–120), or leave it blank for 21.";
    errEl.hidden = false;
    return;
  }
  if (year !== null && (!Number.isFinite(year) || year < 1930 || year > thisYear)) {
    errEl.textContent = `Enter a year between 1930 and ${thisYear}, or leave it blank for all time.`;
    errEl.hidden = false;
    return;
  }

  settings.age = age;
  settings.fromYear = year;
  saveSettings();

  search.title = $("inpTitle").value.trim();
  search.advanced = $("chkAdvanced").checked;
  const btn = $("btnApplySearch");
  btn.disabled = true;
  try {
    if (search.advanced) {
      search.actors = $("inpActors").value;
      search.director = $("inpDirector").value;
      search.composer = $("inpComposer").value;
      search.maxRuntime = $("selRuntime").value ? parseInt($("selRuntime").value, 10) : 0;
      const actors = await resolveActors(search.actors);
      const directors = await resolveActors(search.director);
      const composers = await resolveActors(search.composer);
      const missing = [...actors.missing, ...directors.missing, ...composers.missing];
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
    } else {
      search.actorIds = [];
      search.actorNames = [];
      search.directorIds = [];
      search.directorNames = [];
      search.composerIds = [];
      search.composerNames = [];
    }
    sessionShown.clear();
    announceCount = true;
    navBack();
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

function openInfo() {
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

  // Tapping a name searches that person's whole filmography (all time, age 21).
  const personLink = (kind) => (p) => {
    const s = document.createElement("span");
    s.className = "person-link";
    s.textContent = p.name;
    s.addEventListener("click", () => forcePersonSearch(kind, p.id, p.name));
    return s;
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
  const writers = [...new Set(
    [...crewPeople("Screenplay"), ...crewPeople("Writer")].map((c) => c.name)
  )];
  if (writers.length) rows.push(["Written by", writers.slice(0, 4).join(", ")]);
  const composers = crewPeople("Original Music Composer");
  if (composers.length) {
    const frag = document.createElement("span");
    composers.forEach((p, i) => {
      if (i) frag.append(", ");
      frag.appendChild(personLink("composer")(p));
    });
    rows.push(["Music", frag]);
  }
  const countries = (m.production_countries || []).map((c) => c.name);
  if (countries.length) rows.push(["Country", countries.join(", ")]);
  if (m.budget) rows.push(["Budget", money(m.budget)]);
  if (m.revenue) rows.push(["Box office", money(m.revenue)]);
  const studios = (m.production_companies || []).slice(0, 3).map((c) => c.name);
  if (studios.length) rows.push(["Studio", studios.join(", ")]);

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
  navPush("info");
}

// A person tap in the info screen becomes a fresh advanced search for just
// that person: all time (blank year), blank age (21), no other filters.
function forcePersonSearch(kind, id, name) {
  search.advanced = true;
  search.title = "";
  search.genres.clear();
  search.genreMode = "all";
  search.medium = "";
  search.maxRuntime = 0;
  search.actors = ""; search.actorIds = []; search.actorNames = [];
  search.director = ""; search.directorIds = []; search.directorNames = [];
  search.composer = ""; search.composerIds = []; search.composerNames = [];
  if (kind === "actor") {
    search.actors = name; search.actorIds = [id]; search.actorNames = [name];
  } else if (kind === "director") {
    search.director = name; search.directorIds = [id]; search.directorNames = [name];
  } else {
    search.composer = name; search.composerIds = [id]; search.composerNames = [name];
  }
  settings.age = null;
  settings.fromYear = null;
  saveSettings();
  sessionShown.clear();
  announceCount = true;
  navHome();
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

$("btnFav").addEventListener("click", toggleFavorite);

// Right = favorite, left = block, up = skip, down = seen.
// A tap (no drag) on the poster opens More info; a double tap plays the trailer.
const swipeArea = $("swipeArea");
const BADGES = ["badgeFav", "badgeSkip", "badgeSeen", "badgeBlock"];
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
    $("badgeFav").style.opacity = fade(dx);
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
      if (current && !lists.favorites[current.id]) {
        lists.favorites[current.id] = listEntry(current);
        saveLists();
        refreshCounts();
      }
      current = null;
      pickMovie();
    });
  } else if (axis === "x" && dx < -90) {
    const blocked = current;
    swipeOut("x", -1, () => {
      markCurrent("blocked");
      // Blocking is easy to hit by accident on a fling; offer a way back.
      showToast(`Blocked "${blocked.title}"`, () => {
        delete lists.blocked[blocked.id];
        saveLists();
        refreshCounts();
      });
    });
  } else if (axis === "y" && dy < -90) {
    swipeOut("y", -1, skipCurrent);
  } else if (axis === "y" && dy > 90) {
    swipeOut("y", 1, () => markCurrent("seen"));
  } else {
    snapBack();
  }
}

swipeArea.addEventListener("pointerup", endDrag);
swipeArea.addEventListener("pointercancel", endDrag);

// ---------- Saved lists (drawer) ----------

const LIST_LABELS = {
  favorites: "Favorites",
  seen: "Seen",
  blocked: "Blocked",
};

let openListName = null;

document.querySelectorAll(".drawer-item[data-list]").forEach((btn) => {
  btn.addEventListener("click", () => navPush("list-" + btn.dataset.list));
});

$("drawerSettings").addEventListener("click", () => openSettings());

function renderList() {
  const ul = $("listItems");
  ul.innerHTML = "";
  const entries = Object.entries(lists[openListName]);
  $("listEmpty").hidden = entries.length > 0;
  for (const [id, entry] of entries) {
    ul.appendChild(buildRow(id, entry));
  }
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
  inner.append(img, text);
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
  $("keyStatus").hidden = true;
  $("updateStatus").hidden = true;
  $("btnApplyUpdate").hidden = true;
  $("versionText").textContent = "v" + APP_VERSION;
  navPush("settings");
}

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
      age: data.settings.age || null,
      fromYear: data.settings.fromYear || null,
    };
    lists = data.lists;
    normalizeLists();
    saveSettings();
    saveLists();
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

if (!settings.apiKey) {
  show("screen-setup");
} else {
  // Blank age/year have sensible defaults now, so always start picking.
  show("screen-pick");
  pickMovie();
}
