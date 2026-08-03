# Movie Night 🎬

A tiny progressive web app that helps a group pick a movie to watch.

## How it works

1. **One-time setup** — paste a free [TMDB](https://www.themoviedb.org/) API key
   (sign up, then Settings → API → request a Developer key). Stored only in your
   browser's localStorage.
2. **Two questions** — how old is the youngest viewer, and the oldest year to
   draw from. The age caps the movie's US rating (under 8 → G, under 13 → PG,
   under 17 → PG-13, otherwise up to R); the year sets the earliest release date.
3. **Random pick** — the app shows a poster, title, year, and runtime, drawn
   randomly from popular, well-rated matches (TMDB score ≥ 6 with 200+ votes).
   "More info" reveals the description, cast, genres, and score.
4. **Respond** — every pick gets one of:
   - **⏭️ Skip** — not tonight; won't come up again (clearable in Settings)
   - **👀 Seen it** — already watched; never recommended again
   - **🚫 Never** — never show this movie again

All state (key, answers, lists) persists in localStorage, so the app remembers
everything between sessions. The ⚙️ button reopens the questions and list
management (counts + clear buttons per list).

## Running it

Service workers require http(s), so serve the folder instead of opening
`index.html` directly. Any static server works:

```
npx serve .
# or
python -m http.server 8080
```

Then open http://localhost:3000 (or :8080). On a phone or in Chrome/Edge you'll
get an "Install app" option — it works offline for the shell and cached posters;
fresh picks need a connection.

## Files

- `index.html` / `styles.css` / `app.js` — the whole app, no build step
- `sw.js` — service worker (caches app shell + posters)
- `manifest.webmanifest`, `icons/` — PWA install metadata

This product uses the TMDB API but is not endorsed or certified by TMDB.
