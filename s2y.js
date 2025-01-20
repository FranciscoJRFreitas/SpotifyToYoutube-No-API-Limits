import fetch from "node-fetch";
import * as yt from "youtube-search-without-api-key";
import fs from "fs";
import SpotifyWebApi from "spotify-web-api-node";
import readline from "readline";

const CONFIG_FILE = "config.json";
let config = {};
const RED = "\x1b[31m"; // Red color
const GREEN = "\x1b[32m"; // Green color
const YELLOW = "\x1b[33m"; // Yellow color
const BLUE = "\x1b[34m"; // Blue color
const RESET = "\x1b[0m";

// Delay function to pause execution for a specified duration
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Load the configuration from the JSON file
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(
      `${RED}Config file not found. Please ensure config.json exists.${RESET}`
    );

    process.exit(1);
  }
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  console.log("Configuration loaded successfully.");
}

// Extract Playlist ID from a URL
function extractPlaylistId(url) {
  const match = url.match(/[?&]list=([^&]+)/);
  return match ? match[1] : url;
}

// Extract Spotify Playlist ID
function extractSpotifyPlaylistId(url) {
  const match = url.match(/playlist\/([^?]+)/);
  return match ? match[1] : url;
}

loadConfig();

config.spotify.playlistURL = extractSpotifyPlaylistId(
  config.spotify.playlistURL
);
config.youtube.playlistURL = extractPlaylistId(config.youtube.playlistURL);

// Spotify API configuration
const spotifyApi = new SpotifyWebApi({
  clientId: config.spotify.clientId,
  clientSecret: config.spotify.clientSecret,
  redirectUri: config.spotify.redirectUri,
});

// Utility functions to handle file operations
function loadSongsFromFile(filename) {
  if (!fs.existsSync(filename)) return new Set();
  return new Set(
    fs
      .readFileSync(filename, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
  );
}

function saveSongsToFile(filename, songs) {
  fs.writeFileSync(filename, Array.from(songs).join("\n"), "utf-8");
}

// Update Progress Bar
function updateProgress(current, total) {
  const progress = Math.floor((current / total) * 100);
  const barLength = 20;
  const filledLength = Math.floor((progress / 100) * barLength);
  const bar = "=".repeat(filledLength) + "-".repeat(barLength - filledLength);

  readline.cursorTo(process.stdout, 0);
  process.stdout.write(
    `${BLUE}[${bar}] ${current}/${total} (${progress}%) ${RESET}`
  );
  if (current === total) {
    console.log(GREEN, "\nTransfer complete!");
  }
}

// Authenticate with Spotify
async function authenticateSpotify() {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body["access_token"]);
    console.log("Spotify authentication successful.");
  } catch (err) {
    console.error("Error authenticating with Spotify:", err);
    process.exit(1);
  }
}

// Fetch Spotify Playlist Tracks
async function getSpotifyPlaylistTracks(playlistId) {
  try {
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
  } catch (err) {
    console.error(`${RED}Error fetching Spotify playlist tracks:${RESET}`, err);
    return [];
  }
}

// Add Video to YouTube Playlist
async function addToYouTubePlaylist(playlistId, videoId, track) {
  const payload = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: config.youtube.headers["X-Youtube-Client-Version"],
      },
    },
    actions: [
      {
        action: "ACTION_ADD_VIDEO",
        addedVideoId: videoId,
      },
    ],
    playlistId: playlistId,
  };

  try {
    const response = await fetch(
      "https://www.youtube.com/youtubei/v1/browse/edit_playlist",
      {
        method: "POST",
        headers: config.youtube.headers,
        body: JSON.stringify(payload),
      }
    );

    if (response.status === 429) {
      console.error(
        `${RED}Rate limit exceeded (429). Please wait and try again later, or update the YouTube 'Cookie' value in the config file.${RESET}`
      );
      process.exit(1); // Stop execution on rate limit
    }

    const data = await response.json();
    if (data.status === "STATUS_SUCCEEDED") {
      console.log(`Successfully added: ${track} (Video ID: ${videoId})`);
      return true;
    } else {
      console.error(
        `${RED}Failed to add ${track}:${RESET} ${JSON.stringify(data)}`
      );
      const errorMessage = JSON.stringify(data);
      if (
        errorMessage.includes("visitorData") ||
        errorMessage.includes("UNAUTHENTICATED") ||
        errorMessage.includes("CREDENTIALS_MISSING") ||
        errorMessage.includes("responseContext")
      ) {
        console.error(
          `${RED}The YouTube 'Cookie' value in the config file is invalid or missing. Please update the 'Cookie' in config.json and restart the script.${RESET}`
        );
        process.exit(1); // Stop execution for critical errors
      }
      return false;
    }
  } catch (err) {
    console.error(
      `${RED}Error adding ${track} to YouTube playlist:${RESET}`,
      err
    );
    return false;
  }
}

// Retry Failed Songs
async function retryFailedSongs(
  failedSongs,
  youtubePlaylistId,
  addedSongsFile,
  addedSongsSet
) {
  console.log("\nRetrying failed songs...");
  const newFailedSongs = new Set();

  for (const track of failedSongs) {
    try {
      await delay(500); // 1-second delay

      const results = await yt.search(track);
      if (results.length > 0) {
        const videoId = results[0].id.videoId;
        const success = await addToYouTubePlaylist(
          youtubePlaylistId,
          videoId,
          track
        );

        if (success) {
          addedSongsSet.add(track);
          saveSongsToFile(addedSongsFile, addedSongsSet);
        } else {
          newFailedSongs.add(track);
        }
      } else {
        console.error(
          `${RED}No YouTube results found for track: ${track}${RESET}`
        );
        newFailedSongs.add(track);
      }
    } catch (err) {
      console.error(`${RED}Error processing track "${track}":${RESET}`, err);
      newFailedSongs.add(track);
    }
  }

  if (newFailedSongs.size > 0) {
    console.error(
      `${RED}Some songs could not be added. Please refresh the 'Cookie' in the config file and run the script again.${RESET}`
    );
    saveSongsToFile(
      `failed_songs_${config.spotify.playlistURL}.txt`,
      newFailedSongs
    );
    process.exit(1); // Exit after retry failures
  } else {
    console.log(
      `${GREEN}All failed songs have been successfully processed.${RESET}`
    );
  }
}

// Create a directory for the playlist based on its name
function getOrCreatePlaylistFolder(playlistName) {
  const sanitizedPlaylistName = playlistName.replace(/[<>:"/\\|?*]/g, ""); // Remove invalid characters
  const folderPath = `playlists/${sanitizedPlaylistName}`;

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    console.log(
      `${GREEN}Created directory for playlist: ${folderPath}${RESET}`
    );
  }

  return folderPath;
}

// Main Function
(async () => {
  await authenticateSpotify();

  const SPOTIFY_PLAYLIST_ID = config.spotify.playlistURL;
  const YOUTUBE_PLAYLIST_ID = config.youtube.playlistURL;

  // Fetch playlist name from Spotify API
  const playlistDetails = await spotifyApi.getPlaylist(SPOTIFY_PLAYLIST_ID);
  const playlistName = playlistDetails.body.name;
  const playlistFolder = getOrCreatePlaylistFolder(playlistName);

  const addedSongsFile = `${playlistFolder}/added_songs_${SPOTIFY_PLAYLIST_ID}.txt`;
  const failedSongsFile = `${playlistFolder}/failed_songs_${SPOTIFY_PLAYLIST_ID}.txt`;

  if (!fs.existsSync(addedSongsFile)) fs.writeFileSync(addedSongsFile, "");
  if (!fs.existsSync(failedSongsFile)) fs.writeFileSync(failedSongsFile, "");

  const addedSongs = new Set([...loadSongsFromFile(addedSongsFile)]);
  const failedSongs = Array.from(loadSongsFromFile(failedSongsFile));

  const tracks = await getSpotifyPlaylistTracks(SPOTIFY_PLAYLIST_ID);
  console.log(`${YELLOW}Total tracks retrieved: ${tracks.length}${RESET}`);

  const missingTracks = tracks.filter((track) => !addedSongs.has(track));
  const toProcess = [...new Set([...missingTracks, ...failedSongs])];

  console.log(`${YELLOW}Tracks to process: ${toProcess.length}${RESET}`);

  const currentFailedSongs = new Set();
  let processedCount = 0;

  for (const track of toProcess) {
    await delay(500); // 1-second delay to prevent rate limits

    try {
      if (addedSongs.has(track)) {
        processedCount++;
        updateProgress(processedCount, toProcess.length);
        continue;
      }

      const results = await yt.search(track);
      if (results.length > 0) {
        const videoId = results[0].id.videoId;
        const success = await addToYouTubePlaylist(
          YOUTUBE_PLAYLIST_ID,
          videoId,
          track
        );

        if (success) {
          addedSongs.add(track);
          saveSongsToFile(addedSongsFile, addedSongs);
        } else {
          currentFailedSongs.add(track);
        }
      } else {
        console.error(
          `${RED}No YouTube results found for track: ${track}${RESET}`
        );
        currentFailedSongs.add(track);
      }
    } catch (err) {
      console.error(`${RED}Error processing track "${track}":${RESET}`, err);
      currentFailedSongs.add(track);
    }

    processedCount++;
    updateProgress(processedCount, toProcess.length);

    // Stop if the currentFailedSongs exceeds a threshold
    if (currentFailedSongs.size > 30) {
      console.error(
        `${RED}Too many failures encountered. Please check your configuration and retry.${RESET}`
      );
      process.exit(1);
    }
  }

  saveSongsToFile(failedSongsFile, currentFailedSongs);

  if (currentFailedSongs.size > 0) {
    await retryFailedSongs(
      currentFailedSongs,
      YOUTUBE_PLAYLIST_ID,
      addedSongsFile,
      addedSongs
    );
  } else {
    console.log(`${GREEN}All songs processed successfully.${RESET}`);
  }
})();
