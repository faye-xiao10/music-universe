# Spotify Music Trends

An interactive D3 force graph of your Spotify listening universe — your entire
**Liked Songs** library mapped as tracks → artists → genres, clustered and
colored by genre. Static, no server backend, no persistent login.

## Setup

1. `.env` already holds your Spotify Client ID/Secret and redirect URI —
   don't commit it (it's gitignored).
2. Fetch your data (opens a browser tab once to authorize, then closes):
   ```
   node fetch-data.js
   ```
   This pulls your whole Liked Songs library, resolves multiple accurate
   sub-genres per artist via MusicBrainz (with iTunes as a fallback), and writes
   `data.json`. The first run is slow (~10 min — MusicBrainz allows ~1 lookup/
   second) but results are cached in `genre-cache.json`, so re-runs are fast.
3. Serve the folder (plain `file://` won't work because of `fetch()`):
   ```
   npx serve .
   ```
   or `python3 -m http.server 5000`, then open the printed URL.

## Using the graph

- **Drag** nodes to rearrange, **scroll/pinch** to zoom, drag the background to pan.
- **Hover** any node for details:
  - *Track* → title, artists, top-track affinity (and play count + listening
    time if a streaming-history export is present — see below).
  - *Artist* → how many of your liked tracks they appear on, their genre.
  - *Genre* → track count, artist count, share of your library, top track, and
    which other genres it **bridges into** (via cross-genre collaborations).
- **Gold rings** mark cross-genre collaborations — the intersections between
  your music worlds.
- **Click** a genre node (or its legend row) to isolate that cluster; click
  again or click empty space to reset.
- **Search** to highlight matching tracks, artists, or genres.
- **Forces panel** (bottom-left) tunes the layout live — repulsion, link
  length/strength, spacing, and gravity — with Reheat / Reset. Try raising
  **Spacing** to de-densify the graph.

## What the live Spotify API can and can't give you

- **Can:** your full Liked Songs library, long-term top tracks/artists (used for
  affinity ranking + album art on your favorites), album/track artwork.
- **Can't:** per-track play counts or total listening time, and artist
  genres/popularity — Spotify removed those from the API for Development-Mode
  apps. Genres are therefore resolved per-artist through **MusicBrainz** (free,
  no key, multiple sub-genres each), falling back to the iTunes Search API; play
  counts are shown as pending unless you add the export below.

## Optional: real play counts + listening time

Play counts and listening minutes only exist in your personal streaming-history
export. If you want them:

1. Go to https://www.spotify.com/account/privacy/ → **Download your data**.
2. Check **Account data** (covers the past 12 months; arrives in ~5 days) and/or
   **Extended streaming history** (full lifetime; up to 30 days).
3. When the ZIP arrives, unzip the `StreamingHistory*.json` / `endsong*.json`
   files into a `streaming_history/` folder in this project.
4. Re-run `node fetch-data.js`. The graph automatically upgrades: track and
   genre tooltips gain real play counts + listening time for the last year.
