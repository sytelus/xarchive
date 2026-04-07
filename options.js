/**
 * xarchive options page — main entry point.
 *
 * Orchestrates the full export flow:
 *   1. Check / display credential status.
 *   2. Discover query IDs (from storage or JS bundle scraping).
 *   3. Fetch bookmark folders (Phase 1) and their contents (Phase 2).
 *   4. Fetch all bookmarks with pagination (Phase 3).
 *   5. Assemble and download JSON (Phase 4).
 *
 * All heavy work (API calls, IndexedDB, pagination) runs here in the
 * options page tab rather than the service worker, avoiding MV3
 * lifecycle termination issues.
 */

import { getCredentials, getFreshCt0 } from './lib/api.js';
import { getStoredQueryIds, hasRequiredQueryIds, scrapeQueryIdsFromBundles, captureQueryIdsViaTab, storeQueryIds } from './lib/query-ids.js';
import { fetchAllBookmarks } from './lib/fetcher.js';
import { fetchAllFolders, fetchFolderContents } from './lib/folders.js';
import { getBookmarkCount, getAllBookmarks, getAllFolders, getExportState, saveExportState, clearExportState, clearFolderData, clearAllData } from './lib/db.js';
import { assembleExport, downloadJSON } from './lib/exporter.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {'idle'|'exporting'|'paused'|'complete'|'error'} */
let exportState = 'idle';
let stopRequested = false;
/** When non-null the fetcher blocks on `pauseGate.promise`. */
let pauseGate = null; // { promise, resolve }
let startTime = null;
let elapsedInterval = null;
let currentCreds = null;
let currentQueryIds = {};
let currentUserId = null;
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
const resumePrompt = $('resume-prompt');
const resumeCount = $('resume-count');
const btnResumePrev = $('btn-resume-prev');
const btnStartFresh = $('btn-start-fresh');

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

const completeSection = $('complete-section');
const completeTotal = $('complete-total');
const completeAvailable = $('complete-available');
const completeUnavailable = $('complete-unavailable');
const completeFolders = $('complete-folders');
const completeDuration = $('complete-duration');
const btnDownload = $('btn-download');
const btnClear = $('btn-clear');

const logContainer = $('log');

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
 * Toggle button/section visibility to match the current export phase.
 * @param {'idle'|'exporting'|'paused'|'complete'|'error'} state
 */
function setUIState(state) {
  exportState = state;

  // Kill any lingering cooldown countdown from a previous export.
  if (state === 'idle' || state === 'complete') {
    if (cooldownInterval) {
      clearInterval(cooldownInterval);
      cooldownInterval = null;
    }
    rateLimitNotice.style.display = 'none';
  }

  // Progress bar: indeterminate animation while working, solid on complete.
  if (state === 'exporting' || state === 'paused') {
    progressBar.classList.add('indeterminate');
  } else {
    progressBar.classList.remove('indeterminate');
  }

  btnStart.style.display = state === 'idle' ? '' : 'none';
  btnPause.style.display = state === 'exporting' ? '' : 'none';
  btnResume.style.display = state === 'paused' ? '' : 'none';
  btnStop.style.display = (state === 'exporting' || state === 'paused') ? '' : 'none';
  progressSection.style.display = (state === 'exporting' || state === 'paused') ? '' : 'none';
  completeSection.style.display = state === 'complete' ? '' : 'none';
  resumePrompt.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Credential checking
// ---------------------------------------------------------------------------

/**
 * Read stored credentials and query IDs, update the status indicators,
 * and enable/disable the Start button accordingly.
 * @returns {Promise<{userId: string|null, creds: object|null}>}
 */
async function checkCredentials() {
  const { userId, creds } = await getCredentials();
  currentUserId = userId;
  currentCreds = creds;

  // User ID indicator
  if (userId) {
    userDot.className = 'status-dot ok';
    userText.textContent = `User ID: ${userId}`;
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

  return { userId, creds };
}

// ---------------------------------------------------------------------------
// Resume prompt
// ---------------------------------------------------------------------------

/**
 * Check for prior export state on page load.
 *
 * - If a previous export *completed*, jump straight to the download screen.
 * - If a previous export was *interrupted* (cursor saved), show the
 *   resume prompt so the user can pick up where they left off.
 */
async function checkPriorExport() {
  const completed = await getExportState('export_complete');
  if (completed) {
    log('Previous export data found.', 'success');
    await showComplete();
    return;
  }

  const cursor = await getExportState('main_bookmarks_cursor');
  const count = await getBookmarkCount();

  if (cursor && count > 0) {
    resumePrompt.style.display = '';
    resumeCount.textContent = `${count}`;
    btnStart.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Main export flow
// ---------------------------------------------------------------------------

/**
 * Run the full 4-phase export.
 *
 * Wrapped in a try/catch so any unexpected error resets the UI to idle
 * rather than leaving it stuck in the "exporting" state.
 *
 * @param {boolean} [resumeFromPrevious=false] - If true, resume from
 *   the last saved cursor instead of starting fresh.
 */
async function runExport(resumeFromPrevious = false) {
  setUIState('exporting');
  stopRequested = false;
  startElapsedTimer();

  log('Starting bookmark export...', 'info');

  try {
    await runExportInner(resumeFromPrevious);
  } catch (err) {
    log(`Unexpected error: ${err.message || err}`, 'error');
    setUIState('idle');
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
    const scraped = await scrapeQueryIdsFromBundles();
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
async function runExportInner(resumeFromPrevious) {
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

  // -- Prepare state --------------------------------------------------------
  if (!resumeFromPrevious) {
    await clearExportState();
    // Don't clear bookmarks — they'll be upserted (deduplicated by tweet_id).
  }

  const { creds } = await getCredentials();
  currentCreds = creds;

  const callbacks = {
    onLog: log,
    onCooldown: (waitMs) => {
      // Clear any prior cooldown interval before starting a new one.
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
  // Clear stale folder data from any prior run so that deleted folders
  // and removed tweet-folder mappings don't bleed into this export.
  await clearFolderData();

  statPhase.textContent = 'Fetching folders';
  log('Phase 1: Fetching bookmark folders...', 'info');

  const folders = await fetchAllFolders({
    queryId: currentQueryIds.BookmarkFoldersSlice,
    creds: currentCreds,
    onLog: log,
  });
  statFolders.textContent = String(folders.length);

  if (stopRequested) {
    log('Export stopped.', 'warn');
    setUIState('idle');
    return;
  }

  // -- Phase 2: Fetch folder contents ---------------------------------------
  if (folders.length > 0) {
    if (!currentQueryIds.BookmarkFolderTimeline) {
      // Last-resort: try bundle scraping specifically for this ID.
      // The background tab (run in discovery) can't capture it because
      // BookmarkFolderTimeline only fires when a user opens a folder.
      log(`Found ${folders.length} folder(s) but missing BookmarkFolderTimeline query ID. Scraping bundles...`, 'warn');
      const scraped = await scrapeQueryIdsFromBundles();
      if (scraped?.BookmarkFolderTimeline) {
        currentQueryIds = { ...currentQueryIds, ...scraped };
        await storeQueryIds(currentUserId, scraped);
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
        log('Export stopped.', 'warn');
        setUIState('idle');
        return;
      }
    } else {
      log('Could not discover BookmarkFolderTimeline query ID. Folder assignments will be empty.', 'warn');
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
    stateKey: 'main_bookmarks',
  });

  if (result.stopped) {
    const isRecoverable = result.reason === 'user_stopped' || result.reason === 'rate_limit_exceeded';
    log(`Export stopped: ${result.reason}`, 'warn');
    if (isRecoverable) {
      await saveExportState('export_interrupted', 'true');
    }
    setUIState('idle');
    return;
  }

  // -- Phase 4: Complete ----------------------------------------------------
  statPhase.textContent = 'Complete';
  log('Export complete! Assembling JSON...', 'success');

  const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
  await saveExportState('export_duration_seconds', String(durationSeconds));
  await saveExportState('export_complete', 'true');

  showComplete();
}

// ---------------------------------------------------------------------------
// Completion UI
// ---------------------------------------------------------------------------

/**
 * Populate the "Export Complete" section with stats from IndexedDB.
 *
 * Called both at the end of a live export run and on page reopen when
 * a prior completed export is detected by {@link checkPriorExport}.
 * In the latter case `startTime` is null, so the saved duration from
 * IndexedDB is used instead.
 */
async function showComplete() {
  const bookmarks = await getAllBookmarks();
  const folders = await getAllFolders();

  const available = bookmarks.filter((b) => b.status === 'available').length;
  const unavailable = bookmarks.length - available;
  const elapsed = await getElapsedSeconds();

  completeTotal.textContent = String(bookmarks.length);
  completeAvailable.textContent = String(available);
  completeUnavailable.textContent = String(unavailable);
  completeFolders.textContent = String(folders.length);
  completeDuration.textContent = formatTime(elapsed);

  setUIState('complete');
}

// ---------------------------------------------------------------------------
// Download handler
// ---------------------------------------------------------------------------

async function handleDownload() {
  log('Assembling export JSON...', 'info');

  const data = await assembleExport({
    userId: currentUserId,
    durationSeconds: await getElapsedSeconds(),
  });

  const filename = downloadJSON(data, currentUserId);
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
 *
 * During a live run, computes from `startTime`.  After page reopen
 * (restored export), reads the value saved to IndexedDB.
 *
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

btnStart.addEventListener('click', () => runExport(false));

btnResumePrev.addEventListener('click', () => runExport(true));

btnStartFresh.addEventListener('click', async () => {
  await clearAllData();
  resumePrompt.style.display = 'none';
  btnStart.style.display = '';
  log('Cleared previous data. Ready for fresh export.', 'info');
});

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
  // Unblock the pause gate so the fetcher can see the stop signal.
  if (pauseGate) {
    pauseGate.resolve();
    pauseGate = null;
  }
  log('Stop requested... finishing current page.', 'warn');
});

btnDownload.addEventListener('click', handleDownload);

btnClear.addEventListener('click', async () => {
  if (confirm('Clear all stored bookmark data?')) {
    await clearAllData();
    log('All stored data cleared.', 'info');
    setUIState('idle');
    await checkCredentials();
  }
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init() {
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
