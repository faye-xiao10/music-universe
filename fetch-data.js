// One-time personal data pull. Authorize once in the browser, then:
//   1. pull your entire Liked Songs library (paginated),
//   2. pull long-term top tracks/artists to rank listening affinity,
//   3. resolve a genre per unique artist via the free iTunes Search API
//      (Spotify strips genres/popularity from artist objects and 403s on
//       GET /artists for Development-Mode apps — their 2024+ restriction),
//   4. if a streaming-history export is present (see README), merge in real
//      per-track play counts + listening time for the last 12 months,
//   5. write data.json for the static visual in index.html.
//
// Re-run any time to refresh. The export step is optional — without it the
// graph still builds, and dropping the export files in later upgrades it.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(envPath) {
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const envPath = path.join(HERE, ".env");
if (!existsSync(envPath)) {
  console.error("Missing .env — expected SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI");
  process.exit(1);
}

const env = loadEnv(envPath);
const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI } = env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REDIRECT_URI) {
  console.error("`.env` is missing one of SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI");
  process.exit(1);
}

const redirect = new URL(SPOTIFY_REDIRECT_URI);
const PORT = Number(redirect.port || 8888);
// user-library-read is needed for the full Liked Songs library.
const SCOPE = "user-top-read user-library-read";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugifyGenre(genre) {
  return genre.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function trackKey(trackName, artistName) {
  return `${(trackName || "").toLowerCase().trim()}::${(artistName || "").toLowerCase().trim()}`;
}

// ---------------------------------------------------------------------------
// OAuth (Authorization Code flow, one-time, loopback redirect)
// ---------------------------------------------------------------------------

function getAuthorizationCode() {
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("client_id", SPOTIFY_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", SPOTIFY_REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("state", state);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(`<h1>Authorization failed</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`Spotify authorization error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end("<h1>State mismatch</h1>");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" }).end(
        "<h1>Authorized</h1><p>You can close this tab and return to the terminal.</p>"
      );
      server.close();
      resolve(code);
    });

    server.listen(PORT, "127.0.0.1", () => {
      console.log("Opening Spotify authorization in your browser...");
      console.log(`If it doesn't open automatically, visit:\n${authUrl.toString()}\n`);
      exec(`open "${authUrl.toString()}"`);
    });

    server.on("error", reject);
  });
}

async function exchangeCodeForToken(code) {
  const basicAuth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }

  return (await res.json()).access_token;
}

// ---------------------------------------------------------------------------
// Spotify Web API
// ---------------------------------------------------------------------------

async function spotifyGet(pathAndQuery, token) {
  const res = await fetch(`https://api.spotify.com/v1${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || 2);
    await sleep((retryAfter + 1) * 1000);
    return spotifyGet(pathAndQuery, token);
  }
  if (!res.ok) {
    throw new Error(`GET ${pathAndQuery} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchAllLikedTracks(token) {
  const items = [];
  let url = "/me/tracks?limit=50";
  while (url) {
    const page = await spotifyGet(url, token);
    items.push(...page.items.map((entry) => entry.track).filter(Boolean));
    if (page.next) {
      const parsed = new URL(page.next);
      url = parsed.pathname.replace("/v1", "") + parsed.search;
      process.stdout.write(`\r  fetched ${items.length} liked tracks...`);
    } else {
      url = null;
    }
  }
  process.stdout.write(`\r  fetched ${items.length} liked tracks.      \n`);
  return items;
}

// ---------------------------------------------------------------------------
// Genre resolution via iTunes Search API (per unique artist, cached)
// ---------------------------------------------------------------------------

// Keep only genuinely genre-like tags (MusicBrainz folksonomy tags are noisy:
// countries, decades, "female vocals", "seen live", etc.). A tag is kept if it
// contains one of these stems.
const GENRE_STEMS = [
  "metal", "rock", "pop", "punk", "indie", "folk", "celtic", "instrumental",
  "soundtrack", "score", "cinematic", "epic", "orchestral", "orchestra",
  "symphonic", "classical", "opera", "operatic", "choral", "ambient", "chill",
  "electronic", "electro", "synth", "wave", "house", "techno", "trance",
  "dubstep", "edm", "jazz", "blues", "soul", "funk", "disco", "r&b", "rnb",
  "hip hop", "hip-hop", "rap", "trap", "grime", "country", "americana",
  "bluegrass", "reggae", "ska", "gospel", "latin", "reggaeton", "k-pop",
  "kpop", "j-pop", "jpop", "mandopop", "cantopop", "c-pop", "worldbeat",
  "world music", "new age", "gothic", "industrial", "hardcore", "emo",
  "grunge", "shoegaze", "prog", "power", "death", "black metal", "thrash",
  "doom", "sludge", "groove", "alternative", "acoustic", "singer-songwriter",
  "singer/songwriter", "dance", "drum and bass", "dnb", "garage", "dream pop",
  "lo-fi", "lofi", "post-rock", "post-punk", "swing", "big band", "motown",
  "musical", "anime", "video game", "game", "epic music",
];

function isGenreTag(tag) {
  const t = tag.toLowerCase();
  return GENRE_STEMS.some((stem) => t.includes(stem));
}

function normalizeGenre(tag) {
  return tag
    .toLowerCase()
    .replace(/[\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w === "r&b" ? "R&B" : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// MusicBrainz asks for a descriptive User-Agent and max ~1 request/second.
const MB_HEADERS = { "User-Agent": "SpotifyMusicTrends/1.0 (personal listening visualization)" };

async function fetchMusicBrainzGenres(artistName) {
  const query = encodeURIComponent(`artist:"${artistName}"`);
  const url = `https://musicbrainz.org/ws/2/artist?query=${query}&fmt=json&limit=1`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: MB_HEADERS });
      if (res.status === 503) { await sleep(2000); continue; }
      if (!res.ok) return [];
      const json = await res.json();
      const artist = json.artists?.[0];
      if (!artist || (artist.score ?? 0) < 80) return [];
      const tags = (artist.tags || [])
        .filter((t) => t.count > 0 && isGenreTag(t.name))
        .sort((a, b) => b.count - a.count)
        .map((t) => normalizeGenre(t.name));
      // Dedupe, keep top 5 distinct.
      return [...new Set(tags)].slice(0, 5);
    } catch {
      await sleep(1000);
    }
  }
  return [];
}

// iTunes fallback (single coarse genre) for artists MusicBrainz can't place.
async function fetchITunesGenre(artistName) {
  const term = encodeURIComponent(artistName);
  for (const entity of ["musicArtist", "song"]) {
    try {
      const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=${entity}&limit=1`);
      if (res.status === 429) { await sleep(2000); continue; }
      if (!res.ok) continue;
      const { results } = await res.json();
      const genre = results?.[0]?.primaryGenreName;
      if (genre) return normalizeGenre(genre);
    } catch { /* try next */ }
  }
  return null;
}

// Resolve up to a handful of accurate genres per artist. MusicBrainz first
// (multi-genre, sub-genre accurate), iTunes as a single-genre fallback.
// Results are cached to genre-cache.json so re-runs are instant.
async function resolveGenres(artistNames) {
  const cachePath = path.join(HERE, "genre-cache.json");
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  let resolved = 0, fromCache = 0, since = 0;

  for (const name of artistNames) {
    if (cache[name]) { fromCache++; resolved++; continue; }

    let genres = await fetchMusicBrainzGenres(name);
    await sleep(1100); // MusicBrainz rate limit
    if (genres.length === 0) {
      const itunes = await fetchITunesGenre(name);
      if (itunes) genres = [itunes];
    }
    cache[name] = genres;
    resolved++;
    // Persist periodically so a long run's progress survives interruption.
    if (++since >= 20) { writeFileSync(cachePath, JSON.stringify(cache)); since = 0; }
    if (resolved % 25 === 0 || resolved === artistNames.length) {
      process.stdout.write(`\r  ${resolved}/${artistNames.length} artists (${fromCache} cached)`);
    }
  }
  writeFileSync(cachePath, JSON.stringify(cache));
  process.stdout.write("\n");
  return cache;
}

// ---------------------------------------------------------------------------
// Streaming-history export ingestion (optional)
// ---------------------------------------------------------------------------

// Looks for Spotify's exported streaming history. Supports both the lighter
// "Account data" format (StreamingHistory*.json: endTime/artistName/trackName/
// msPlayed) and the "Extended streaming history" format (endsong*.json / *.json
// with ts/master_metadata_*/ms_played). Aggregates plays + listening time per
// track over the last 12 months. Returns a Map keyed by trackKey, or null if
// no export is present.
function loadStreamingHistory() {
  const candidateDirs = [path.join(HERE, "streaming_history"), HERE];
  const files = [];
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      if (/streaminghistory|streaming_history|endsong/i.test(name)) {
        files.push(path.join(dir, name));
      }
    }
  }
  if (files.length === 0) return null;

  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const stats = new Map(); // trackKey -> { plays, msPlayed, name, artist }

  for (const file of files) {
    let rows;
    try {
      rows = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      console.warn(`  skipping unreadable export file: ${path.basename(file)}`);
      continue;
    }
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      const name = row.trackName ?? row.master_metadata_track_name;
      const artist = row.artistName ?? row.master_metadata_album_artist_name;
      const ms = row.msPlayed ?? row.ms_played ?? 0;
      const when = row.endTime ?? row.ts;
      if (!name || !artist || !when) continue;

      const ts = new Date(when).getTime();
      if (Number.isNaN(ts) || ts < cutoff) continue;
      // Ignore near-instant skips so "plays" means something.
      if (ms < 30000) continue;

      const key = trackKey(name, artist);
      const entry = stats.get(key) ?? { plays: 0, msPlayed: 0, name, artist };
      entry.plays += 1;
      entry.msPlayed += ms;
      stats.set(key, entry);
    }
  }

  console.log(`  streaming history: ${files.length} file(s), ${stats.size} tracks played in the last year`);
  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let token;
  try {
    const code = await getAuthorizationCode();
    token = await exchangeCodeForToken(code);
  } catch (err) {
    console.error("Authorization failed:", err.message);
    process.exit(1);
  }

  let me, likedTracks, topTracks, topArtists;
  try {
    me = await spotifyGet("/me", token);
    console.log("Fetching your Liked Songs library...");
    likedTracks = await fetchAllLikedTracks(token);
    const [topTracksRes, topArtistsRes] = await Promise.all([
      spotifyGet("/me/top/tracks?time_range=long_term&limit=50", token),
      spotifyGet("/me/top/artists?time_range=long_term&limit=50", token),
    ]);
    topTracks = topTracksRes.items;
    topArtists = topArtistsRes.items;
  } catch (err) {
    console.error("Fetching library failed:", err.message);
    process.exit(1);
  }

  if (likedTracks.length === 0) {
    console.error("No liked songs found — like some tracks on Spotify, or switch the source to top tracks.");
    process.exit(1);
  }

  // Affinity: rank within long-term top items (0-100), used for node sizing
  // when real play counts aren't available yet.
  const topTrackRank = new Map(topTracks.map((t, i) => [t.id, Math.round((100 * (topTracks.length - i)) / topTracks.length)]));
  const topArtistRank = new Map(topArtists.map((a, i) => [a.id, Math.round((100 * (topArtists.length - i)) / topArtists.length)]));

  // Collect unique artists across the whole library.
  const uniqueArtists = new Map(); // id -> { id, name, image, spotifyUrl }
  for (const track of likedTracks) {
    for (const artist of track.artists) {
      if (!uniqueArtists.has(artist.id)) {
        uniqueArtists.set(artist.id, {
          id: artist.id,
          name: artist.name,
          spotifyUrl: artist.external_urls?.spotify ?? null,
          image: null, // /me/tracks doesn't include artist images
        });
      }
    }
  }

  console.log(`Resolving genres for ${uniqueArtists.size} unique artists (MusicBrainz + iTunes)...`);
  console.log("  (first run is slow — ~1s/artist — then cached in genre-cache.json)");
  const artistList = [...uniqueArtists.values()];
  const genreCache = await resolveGenres(artistList.map((a) => a.name));
  artistList.forEach((a) => { a.genres = genreCache[a.name] ?? []; });

  // Prune singleton genres (only one artist across the whole library) so the
  // graph clusters on shared sub-genres instead of fragmenting into micro-tags,
  // but always keep each artist's top genre so nobody ends up untagged/grey.
  const genreFreq = new Map();
  for (const a of artistList) for (const g of a.genres) genreFreq.set(g, (genreFreq.get(g) ?? 0) + 1);
  for (const a of artistList) {
    const kept = a.genres.filter((g) => (genreFreq.get(g) ?? 0) >= 2);
    a.genres = kept.length ? kept : a.genres.slice(0, 1);
  }

  const history = loadStreamingHistory();

  // -------------------------------------------------------------------------
  // Build nodes + links
  // -------------------------------------------------------------------------

  const nodes = new Map();
  const links = [];

  function addGenreNode(genre) {
    const id = `genre:${slugifyGenre(genre)}`;
    if (!nodes.has(id)) nodes.set(id, { id, tier: "genre", name: genre });
    return id;
  }

  for (const artist of artistList) {
    const id = `artist:${artist.id}`;
    nodes.set(id, {
      id,
      tier: "artist",
      name: artist.name,
      affinity: topArtistRank.get(artist.id) ?? 0,
      image: artist.image,
      spotifyUrl: artist.spotifyUrl,
      genres: artist.genres,
      genre: artist.genres[0] ?? null, // primary genre (for coloring)
    });
    // One link per genre — multi-genre artists become the connective tissue
    // between sub-genre clusters (e.g. a symphonic-metal + celtic artist).
    for (const g of artist.genres) {
      links.push({ source: id, target: addGenreNode(g), kind: "artist-genre" });
    }
  }

  for (const track of likedTracks) {
    const trackId = `track:${track.id}`;
    const primaryArtist = track.artists[0];
    const hist = history?.get(trackKey(track.name, primaryArtist?.name));

    nodes.set(trackId, {
      id: trackId,
      tier: "track",
      name: track.name,
      artistNames: track.artists.map((a) => a.name),
      affinity: topTrackRank.get(track.id) ?? 0,
      plays: hist?.plays ?? null,
      minutesListened: hist ? Math.round(hist.msPlayed / 60000) : null,
      image: track.album?.images?.[0]?.url ?? null,
      spotifyUrl: track.external_urls?.spotify ?? null,
    });

    // Link to every credited artist — multi-artist collabs become the bridges
    // that connect otherwise-separate genre clusters (the "intersections").
    for (const artist of track.artists) {
      if (uniqueArtists.has(artist.id)) {
        links.push({ source: trackId, target: `artist:${artist.id}`, kind: "track-artist" });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Genre-level aggregate stats (for the genre hover panel)
  // -------------------------------------------------------------------------

  const genreStats = new Map();
  for (const node of nodes.values()) {
    if (node.tier !== "genre") continue;
    genreStats.set(node.id, { artists: 0, tracks: 0, plays: 0, minutes: 0, topTrack: null, topPlays: -1 });
  }

  // Count each artist toward every genre it belongs to.
  const artistPrimaryGenreId = new Map(); // artist node id -> primary genre id
  for (const artist of artistList) {
    if (artist.genres[0]) artistPrimaryGenreId.set(`artist:${artist.id}`, `genre:${slugifyGenre(artist.genres[0])}`);
    for (const g of artist.genres) {
      const gid = `genre:${slugifyGenre(g)}`;
      if (genreStats.has(gid)) genreStats.get(gid).artists += 1;
    }
  }
  // Attribute each track to its primary artist's primary genre.
  const trackPrimaryArtistId = new Map();
  for (const track of likedTracks) {
    const primary = track.artists[0];
    if (primary) trackPrimaryArtistId.set(`track:${track.id}`, `artist:${primary.id}`);
  }
  for (const node of nodes.values()) {
    if (node.tier !== "track") continue;
    const artistId = trackPrimaryArtistId.get(node.id);
    const genreId = artistId ? artistPrimaryGenreId.get(artistId) : null;
    if (!genreId || !genreStats.has(genreId)) continue;
    const g = genreStats.get(genreId);
    g.tracks += 1;
    g.plays += node.plays ?? 0;
    g.minutes += node.minutesListened ?? 0;
    const rankForTop = node.plays ?? node.affinity ?? 0;
    if (rankForTop > g.topPlays) { g.topPlays = rankForTop; g.topTrack = node.name; }
  }
  for (const node of nodes.values()) {
    if (node.tier === "genre") node.stats = genreStats.get(node.id);
  }

  const hasHistory = Boolean(history);
  const data = {
    generatedAt: new Date().toISOString(),
    user: me.display_name ?? me.id,
    hasPlayCounts: hasHistory,
    nodes: [...nodes.values()],
    links,
  };
  writeFileSync(path.join(HERE, "data.json"), JSON.stringify(data));

  const counts = { track: 0, artist: 0, genre: 0 };
  for (const node of data.nodes) counts[node.tier]++;
  console.log(`\nDone! Wrote data.json for ${data.user}`);
  console.log(`${counts.track} tracks, ${counts.artist} artists, ${counts.genre} genres, ${links.length} links`);
  console.log(hasHistory
    ? "Real play counts + listening time are included."
    : "No streaming-history export found — play counts show as pending. See README to add them.");
}

main();
