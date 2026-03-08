# Spotify to YouTube Playlist Sync (No Developer YouTube API required - No quota constraints)
## Why do I need this and why no developer YouTube API required?
This app transfers tracks from Spotify playlists to YouTube playlists without using the YouTube Developer API quota flow. It uses your authenticated YouTube web session headers, so large playlist syncs are practical and resumable. The new version adds a local web UI for live progress, controls, and configuration.

---

## Features
- Sync Spotify playlists to YouTube playlists with local progress tracking.
- Dashboard UI with:
  - Start, pause, and resume controls.
  - Live status, logs, and progress bar.
  - Spotify and YouTube playlist selectors.
- Settings page to edit and save `config.json` through form fields.
- Desktop notifications for:
  - Sync completed.
  - Cookie update required.
- YouTube cookie prompt in-app when cookie expires (paste and continue).
- Automatic cooldown: after repeated `ERR_TOO_MANY_REDIRECTS`, sync pauses for 5 minutes and auto-resumes.
- Failed-song retry flow at the end of sync (prompt to retry remaining failed tracks).
- Local history per playlist (added/failed files + profile metadata).

---

## Prerequisites
1. Install [Node.js](https://nodejs.org/) (v18.0.0 or later).
2. Install npm (comes with Node.js).

---

## Installation

### Step 1: Clone the Repository
```bash
git clone https://github.com/FranciscoJRFreitas/SpotifyToYoutube-No-API-Limits.git
```

Navigate to the project directory:
```bash
cd SpotifyToYoutube-No-API-Limits
```

### Step 2: Install Dependencies
```bash
npm install
```

---

## Configuration

### Step 0: Create an Empty (or existing) YouTube Playlist
[Guide: create a YouTube playlist on desktop](https://support.google.com/youtube/answer/57792?hl=en&co=GENIE.Platform%3DDesktop)

### Step 1: Obtain Spotify API Credentials
1. Log in to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Create an app and get:
   - `clientId`
   - `clientSecret`
3. Keep `redirectUri` as `http://localhost:8080/callback`.

### Step 2: Fill the Config in the UI (recommended)
1. Start the app:
   ```bash
   npm run start
   ```
2. Open `http://localhost:3030`.
3. Go to **Settings** page.
4. Fill Spotify and YouTube fields and click **Save**.

The app writes values directly to `config.json`.

### Expected `config.json` shape
```json
{
  "spotify": {
    "clientId": "your_client_id",
    "clientSecret": "your_client_secret",
    "redirectUri": "http://localhost:8080/callback",
    "playlistURL": "spotify_playlist_id_or_url"
  },
  "youtube": {
    "playlistURL": "youtube_playlist_id_or_url",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "SAPISIDHASH ...",
      "Cookie": "__Secure-3PSID=...",
      "X-Goog-Visitor-Id": "...",
      "X-Origin": "https://www.youtube.com",
      "X-Youtube-Client-Version": "2.x.x"
    }
  }
}
```

### How to collect YouTube header values
1. Open [YouTube](https://www.youtube.com) and sign in with the target account.
2. Open browser DevTools (`F12`) -> **Network**.
3. Perform any YouTube search.
4. Filter by `v1/search` and open one request.
5. Copy required request headers:
   - `Authorization`
   - `Cookie`
   - `X-Goog-Visitor-Id`
   - `X-Youtube-Client-Version` (if needed)

When cookie expires, the app prompts you during sync. Paste the new cookie and continue.

---

## Usage

### Step 1: Run the App
```bash
npm run start
```
Then open `http://localhost:3030`.

### Step 2: Select Active Playlists
In **Dashboard**:
1. Choose Spotify source and YouTube target playlists from dropdowns.
2. Click **Apply Selection** to write selected IDs to `config.json`.

Important: if dropdown values are changed but not applied, app warns before starting sync.

### Step 3: Start and Control Sync
- **Start Sync**: starts transfer using the applied config.
- **Pause** / **Resume**: controls running sync.
- If cookie is invalid: prompt appears, paste cookie, continue.
- If repeated redirects happen: app pauses 5 minutes and auto-resumes.
- If failed songs remain at end: app prompts retry decision.

### Optional CLI mode
```bash
npm run sync
```
(Uses terminal flow from `s2y.js`.)

---

## File Structure
Each playlist keeps its own local state under `playlists/`:

```text
playlists/
  Playlist Name/
    added_songs_<spotify_playlist_id>.txt
    failed_songs_<spotify_playlist_id>.txt
    playlist_profile.json
```

- `added_songs_...txt`: successfully added tracks.
- `failed_songs_...txt`: failed tracks pending retry.
- `playlist_profile.json`: local metadata/history used by dashboard selectors.

### Keep previous sync status when moving machines or reinstalling
To preserve progress/history, copy your existing `playlists` folder into the project root:

```text
SpotifyToYoutube-No-API-Limits/
  playlists/   <-- copy this folder here
  config.json
  start.js
  ...
```

After copy, start app normally (`npm run start`). Dashboard will load previous local sync history.

---

## Troubleshooting
### Common Issues
- Missing `config.json`: open Settings and save valid config.
- Invalid YouTube cookie: update cookie when prompted.
- Start sync warning about unapplied selection: click **Apply Selection** first.
- Spotify playlist discovery returns none: verify Spotify credentials and selected seed playlist.
- Port already in use: set another port (PowerShell example):
  ```powershell
  $env:PORT='3040'; npm run start
  ```

---

## Contributing
If you have feature requests, suggestions, or feedback, you can [reach out here](https://franciscofreitas.netlify.app/).

Ways to help:
- Improve this tool with pull requests.
- Star and share the project.
- Support development: [Buy me a coffee (or a home)](https://paypal.me/franfreitas2002)
