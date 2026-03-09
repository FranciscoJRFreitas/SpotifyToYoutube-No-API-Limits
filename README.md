# DEPRECATED

![No Maintenance Intended](https://img.shields.io/badge/maintenance-no%20maintenance%20intended-red.svg)

This repository is **unmaintained** and is kept for archival/reference purposes only.

**Suggested replacement:** use an actively maintained migration tool/service such as [TuneMyMusic](https://www.tunemymusic.com/) or [Soundiiz](https://soundiiz.com/).

---

# Syncify - Spotify x YouTube

Sync your Spotify playlists to YouTube. Runs locally with a single command.

## Setup

```bash
npm install
npm run sync
```

Then open http://127.0.0.1:4040 in your browser (it opens automatically).

## First-time configuration

### 1. Spotify
1. Go to https://developer.spotify.com/dashboard and create/open your app.
2. Click **Edit Settings** and add this Redirect URI: `http://127.0.0.1:4040/`.
3. Click **Save**.
4. In Syncify, open **Settings**, enter your Client ID and Secret, then click **Connect with Spotify**.
5. Add your Spotify account email under **User Management** in the Spotify dashboard (required for dev-mode apps).

### 2. YouTube Cookie
1. Open https://youtube.com and log in.
2. Open DevTools (F12) -> Application tab -> Cookies -> `https://www.youtube.com`.
3. Copy the full cookie string.
4. Paste it in Syncify -> **Settings** -> YouTube Cookie -> **Save**.

## How it works

- Synced songs are saved to `/playlists/<PlaylistName>/added_songs_<id>.txt`.
- Failed songs are saved to `/playlists/<PlaylistName>/failed_songs_<id>.txt`.
- Interrupted syncs resume from where they left off.
- Rate-limit hits auto-pause for 2 minutes then resume.
- Expired cookies prompt you to update mid-sync.

## File structure

```text
/
|-- server.js          # Express server
|-- package.json
|-- config.json        # Auto-created, stores credentials and metadata
|-- playlists/         # Auto-created, stores sync progress
|   `-- MyPlaylist/
|       |-- added_songs_PLAYLISTID.txt
|       `-- failed_songs_PLAYLISTID.txt
`-- public/
    `-- index.html     # The UI
```
