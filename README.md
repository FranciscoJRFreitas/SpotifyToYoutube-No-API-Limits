# Spotify to YouTube Playlist Sync (No Developer Youtube API required - No quota constraints)
## Why do I need this and why no developer youtube API required?
This script transfers tracks from any Spotify playlist to a YouTube playlist automatically. Unlike other solutions, it does not rely on the YouTube Developer API, which often exceeds its daily quota when handling around 100 songs or more (based on my experience), this way you can easily transfer big playlists. It also handles failed tracks, retries them, and maintains progress logs for added and failed tracks in organized folders, so you can always add songs to the transfered spotify playlist and update them to youtube, rerunning this script, from where you left.

---

## Features
- Transfers songs from any Spotify playlist to a YouTube playlist (~33 tracks/minute).
- Automatically retries failed tracks.
- Stores progress logs (`added_songs` and `failed_songs`) in a dedicated folder for each playlist.
- Allows you to pause or abort the program and resume from where you left off.
- Prompts to refresh cookies if authentication fails.

---

## Prerequisites
1. Install [Node.js](https://nodejs.org/) (v18.0.0 or later).
2. Install npm (comes with Node.js).

---

## Installation

### Step 1: Clone the Repository
Clone this repository to your local machine:
```bash
git clone https://github.com/FranciscoJRFreitas/SpotifyToYoutube-No-API-Limits.git
```

Navigate to the project directory:
```
cd SpotifyToYoutube-No-API-Limits
```
### Step 2: Install Dependencies
Run the following command to install the required packages:
```
npm install
```
## Configuration

### Step 0: Create an Empty (or use existing) Youtube Playlist

- [PC Guide](https://support.google.com/youtube/answer/57792?hl=en&co=GENIE.Platform%3DDesktop)
- [Mobile - Android](https://support.google.com/youtube/answer/57792?hl=en&co=GENIE.Platform%3DAndroid)
- [Mobile - iPhone and iPad](https://support.google.com/youtube/answer/57792?hl=en&co=GENIE.Platform%3DiOS&oco=0)

### Step 1: Edit the ***config.json*** File

```json
{
  "spotify": {
    "clientId": "your_client_id",
    "clientSecret": "your_client_secret",
    "redirectUri": "http://localhost:8080/callback", // No need to change
    "playlistURL": "https://open.spotify.com/playlist{playlistId}?si={si}" // Spotify playlist being copied - Handles different formats, you can simply copy the playlist URL directly from the spotify share functionality
  },
  "youtube": {
    "playlistURL": "https://www.youtube.com/playlist?list={playlist}", // Youtube target playlist - Handles different formats, you can simply copy the playlist URL directly from the browser in the playlist page, after creating it
    "headers": { // Instructions below
      "Content-Type": "application/json", // don't change
      "Authorization": "SAPISIDHASH ... ", // change according to instructions below
      "Cookie": "__Secure-3PSID= ... wide=1", // change according to instructions below
      "X-Goog-Visitor-Id": "...", // change according to instructions below
      "X-Origin": "https://www.youtube.com", // don't change
      "X-Youtube-Client-Version": "2.20250116.10.00" // check headers version
    }
  }
}
```

For the headers segment in this configuration, open [Youtube](https://www.youtube.com) and login to your desired account with the target playlist. After that, open Developer Tools of your browser (*Press F12 key to toggle*) switch to *"Network"* tab and perform a search action in Youtube (i.e. search for any video). In the developer tools, filter by *"v1/search"* and inspect any request made. Scroll down to *"Request Headers"* and there you have all the header parameters you need to copy from your session: ***Authorization***, ***Cookie***, ***X-Goog-Visitor-Id*** and eventually ***X-Youtube-Client-Version***. Use this process to update the ***Cookie*** header, when required/prompted.

*Tip: You can easily copy any value by pressing right click on the header and "Copy Value".*

### Step 3 - Obtain Spotify API Credentials

1. Log in to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).

2. Create an application and retrieve the Client ID and Client Secret.

3. Add http://localhost:8080/callback to the list of Redirect URIs in your app settings.

## Usage

### Step 1: Run the Script
Run the following command:

```bash
node s2y.js
```

## File Structure
Each playlist will have its own folder in the *playlists/* directory:

```
playlists/
├── Playlist Name/
│   ├── added_songs_<playlist_id>.txt
│   └── failed_songs_<playlist_id>.txt
```

- added_songs_<playlist_id>.txt: Tracks successfully added to the YouTube playlist.
- failed_songs_<playlist_id>.txt: Tracks that failed to transfer.

## Troubleshooting
### Common Issues
- Missing config.json: Ensure the config.json file exists in the root directory.
- Invalid YouTube Cookie: If the script prompts you to update the YouTube Cookie, refresh it and rerun the script.
- API Errors: Ensure that your Spotify and YouTube credentials are correct.

## Contributing

If you have any feature requests, suggestions, or feedback, feel free to [reach out to me](https://franciscofreitas.netlify.app/). Your support is greatly appreciated! Here’s how you can help:

- 📈 Contribute by improving this tool.
- ⭐ Star this project and share it with others who might find it useful.
- ☕ [Buy me a coffee (or a home)](https://paypal.me/franfreitas2002) to support my work.



