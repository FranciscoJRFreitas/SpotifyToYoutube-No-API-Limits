import fetch from "node-fetch";
import * as yt from "youtube-search-without-api-key";
import fs from "fs";
import path from "path";
import SpotifyWebApi from "spotify-web-api-node";
import readline from "readline";
import { fileURLToPath } from "url";

const CONFIG_FILE = "config.json";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function extractPlaylistId(url) {
  const match = String(url ?? "").match(/[?&]list=([^&]+)/);
  return match ? match[1] : String(url ?? "").trim();
}

export function extractSpotifyPlaylistId(url) {
  const match = String(url ?? "").match(/playlist\/([^?]+)/);
  return match ? match[1] : String(url ?? "").trim();
}

export function normalizeAndValidateConfig(rawConfig) {
  const config = clone(rawConfig ?? {});

  if (!config.spotify || !config.youtube) {
    throw new Error("Invalid config: missing spotify or youtube section.");
  }

  const spotifyKeys = ["clientId", "clientSecret", "redirectUri", "playlistURL"];
  for (const key of spotifyKeys) {
    if (!config.spotify[key] || typeof config.spotify[key] !== "string") {
      throw new Error(`Invalid config: spotify.${key} is required.`);
    }
  }

  if (!config.youtube.playlistURL || typeof config.youtube.playlistURL !== "string") {
    throw new Error("Invalid config: youtube.playlistURL is required.");
  }

  if (!config.youtube.headers || typeof config.youtube.headers !== "object") {
    throw new Error("Invalid config: youtube.headers is required.");
  }

  const youtubeHeaderKeys = [
    "Content-Type",
    "Authorization",
    "Cookie",
    "X-Goog-Visitor-Id",
    "X-Origin",
    "X-Youtube-Client-Version",
  ];

  for (const key of youtubeHeaderKeys) {
    if (!config.youtube.headers[key] || typeof config.youtube.headers[key] !== "string") {
      throw new Error(`Invalid config: youtube.headers[\"${key}\"] is required.`);
    }
  }

  config.spotify.playlistURL = extractSpotifyPlaylistId(config.spotify.playlistURL);
  config.youtube.playlistURL = extractPlaylistId(config.youtube.playlistURL);

  return config;
}

export function loadConfigFromFile(configFile = CONFIG_FILE) {
  if (!fs.existsSync(configFile)) {
    throw new Error(`Config file not found: ${configFile}`);
  }

  const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  return normalizeAndValidateConfig(parsed);
}

export function saveConfigToFile(config, configFile = CONFIG_FILE) {
  const normalized = normalizeAndValidateConfig(config);
  fs.writeFileSync(configFile, JSON.stringify(normalized, null, 2), "utf-8");
  return normalized;
}

function loadSongsFromFile(filename) {
  if (!fs.existsSync(filename)) return new Set();
  return new Set(
    fs
      .readFileSync(filename, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

function saveSongsToFile(filename, songs) {
  fs.writeFileSync(filename, Array.from(songs).join("\n"), "utf-8");
}

function getOrCreatePlaylistFolder(playlistName) {
  const sanitizedPlaylistName = playlistName.replace(/[<>:"/\\|?*]/g, "");
  const folderPath = path.join("playlists", sanitizedPlaylistName);

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  return folderPath;
}

function isCookieAuthError(payload) {
  const text = JSON.stringify(payload);
  return (
    text.includes("visitorData") ||
    text.includes("UNAUTHENTICATED") ||
    text.includes("CREDENTIALS_MISSING") ||
    text.includes("responseContext")
  );
}

async function getSpotifyPlaylistTracks(spotifyApi, playlistId) {
  const tracks = [];
  let response = await spotifyApi.getPlaylistTracks(playlistId);

  while (response) {
    response.body.items.forEach((item) => {
      const track = item.track;
      if (track) {
        const song = `${track.name} ${track.artists[0].name}`;
        tracks.push(song);
      }
    });

    if (response.body.next) {
      response = await spotifyApi.getPlaylistTracks(playlistId, {
        offset: response.body.offset + response.body.limit,
      });
    } else {
      break;
    }
  }

  return tracks;
}

export async function syncSpotifyToYoutube(options = {}) {
  const {
    config,
    configFile = CONFIG_FILE,
    delayMs = 500,
    maxFailures = 30,
    signal,
    getUpdatedCookie,
    waitIfPaused,
    onEvent = () => {},
  } = options;

  const resolvedConfig = config
    ? normalizeAndValidateConfig(config)
    : loadConfigFromFile(configFile);

  const emit = (type, data = {}) => {
    onEvent({ type, at: new Date().toISOString(), ...data });
  };

  const throwIfAborted = () => {
    if (signal?.aborted) {
      const error = new Error("Sync aborted by user.");
      error.code = "SYNC_ABORTED";
      throw error;
    }
  };

  const waitIfPausedOrThrow = async () => {
    throwIfAborted();
    if (typeof waitIfPaused === "function") {
      await waitIfPaused();
      throwIfAborted();
    }
  };

  const spotifyApi = new SpotifyWebApi({
    clientId: resolvedConfig.spotify.clientId,
    clientSecret: resolvedConfig.spotify.clientSecret,
    redirectUri: resolvedConfig.spotify.redirectUri,
  });

  const addToYouTubePlaylist = async (playlistId, videoId, track) => {
    const payload = {
      context: {
        client: {
          clientName: "WEB",
          clientVersion: resolvedConfig.youtube.headers["X-Youtube-Client-Version"],
        },
      },
      actions: [
        {
          action: "ACTION_ADD_VIDEO",
          addedVideoId: videoId,
        },
      ],
      playlistId,
    };

    await waitIfPausedOrThrow();

    const response = await fetch(
      "https://www.youtube.com/youtubei/v1/browse/edit_playlist",
      {
        method: "POST",
        headers: resolvedConfig.youtube.headers,
        body: JSON.stringify(payload),
      }
    );

    if (response.status === 429) {
      const error = new Error(
        "Rate limit exceeded (429). Update Cookie or retry later."
      );
      error.code = "YOUTUBE_RATE_LIMIT";
      throw error;
    }

    const data = await response.json();

    if (data.status === "STATUS_SUCCEEDED") {
      emit("track-added", { track, videoId });
      return true;
    }

    if (isCookieAuthError(data)) {
      if (typeof getUpdatedCookie === "function") {
        emit("cookie-update-required", {
          code: "YOUTUBE_COOKIE_INVALID",
          message: "YouTube Cookie appears invalid or expired. Paste a new cookie to continue.",
          track,
        });

        const updatedCookie = await getUpdatedCookie({ track, errorPayload: data });

        if (updatedCookie) {
          resolvedConfig.youtube.headers.Cookie = updatedCookie;
          if (!config) {
            saveConfigToFile(resolvedConfig, configFile);
          }
          emit("config-updated", { field: "youtube.headers.Cookie" });

          return addToYouTubePlaylist(playlistId, videoId, track);
        }
      }

      const authError = new Error(
        "YouTube Cookie appears invalid or expired. Update config and retry."
      );
      authError.code = "YOUTUBE_COOKIE_INVALID";
      authError.details = data;
      throw authError;
    }

    emit("track-failed", { track, reason: "add-failed", details: data });
    return false;
  };

  const retryFailedSongs = async (
    failedSongs,
    youtubePlaylistId,
    addedSongsFile,
    addedSongsSet
  ) => {
    emit("log", { level: "info", message: "Retrying failed songs..." });
    const newFailedSongs = new Set();

    for (const track of failedSongs) {
      await waitIfPausedOrThrow();
      await delay(delayMs);
      await waitIfPausedOrThrow();

      try {
        let results = await yt.search(track);

        if (results.length > 0) {
          const videoId = results[0].id.videoId;
          const success = await addToYouTubePlaylist(youtubePlaylistId, videoId, track);

          if (success) {
            addedSongsSet.add(track);
            saveSongsToFile(addedSongsFile, addedSongsSet);
          } else {
            newFailedSongs.add(track);
          }
        } else {
          newFailedSongs.add(track);
          emit("track-failed", { track, reason: "no-youtube-results" });
        }
      } catch (err) {
        newFailedSongs.add(track);
        emit("track-failed", {
          track,
          reason: err.code || "retry-error",
          message: err.message,
        });
      }
    }

    if (newFailedSongs.size > 0) {
      throw new Error("Some songs could not be added after retry.");
    }
  };

  emit("sync-started", {
    spotifyPlaylistId: resolvedConfig.spotify.playlistURL,
    youtubePlaylistId: resolvedConfig.youtube.playlistURL,
  });

  throwIfAborted();

  const authData = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(authData.body.access_token);
  emit("log", { level: "info", message: "Spotify authentication successful." });

  const spotifyPlaylistId = resolvedConfig.spotify.playlistURL;
  const youtubePlaylistId = resolvedConfig.youtube.playlistURL;

  const playlistDetails = await spotifyApi.getPlaylist(spotifyPlaylistId);
  const playlistName = playlistDetails.body.name;
  const playlistFolder = getOrCreatePlaylistFolder(playlistName);

  const addedSongsFile = path.join(
    playlistFolder,
    `added_songs_${spotifyPlaylistId}.txt`
  );
  const failedSongsFile = path.join(
    playlistFolder,
    `failed_songs_${spotifyPlaylistId}.txt`
  );

  if (!fs.existsSync(addedSongsFile)) fs.writeFileSync(addedSongsFile, "");
  if (!fs.existsSync(failedSongsFile)) fs.writeFileSync(failedSongsFile, "");

  const addedSongs = new Set([...loadSongsFromFile(addedSongsFile)]);
  const failedSongs = Array.from(loadSongsFromFile(failedSongsFile));

  const tracks = await getSpotifyPlaylistTracks(spotifyApi, spotifyPlaylistId);
  const missingTracks = tracks.filter((track) => !addedSongs.has(track));
  const toProcess = [...new Set([...missingTracks, ...failedSongs])];

  emit("sync-meta", {
    playlistName,
    totalTracks: tracks.length,
    toProcess: toProcess.length,
    alreadyAdded: addedSongs.size,
  });

  const currentFailedSongs = new Set();
  let processedCount = 0;

  for (const track of toProcess) {
    await waitIfPausedOrThrow();
    await delay(delayMs);
    await waitIfPausedOrThrow();

    try {
      if (!addedSongs.has(track)) {
        const results = await yt.search(track);

        if (results.length > 0) {
          const videoId = results[0].id.videoId;
          const success = await addToYouTubePlaylist(youtubePlaylistId, videoId, track);

          if (success) {
            addedSongs.add(track);
            saveSongsToFile(addedSongsFile, addedSongs);
          } else {
            currentFailedSongs.add(track);
          }
        } else {
          currentFailedSongs.add(track);
          emit("track-failed", { track, reason: "no-youtube-results" });
        }
      }
    } catch (err) {
      currentFailedSongs.add(track);
      emit("track-failed", {
        track,
        reason: err.code || "process-error",
        message: err.message,
      });

      if (err.code === "YOUTUBE_COOKIE_INVALID" || err.code === "YOUTUBE_RATE_LIMIT") {
        throw err;
      }
    }

    processedCount += 1;
    const percent = toProcess.length === 0 ? 100 : Math.floor((processedCount / toProcess.length) * 100);
    emit("progress", {
      processed: processedCount,
      total: toProcess.length,
      percent,
      currentTrack: track,
      failed: currentFailedSongs.size,
    });

    if (currentFailedSongs.size > maxFailures) {
      const error = new Error(
        "Too many failures encountered. Check configuration and retry."
      );
      error.code = "TOO_MANY_FAILURES";
      throw error;
    }
  }

  saveSongsToFile(failedSongsFile, currentFailedSongs);

  if (currentFailedSongs.size > 0) {
    await retryFailedSongs(
      currentFailedSongs,
      youtubePlaylistId,
      addedSongsFile,
      addedSongs
    );

    saveSongsToFile(failedSongsFile, new Set());
  }

  const summary = {
    playlistName,
    spotifyPlaylistId,
    youtubePlaylistId,
    totalTracks: tracks.length,
    processed: toProcess.length,
    failed: 0,
    addedSongsCount: addedSongs.size,
    completedAt: new Date().toISOString(),
  };

  emit("sync-completed", summary);
  return summary;
}

export async function runFromConfigFile(options = {}) {
  return syncSpotifyToYoutube({ ...options, configFile: options.configFile || CONFIG_FILE });
}

async function promptCookieInTerminal() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${CYAN}Please enter the new YouTube Cookie: ${RESET}`, (cookie) => {
      rl.close();
      resolve(cookie.trim());
    });
  });
}

function renderCliProgress(processed, total) {
  const progress = total === 0 ? 100 : Math.floor((processed / total) * 100);
  const barLength = 20;
  const filledLength = Math.floor((progress / 100) * barLength);
  const bar = "=".repeat(filledLength) + "-".repeat(barLength - filledLength);

  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`${BLUE}[${bar}] ${processed}/${total} (${progress}%) ${RESET}`);

  if (processed === total) {
    process.stdout.write("\n");
  }
}

async function runCli() {
  try {
    await runFromConfigFile({
      onEvent: (event) => {
        if (event.type === "progress") {
          renderCliProgress(event.processed, event.total);
          return;
        }

        if (event.type === "track-added") {
          console.log(`${GREEN}Added:${RESET} ${event.track} (${event.videoId})`);
          return;
        }

        if (event.type === "track-failed") {
          console.log(
            `${RED}Failed:${RESET} ${event.track} (${event.reason || "unknown"})`
          );
          return;
        }

        if (event.type === "sync-meta") {
          console.log(
            `${YELLOW}Playlist:${RESET} ${event.playlistName} | ${event.toProcess} track(s) to process`
          );
          return;
        }

        if (event.type === "log") {
          console.log(event.message);
        }
      },
      getUpdatedCookie: async () => {
        const newCookie = await promptCookieInTerminal();
        if (!newCookie) {
          return "";
        }
        return newCookie;
      },
    });

    console.log(`${GREEN}All songs processed successfully.${RESET}`);
  } catch (err) {
    console.error(`${RED}Sync failed:${RESET}`, err.message);
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runCli();
}




