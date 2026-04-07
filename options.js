/**
 * xarchive options page — main entry point.
 *
 * Orchestrates the full export flow:
 *   1. Check / display credential status.
 *   2. Discover query IDs (background tab + JS bundle scraping).
 *   3. Fetch bookmark folders (Phase 1) and their contents (Phase 2).
 *   4. Fetch all bookmarks with pagination (Phase 3).
 *   5. Assemble and download JSON.
 *
 * State machine (4 user actions: Start, Pause, Stop, Download):
 *
 *   idle ──Start──▶ exporting ──Pause──▶ paused ──Resume──▶ exporting
 *                   │                    │
 *                   └──Stop──▶ stopped ◀─┘
 *                                │
 *   complete ◀── (normal end)    ├── Download (stays stopped)
 *     │                          └── Start ──▶ exporting (fresh)
 *     ├── Download (stays complete)
 *     └── Start ──▶ exporting (fresh)
 *
 * Start ALWAYS clears all data and begins fresh.
 * Pause/Resume only applies within a running export.
 * Stop ends the current run but keeps collected data for download.
 */

import { getCredentials, getFreshCt0 } from './lib/api.js';
import { getStoredQueryIds, hasRequiredQueryIds, scrapeQueryIdsFromBundles, captureQueryIdsViaTab, captureFolderQueryIdViaTab, storeQueryIds } from './lib/query-ids.js';
import { fetchAllBookmarks } from './lib/fetcher.js';
import { fetchAllFolders, fetchFolderContents } from './lib/folders.js';
import { getBookmarkCount, getAllBookmarks, getAllFolders, getExportState, saveExportState, clearAllData } from './lib/db.js';
import { assembleExport, downloadJSON } from './lib/exporter.js';
import { VERSION, BUILD_DATE } from './version.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @type {'idle'|'exporting'|'paused'|'stopped'|'complete'}
 *
 * Transitions:
 *   idle      → exporting  (Start clicked)
 *   exporting → paused     (Pause clicked)
 *   exporting → stopped    (Stop clicked, or error with data)
 *   exporting → complete   (all pages fetched)
 *   paused    → exporting  (Resume clicked)
 *   paused    → stopped    (Stop clicked)
 *   stopped   → exporting  (Start clicked — fresh)
 *   complete  → exporting  (Start clicked — fresh)
 */
let exportState = 'idle';
let stopRequested = false;
/** When non-null the fetcher blocks on `pauseGate.promise`. */
let pauseGate = null; // { promise, resolve }
let startTime = null;
let elapsedInterval = null;
let currentCreds = null;
let currentQueryIds = {};
let currentUserId = null;
let currentScreenName = null;
/** Active cooldown countdown interval, if any. Cleared on state transitions. */
let cooldownInterval = null;

/**
 * Called by the fetcher before each page request.  If paused, the
 * returned promise won't resolve until the user clicks Resume.
 * @returns {Promise<void>}
 */
function shouldPause() {
  return pauseGate ? pauseGate.promise : Promise.resolve();
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const credDot = $('cred-dot');
const credText = $('cred-text');
const queryidDot = $('queryid-dot');
const queryidText = $('queryid-text');
const userDot = $('user-dot');
const userText = $('user-text');
const hintText = $('hint-text');

const btnStart = $('btn-start');
const btnPause = $('btn-pause');
const btnResume = $('btn-resume');
const btnStop = $('btn-stop');

const progressSection = $('progress-section');
const statPhase = $('stat-phase');
const statBookmarks = $('stat-bookmarks');
const statPages = $('stat-pages');
const statFolders = $('stat-folders');
const statSpeed = $('stat-speed');
const statElapsed = $('stat-elapsed');
const progressBar = $('progress-bar');
const rateLimitNotice = $('rate-limit-notice');
const cooldownTimer = $('cooldown-timer');

const resultSection = $('result-section');
const resultHeading = $('result-heading');
const resultTotal = $('result-total');
const resultAvailable = $('result-available');
const resultUnavailable = $('result-unavailable');
const resultFolders = $('result-folders');
const resultDuration = $('result-duration');
const btnDownload = $('btn-download');

const logContainer = $('log');
const versionInfo = $('version-info');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Append a timestamped entry to the on-screen log.
 * @param {string} message
 * @param {'info'|'warn'|'error'|'success'} [level='info']
 */
function log(message, level = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// ---------------------------------------------------------------------------
// Elapsed timer
// ---------------------------------------------------------------------------

function startElapsedTimer() {
  startTime = Date.now();
  elapsedInterval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    statElapsed.textContent = formatTime(elapsedSec);

    // Compute bookmarks/min from the displayed count.
    if (elapsedSec > 0) {
      const count = parseInt(statBookmarks.textContent, 10) || 0;
      const perMin = Math.round(count / (elapsedSec / 60));
      statSpeed.textContent = perMin > 0 ? `${perMin}/min` : '--';
    }
  }, 1000);
}

function stopElapsedTimer() {
  if (elapsedInterval) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
}

// ---------------------------------------------------------------------------
// UI state management
// ---------------------------------------------------------------------------

/**
 * Toggle button/section visibility to match the current export state.
 * @param {'idle'|'exporting'|'paused'|'stopped'|'complete'} state
 */
function setUIState(state) {
  exportState = state;

  // Kill any lingering cooldown countdown.
  if (state !== 'exporting' && state !== 'paused') {
    if (cooldownInterval) {
      clearInterval(cooldownInterval);
      cooldownInterval = null;
    }
    rateLimitNotice.style.display = 'none';
  }

  // Progress bar: indeterminate animation while working.
  if (state === 'exporting' || state === 'paused') {
    progressBar.classList.add('indeterminate');
  } else {
    progressBar.classList.remove('indeterminate');
  }

  const running = state === 'exporting' || state === 'paused';
  const done = state === 'stopped' || state === 'complete';

  // Start is visible when idle OR when there's a result to start over from.
  btnStart.style.display = (state === 'idle' || done) ? '' : 'none';
  btnPause.style.display = state === 'exporting' ? '' : 'none';
  btnResume.style.display = state === 'paused' ? '' : 'none';
  btnStop.style.display = running ? '' : 'none';
  progressSection.style.display = running ? '' : 'none';
  resultSection.style.display = done ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Credential checking
// ---------------------------------------------------------------------------

/**
 * Read stored credentials and query IDs, update the status indicators,
 * and enable/disable the Start button accordingly.
 */
async function checkCredentials() {
  const { userId, creds } = await getCredentials();
  currentUserId = userId;
  currentCreds = creds;

  // Read screen name captured by content script.
  const stored = await chrome.storage.local.get('xarchive_screen_name');
  currentScreenName = stored.xarchive_screen_name || null;

  // User ID indicator
  if (userId) {
    userDot.className = 'status-dot ok';
    userText.textContent = currentScreenName ? `@${currentScreenName} (${userId})` : `User ID: ${userId}`;
  } else {
    userDot.className = 'status-dot error';
    userText.textContent = 'No user session detected';
  }

  // Auth credentials indicator
  if (creds?.authorization || creds?.['x-csrf-token']) {
    credDot.className = 'status-dot ok';
    const age = creds.captured_at ? Math.round((Date.now() - creds.captured_at) / 60_000) : '?';
    credText.textContent = `Credentials captured (${age} min ago)`;
  } else {
    const ct0 = await getFreshCt0();
    if (ct0) {
      credDot.className = 'status-dot waiting';
      credText.textContent = 'Cookie found but full headers not captured yet';
    } else {
      credDot.className = 'status-dot error';
      credText.textContent = 'No credentials captured';
    }
  }

  // Query IDs indicator
  currentQueryIds = getStoredQueryIds(creds);
  if (hasRequiredQueryIds(currentQueryIds)) {
    queryidDot.className = 'status-dot ok';
    const ops = Object.keys(currentQueryIds).join(', ');
    queryidText.textContent = `Query IDs: ${ops}`;
  } else {
    queryidDot.className = 'status-dot waiting';
    queryidText.textContent = 'Query IDs not yet captured (auto-discovered on export start)';
  }

  // Actionable hints
  const hints = [];
  if (!userId || !creds?.authorization) {
    hints.push('Browse x.com while logged in to capture credentials.');
  }
  if (!hasRequiredQueryIds(currentQueryIds)) {
    hints.push('Query IDs will be auto-discovered when you click Start Export.');
  }

  if (hints.length > 0) {
    hintText.textContent = hints.join(' ');
    hintText.style.display = '';
  } else {
    hintText.style.display = 'none';
  }

  // Enable Start when we have at least some credentials.
  const hasCreds = creds?.authorization || (await getFreshCt0());
  btnStart.disabled = !hasCreds;
}

// ---------------------------------------------------------------------------
// Prior export check (page reopen)
// ---------------------------------------------------------------------------

/**
 * On page load, check if a previous export left data in IndexedDB.
 * Show the result section so the user can download or start fresh.
 */
async function checkPriorExport() {
  const completed = await getExportState('export_complete');
  const interrupted = await getExportState('export_interrupted');
  const count = await getBookmarkCount();

  if ((completed || interrupted) && count > 0) {
    log(`Previous export data found (${count} bookmarks).`, 'success');
    await showResult(completed ? 'complete' : 'stopped');
  }
}

// ---------------------------------------------------------------------------
// Main export flow
// ---------------------------------------------------------------------------

/**
 * Run the full export. Always starts fresh (clears all prior data).
 *
 * Wrapped in a try/catch so any unexpected error resets the UI to idle
 * rather than leaving it stuck in the "exporting" state.
 */
async function runExport() {
  setUIState('exporting');
  stopRequested = false;
  startElapsedTimer();

  log('Starting fresh bookmark export...', 'info');

  try {
    // Clear everything from prior runs.
    await clearAllData();
    await runExportInner();
  } catch (err) {
    log(`Unexpected error: ${err.message || err}`, 'error');
    // If we collected anything before the error, show it.
    const count = await getBookmarkCount();
    if (count > 0) {
      await showResult('stopped');
    } else {
      setUIState('idle');
    }
  } finally {
    stopElapsedTimer();
  }
}

/** Folder-related operations whose IDs are desirable but not required. */
const FOLDER_OPERATIONS = ['BookmarkFoldersSlice', 'BookmarkFolderTimeline'];

/**
 * Try to discover any missing query IDs.
 *
 * 1. Background tab → captures Bookmarks + BookmarkFoldersSlice from
 *    real API calls when the bookmarks page loads.
 * 2. Bundle scraping → finds ALL operation IDs (including
 *    BookmarkFolderTimeline) from compiled JS source code.
 *
 * Both strategies are tried so that we get the most complete set.
 */
async function discoverQueryIds() {
  // Strategy 1: background tab (captures live IDs quickly).
  const tabIds = await captureQueryIdsViaTab(currentUserId, log);
  if (tabIds) {
    currentQueryIds = { ...currentQueryIds, ...tabIds };
  }

  // Strategy 2: bundle scraping for any still-missing operations.
  // The background tab can't capture BookmarkFolderTimeline (it only
  // fires when a user opens a specific folder), but the scraper can
  // find it in the compiled JS.
  const allFound = FOLDER_OPERATIONS.every((op) => currentQueryIds[op]);
  if (!hasRequiredQueryIds(currentQueryIds) || !allFound) {
    log('Scraping JS bundles for remaining query IDs...', 'info');
    const scraped = await scrapeQueryIdsFromBundles(log);
    if (scraped) {
      currentQueryIds = { ...currentQueryIds, ...scraped };
      await storeQueryIds(currentUserId, scraped);
    }
  }

  if (hasRequiredQueryIds(currentQueryIds)) {
    const ops = Object.keys(currentQueryIds).join(', ');
    log(`Query IDs ready: ${ops}`, 'success');
    queryidDot.className = 'status-dot ok';
    queryidText.textContent = `Query IDs: ${ops}`;
  }
}

/**
 * Inner export logic — separated so the outer function can wrap it in
 * a single try/catch/finally.
 */
async function runExportInner() {
  // -- Query ID discovery ---------------------------------------------------
  if (!hasRequiredQueryIds(currentQueryIds)) {
    statPhase.textContent = 'Discovering query IDs';
    await discoverQueryIds();

    if (!hasRequiredQueryIds(currentQueryIds)) {
      log('Could not discover Bookmarks query ID. Make sure you are logged in to X.com, then retry.', 'error');
      setUIState('idle');
      return;
    }
  }

  const { creds } = await getCredentials();
  currentCreds = creds;

  const callbacks = {
    onLog: log,
    onCooldown: (waitMs) => {
      if (cooldownInterval) clearInterval(cooldownInterval);
      rateLimitNotice.style.display = '';
      let remaining = Math.ceil(waitMs / 1000);
      cooldownTimer.textContent = formatTime(remaining);
      cooldownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(cooldownInterval);
          cooldownInterval = null;
          rateLimitNotice.style.display = 'none';
        } else {
          cooldownTimer.textContent = formatTime(remaining);
        }
      }, 1000);
    },
    shouldStop: () => stopRequested,
    shouldPause,
  };

  // -- Phase 1: Fetch folders -----------------------------------------------
  statPhase.textContent = 'Fetching folders';
  log('Phase 1: Fetching bookmark folders...', 'info');

  const folders = await fetchAllFolders({
    queryId: currentQueryIds.BookmarkFoldersSlice,
    creds: currentCreds,
    onLog: log,
  });
  statFolders.textContent = String(folders.length);

  if (stopRequested) {
    await finishStopped();
    return;
  }

  // -- Phase 2: Fetch folder contents ---------------------------------------
  if (folders.length > 0) {
    // If the initial discovery (background tab + bundle scraping) didn't
    // find BookmarkFolderTimeline, try opening an actual folder in a
    // background tab.  The main bookmarks page only triggers Bookmarks
    // and BookmarkFoldersSlice; BookmarkFolderTimeline only fires when
    // viewing a specific folder.
    if (!currentQueryIds.BookmarkFolderTimeline) {
      log(`Missing BookmarkFolderTimeline query ID. Opening folder in background tab...`, 'warn');
      const qid = await captureFolderQueryIdViaTab(folders[0].id, currentUserId, log);
      if (qid) {
        currentQueryIds.BookmarkFolderTimeline = qid;
        await storeQueryIds(currentUserId, { BookmarkFolderTimeline: qid });
      } else {
        log(`Could not capture BookmarkFolderTimeline. Folder assignments will be empty.`, 'warn');
      }
    }

    if (currentQueryIds.BookmarkFolderTimeline) {
      statPhase.textContent = 'Fetching folder contents';
      log('Phase 2: Fetching folder contents...', 'info');

      await fetchFolderContents({
        folders,
        queryId: currentQueryIds.BookmarkFolderTimeline,
        creds: currentCreds,
        onLog: log,
        onFolderProgress: (current, total, name) => {
          statFolders.textContent = `${current}/${total}`;
          statPhase.textContent = `Folder: ${name}`;
        },
        shouldStop: () => stopRequested,
        shouldPause,
        onCooldown: callbacks.onCooldown,
      });

      if (stopRequested) {
        await finishStopped();
        return;
      }
    }
  }

  // -- Phase 3: Fetch all bookmarks -----------------------------------------
  statPhase.textContent = 'Fetching bookmarks';
  log('Phase 3: Fetching all bookmarks...', 'info');

  const result = await fetchAllBookmarks({
    queryId: currentQueryIds.Bookmarks,
    creds: currentCreds,
    onPage: async (tweets, pageNum) => {
      const count = await getBookmarkCount();
      statBookmarks.textContent = String(count);
      statPages.textContent = String(pageNum);
    },
    ...callbacks,
  });

  if (result.stopped) {
    log(`Export stopped: ${result.reason}`, 'warn');
    await finishStopped();
    return;
  }

  // -- Phase 4: Complete ----------------------------------------------------
  statPhase.textContent = 'Complete';
  log('Export complete!', 'success');

  const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
  await saveExportState('export_duration_seconds', String(durationSeconds));
  await saveExportState('export_complete', 'true');

  await showResult('complete');
}

/**
 * Handle an export that was stopped (by user or by error).
 * Saves state and shows the result screen if any data was collected.
 */
async function finishStopped() {
  const count = await getBookmarkCount();
  const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
  await saveExportState('export_duration_seconds', String(durationSeconds));
  await saveExportState('export_interrupted', 'true');

  if (count > 0) {
    log(`Stopped with ${count} bookmarks saved. You can download or start over.`, 'info');
    await showResult('stopped');
  } else {
    log('Export stopped. No bookmarks collected.', 'warn');
    setUIState('idle');
  }
}

// ---------------------------------------------------------------------------
// Result UI (complete or stopped)
// ---------------------------------------------------------------------------

/**
 * Populate and show the result section.
 * @param {'complete'|'stopped'} reason
 */
async function showResult(reason) {
  const bookmarks = await getAllBookmarks();
  const folders = await getAllFolders();

  const available = bookmarks.filter((b) => b.status === 'available').length;
  const unavailable = bookmarks.length - available;
  const elapsed = await getElapsedSeconds();

  resultHeading.textContent = reason === 'complete' ? 'Export Complete' : 'Export Stopped';
  resultTotal.textContent = String(bookmarks.length);
  resultAvailable.textContent = String(available);
  resultUnavailable.textContent = String(unavailable);
  resultFolders.textContent = String(folders.length);
  resultDuration.textContent = formatTime(elapsed);

  setUIState(reason);
}

// ---------------------------------------------------------------------------
// Download handler
// ---------------------------------------------------------------------------

async function handleDownload() {
  log('Assembling export JSON...', 'info');

  const data = await assembleExport({
    userId: currentUserId,
    screenName: currentScreenName,
    durationSeconds: await getElapsedSeconds(),
  });

  const filename = downloadJSON(data, currentScreenName || currentUserId);
  log(`Download started: ${filename}`, 'success');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a duration in seconds as `M:SS`.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTime(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get the export duration in seconds.
 * During a live run computes from `startTime`; after page reopen
 * reads the saved value from IndexedDB.
 * @returns {Promise<number>}
 */
async function getElapsedSeconds() {
  if (startTime) return Math.floor((Date.now() - startTime) / 1000);
  const saved = await getExportState('export_duration_seconds');
  return parseInt(saved || '0', 10);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

btnStart.addEventListener('click', () => runExport());

btnPause.addEventListener('click', () => {
  setUIState('paused');
  log('Export paused.', 'warn');
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  pauseGate = { promise, resolve };
});

btnResume.addEventListener('click', () => {
  if (pauseGate) {
    pauseGate.resolve();
    pauseGate = null;
  }
  setUIState('exporting');
  log('Export resumed.', 'info');
});

btnStop.addEventListener('click', () => {
  stopRequested = true;
  if (pauseGate) {
    pauseGate.resolve();
    pauseGate = null;
  }
  log('Stop requested... finishing current page.', 'warn');
});

btnDownload.addEventListener('click', handleDownload);

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init() {
  versionInfo.textContent = `v${VERSION} (${BUILD_DATE})`;
  log('xarchive initialized.', 'info');
  await checkCredentials();
  await checkPriorExport();

  // Re-check credentials periodically (user might browse x.com in another tab).
  setInterval(async () => {
    if (exportState === 'idle') {
      await checkCredentials();
    }
  }, 10_000);
}

init();
