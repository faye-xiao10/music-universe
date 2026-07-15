# One-shot build prompt: Spotify Music Trends Force Graph

Paste this into a fresh Claude Code session once you have a Spotify Developer
app (Client ID + Secret). Fill in the `<TODO>` values first. This reflects the
real, working approach — including the Spotify API limitations you WILL hit.

---

## Goal

Build a **standalone, static, interactive D3 force-directed graph** of my
Spotify listening universe: my entire **Liked Songs** library as a
tracks → artists → genres network, clustered and colored by genre, on a dark
"constellation" canvas. No backend, no persistent login — a one-time local data
fetch plus a self-contained `index.html`.

## Credentials (fill in before sending)

```
SPOTIFY_CLIENT_ID=<TODO>
SPOTIFY_CLIENT_SECRET=<TODO>
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback   (register this EXACT value in the dashboard — Spotify requires 127.0.0.1, not "localhost")
```

## Hard API limitations to design around (don't fight these)

- **No play counts / listening time** exist anywhere in the Spotify Web API.
  They only live in the user's streaming-history export (privacy page, arrives
  days later). Build so those fields are optional: read a `streaming_history/`
  folder of `StreamingHistory*.json` / `endsong*.json` if present and aggregate
  plays + `msPlayed` per track over the last 365 days; otherwise show "pending".
- **Artist objects are stripped** of `genres` and `popularity` for
  Development-Mode apps, and `GET /artists` returns **403**. iTunes gives only
  one coarse, often-wrong genre per artist (Nightwish → "Hard Rock"). Instead
  resolve **multiple accurate sub-genres per artist via MusicBrainz** (free, no
  key): `GET https://musicbrainz.org/ws/2/artist?query=artist:"<name>"&fmt=json&limit=1`
  with a descriptive `User-Agent`, take the match's `tags` (filter to genre-like
  stems, drop countries/decades/"female vocals", keep top ~5 by count,
  Title-Case them). Throttle to ~1 req/sec and cache to `genre-cache.json`.
  Fall back to iTunes `primaryGenreName` only when MusicBrainz has nothing.
  Prune genres held by a single artist (keep each artist's top genre) so the
  graph clusters on shared sub-genres instead of fragmenting.

## Step 1 — `fetch-data.js` (one-time, run locally, never shipped)

1. Authorization Code flow on a local `127.0.0.1:8888` server, scopes
   `user-top-read user-library-read`. Open the authorize URL, capture the code,
   exchange for an access token.
2. Fetch:
   - **All Liked Songs**: page `GET /me/tracks?limit=50` following `next` until done.
   - `GET /me/top/tracks?time_range=long_term&limit=50` and
     `GET /me/top/artists?time_range=long_term&limit=50` — use rank position as
     an `affinity` score (0–100) for node sizing / album-art selection, since
     there's no popularity field.
3. Resolve multiple sub-genres per unique artist via MusicBrainz (cached; see
   the API-limitations note above), iTunes fallback. Each artist gets a `genres`
   array; link the artist to every one of its genres.
4. Optionally ingest `streaming_history/*.json` for real play counts + minutes.
5. Write `data.json`:
   ```json
   {
     "hasPlayCounts": false,
     "nodes": [
       {"id":"track:<id>","tier":"track","name":"...","artistNames":[...],"affinity":0,"plays":null,"minutesListened":null,"image":"album art","spotifyUrl":"..."},
       {"id":"artist:<id>","tier":"artist","name":"...","affinity":0,"image":null,"spotifyUrl":"...","genres":["Symphonic Metal","Power Metal","Metal"],"genre":"Symphonic Metal"},
       {"id":"genre:<slug>","tier":"genre","name":"Metal","stats":{"artists":0,"tracks":0,"plays":0,"minutes":0,"topTrack":"..."}}
     ],
     "links": [
       {"source":"track:<id>","target":"artist:<id>","kind":"track-artist"},
       {"source":"artist:<id>","target":"genre:<slug>","kind":"artist-genre"}
     ]
   }
   ```
   Link every track to ALL its credited artists, and every artist to ALL its
   genres — multi-genre artists and multi-artist collabs are what bridge the
   clusters (the intersections).

## Step 2 — `index.html` (the deliverable; D3 v7 via CDN, no build step)

Force graph (`forceLink` + `forceManyBody` + `forceCollide` + weak `forceX/Y`,
tuned for ~1500 nodes) that `fetch()`es `data.json`:

- **Sizing:** genres largest (by track count), artists by how many liked tracks
  they appear on, tracks tiny dots — except your top tracks (affinity > 0),
  which are larger and show **album art** clipped into a circle. Only render art
  for top tracks to stay performant with ~1000 tracks.
- **Color:** golden-angle hue rotation (`hue = i * 137.5°`) per genre so even
  similar-sized genres are visually distinct; artists/tracks inherit their
  genre's color. Draw order: tracks, then artists, then genres + labels on top.
- **Intersections:** compute genre↔genre co-occurrence from artists tagged with
  multiple genres (the main bridging signal) and list each genre's top "bridges
  into" partners in its tooltip; gold-ring tracks whose credited artists' primary
  genres differ (cross-genre collabs).
- **Tooltips:** track → title, artists, affinity, play count + listening time
  when present else "pending"; artist → # liked tracks + its genres; genre →
  tracks/artists counts, % share of library, top track, bridge partners.
- **Interactions:** drag (alpha-reheat), zoom/pan, hover shows a tooltip only
  (do NOT dim the rest of the graph), click a genre (or legend row) to isolate
  its 2-hop cluster, a search box, and a dynamic legend with per-genre track counts.
- Dark radial-gradient background; label only genres with ≥8 tracks to cut clutter.

## Done when

- `node fetch-data.js` writes a `data.json` covering the whole Liked Songs library.
- Served over http (not `file://`), `index.html` shows a smooth, colorful,
  draggable/zoomable genre-clustered graph with working tooltips (incl. genre
  aggregate stats), gold-ringed cross-genre collabs, click-to-isolate, and search.
