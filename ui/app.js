const page = document.body.dataset.page || "dashboard";

document.querySelectorAll("[data-nav]").forEach((link) => {
  if (link.dataset.nav === page) {
    link.classList.add("active");
  }
});

const startSyncBtn = document.getElementById("startSyncBtn");
const pauseSyncBtn = document.getElementById("pauseSyncBtn");
const resumeSyncBtn = document.getElementById("resumeSyncBtn");
const refreshDataBtn = document.getElementById("refreshDataBtn");
const statusBadge = document.getElementById("statusBadge");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const currentTrack = document.getElementById("currentTrack");
const lastError = document.getElementById("lastError");
const logs = document.getElementById("logs");
const playlists = document.getElementById("playlists");

const activeSpotifySelect = document.getElementById("activeSpotifySelect");
const activeYoutubeSelect = document.getElementById("activeYoutubeSelect");
const fetchSpotifyPlaylistsBtn = document.getElementById("fetchSpotifyPlaylistsBtn");
const applyActivePlaylistsBtn = document.getElementById("applyActivePlaylistsBtn");
const activeSelectionMsg = document.getElementById("activeSelectionMsg");
const spotifyFetchMsg = document.getElementById("spotifyFetchMsg");
const runningPair = document.getElementById("runningPair");

const cookieModal = document.getElementById("cookieModal");
const cookiePromptText = document.getElementById("cookiePromptText");
const cookieInput = document.getElementById("cookieInput");
const cookieError = document.getElementById("cookieError");
const submitCookieBtn = document.getElementById("submitCookieBtn");

const retryModal = document.getElementById("retryModal");
const retryPromptText = document.getElementById("retryPromptText");
const retrySongs = document.getElementById("retrySongs");
const retryStopBtn = document.getElementById("retryStopBtn");
const retryContinueBtn = document.getElementById("retryContinueBtn");

const reloadConfigBtn = document.getElementById("reloadConfigBtn");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const configMessage = document.getElementById("configMessage");
const configFields = {
  spotifyClientId: document.getElementById("spotifyClientId"),
  spotifyClientSecret: document.getElementById("spotifyClientSecret"),
  spotifyRedirectUri: document.getElementById("spotifyRedirectUri"),
  spotifyPlaylistUrl: document.getElementById("spotifyPlaylistUrl"),
  youtubePlaylistUrl: document.getElementById("youtubePlaylistUrl"),
  ytContentType: document.getElementById("ytContentType"),
  ytAuthorization: document.getElementById("ytAuthorization"),
  ytCookie: document.getElementById("ytCookie"),
  ytVisitorId: document.getElementById("ytVisitorId"),
  ytOrigin: document.getElementById("ytOrigin"),
  ytClientVersion: document.getElementById("ytClientVersion"),
};

const hasDashboard = Boolean(startSyncBtn);
const hasSettings = Boolean(configFields.spotifyClientId);

let currentState = {
  running: false,
  paused: false,
  waitingForCookie: false,
  waitingForRetryDecision: false,
  pauseReason: null,
  cooldownUntil: null,
  currentSync: null,
  activeSelection: null,
  lastError: null,
};

let loadedConfig = null;

let latestLocalSpotifyOptions = [];
let latestSpotifyDiscoveryOptions = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatId(id) {
  return id ? id : "(not set)";
}


function updateRunningPairText(sync, running) {
  if (!runningPair) return;

  if (running && sync) {
    const playlistName = sync.playlistName ? ` (${sync.playlistName})` : "";
    runningPair.textContent =
      `Currently syncing: Spotify ${formatId(sync.spotifyPlaylistId)} -> YouTube ${formatId(sync.youtubePlaylistId)}${playlistName}`;
    return;
  }

  runningPair.textContent = "Currently syncing: No sync running.";
}

async function ensureNotificationPermission() {
  if (!("Notification" in window)) return false;

  if (Notification.permission === "granted") {
    return true;
  }

  if (Notification.permission === "default") {
    try {
      const permission = await Notification.requestPermission();
      return permission === "granted";
    } catch {
      return false;
    }
  }

  return false;
}

function notifyDesktop(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  try {
    new Notification(title, { body });
  } catch {
    // ignore notification errors
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function setFieldValue(field, value) {
  if (field) field.value = value ?? "";
}

function populateConfigForm(config) {
  if (!hasSettings) return;

  const spotify = config.spotify || {};
  const youtube = config.youtube || {};
  const headers = youtube.headers || {};

  setFieldValue(configFields.spotifyClientId, spotify.clientId);
  setFieldValue(configFields.spotifyClientSecret, spotify.clientSecret);
  setFieldValue(configFields.spotifyRedirectUri, spotify.redirectUri);
  setFieldValue(configFields.spotifyPlaylistUrl, spotify.playlistURL);
  setFieldValue(configFields.youtubePlaylistUrl, youtube.playlistURL);

  setFieldValue(configFields.ytContentType, headers["Content-Type"]);
  setFieldValue(configFields.ytAuthorization, headers.Authorization);
  setFieldValue(configFields.ytCookie, headers.Cookie);
  setFieldValue(configFields.ytVisitorId, headers["X-Goog-Visitor-Id"]);
  setFieldValue(configFields.ytOrigin, headers["X-Origin"]);
  setFieldValue(configFields.ytClientVersion, headers["X-Youtube-Client-Version"]);
}

function buildConfigFromForm() {
  const base = clone(loadedConfig || {});

  base.spotify ||= {};
  base.youtube ||= {};
  base.youtube.headers ||= {};

  base.spotify.clientId = configFields.spotifyClientId.value.trim();
  base.spotify.clientSecret = configFields.spotifyClientSecret.value.trim();
  base.spotify.redirectUri = configFields.spotifyRedirectUri.value.trim();
  base.spotify.playlistURL = configFields.spotifyPlaylistUrl.value.trim();

  base.youtube.playlistURL = configFields.youtubePlaylistUrl.value.trim();
  base.youtube.headers["Content-Type"] = configFields.ytContentType.value.trim();
  base.youtube.headers.Authorization = configFields.ytAuthorization.value.trim();
  base.youtube.headers.Cookie = configFields.ytCookie.value.trim();
  base.youtube.headers["X-Goog-Visitor-Id"] = configFields.ytVisitorId.value.trim();
  base.youtube.headers["X-Origin"] = configFields.ytOrigin.value.trim();
  base.youtube.headers["X-Youtube-Client-Version"] = configFields.ytClientVersion.value.trim();

  return base;
}

async function loadConfig() {
  const { config } = await api("/api/config");
  loadedConfig = config;
  populateConfigForm(config);
}

async function saveConfig() {
  configMessage.textContent = "Saving...";

  try {
    const nextConfig = buildConfigFromForm();
    const { config } = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: nextConfig }),
    });

    loadedConfig = config;
    populateConfigForm(config);

    configMessage.textContent = "Config saved.";
    setTimeout(() => {
      configMessage.textContent = "";
    }, 2000);
  } catch (error) {
    configMessage.textContent = `Save failed: ${error.message}`;
  }
}

function showCookiePrompt(message) {
  if (!cookieModal) return;
  cookiePromptText.textContent = message || "Paste a new YouTube Cookie to continue.";
  cookieError.textContent = "";
  cookieModal.classList.remove("hidden");
  cookieInput.focus();
}

function hideCookiePrompt() {
  if (!cookieModal) return;
  cookieModal.classList.add("hidden");
  cookieError.textContent = "";
  cookieInput.value = "";
}

function showRetryPrompt(payload) {
  if (!retryModal) return;

  retryPromptText.textContent =
    `${payload.failedCount} failed song(s) remain after retry round ${payload.attempt}. Retry again?`;

  retrySongs.innerHTML = (payload.songs || [])
    .map((song) => `<li>${escapeHtml(song)}</li>`)
    .join("");

  retryModal.classList.remove("hidden");
}

function hideRetryPrompt() {
  if (!retryModal) return;
  retryModal.classList.add("hidden");
  retrySongs.innerHTML = "";
}

function formatCooldown(isoDate) {
  const target = new Date(isoDate).getTime();
  const remainingMs = Number.isFinite(target) ? Math.max(0, target - Date.now()) : 0;
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function renderPlaylistSelect(selectEl, options, selectedId, placeholderLabel) {
  if (!selectEl) return;

  const normalizedOptions = Array.isArray(options) ? [...options] : [];
  if (selectedId && !normalizedOptions.some((option) => option.id === selectedId)) {
    normalizedOptions.unshift({
      id: selectedId,
      label: `${selectedId} (from current config)`,
    });
  }

  const baseOption = `<option value="">${placeholderLabel}</option>`;
  const optionHtml = normalizedOptions
    .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label || option.id)}</option>`)
    .join("");

  selectEl.innerHTML = baseOption + optionHtml;
  selectEl.value = selectedId || "";
}

function setSpotifyFetchMessage(message, isError = false) {
  if (!spotifyFetchMsg) return;
  spotifyFetchMsg.textContent = message || "";
  spotifyFetchMsg.classList.toggle("error-text", Boolean(isError));
}

function setActiveSelectionMessage(message, isError = false, kind = "status") {
  if (!activeSelectionMsg) return;
  activeSelectionMsg.textContent = message || "";
  activeSelectionMsg.classList.toggle("error-text", Boolean(isError));
  activeSelectionMsg.dataset.kind = kind || "";
}

function getSelectionDiff() {
  const selectedSpotify = String(activeSpotifySelect?.value || "").trim();
  const selectedYoutube = String(activeYoutubeSelect?.value || "").trim();
  const hasAppliedSelection = Boolean(currentState?.activeSelection);
  const appliedSpotify = hasAppliedSelection
    ? String(currentState.activeSelection.spotifyPlaylistId || "").trim()
    : selectedSpotify;
  const appliedYoutube = hasAppliedSelection
    ? String(currentState.activeSelection.youtubePlaylistId || "").trim()
    : selectedYoutube;

  return {
    selectedSpotify,
    selectedYoutube,
    appliedSpotify,
    appliedYoutube,
    hasChanges: selectedSpotify !== appliedSpotify || selectedYoutube !== appliedYoutube,
  };
}

function refreshSelectionDirtyState() {
  if (!hasDashboard) return;

  const diff = getSelectionDiff();
  if (diff.hasChanges) {
    setActiveSelectionMessage(
      "Selection changed but not applied. Click Apply Selection before syncing.",
      true,
      "dirty"
    );
    return;
  }

  if (activeSelectionMsg?.dataset.kind === "dirty") {
    setActiveSelectionMessage("", false, "");
  }
}

function mergeSpotifyOptions(localOptions = [], discoveredOptions = []) {
  const mergedById = new Map();

  for (const option of discoveredOptions) {
    const id = String(option?.id || "").trim();
    if (!id) continue;

    const playlistName = String(option?.name || option?.label || id).trim();
    const tracksLabel = Number.isFinite(option?.tracksTotal)
      ? ` | ${option.tracksTotal} tracks`
      : "";

    mergedById.set(id, {
      id,
      label: `Spotify API: ${playlistName} (${id})${tracksLabel}` ,
      local: false,
    });
  }

  for (const option of localOptions) {
    const id = String(option?.id || "").trim();
    if (!id) continue;

    const existing = mergedById.get(id);
    if (existing) {
      existing.local = true;
      if (!existing.label.includes("local history")) {
        existing.label += " | local history";
      }
      continue;
    }

    mergedById.set(id, {
      id,
      label: `Local history: ${option.label || id}` ,
      local: true,
    });
  }

  return Array.from(mergedById.values()).sort((a, b) =>
    String(a.label).localeCompare(String(b.label), undefined, { sensitivity: "base" })
  );
}

async function fetchSpotifyDiscoveryOptions(seedPlaylistId, options = {}) {
  const { announce = false } = options;
  const seedId = String(seedPlaylistId || "").trim();
  const query = seedId ? `?seedPlaylistId=${encodeURIComponent(seedId)}` : "";

  if (fetchSpotifyPlaylistsBtn) {
    fetchSpotifyPlaylistsBtn.disabled = true;
  }

  if (announce) {
    setSpotifyFetchMessage("Fetching playlists from Spotify...");
  }

  try {
    const payload = await api(`/api/spotify/playlists${query}`);
    latestSpotifyDiscoveryOptions = Array.isArray(payload.options)
      ? payload.options
      : [];

    if (announce) {
      const owner = payload?.owner?.name || payload?.owner?.id || "playlist owner";
      setSpotifyFetchMessage(
        `Loaded ${latestSpotifyDiscoveryOptions.length} playlist(s) from Spotify (${owner}).`
      );
    }
  } catch (error) {
    if (announce) {
      setSpotifyFetchMessage(`Spotify fetch failed: ${error.message}`, true);
    }
  } finally {
    if (fetchSpotifyPlaylistsBtn) {
      fetchSpotifyPlaylistsBtn.disabled = false;
    }
  }
}

async function refreshProfileSelectors(options = {}) {
  if (!hasDashboard) return;

  const { fetchSpotify = false, announceSpotify = false } = options;

  const [profilesData, configData] = await Promise.all([
    api("/api/profiles"),
    api("/api/config"),
  ]);

  latestLocalSpotifyOptions = Array.isArray(profilesData.spotifyOptions)
    ? profilesData.spotifyOptions
    : [];

  const spotifyId = configData?.config?.spotify?.playlistURL || "";
  const youtubeId = configData?.config?.youtube?.playlistURL || "";

  if (fetchSpotify) {
    await fetchSpotifyDiscoveryOptions(spotifyId, { announce: announceSpotify });
  }

  const mergedSpotifyOptions = mergeSpotifyOptions(
    latestLocalSpotifyOptions,
    latestSpotifyDiscoveryOptions
  );

  renderPlaylistSelect(
    activeSpotifySelect,
    mergedSpotifyOptions,
    spotifyId,
    "Select Spotify playlist"
  );

  renderPlaylistSelect(
    activeYoutubeSelect,
    profilesData.youtubeOptions,
    youtubeId,
    "Select YouTube playlist"
  );

  refreshSelectionDirtyState();
}

async function applyActivePlaylists() {
  if (!hasDashboard) return;

  const spotifyPlaylistId = activeSpotifySelect.value.trim();
  const youtubePlaylistId = activeYoutubeSelect.value.trim();

  setActiveSelectionMessage("Applying selected playlists...", false, "status");

  try {
    await api("/api/config/active-playlists", {
      method: "POST",
      body: JSON.stringify({ spotifyPlaylistId, youtubePlaylistId }),
    });

    setActiveSelectionMessage("Selection applied to config.json.", false, "status");
    refreshSelectionDirtyState();
  } catch (error) {
    setActiveSelectionMessage(`Failed to apply selection: ${error.message}`, true, "error");
  }
}

function setStatus(nextState = {}) {
  if (!hasDashboard) return;

  currentState = {
    ...currentState,
    ...nextState,
  };

  const {
    running,
    paused,
    waitingForCookie,
    waitingForRetryDecision,
    pauseReason,
    cooldownUntil,
    currentSync,
    activeSelection,
    lastError: syncError,
  } = currentState;

  if (running && waitingForRetryDecision) {
    statusBadge.className = "badge waiting";
    statusBadge.textContent = "Waiting Retry Decision";
  } else if (running && waitingForCookie) {
    statusBadge.className = "badge waiting";
    statusBadge.textContent = "Waiting Cookie";
  } else if (running && paused && pauseReason === "redirect-cooldown") {
    statusBadge.className = "badge paused";
    statusBadge.textContent = `Cooldown ${formatCooldown(cooldownUntil)}`;
  } else if (running && paused) {
    statusBadge.className = "badge paused";
    statusBadge.textContent = "Paused";
  } else if (running) {
    statusBadge.className = "badge running";
    statusBadge.textContent = "Running";
  } else if (syncError) {
    statusBadge.className = "badge error";
    statusBadge.textContent = "Idle (Error)";
  } else {
    statusBadge.className = "badge idle";
    statusBadge.textContent = "Idle";
  }

  startSyncBtn.disabled = running;
  pauseSyncBtn.disabled = !running || paused || waitingForCookie || waitingForRetryDecision;
  resumeSyncBtn.disabled = !running || !paused;

  if (activeSelection) {
    refreshSelectionDirtyState();
  }

  updateRunningPairText(currentSync, running);

  if (!running && !waitingForCookie) {
    hideCookiePrompt();
  }

  if (!running && !waitingForRetryDecision) {
    hideRetryPrompt();
  }
}

function updateProgress(progress = {}) {
  if (!hasDashboard) return;

  const percent = Number(progress.percent || 0);
  progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  progressText.textContent = `${progress.processed || 0} / ${progress.total || 0} (${percent}%)`;
  currentTrack.textContent = progress.currentTrack
    ? `Current: ${progress.currentTrack}`
    : "No active track";
}

function appendLog(entry) {
  if (!hasDashboard) return;

  const node = document.createElement("div");
  node.className = `log ${entry.level || "info"}`;
  const when = new Date(entry.at || Date.now()).toLocaleTimeString();
  node.textContent = `[${when}] ${entry.message}`;
  logs.appendChild(node);
  logs.scrollTop = logs.scrollHeight;
}

function renderPlaylists(items) {
  if (!hasDashboard) return;

  if (!items.length) {
    playlists.innerHTML = '<p class="muted">No local sync history yet.</p>';
    return;
  }

  playlists.innerHTML = items
    .map((item) => {
      const addedPreview = item.addedPreview.map((song) => `<li>${escapeHtml(song)}</li>`).join("");
      const failedPreview = item.failedPreview.map((song) => `<li>${escapeHtml(song)}</li>`).join("");

      return `
      <article class="playlist-item">
        <h3>${escapeHtml(item.name)}</h3>
        <p class="kv">Spotify ID: ${escapeHtml(item.spotifyPlaylistId || "-")}</p>
        <p class="kv">YouTube ID: ${escapeHtml(item.youtubePlaylistId || "-")}</p>
        <p class="kv">Updated: ${new Date(item.updatedAt).toLocaleString()}</p>
        <p class="kv">Added: ${item.addedCount} | Failed: ${item.failedCount}</p>
        ${addedPreview ? `<p class="kv">First added:</p><ul class="preview">${addedPreview}</ul>` : ""}
        ${failedPreview ? `<p class="kv">First failed:</p><ul class="preview">${failedPreview}</ul>` : ""}
      </article>`;
    })
    .join("");
}

async function refreshData() {
  if (!hasDashboard) return;

  const [syncState, playlistData] = await Promise.all([
    api("/api/sync/status"),
    api("/api/playlists"),
  ]);

  setStatus(syncState);
  updateProgress(syncState.progress);
  lastError.textContent = syncState.lastError ? syncState.lastError.message : "";

  logs.innerHTML = "";
  syncState.logs.forEach(appendLog);
  renderPlaylists(playlistData.playlists || []);
}

async function startSync() {
  lastError.textContent = "";
  await ensureNotificationPermission();

  const diff = getSelectionDiff();
  if (diff.hasChanges) {
    const message = [
      "Selected playlists are different from what is applied in config.json.",
      "",
      `Applied now: Spotify ${formatId(diff.appliedSpotify)} -> YouTube ${formatId(diff.appliedYoutube)}` ,
      `Selected in UI: Spotify ${formatId(diff.selectedSpotify)} -> YouTube ${formatId(diff.selectedYoutube)}` ,
      "",
      "Press OK to continue with the currently applied config, or Cancel to apply your selection first.",
    ].join("\n");

    const proceed = window.confirm(message);
    if (!proceed) {
      setActiveSelectionMessage(
        "Sync canceled. Click Apply Selection to save the current dropdown choices.",
        true,
        "error"
      );
      return;
    }
  }

  try {
    await api("/api/sync/start", { method: "POST" });
  } catch (error) {
    lastError.textContent = error.message;
  }
}

async function pauseSync() {
  try {
    await api("/api/sync/pause", { method: "POST" });
  } catch (error) {
    lastError.textContent = error.message;
  }
}

async function resumeSync() {
  try {
    await api("/api/sync/resume", { method: "POST" });
  } catch (error) {
    lastError.textContent = error.message;
  }
}

async function submitCookie() {
  cookieError.textContent = "";
  const cookie = cookieInput.value.trim();

  if (!cookie) {
    cookieError.textContent = "Paste a cookie value first.";
    return;
  }

  try {
    submitCookieBtn.disabled = true;
    await api("/api/sync/cookie", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    });
    hideCookiePrompt();
  } catch (error) {
    cookieError.textContent = error.message;
  } finally {
    submitCookieBtn.disabled = false;
  }
}

async function submitRetryDecision(retry) {
  try {
    await api("/api/sync/retry-decision", {
      method: "POST",
      body: JSON.stringify({ retry }),
    });
    hideRetryPrompt();
  } catch (error) {
    if (hasDashboard) {
      lastError.textContent = error.message;
    }
  }
}

function connectEvents() {
  const events = new EventSource("/api/events");

  events.addEventListener("status", (ev) => {
    const status = JSON.parse(ev.data);
    setStatus(status);
    if (status.lastError && hasDashboard) {
      lastError.textContent = status.lastError.message;
    }
  });

  events.addEventListener("progress", (ev) => {
    updateProgress(JSON.parse(ev.data));
  });

  events.addEventListener("log", (ev) => {
    appendLog(JSON.parse(ev.data));
  });

  events.addEventListener("cookie-required", (ev) => {
    const payload = JSON.parse(ev.data);
    showCookiePrompt(payload.message);
    notifyDesktop("S2Y: Cookie Update Required", payload.message || "Update YouTube cookie to continue sync.");

    if (payload.track && hasDashboard) {
      lastError.textContent = `Cookie required while processing: ${payload.track}`;
    }
  });

  events.addEventListener("retry-decision-required", (ev) => {
    const payload = JSON.parse(ev.data);
    showRetryPrompt(payload);
  });

  events.addEventListener("summary", async (ev) => {
    const summary = JSON.parse(ev.data);
    const label = summary.playlistName ? `${summary.playlistName} completed.` : "Sync completed.";
    notifyDesktop("S2Y: Sync Complete", label);

    if (hasDashboard) {
      await refreshProfileSelectors();
      await refreshData();
    }
  });

  events.addEventListener("error", (ev) => {
    const error = JSON.parse(ev.data);
    if (hasDashboard) {
      lastError.textContent = error.message;
    }
  });

  events.onerror = () => {
    setTimeout(connectEvents, 1500);
    events.close();
  };
}

if (hasDashboard) {
  startSyncBtn.addEventListener("click", startSync);
  pauseSyncBtn.addEventListener("click", pauseSync);
  resumeSyncBtn.addEventListener("click", resumeSync);
  refreshDataBtn.addEventListener("click", async () => {
    await refreshProfileSelectors({ fetchSpotify: true, announceSpotify: true });
    await refreshData();
  });

  applyActivePlaylistsBtn.addEventListener("click", applyActivePlaylists);

  activeSpotifySelect.addEventListener("change", refreshSelectionDirtyState);
  activeYoutubeSelect.addEventListener("change", refreshSelectionDirtyState);
  if (fetchSpotifyPlaylistsBtn) {
    fetchSpotifyPlaylistsBtn.addEventListener("click", async () => {
      await refreshProfileSelectors({ fetchSpotify: true, announceSpotify: true });
    });
  }
  submitCookieBtn.addEventListener("click", submitCookie);
  retryContinueBtn.addEventListener("click", () => submitRetryDecision(true));
  retryStopBtn.addEventListener("click", () => submitRetryDecision(false));

  cookieInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      submitCookie();
    }
  });

  setInterval(() => {
    if (currentState.running && currentState.paused && currentState.pauseReason === "redirect-cooldown") {
      setStatus({});
    }
  }, 1000);

  await Promise.all([refreshProfileSelectors({ fetchSpotify: true }), refreshData()]);
}

if (hasSettings) {
  reloadConfigBtn.addEventListener("click", loadConfig);
  saveConfigBtn.addEventListener("click", saveConfig);
  await loadConfig();
}

ensureNotificationPermission();
connectEvents();