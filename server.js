const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 4040;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PLAYLISTS_DIR = path.join(__dirname, 'playlists');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Ensure dirs exist ───────────────────────────────────────────────────────
if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });

// ─── Config helpers ──────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}

function saveConfig(data) {
  const current = loadConfig();
  const merged = { ...current, ...data };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

// ─── Config API ──────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  // Never send secrets to client in plain — client only needs to know they're set
  res.json({
    hasClientId: !!cfg.spotifyClientId,
    hasClientSecret: !!cfg.spotifyClientSecret,
    spotifyClientId: cfg.spotifyClientId || '',
    hasYtCookie: !!cfg.ytCookie,
    ytClientVersion: cfg.ytClientVersion || '2.20240101.00.00',
    spotifyAccessToken: cfg.spotifyAccessToken || '',
    spotifyRefreshToken: cfg.spotifyRefreshToken || '',
    spotifyExpiresAt: cfg.spotifyExpiresAt || 0,
    spotifyUserName: cfg.spotifyUserName || '',
    spotifyUserId: cfg.spotifyUserId || '',
    ytPlaylistMeta: cfg.ytPlaylistMeta || {},
    syncMeta: cfg.syncMeta || {},
  });
});

app.post('/api/config', (req, res) => {
  try {
    const cfg = saveConfig(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Spotify OAuth ───────────────────────────────────────────────────────────
app.post('/api/spotify/token', async (req, res) => {
  const { code, redirectUri } = req.body;
  const cfg = loadConfig();
  const clientId = cfg.spotifyClientId;
  const clientSecret = cfg.spotifyClientSecret;

  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Missing Spotify credentials in config' });
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: body.toString(),
    });
    const data = await r.json();
    if (data.access_token) {
      saveConfig({
        spotifyAccessToken: data.access_token,
        spotifyRefreshToken: data.refresh_token || '',
        spotifyExpiresAt: Date.now() + data.expires_in * 1000,
      });
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/spotify/refresh', async (req, res) => {
  const cfg = loadConfig();
  const { spotifyClientId: clientId, spotifyClientSecret: clientSecret, spotifyRefreshToken: refreshToken } = cfg;
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token' });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: body.toString(),
    });
    const data = await r.json();
    if (data.access_token) {
      saveConfig({
        spotifyAccessToken: data.access_token,
        spotifyExpiresAt: Date.now() + data.expires_in * 1000,
        ...(data.refresh_token ? { spotifyRefreshToken: data.refresh_token } : {}),
      });
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── YouTube proxy (avoids CORS issues with YouTube internal API) ─────────────
app.post('/api/youtube/add', async (req, res) => {
  const { playlistId, videoId } = req.body;
  const cfg = loadConfig();
  const cookie = cfg.ytCookie;
  const clientVersion = cfg.ytClientVersion || '2.20240101.00.00';

  if (!cookie) return res.status(400).json({ error: 'No YouTube cookie configured' });

  const payload = {
    context: {
      client: { clientName: 'WEB', clientVersion },
    },
    actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }],
    playlistId,
  };

  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/browse/edit_playlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': clientVersion,
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify(payload),
    });

    if (r.status === 429) return res.json({ rateLimited: true });

    const data = await r.json();
    if (data.status === 'STATUS_SUCCEEDED') return res.json({ success: true });

    const str = JSON.stringify(data);
    if (str.includes('UNAUTHENTICATED') || str.includes('CREDENTIALS_MISSING') || str.includes('visitorData')) {
      return res.json({ cookieExpired: true });
    }
    return res.json({ failed: true, raw: str.slice(0, 300) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── YouTube search proxy ────────────────────────────────────────────────────
app.get('/api/youtube/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const html = await r.text();
    // Extract video IDs from initial data JSON embedded in page
    const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (match) return res.json({ videoId: match[1] });
    return res.json({ videoId: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Playlist files API ──────────────────────────────────────────────────────
function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Unknown';
}

// List all synced playlists by scanning the playlists/ directory
app.get('/api/playlists', (req, res) => {
  try {
    const result = [];
    if (!fs.existsSync(PLAYLISTS_DIR)) return res.json([]);
    const folders = fs.readdirSync(PLAYLISTS_DIR).filter(f =>
      fs.statSync(path.join(PLAYLISTS_DIR, f)).isDirectory()
    );

    for (const folder of folders) {
      const folderPath = path.join(PLAYLISTS_DIR, folder);
      const files = fs.readdirSync(folderPath);
      const addedFiles = files.filter(f => f.startsWith('added_songs_') && f.endsWith('.txt'));

      for (const addedFile of addedFiles) {
        const match = addedFile.match(/^added_songs_(.+)\.txt$/);
        if (!match) continue;
        const spPlaylistId = match[1];
        const failedFile = `failed_songs_${spPlaylistId}.txt`;

        const addedPath = path.join(folderPath, addedFile);
        const failedPath = path.join(folderPath, failedFile);

        const addedContent = fs.readFileSync(addedPath, 'utf-8');
        const failedContent = fs.existsSync(failedPath) ? fs.readFileSync(failedPath, 'utf-8') : '';

        const addedSongs = addedContent.split('\n').map(l => l.trim()).filter(Boolean);
        const failedSongs = failedContent.split('\n').map(l => l.trim()).filter(Boolean);

        const stat = fs.statSync(addedPath);

        // Read per-folder meta.json if it exists
        const metaPath = path.join(folderPath, 'meta.json');
        let folderMeta = {};
        if (fs.existsSync(metaPath)) {
          try { folderMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
        }

        result.push({
          id: spPlaylistId,
          folderName: folder,
          addedCount: addedSongs.length,
          failedCount: failedSongs.length,
          total: addedSongs.length + failedSongs.length,
          lastModified: stat.mtime.toISOString(),
          addedSongs,
          failedSongs,
          spPlaylist: folderMeta.spPlaylist || null,
          ytPlaylist: folderMeta.ytPlaylist || null,
          syncDate: folderMeta.date || null,
        });
      }
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get songs for a specific playlist
app.get('/api/playlists/:id/songs', (req, res) => {
  const { id } = req.params;
  const cfg = loadConfig();
  const meta = (cfg.syncMeta || {})[id];
  if (!meta) return res.status(404).json({ error: 'Not found' });

  const folder = sanitizeName(meta.spPlaylist?.name || id);
  const folderPath = path.join(PLAYLISTS_DIR, folder);
  const addedPath = path.join(folderPath, `added_songs_${id}.txt`);
  const failedPath = path.join(folderPath, `failed_songs_${id}.txt`);

  const added = fs.existsSync(addedPath) ? fs.readFileSync(addedPath, 'utf-8').split('\n').filter(Boolean) : [];
  const failed = fs.existsSync(failedPath) ? fs.readFileSync(failedPath, 'utf-8').split('\n').filter(Boolean) : [];
  res.json({ added, failed });
});

// Write added/failed songs for a playlist
app.post('/api/playlists/:id/save', (req, res) => {
  const { id } = req.params;
  const { folderName, addedSongs, failedSongs, spPlaylist, ytPlaylist } = req.body;

  try {
    const folder = sanitizeName(folderName || id);
    const folderPath = path.join(PLAYLISTS_DIR, folder);
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

    fs.writeFileSync(path.join(folderPath, `added_songs_${id}.txt`), (addedSongs || []).join('\n'), 'utf-8');
    fs.writeFileSync(path.join(folderPath, `failed_songs_${id}.txt`), (failedSongs || []).join('\n'), 'utf-8');

    // Always write/update meta.json with playlist info
    const metaPath = path.join(folderPath, 'meta.json');
    let existingMeta = {};
    if (fs.existsSync(metaPath)) {
      try { existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
    }
    const meta = {
      ...existingMeta,
      ...(spPlaylist ? { spPlaylist } : {}),
      ...(ytPlaylist ? { ytPlaylist } : {}),
      date: existingMeta.date || new Date().toISOString(),
      lastSynced: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log('\x1b[32m');
  console.log('  ╔══════════════════════════════════╗');
  console.log('  ║   🎵 Syncify is running!          ║');
  console.log(`  ║   → ${url}             ║`);
  console.log('  ║   Press Ctrl+C to stop            ║');
  console.log('  ╚══════════════════════════════════╝');
  console.log('\x1b[0m');

  // Auto-open browser
  try {
    const open = require('open');
    open(url);
  } catch(e) {
    // open is optional
  }
});