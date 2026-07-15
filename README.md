# 🎧 Music Universe

**An interactive map of your Spotify taste — every liked song, artist, and genre rendered as a living force-directed constellation.**

Your entire *Liked Songs* library becomes a network: tracks orbit their artists, artists cluster into genres, and cross-genre collaborations light up as bridges between worlds. Built as a single static page — no backend, no database, no login.

<!-- Replace with a real capture: full-graph overview at default zoom -->
<p align="center">
  <img src="docs/screenshots/hero.png" alt="Full force-directed graph of the music library" width="820">
</p>

<p align="center">
  <em>994 tracks · 541 artists · 150 sub-genres · ~2,800 connections</em>
</p>

---

## What it does

Music Universe turns a year of listening into something you can *explore*:

- **See the shape of your taste.** Genres form gravity wells; the biggest are the ones you actually listen to. Sub-genres you might not know you had (symphonic metal, classical crossover, tropical house) surface as their own clusters.
- **Find the intersections.** Artists tagged with multiple genres physically bridge those clusters — the connective tissue between, say, *metal*, *celtic*, and *instrumental*. Cross-genre collaborations get a gold ring.
- **Drill in.** Hover any node for stats, click a genre to isolate its neighborhood, search to spotlight matches, and tune the physics live until the layout feels right.

## Screenshots

<!-- Capture these four and drop them in docs/screenshots/ -->
| Genre isolated | Node tooltip |
|---|---|
| ![Clicking a genre isolates its cluster](docs/screenshots/genre-isolate.png) | ![Hovering a node reveals stats and bridges](docs/screenshots/tooltip.png) |
| **Force controls** | **Spread-out layout** |
| ![Live force-tuning panel](docs/screenshots/forces.png) | ![Increasing spacing de-densifies the graph](docs/screenshots/spacing.png) |

## Features

| | |
|---|---|
| 🌌 **Force-directed layout** | D3 physics simulation over ~1,500 nodes; drag, zoom, and pan |
| 🎨 **Genre-colored clusters** | Golden-angle hue rotation so all 150 sub-genres stay visually distinct |
| 🔗 **Intersection bridges** | Multi-genre artists connect clusters; collabs are gold-ringed |
| 🏷️ **Rich, accurate genres** | Multiple sub-genres per artist from MusicBrainz (not one coarse label) |
| 💬 **Contextual tooltips** | Per-track / artist / genre stats, share of library, and "bridges into" |
| 🔍 **Isolate & search** | Click a genre to focus its 2-hop neighborhood; live text search |
| 🎛️ **Live force tuning** | Sliders for repulsion, link length/strength, spacing, and gravity |
| 🖼️ **Album art** | Your top tracks render their cover art, clipped into their node |
| ⚡ **Zero-infra** | One static HTML file + a JSON blob — deploys anywhere |

## How it's built

The project is deliberately split into a **one-time data step** (run locally) and a **static visual** (what ships).

```
fetch-data.js  ──►  data.json  ──►  index.html
 (Node, local)      (baked in)      (D3, static)
```

### The data pipeline (`fetch-data.js`)

1. **Auth** — a one-time Spotify OAuth 2.0 *Authorization Code* flow over a local `127.0.0.1` loopback server (scopes: `user-top-read`, `user-library-read`).
2. **Library** — pages through your entire *Liked Songs* library (`/me/tracks`), plus long-term top tracks/artists to rank listening *affinity*.
3. **Genre enrichment** — resolves **multiple accurate sub-genres per artist** from MusicBrainz, with iTunes as a fallback, cached to `genre-cache.json`.
4. **Graph assembly** — builds the tracks → artists → genres node/link graph, prunes singleton genres, and computes genre-level aggregate stats.
5. **Output** — writes a single `data.json` the page reads at load.

### The interesting constraint

Spotify's Web API **no longer exposes artist genres, popularity, or any play counts** to development-mode apps (the `/artists` endpoint returns `403`, and top-artist objects come back stripped). So the naive "just read Spotify's genres" approach doesn't work at all.

Music Universe works around this with a small enrichment pipeline:

| Problem | Solution |
|---|---|
| No genres on Spotify artist objects | **MusicBrainz** folksonomy tags, filtered to genre-like stems, multiple per artist |
| MusicBrainz misses an obscure artist | **iTunes Search API** fallback (single coarse genre) |
| No popularity field for sizing | **Rank position** in your long-term top items as an affinity score |
| No play counts / listening time | **Optional**: ingest Spotify's streaming-history export (see below) |
| Coarse tags fragment the graph | Prune single-artist genres; keep each artist's top tag so nothing goes untagged |

The payoff: an artist like *Nightwish* resolves to **Symphonic Metal · Power Metal · Metal** instead of a flat "Hard Rock," and those shared sub-genre nodes are exactly what stitch the clusters together.

### The visual (`index.html`)

A single self-contained page — no framework, no build step. D3 v7 (via CDN) drives a `forceSimulation` with tuned link / charge / collision / centering forces, SVG rendering, `d3.zoom` / `d3.drag` interactions, `clipPath`-masked album art, and a small vanilla-JS control panel that mutates the force parameters and reheats the simulation in real time.

## Tech stack

| Layer | Technology | Role |
|---|---|---|
| Visualization | **D3.js v7** | Force simulation, scales, zoom/drag, SVG rendering |
| Frontend | **Vanilla HTML / CSS / JS** | No framework, no bundler, no build step |
| Data fetch | **Node.js (ESM)** | One-time local script (`fetch-data.js`) |
| Music data | **Spotify Web API** | Liked Songs + long-term top items (OAuth 2.0) |
| Genre enrichment | **MusicBrainz API** | Multiple sub-genres per artist (primary source) |
| Genre fallback | **iTunes Search API** | Single-genre fallback for gaps |
| Play counts *(optional)* | **Spotify data export** | Real plays + listening time from streaming history |
| Hosting | **Vercel** | Static deploy — no server, no env vars, no DB |

## Getting started

> Requires Node 18+ and your own Spotify app credentials.

1. Create a Spotify app at the [developer dashboard](https://developer.spotify.com/dashboard) and add the redirect URI `http://127.0.0.1:8888/callback` (Spotify requires the literal IP, not `localhost`).
2. Copy `.env.example` to `.env` and fill in your Client ID/Secret (shape shown below).
3. Generate your data (opens a browser once to authorize, then closes):
   ```bash
   node fetch-data.js
   ```
   The first run is slow (~10 min — MusicBrainz allows ~1 lookup/second) but caches to `genre-cache.json`, so re-runs are fast.
4. Serve the folder locally (a plain `file://` open won't work — the page `fetch()`es `data.json`):
   ```bash
   npx serve .        # or: python3 -m http.server 5000
   ```

**`.env` shape** (never committed — it's gitignored):
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

## Using the graph

- **Drag** to rearrange · **scroll/pinch** to zoom · drag the background to **pan**
- **Hover** a node for details (tracks show artists + affinity; genres show track/artist counts, library share, top track, and which genres they bridge into)
- **Gold rings** mark cross-genre collaborations
- **Click** a genre (or its legend row) to isolate its cluster; click empty space to reset
- **Search** to highlight matching tracks, artists, or genres
- **Forces panel** (bottom-left) tunes the layout live — raise **Spacing** to de-densify

## Optional: real play counts + listening time

Play counts and listening minutes don't exist in the live API — only in your personal streaming-history export:

1. Go to [spotify.com/account/privacy](https://www.spotify.com/account/privacy/) → **Download your data** → check **Account data** (past 12 months, ~5 days) and/or **Extended streaming history** (lifetime, up to 30 days).
2. Unzip the `StreamingHistory*.json` / `endsong*.json` files into a `streaming_history/` folder.
3. Re-run `node fetch-data.js` — track and genre tooltips gain real plays + listening time for the last year.

## Deploy

It's a static site, so deployment is trivial and requires **no environment variables and no database**:

1. Push to GitHub.
2. Import the repo at [vercel.com/new](https://vercel.com/new) → **Framework Preset: Other**, empty build command, no env vars.
3. Deploy.

To refresh later: re-run `node fetch-data.js`, commit the new `data.json`, and push — Vercel auto-redeploys.

> ⚠️ **Privacy note:** `data.json` ships with the site and contains your listening data (track/artist/genre names + Spotify links). A deployed instance is public to anyone with the URL — that's the tradeoff of a no-auth static visual.

## Notes & limitations

- Genres come from community tags, so they're occasionally quirky — accurate in aggregate, not gospel per artist.
- The full graph is dense by design; it reads best zoomed in, isolated to a genre, or spread out via the Forces panel.
- Everything is computed once at fetch time; the page itself is fully static.
