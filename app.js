"use strict";

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

let settings = store.load("mp_settings", { apiKey: "", age: null, fromYear: null });
// Each list maps movieId -> { title, year }
let lists = store.load("mp_lists", { seen: {}, skipped: {}, never: {} });

function saveSettings() { store.save("mp_settings", settings); }
function saveLists() { store.save("mp_lists", lists); }

// ---------- TMDB API ----------

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";

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
function certForAge(age) {
  if (age < 8) return "G";
  if (age < 13) return "PG";
  if (age < 17) return "PG-13";
  return "R";
}

function discoverParams(page) {
  return {
    certification_country: "US",
    "certification.lte": certForAge(settings.age),
    "primary_release_date.gte": settings.fromYear + "-01-01",
    sort_by: "popularity.desc",
    include_adult: "false",
    "vote_count.gte": "200",   // enough votes that the score means something
    "vote_average.gte": "6",   // quality floor so picks are watchable
    page: String(page),
  };
}

// ---------- Picking ----------

function excludedIds() {
  return new Set([
    ...Object.keys(lists.seen),
    ...Object.keys(lists.skipped),
    ...Object.keys(lists.never),
  ].map(Number));
}

async function pickMovie() {
  showPickState("loading");
  try {
    const excluded = excludedIds();
    const first = await tmdbFetch("/discover/movie", discoverParams(1));

    if (first.total_results === 0) {
      showPickError("No movies match. Try an earlier year or a different age.");
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
      const candidates = data.results.filter((m) => !excluded.has(m.id) && m.poster_path);
      if (candidates.length === 0) continue;

      const movie = candidates[Math.floor(Math.random() * candidates.length)];
      const details = await tmdbFetch("/movie/" + movie.id, { append_to_response: "credits" });
      renderMovie(details);
      return;
    }

    showPickError("Looks like you've been through everything that matches! Clear your skipped list in Settings, or widen the year range.");
  } catch (err) {
    showPickError(err.message || "Something went wrong. Check your connection.");
  }
}

// ---------- Rendering ----------

const $ = (id) => document.getElementById(id);

let current = null; // the movie on screen

function show(screen) {
  for (const s of ["screen-setup", "screen-questions", "screen-pick"]) {
    $(s).hidden = s !== screen;
  }
  $("btnSettings").hidden = screen !== "screen-pick";
}

function showPickState(state) {
  $("loading").hidden = state !== "loading";
  $("pickError").hidden = state !== "error";
  $("card").hidden = state !== "movie";
  $("actions").hidden = state !== "movie";
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

function renderMovie(m) {
  current = m;
  const year = (m.release_date || "").slice(0, 4);

  $("poster").src = m.poster_path ? IMG + m.poster_path : "";
  $("poster").alt = m.title + " poster";
  $("movieTitle").textContent = m.title;
  $("movieMeta").textContent = [year, runtimeText(m.runtime)].filter(Boolean).join(" · ");

  $("movieOverview").textContent = m.overview || "No description available.";
  const cast = (m.credits?.cast || []).slice(0, 8).map((c) => c.name).join(", ");
  $("movieCast").textContent = cast ? "Starring: " + cast : "";
  const bits = [];
  if (m.genres?.length) bits.push(m.genres.map((g) => g.name).join(", "));
  if (m.vote_average) bits.push("TMDB score: " + m.vote_average.toFixed(1) + "/10");
  $("movieExtra").textContent = bits.join(" · ");

  $("details").hidden = true;
  $("btnDetails").textContent = "More info ▾";
  showPickState("movie");
  window.scrollTo(0, 0);
}

function markCurrent(listName) {
  if (!current) return;
  lists[listName][current.id] = {
    title: current.title,
    year: (current.release_date || "").slice(0, 4),
  };
  saveLists();
  current = null;
  pickMovie();
}

function refreshListCounts() {
  const n = (o) => Object.keys(o).length;
  $("listCounts").textContent =
    `Seen: ${n(lists.seen)} · Skipped: ${n(lists.skipped)} · Never: ${n(lists.never)}`;
}

function updateCertHint() {
  const age = parseInt($("inpAge").value, 10);
  $("certHint").textContent = Number.isFinite(age) && age > 0
    ? `Movies rated up to ${certForAge(age)} will be included.`
    : "Sets the maximum movie rating (G, PG, PG-13, R).";
}

// ---------- Wiring ----------

function initQuestionsScreen() {
  if (settings.age) $("inpAge").value = settings.age;
  if (settings.fromYear) $("inpYear").value = settings.fromYear;
  updateCertHint();
  refreshListCounts();
  $("questionsError").hidden = true;
  show("screen-questions");
}

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
    initQuestionsScreen();
  } catch (err) {
    settings.apiKey = "";
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    $("btnSaveKey").disabled = false;
  }
});

$("inpAge").addEventListener("input", updateCertHint);

$("btnStart").addEventListener("click", () => {
  const age = parseInt($("inpAge").value, 10);
  const year = parseInt($("inpYear").value, 10);
  const thisYear = new Date().getFullYear();
  const errEl = $("questionsError");

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
  errEl.hidden = true;
  settings.age = age;
  settings.fromYear = year;
  saveSettings();
  show("screen-pick");
  pickMovie();
});

$("btnSettings").addEventListener("click", initQuestionsScreen);
$("btnBackToQuestions").addEventListener("click", initQuestionsScreen);
$("btnRetry").addEventListener("click", pickMovie);

$("btnDetails").addEventListener("click", () => {
  const d = $("details");
  d.hidden = !d.hidden;
  $("btnDetails").textContent = d.hidden ? "More info ▾" : "Less info ▴";
});

$("btnSkip").addEventListener("click", () => markCurrent("skipped"));
$("btnSeen").addEventListener("click", () => markCurrent("seen"));
$("btnNever").addEventListener("click", () => markCurrent("never"));

function clearList(name, label) {
  if (!confirm(`Clear your "${label}" list?`)) return;
  lists[name] = {};
  saveLists();
  refreshListCounts();
}
$("btnClearSkipped").addEventListener("click", () => clearList("skipped", "skipped"));
$("btnClearSeen").addEventListener("click", () => clearList("seen", "seen it"));
$("btnClearNever").addEventListener("click", () => clearList("never", "never"));

$("btnChangeKey").addEventListener("click", () => {
  $("inpKey").value = settings.apiKey;
  $("setupError").hidden = true;
  show("screen-setup");
});

// ---------- Boot ----------

if (!settings.apiKey) {
  show("screen-setup");
} else if (!settings.age || !settings.fromYear) {
  initQuestionsScreen();
} else {
  show("screen-pick");
  pickMovie();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
