
import http from "http";
import fs from "fs";
import path from "path";
import { URL } from "url";
import SpotifyWebApi from "spotify-web-api-node";
import {
  extractSpotifyPlaylistId,
  loadConfigFromFile,
  saveConfigToFile,
  syncSpotifyToYoutube,
} from "./s2y.js";

const PORT = Number(process.env.PORT || 3030);
const ROOT = process.cwd();
const UI_DIR = path.join(ROOT, "ui");
const PLAYLISTS_DIR = path.join(ROOT, "playlists");
const CONFIG_FILE = path.join(ROOT, "config.json");

const REDIRECT_ERROR_THRESHOLD = 5;
const REDIRECT_COOLDOWN_MS = 5 * 60 * 1000;

const state = {
  running: false,
  paused: false,
  pauseReason: null,
  waitingForCookie: false,
  waitingForRetryDecision: false,
  cooldownUntil: null,
  startedAt: null,
  finishedAt: null,
  progress: { processed: 0, total: 0, percent: 0, failed: 0, currentTrack: null },
  playlistName: null,
  currentSync: null,
  logs: [],
  lastSummary: null,
  lastError: null,
};

const clients = new Set();
let cookieResolver = null;
let retryDecisionResolver = null;
let autoResumeTimer = null;
let redirectErrorStreak = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePlaylistName(name) {
  return String(name || "").replace(/[<>:"/\\|?*]/g, "");
}

function countLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;

  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function readSongsList(filePath) {
  if (!fs.existsSync(filePath)) return [];

  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function preview(filePath, limit = 5) {
  return readSongsList(filePath).slice(0, limit);
}

function extractSpotifyIdFromFileName(fileName) {
  const match = String(fileName).match(/(?:added_songs_|failed_songs_)(.+)\.txt$/);
  return match ? match[1] : null;
}

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function loadRawConfig() {
  return readJsonFileSafe(CONFIG_FILE) || {};
}

function loadSpotifyDiscoveryConfig() {
  const raw = loadRawConfig();
  const spotify = raw?.spotify || {};

  const clientId = String(spotify.clientId || "").trim();
  const clientSecret = String(spotify.clientSecret || "").trim();
  const redirectUri = String(spotify.redirectUri || "http://localhost").trim();
  const playlistURL = extractSpotifyPlaylistId(spotify.playlistURL || "");

  if (!clientId || !clientSecret) {
    const error = new Error("Spotify clientId/clientSecret are required to fetch playlists.");
    error.code = "SPOTIFY_DISCOVERY_CONFIG";
    throw error;
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    playlistURL,
  };
}

function toSpotifyOption(playlist, ownerName = "") {
  const id = String(playlist?.id || "").trim();
  if (!id) return null;

  const name = String(playlist?.name || "Untitled Playlist");
  const tracksTotal = Number.isFinite(playlist?.tracks?.total)
    ? playlist.tracks.total
    : null;
  const visibility = playlist?.public === false ? "Private" : "Public";

  const suffix = [
    tracksTotal !== null ? String(tracksTotal) + " tracks" : null,
    visibility,
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    id,
    name,
    tracksTotal,
    visibility,
    ownerName,
    source: "spotify-api",
    label: name + " (" + id + ")" + (suffix ? " - " + suffix : ""),
  };
}

async function fetchSpotifyPlaylistsForSelection(seedPlaylistId = "") {
  const spotifyConfig = loadSpotifyDiscoveryConfig();

  const spotifyApi = new SpotifyWebApi({
    clientId: spotifyConfig.clientId,
    clientSecret: spotifyConfig.clientSecret,
    redirectUri: spotifyConfig.redirectUri,
  });

  const authData = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(authData.body.access_token);

  const resolvedSeedId = extractSpotifyPlaylistId(seedPlaylistId || spotifyConfig.playlistURL);

  if (!resolvedSeedId) {
    const error = new Error(
      "No Spotify seed playlist is configured. Set spotify.playlistURL or pass seedPlaylistId."
    );
    error.code = "SPOTIFY_DISCOVERY_CONFIG";
    throw error;
  }

  const seedPlaylistResponse = await spotifyApi.getPlaylist(resolvedSeedId);
  const seedPlaylist = seedPlaylistResponse?.body || {};
  const ownerId = String(seedPlaylist?.owner?.id || "").trim();
  const ownerName = String(seedPlaylist?.owner?.display_name || ownerId || "").trim();

  if (!ownerId) {
    const error = new Error("Could not resolve Spotify playlist owner from the seed playlist.");
    error.code = "SPOTIFY_OWNER_RESOLVE_FAILED";
    throw error;
  }

  const optionsById = new Map();

  const addOption = (playlist) => {
    const option = toSpotifyOption(playlist, ownerName);
    if (!option) return;
    optionsById.set(option.id, option);
  };

  addOption(seedPlaylist);

  const limit = 50;
  let offset = 0;
  while (true) {
    const response = await spotifyApi.getUserPlaylists(ownerId, { limit, offset });
    const items = response?.body?.items || [];

    items.forEach(addOption);

    if (!response?.body?.next) break;

    offset += limit;
    if (offset >= 1000) break;
  }

  const options = Array.from(optionsById.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  return {
    seedPlaylistId: resolvedSeedId,
    owner: {
      id: ownerId,
      name: ownerName || ownerId,
    },
    options,
  };
}
function getActivePlaylistSelection() {
  try {
    const config = loadConfigFromFile(CONFIG_FILE);
    return {
      spotifyPlaylistId: config.spotify.playlistURL,
      youtubePlaylistId: config.youtube.playlistURL,
    };
  } catch {
    const raw = loadRawConfig();
    return {
      spotifyPlaylistId: raw?.spotify?.playlistURL || "",
      youtubePlaylistId: raw?.youtube?.playlistURL || "",
    };
  }
}

function statusPayload() {
  return {
    running: state.running,
    paused: state.paused,
    pauseReason: state.pauseReason,
    waitingForCookie: state.waitingForCookie,
    waitingForRetryDecision: state.waitingForRetryDecision,
    cooldownUntil: state.cooldownUntil,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    progress: state.progress,
    playlistName: state.playlistName,
    currentSync: state.currentSync,
    lastSummary: state.lastSummary,
    lastError: state.lastError,
    activeSelection: getActivePlaylistSelection(),
  };
}

function sendToClient(client, type, data) {
  client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function event(type, data) {
  for (const client of clients) {
    sendToClient(client, type, data);
  }
}

function publishStatus() {
  event("status", statusPayload());
}

function log(level, message) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    level,
    message,
  };

  state.logs.push(entry);
  if (state.logs.length > 500) {
    state.logs = state.logs.slice(-500);
  }

  event("log", entry);
}

function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) {
        reject(new Error("Payload too large."));
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function getOrCreatePlaylistFolderByName(playlistName) {
  const folder = path.join(PLAYLISTS_DIR, sanitizePlaylistName(playlistName));
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function upsertPlaylistProfile(summary) {
  if (!summary?.playlistName || !summary?.spotifyPlaylistId || !summary?.youtubePlaylistId) {
    return;
  }

  const folder = getOrCreatePlaylistFolderByName(summary.playlistName);
  const profilePath = path.join(folder, "playlist_profile.json");
  const existing = readJsonFileSafe(profilePath) || {};

  const history = Array.isArray(existing.history) ? existing.history : [];
  history.push({
    at: summary.completedAt || new Date().toISOString(),
    spotifyPlaylistId: summary.spotifyPlaylistId,
    youtubePlaylistId: summary.youtubePlaylistId,
    totalTracks: summary.totalTracks,
    processed: summary.processed,
    failed: summary.failed,
  });

  const profile = {
    playlistName: summary.playlistName,
    spotifyPlaylistId: summary.spotifyPlaylistId,
    youtubePlaylistId: summary.youtubePlaylistId,
    lastSuccessfulSyncAt: summary.completedAt || new Date().toISOString(),
    totalTracks: summary.totalTracks,
    addedSongsCount: summary.addedSongsCount,
    history: history.slice(-20),
  };

  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf-8");
}

function parsePlaylistFolder(entry) {
  const folder = path.join(PLAYLISTS_DIR, entry.name);
  const files = fs.readdirSync(folder);

  const addedName = files.find((name) => name.startsWith("added_songs_"));
  const failedName = files.find((name) => name.startsWith("failed_songs_"));

  const addedPath = addedName ? path.join(folder, addedName) : null;
  const failedPath = failedName ? path.join(folder, failedName) : null;
  const profile = readJsonFileSafe(path.join(folder, "playlist_profile.json"));

  const spotifyFromFiles = extractSpotifyIdFromFileName(addedName || failedName || "");

  return {
    folderName: entry.name,
    name: profile?.playlistName || entry.name,
    spotifyPlaylistId: profile?.spotifyPlaylistId || spotifyFromFiles || "",
    youtubePlaylistId: profile?.youtubePlaylistId || "",
    updatedAt: fs.statSync(folder).mtime.toISOString(),
    lastSuccessfulSyncAt: profile?.lastSuccessfulSyncAt || null,
    addedCount: addedPath ? countLines(addedPath) : 0,
    failedCount: failedPath ? countLines(failedPath) : 0,
    addedPreview: addedPath ? preview(addedPath, 5) : [],
    failedPreview: failedPath ? preview(failedPath, 5) : [],
  };
}

function getFailedSongsForPlaylist(playlistName, spotifyPlaylistId) {
  if (!fs.existsSync(PLAYLISTS_DIR)) return [];

  const preferredFileName = spotifyPlaylistId
    ? "failed_songs_" + spotifyPlaylistId + ".txt"
    : null;
  const folderName = sanitizePlaylistName(playlistName || "");

  const candidatePaths = [];

  if (folderName) {
    const namedFolder = path.join(PLAYLISTS_DIR, folderName);
    if (fs.existsSync(namedFolder)) {
      if (preferredFileName) {
        candidatePaths.push(path.join(namedFolder, preferredFileName));
      }

      const firstFailed = fs
        .readdirSync(namedFolder)
        .find((name) => name.startsWith("failed_songs_") && name.endsWith(".txt"));

      if (firstFailed) {
        candidatePaths.push(path.join(namedFolder, firstFailed));
      }
    }
  }

  if (preferredFileName) {
    for (const entry of fs.readdirSync(PLAYLISTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidatePaths.push(path.join(PLAYLISTS_DIR, entry.name, preferredFileName));
    }
  }

  for (const filePath of candidatePaths) {
    if (fs.existsSync(filePath)) {
      return readSongsList(filePath);
    }
  }

  return [];
}

function getLocalPlaylistEntries() {
  if (!fs.existsSync(PLAYLISTS_DIR)) return [];

  return fs
    .readdirSync(PLAYLISTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(parsePlaylistFolder)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function buildProfilesData() {
  const entries = getLocalPlaylistEntries();

  const spotifyMap = new Map();
  const youtubeMap = new Map();

  for (const entry of entries) {
    if (entry.spotifyPlaylistId && !spotifyMap.has(entry.spotifyPlaylistId)) {
      spotifyMap.set(entry.spotifyPlaylistId, {
        id: entry.spotifyPlaylistId,
        label: `${entry.name} (${entry.spotifyPlaylistId})`,
        folderName: entry.folderName,
        updatedAt: entry.updatedAt,
      });
    }

    if (entry.youtubePlaylistId && !youtubeMap.has(entry.youtubePlaylistId)) {
      youtubeMap.set(entry.youtubePlaylistId, {
        id: entry.youtubePlaylistId,
        label: `${entry.name} (${entry.youtubePlaylistId})`,
        folderName: entry.folderName,
        updatedAt: entry.updatedAt,
      });
    }
  }

  return {
    entries,
    spotifyOptions: Array.from(spotifyMap.values()),
    youtubeOptions: Array.from(youtubeMap.values()),
  };
}

function serve(reqPath, res) {
  const target = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const filePath = path.join(UI_DIR, target);

  if (!filePath.startsWith(UI_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };

  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });

  fs.createReadStream(filePath).pipe(res);
}

function updateCookieFile(cookie) {
  const currentConfig = loadRawConfig();
  currentConfig.spotify ??= {};
  currentConfig.youtube ??= {};
  currentConfig.youtube.headers ??= {};
  currentConfig.youtube.headers.Cookie = cookie;
  saveConfigToFile(currentConfig, CONFIG_FILE);
}

function updateActivePlaylists(spotifyPlaylistId, youtubePlaylistId) {
  const currentConfig = loadRawConfig();

  currentConfig.spotify ??= {};
  currentConfig.youtube ??= {};
  currentConfig.youtube.headers ??= {};

  if (spotifyPlaylistId !== undefined) {
    currentConfig.spotify.playlistURL = String(spotifyPlaylistId || "").trim();
  }

  if (youtubePlaylistId !== undefined) {
    currentConfig.youtube.playlistURL = String(youtubePlaylistId || "").trim();
  }

  return saveConfigToFile(currentConfig, CONFIG_FILE);
}

function clearAutoResumeTimer() {
  if (autoResumeTimer) {
    clearTimeout(autoResumeTimer);
    autoResumeTimer = null;
  }
}

function autoResumeFromCooldown() {
  autoResumeTimer = null;

  if (!state.running) return;
  if (state.pauseReason !== "redirect-cooldown") return;

  state.paused = false;
  state.pauseReason = null;
  state.cooldownUntil = null;
  publishStatus();
  log("info", "Auto-resume: redirect cooldown finished.");
}

function startRedirectCooldown() {
  if (!state.running) return;
  if (state.waitingForCookie || state.waitingForRetryDecision) return;
  if (state.pauseReason === "redirect-cooldown") return;

  state.paused = true;
  state.pauseReason = "redirect-cooldown";
  state.cooldownUntil = new Date(Date.now() + REDIRECT_COOLDOWN_MS).toISOString();
  publishStatus();

  log(
    "warn",
    `Detected ${REDIRECT_ERROR_THRESHOLD} consecutive ERR_TOO_MANY_REDIRECTS failures. Pausing for 5 minutes.`
  );

  clearAutoResumeTimer();
  autoResumeTimer = setTimeout(autoResumeFromCooldown, REDIRECT_COOLDOWN_MS);
}

function registerFailureReason(reason) {
  if (reason === "ERR_TOO_MANY_REDIRECTS") {
    redirectErrorStreak += 1;

    if (redirectErrorStreak >= REDIRECT_ERROR_THRESHOLD) {
      redirectErrorStreak = 0;
      startRedirectCooldown();
    }
    return;
  }

  redirectErrorStreak = 0;
}

function registerSuccess() {
  redirectErrorStreak = 0;
}

async function waitIfPaused() {
  while (state.paused) {
    await sleep(250);
  }
}

async function waitForUpdatedCookie(context = {}) {
  state.waitingForCookie = true;
  publishStatus();

  const message = "YouTube Cookie expired. Paste a new cookie to continue.";
  event("cookie-required", { message, track: context.track || null });
  log("warn", message);

  return new Promise((resolve) => {
    cookieResolver = resolve;
  });
}

async function waitForRetryDecision(details) {
  const failedSongs = details.failedSongs || [];
  const payload = {
    attempt: details.attempt,
    failedCount: failedSongs.length,
    songs: failedSongs.slice(0, 20),
  };

  state.waitingForRetryDecision = true;
  publishStatus();

  log(
    "warn",
    `${payload.failedCount} failed song(s) remain after retry round ${payload.attempt}. Waiting for retry decision.`
  );
  event("retry-decision-required", payload);

  return new Promise((resolve) => {
    retryDecisionResolver = resolve;
  });
}

async function startSync() {
  if (state.running) return false;

  const config = loadConfigFromFile(CONFIG_FILE);

  clearAutoResumeTimer();
  redirectErrorStreak = 0;

  state.running = true;
  state.paused = false;
  state.pauseReason = null;
  state.waitingForCookie = false;
  state.waitingForRetryDecision = false;
  state.cooldownUntil = null;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastError = null;
  state.lastSummary = null;
  state.progress = { processed: 0, total: 0, percent: 0, failed: 0, currentTrack: null };
  state.currentSync = {
    spotifyPlaylistId: config.spotify.playlistURL,
    youtubePlaylistId: config.youtube.playlistURL,
    playlistName: null,
  };

  publishStatus();
  log("info", "Sync started.");

  const spotifyPlaylistId = config.spotify.playlistURL;
  let retryPromptRound = 0;

  try {
    while (true) {
      try {
        const summary = await syncSpotifyToYoutube({
          config,
          waitIfPaused,
          getUpdatedCookie: waitForUpdatedCookie,
          onEvent: (ev) => {
            if (ev.type === "sync-meta") {
              state.playlistName = ev.playlistName;
              state.progress.total = ev.toProcess;
              if (state.currentSync) {
                state.currentSync.playlistName = ev.playlistName;
              }
              log("info", `Playlist ${ev.playlistName}: ${ev.toProcess} track(s) to process.`);
              publishStatus();
              return;
            }

            if (ev.type === "progress") {
              state.progress = {
                processed: ev.processed,
                total: ev.total,
                percent: ev.percent,
                failed: ev.failed,
                currentTrack: ev.currentTrack,
              };
              event("progress", state.progress);
              return;
            }

            if (ev.type === "track-added") {
              registerSuccess();
              log("success", `Added: ${ev.track}`);
              return;
            }

            if (ev.type === "track-failed") {
              registerFailureReason(ev.reason);
              log("error", `Failed: ${ev.track} (${ev.reason || "unknown"})`);
              return;
            }

            if (ev.type === "log") {
              log(ev.level || "info", ev.message);
            }
          },
        });

        state.lastSummary = summary;
        state.finishedAt = new Date().toISOString();
        upsertPlaylistProfile(summary);
        log("success", "Sync completed successfully.");
        event("summary", summary);
        break;
      } catch (error) {
        if (error.message === "Some songs could not be added after retry.") {
          retryPromptRound += 1;
          const failedSongs = getFailedSongsForPlaylist(state.playlistName, spotifyPlaylistId);
          const shouldRetry = await waitForRetryDecision({
            attempt: retryPromptRound,
            failedSongs,
          });

          state.waitingForRetryDecision = false;
          publishStatus();

          if (shouldRetry) {
            log("info", "Retrying sync with remaining failed songs.");
            continue;
          }

          const finalError = new Error(
            `Sync stopped by user with ${failedSongs.length} failed song(s) still pending.`
          );
          finalError.code = "FAILED_SONGS_REMAIN";
          throw finalError;
        }

        throw error;
      }
    }
  } catch (error) {
    state.lastError = {
      message: error.message,
      code: error.code || "SYNC_ERROR",
      at: new Date().toISOString(),
    };
    state.finishedAt = new Date().toISOString();
    log("error", `Sync stopped: ${error.message}`);
    event("error", state.lastError);
  } finally {
    clearAutoResumeTimer();
    redirectErrorStreak = 0;

    state.running = false;
    state.paused = false;
    state.pauseReason = null;
    state.waitingForCookie = false;
    state.waitingForRetryDecision = false;
    state.cooldownUntil = null;
    state.currentSync = null;

    if (cookieResolver) {
      const resolver = cookieResolver;
      cookieResolver = null;
      resolver("");
    }

    if (retryDecisionResolver) {
      const resolver = retryDecisionResolver;
      retryDecisionResolver = null;
      resolver(false);
    }

    publishStatus();
  }

  return true;
}

http
  .createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);
      const reqPath = reqUrl.pathname;

      if (req.method === "GET" && reqPath === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });

        res.write("\n");
        clients.add(res);
        sendToClient(res, "status", statusPayload());

        req.on("close", () => {
          clients.delete(res);
        });
        return;
      }

      if (req.method === "GET" && reqPath === "/api/config") {
        return json(res, 200, { config: loadRawConfig() });
      }

      if (req.method === "PUT" && reqPath === "/api/config") {
        const payload = JSON.parse((await readBody(req)) || "{}");
        if (!payload.config) return json(res, 400, { error: "Missing config payload." });

        const saved = saveConfigToFile(payload.config, CONFIG_FILE);
        log("info", "Configuration updated from UI.");
        return json(res, 200, { ok: true, config: saved });
      }

      if (req.method === "POST" && reqPath === "/api/config/active-playlists") {
        const payload = JSON.parse((await readBody(req)) || "{}");

        const saved = updateActivePlaylists(
          payload.spotifyPlaylistId,
          payload.youtubePlaylistId
        );

        log("info", "Active playlists changed from dashboard selector.");
        publishStatus();
        return json(res, 200, { ok: true, config: saved });
      }

      if (req.method === "GET" && reqPath === "/api/playlists") {
        return json(res, 200, { playlists: getLocalPlaylistEntries() });
      }

      if (req.method === "GET" && reqPath === "/api/profiles") {
        return json(res, 200, buildProfilesData());
      }
      if (req.method === "GET" && reqPath === "/api/spotify/playlists") {
        try {
          const seedPlaylistId = reqUrl.searchParams.get("seedPlaylistId") || "";
          const data = await fetchSpotifyPlaylistsForSelection(seedPlaylistId);
          return json(res, 200, data);
        } catch (error) {
          const statusCode = error.code === "SPOTIFY_DISCOVERY_CONFIG" ? 400 : 502;
          return json(res, statusCode, { error: error.message || "Failed to fetch Spotify playlists." });
        }
      }

      if (req.method === "GET" && reqPath === "/api/sync/status") {
        return json(res, 200, {
          ...statusPayload(),
          logs: state.logs.slice(-100),
        });
      }

      if (req.method === "POST" && reqPath === "/api/sync/start") {
        if (state.running) return json(res, 409, { error: "Sync already running." });

        startSync();
        return json(res, 202, { ok: true, message: "Sync started." });
      }

      if (req.method === "POST" && reqPath === "/api/sync/pause") {
        if (!state.running) return json(res, 409, { error: "No sync is currently running." });

        clearAutoResumeTimer();
        state.paused = true;
        state.pauseReason = "manual";
        state.cooldownUntil = null;
        publishStatus();
        log("warn", "Sync paused.");
        return json(res, 200, { ok: true, message: "Sync paused." });
      }

      if (req.method === "POST" && reqPath === "/api/sync/resume") {
        if (state.running) {
          clearAutoResumeTimer();
          state.paused = false;
          state.pauseReason = null;
          state.cooldownUntil = null;
          publishStatus();
          log("info", "Sync resumed.");
          return json(res, 200, { ok: true, message: "Sync resumed." });
        }

        startSync();
        return json(res, 202, { ok: true, message: "Sync resumed from checkpoint." });
      }

      if (req.method === "POST" && reqPath === "/api/sync/cookie") {
        const payload = JSON.parse((await readBody(req)) || "{}");
        const cookie = String(payload.cookie || "").trim();

        if (!cookie) {
          return json(res, 400, { error: "Cookie is required." });
        }

        if (!cookieResolver) {
          return json(res, 409, { error: "No cookie update is currently requested." });
        }

        updateCookieFile(cookie);

        const resolver = cookieResolver;
        cookieResolver = null;
        state.waitingForCookie = false;
        publishStatus();
        log("success", "YouTube Cookie updated. Resuming sync.");
        resolver(cookie);

        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && reqPath === "/api/sync/retry-decision") {
        const payload = JSON.parse((await readBody(req)) || "{}");

        if (!retryDecisionResolver) {
          return json(res, 409, { error: "No retry decision is currently requested." });
        }

        const shouldRetry = Boolean(payload.retry);
        const resolver = retryDecisionResolver;
        retryDecisionResolver = null;
        state.waitingForRetryDecision = false;
        publishStatus();

        log(shouldRetry ? "info" : "warn", shouldRetry
          ? "Retry decision: retry failed songs."
          : "Retry decision: stop with current failed songs.");

        resolver(shouldRetry);
        return json(res, 200, { ok: true });
      }

      serve(reqPath, res);
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
  })
  .listen(PORT, () => {
    console.log(`S2Y UI running at http://localhost:${PORT}`);
  });

