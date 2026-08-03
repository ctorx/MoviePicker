"use strict";

const APP_VERSION = "2.6.1";

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
  for (const name of ["favorites", "skipped", "seen", "blocked"]) {
    if (!lists[name] || typeof lists[name] !== "object") lists[name] = {};
  }
}

function saveSettings() { store.save("mp_settings", settings); }
function saveLists() { store.save("mp_lists", lists); }

// Session-only search filters (advanced is off by default on every start).
const search = {
  advanced: false,
  genres: new Set(),
  actors: "",
  actorIds: [],
  actorNames: [],
  director: "",
  directorIds: [],
  directorNames: [],
  maxRuntime: 120,
};

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
  if (settings.age >= 17) return true;
  const cert = certOf(m);
  const max = CERT_RANK[certForAge(settings.age)];
  return cert in CERT_RANK && CERT_RANK[cert] <= max;
}

function discoverParams(page) {
  const p = {
    certification_country: "US",
    "certification.lte": certForAge(settings.age),
    "primary_release_date.gte": settings.fromYear + "-01-01",
    sort_by: "popularity.desc",
    include_adult: "false",
    "vote_count.gte": "200",   // enough votes that the score means something
    "vote_average.gte": "6",   // quality floor so picks are watchable
    page: String(page),
  };
  if (search.advanced) {
    if (search.genres.size) p.with_genres = [...search.genres].join(",");
    if (search.actorIds.length) p.with_cast = search.actorIds.join(",");
    if (search.directorIds.length) p.with_crew = search.directorIds.join(",");
    if (search.actorIds.length || search.directorIds.length) {
      // Personal filmographies are small; the popularity floors would empty them out.
      p["vote_count.gte"] = "10";
      delete p["vote_average.gte"];
      if (settings.age >= 17) {
        // The certification join excludes anything TMDB has no US rating for,
        // which guts person searches. Adults don't need it (picks are verified).
        delete p.certification_country;
        delete p["certification.lte"];
      }
    }
    if (search.maxRuntime) p["with_runtime.lte"] = String(search.maxRuntime);
  }
  return p;
}

// with_crew matches any crew role, so confirm the person actually directed.
function directorOk(m) {
  if (!search.advanced || !search.directorIds.length) return true;
  const crew = m.credits?.crew || [];
  return crew.some((c) => c.job === "Director" && search.directorIds.includes(c.id));
}

function searchSummary() {
  const bits = [];
  if (settings.age < 17) bits.push("rated " + certForAge(settings.age) + " or under");
  bits.push(settings.fromYear + " and newer");
  if (search.advanced) {
    if (search.genres.size && genreCache) {
      bits.push(genreCache.filter((g) => search.genres.has(g.id)).map((g) => g.name).join("/"));
    }
    if (search.actorNames.length) bits.push("with " + search.actorNames.join(" & "));
    if (search.directorNames.length) bits.push("directed by " + search.directorNames.join(" & "));
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
      ...Object.keys(lists.skipped),
      ...Object.keys(lists.seen),
      ...Object.keys(lists.blocked),
    ].map(Number)
  );
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let pickToken = 0; // ignore stale responses when the user re-searches mid-load

async function pickMovie() {
  const token = ++pickToken;
  if (!$("card").hidden) {
    $("card").classList.add("loading");
  } else {
    showPickState("loading");
  }
  try {
    const excluded = excludedIds();
    const first = await tmdbFetch("/discover/movie", discoverParams(1));
    if (token !== pickToken) return;

    if (first.total_results === 0) {
      showPickError("No movies match: " + searchSummary() + ". Try relaxing a filter.");
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
        data.results.filter((m) => !excluded.has(m.id) && m.poster_path)
      );

      // Verify the real certification before accepting a candidate (see certAllowed).
      for (const movie of candidates.slice(0, 5)) {
        const details = await tmdbFetch("/movie/" + movie.id, {
          append_to_response: "credits,videos,release_dates",
        });
        if (token !== pickToken) return;
        if (!certAllowed(details) || !directorOk(details)) continue;
        renderMovie(details);
        return;
      }
    }

    showPickError("Looks like you've been through everything that matches! Widen the search, or clear your skipped list from the menu.");
  } catch (err) {
    if (token !== pickToken) return;
    showPickError(err.message || "Something went wrong. Check your connection.");
  }
}

async function openMovieById(id) {
  const token = ++pickToken; // cancel any in-flight pick
  showPickState("loading");
  closeAllModals();
  try {
    const details = await tmdbFetch("/movie/" + id, {
      append_to_response: "credits,videos,release_dates",
    });
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
  $("cntSkipped").textContent = n(lists.skipped) || "";
  $("cntSeen").textContent = n(lists.seen) || "";
  $("cntBlocked").textContent = n(lists.blocked) || "";
}

// ---------- Modals & drawer ----------

const MODALS = ["modalSearch", "modalInfo", "modalList", "modalSettings"];

function openModal(id) {
  $(id).hidden = false;
  $(id).scrollTop = 0;
  document.body.classList.add("no-scroll");
}

function closeModal(id) {
  $(id).hidden = true;
  if (MODALS.every((m) => $(m).hidden)) document.body.classList.remove("no-scroll");
}

function closeAllModals() {
  MODALS.forEach((m) => ($(m).hidden = true));
  document.body.classList.remove("no-scroll");
  closeDrawer();
}

document.querySelectorAll(".modal-close").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});

$("btnInfoBack").addEventListener("click", () => closeModal("modalInfo"));

function openDrawer() {
  refreshCounts();
  document.body.classList.add("drawer-open");
}
function closeDrawer() {
  document.body.classList.remove("drawer-open");
}

$("btnMenu").addEventListener("click", openDrawer);
$("drawerOverlay").addEventListener("click", closeDrawer);

// ---------- Search ----------

function updateCertHint() {
  const age = parseInt($("inpAge").value, 10);
  $("certHint").textContent = Number.isFinite(age) && age > 0
    ? `Movies rated up to ${certForAge(age)} will be included.`
    : "Sets the maximum movie rating (G, PG, PG-13, R).";
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
  if (settings.age) $("inpAge").value = settings.age;
  if (settings.fromYear) $("inpYear").value = settings.fromYear;
  $("chkAdvanced").checked = search.advanced;
  $("advancedBox").hidden = !search.advanced;
  $("inpActors").value = search.actors;
  $("inpDirector").value = search.director;
  buildRuntimeOptions();
  if (search.advanced) renderGenreChips();
  updateCertHint();
  $("searchError").hidden = true;
  closeDrawer();
  openModal("modalSearch");
}

$("btnSearch").addEventListener("click", openSearch);
$("btnErrorSearch").addEventListener("click", openSearch);
$("inpAge").addEventListener("input", updateCertHint);

$("chkAdvanced").addEventListener("change", () => {
  $("advancedBox").hidden = !$("chkAdvanced").checked;
  if ($("chkAdvanced").checked) renderGenreChips();
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

  const age = parseInt($("inpAge").value, 10);
  const year = parseInt($("inpYear").value, 10);
  const thisYear = new Date().getFullYear();

  if (!Number.isFinite(age) || age < 1 || age > 120) {
    errEl.textContent = "Enter the youngest viewer's age (1–120).";
    errEl.hidden = false;
    return;
  }
  if (!Number.isFinite(year) || year < 1930 || year > thisYear) {
    errEl.textContent = `Enter a year between 1930 and ${thisYear}.`;
    errEl.hidden = false;
    return;
  }

  settings.age = age;
  settings.fromYear = year;
  saveSettings();

  search.advanced = $("chkAdvanced").checked;
  const btn = $("btnApplySearch");
  btn.disabled = true;
  try {
    if (search.advanced) {
      search.actors = $("inpActors").value;
      search.director = $("inpDirector").value;
      search.maxRuntime = $("selRuntime").value ? parseInt($("selRuntime").value, 10) : 0;
      const actors = await resolveActors(search.actors);
      const directors = await resolveActors(search.director);
      const missing = [...actors.missing, ...directors.missing];
      if (missing.length) {
        errEl.textContent = "Couldn't find: " + missing.join(", ");
        errEl.hidden = false;
        return;
      }
      search.actorIds = actors.ids;
      search.actorNames = actors.resolved;
      search.directorIds = directors.ids;
      search.directorNames = directors.resolved;
      // Confirms who the names matched, so a typo is easy to catch.
      const who = [];
      if (actors.resolved.length) who.push("with " + actors.resolved.join(" & "));
      if (directors.resolved.length) who.push("directed by " + directors.resolved.join(" & "));
      if (who.length) showToast("Movies " + who.join(", "));
    } else {
      search.actorIds = [];
      search.actorNames = [];
      search.directorIds = [];
      search.directorNames = [];
    }
    closeModal("modalSearch");
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
  const crewNames = (job) => crew.filter((c) => c.job === job).map((c) => c.name);
  const directors = crewNames("Director");
  $("infoDirector").textContent = directors.length ? "Directed by: " + directors.join(", ") : "";

  const cast = (m.credits?.cast || []).slice(0, 10).map((c) => c.name).join(", ");
  $("infoCast").textContent = cast ? "Starring: " + cast : "";

  const money = (n) =>
    n >= 1e6 ? "$" + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M" : "$" + n.toLocaleString();
  const rows = [];
  const writers = [...new Set([...crewNames("Screenplay"), ...crewNames("Writer")])];
  if (writers.length) rows.push(["Written by", writers.slice(0, 4).join(", ")]);
  const composers = crewNames("Original Music Composer");
  if (composers.length) rows.push(["Music", composers.join(", ")]);
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
    v.textContent = value;
    row.append(k, v);
    extra.appendChild(row);
  }

  trailerKey = trailerKeyFor(m);
  $("btnTrailer").hidden = !trailerKey;
  $("lnkCSM").href = "https://www.commonsensemedia.org/movie-reviews/" + csmSlug(m.title);
  openModal("modalInfo");
}

// Common Sense Media review slugs are the lowercased title with punctuation
// dropped, e.g. "Spider-Man: Into the Spider-Verse" -> spider-man-into-the-spider-verse
function csmSlug(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}


// ---------- Trailer player ----------

// Embedded player instead of a YouTube link so we can go fullscreen and
// (where the browser allows it — Android, not iOS) lock landscape.
let trailerKey = null;

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
  $("trailerFrame").src =
    "https://www.youtube-nocookie.com/embed/" + key +
    "?autoplay=1&playsinline=1&rel=0";
  $("lnkTrailerYT").href = "https://www.youtube.com/watch?v=" + key;
  const overlay = $("trailerOverlay");
  overlay.hidden = false;
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

function closeTrailer() {
  $("trailerOverlay").hidden = true;
  $("trailerFrame").src = "";
  try {
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
  } catch {}
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

$("btnTrailer").addEventListener("click", () => openTrailer(trailerKey));
$("btnCloseTrailer").addEventListener("click", closeTrailer);
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && !$("trailerOverlay").hidden) closeTrailer();
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
    if (key) openTrailer(key);
    else showToast("No trailer available for this one.");
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
    swipeOut("y", -1, () => markCurrent("skipped"));
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
  skipped: "Skipped",
  seen: "Seen",
  blocked: "Blocked",
};

let openListName = null;

document.querySelectorAll(".drawer-item[data-list]").forEach((btn) => {
  btn.addEventListener("click", () => {
    closeDrawer();
    openList(btn.dataset.list);
  });
});

$("drawerSettings").addEventListener("click", () => {
  closeDrawer();
  openSettings();
});

function openList(name) {
  openListName = name;
  $("listTitle").textContent = LIST_LABELS[name];
  renderList();
  openModal("modalList");
}

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

function showToast(msg, undoFn) {
  const toast = $("toast");
  $("toastMsg").textContent = msg;
  $("btnUndo").hidden = !undoFn;
  $("btnUndo").onclick = undoFn
    ? () => { hideToast(); undoFn(); }
    : null;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
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
  openModal("modalSettings");
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
    app: "movie-night",
    version: APP_VERSION,
    exported: new Date().toISOString(),
    settings,
    lists,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "movie-night-backup.json";
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
    showToast("That file isn't a Movie Night backup.");
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

refreshCounts();

if (!settings.apiKey) {
  show("screen-setup");
} else {
  show("screen-pick");
  if (settings.age && settings.fromYear) {
    pickMovie();
  } else {
    openSearch();
  }
}
