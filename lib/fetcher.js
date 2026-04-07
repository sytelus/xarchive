/**
 * Paginated bookmark fetching with rate limiting and retry.
 *
 * Both {@link fetchAllBookmarks} and {@link fetchFolderBookmarks} implement
 * cursor-based pagination against X.com's internal GraphQL API.  They share
 * the same rate-limiting strategy:
 *
 * - Jittered delay between every page request (2.5 s base x 0.7–1.5).
 * - Exponential back-off on HTTP 429 responses.
 * - 5-minute cooldown after 3 consecutive 429s; full stop after 5.
 * - Up to 5 retries per single page; abort on auth errors immediately.
 */

import { graphqlRequest } from './api.js';
import { parseBookmarksPage } from './parser.js';
import { upsertBookmarks } from './db.js';
import {
  BASE_DELAY_MS, MAX_RETRIES, COOLDOWN_MS,
  CONSECUTIVE_429_COOLDOWN, CONSECUTIVE_429_STOP, MAX_CONSECUTIVE_EMPTY,
  sleep, jitteredDelay,
} from './utils.js';

/**
 * Execute a single GraphQL request with retry and rate-limit handling.
 *
 * @param {object} opts
 * @param {string} opts.queryId        - GraphQL query ID.
 * @param {string} opts.operationName  - GraphQL operation name.
 * @param {object} opts.variables      - Request variables (includes cursor).
 * @param {object} opts.creds          - Stored auth credentials.
 * @param {object} opts.state          - Mutable counter object shared across
 *   pages: `{ consecutive429s }`.
 * @param {Function} [opts.onRateLimit]  - Called with (waitMs) on back-off.
 * @param {Function} [opts.onCooldown]   - Called with (waitMs) on cooldown.
 * @param {Function} [opts.onLog]        - Logger callback (message, level).
 * @returns {Promise<{result: object|null, abort: boolean, reason: string|null}>}
 *   `result` is the parsed API response, or null on unrecoverable failure.
 *   `abort` signals the caller should stop pagination entirely.
 */
async function fetchWithRetry({
  queryId, operationName, variables, creds,
  state, onRateLimit, onCooldown, onLog,
}) {
  let retries = 0;

  while (retries < MAX_RETRIES) {
    const result = await graphqlRequest(queryId, operationName, variables, creds);

    if (!result.error) return { result, abort: false, reason: null };

    if (result.error === 'rate_limited') {
      state.consecutive429s++;
      retries++;

      if (state.consecutive429s >= CONSECUTIVE_429_STOP) {
        onLog?.(`Stopped: ${CONSECUTIVE_429_STOP} consecutive rate limits. Try again later.`, 'error');
        return { result: null, abort: true, reason: 'rate_limit_exceeded' };
      }

      if (state.consecutive429s >= CONSECUTIVE_429_COOLDOWN) {
        onLog?.(`Cooling down for 5 minutes after ${state.consecutive429s} consecutive rate limits...`, 'warn');
        onCooldown?.(COOLDOWN_MS);
        await sleep(COOLDOWN_MS);
        continue;
      }

      const backoff = BASE_DELAY_MS * Math.pow(2, retries) + Math.random() * 1000;
      onLog?.(`Rate limited (attempt ${retries}/${MAX_RETRIES}). Waiting ${(backoff / 1000).toFixed(1)}s...`, 'warn');
      onRateLimit?.(backoff);
      await sleep(backoff);
      continue;
    }

    if (result.error === 'auth_error') {
      onLog?.(`Auth error (${result.status}). Credentials may have expired. Visit x.com to refresh.`, 'error');
      return { result: null, abort: true, reason: 'auth_error' };
    }

    // Network or other transient error — retry with back-off.
    retries++;
    const backoff = BASE_DELAY_MS * Math.pow(2, retries);
    onLog?.(`Error: ${result.error} (${result.status || result.message || ''}). Retry ${retries}/${MAX_RETRIES}...`, 'warn');
    await sleep(backoff);
  }

  onLog?.(`Failed after ${MAX_RETRIES} retries. Stopping.`, 'error');
  return { result: null, abort: true, reason: 'max_retries' };
}

/**
 * Determine whether pagination should stop based on the new cursor and
 * page contents.
 *
 * @param {object} opts
 * @param {string|null} bottomCursor    - Cursor returned by the API.
 * @param {string|null} currentCursor   - Cursor we sent with this request.
 * @param {number}      consecutiveEmpty - Running count of empty pages.
 * @param {Function}    [onLog]
 * @returns {boolean} `true` if pagination should end.
 */
function shouldStopPaginating({ bottomCursor, currentCursor, consecutiveEmpty, onLog }) {
  if (!bottomCursor) {
    onLog?.('No more pages (no bottom cursor).', 'success');
    return true;
  }
  if (bottomCursor === currentCursor) {
    onLog?.('Pagination loop detected (same cursor returned). Stopping.', 'warn');
    return true;
  }
  if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
    onLog?.(`${MAX_CONSECUTIVE_EMPTY} consecutive empty pages. Stopping.`, 'warn');
    return true;
  }
  return false;
}

/**
 * Fetch all bookmarks from the main timeline with cursor-based pagination.
 *
 * Each page of tweets is stored in IndexedDB immediately so that data
 * is available for download even if the export is stopped mid-run.
 *
 * @param {object} opts
 * @param {string}   opts.queryId     - GraphQL query ID for "Bookmarks".
 * @param {object}   opts.creds       - Stored auth credentials.
 * @param {Function} [opts.onPage]    - Called after each page: (tweets, pageNum, cursor).
 * @param {Function} [opts.onRateLimit] - Called with (waitMs) on back-off.
 * @param {Function} [opts.onCooldown]  - Called with (waitMs) on cooldown.
 * @param {Function} [opts.onLog]       - Logger callback (message, level).
 * @param {Function} [opts.shouldStop]  - Returns `true` when user requests stop.
 * @param {Function} [opts.shouldPause] - Returns a Promise that blocks while paused.
 * @param {number}   [opts.count=100] - Bookmarks per page (API supports up to 100).
 * @returns {Promise<{totalTweets: number, stopped: boolean, reason: string}>}
 */
export async function fetchAllBookmarks({
  queryId,
  creds,
  onPage,
  onRateLimit,
  onCooldown,
  onLog,
  shouldStop,
  shouldPause,
  count = 100,
}) {
  let cursor = null;
  let pageNum = 0;
  let totalTweets = 0;
  let consecutiveEmpty = 0;
  const state = { consecutive429s: 0 };

  while (true) {
    // Check stop / pause signals before each page request.
    if (shouldStop?.()) {
      onLog?.('Export stopped by user.', 'warn');
      return { totalTweets, stopped: true, reason: 'user_stopped' };
    }
    if (shouldPause) await shouldPause();

    const variables = { count };
    if (cursor) variables.cursor = cursor;

    const { result, abort, reason } = await fetchWithRetry({
      queryId, operationName: 'Bookmarks', variables, creds,
      state, onRateLimit, onCooldown, onLog,
    });

    if (abort) return { totalTweets, stopped: true, reason };

    // Reset 429 counter on success.
    state.consecutive429s = 0;

    const { tweets, bottomCursor } = parseBookmarksPage(result.data);
    pageNum++;

    if (tweets.length > 0) {
      consecutiveEmpty = 0;
      await upsertBookmarks(tweets);
      totalTweets += tweets.length;
      onPage?.(tweets, pageNum, bottomCursor);
      onLog?.(`Page ${pageNum}: ${tweets.length} bookmarks (total: ${totalTweets})`, 'info');
    } else {
      consecutiveEmpty++;
      onLog?.(`Page ${pageNum}: empty page (${consecutiveEmpty}/${MAX_CONSECUTIVE_EMPTY})`, 'info');
    }

    if (shouldStopPaginating({ bottomCursor, currentCursor: cursor, consecutiveEmpty, onLog })) {
      break;
    }

    cursor = bottomCursor;
    await sleep(jitteredDelay());
  }

  return { totalTweets, stopped: false, reason: 'complete' };
}

/**
 * Fetch bookmarks belonging to a specific folder.
 *
 * Uses the same retry / rate-limit strategy as {@link fetchAllBookmarks}
 * but does not persist resume state (folders are small and re-fetched on
 * each export run).
 *
 * @param {object} opts
 * @param {string}   opts.queryId     - GraphQL query ID for "BookmarkFolderTimeline".
 * @param {string}   opts.folderId    - Folder / collection ID.
 * @param {object}   opts.creds       - Stored auth credentials.
 * @param {Function} [opts.onPage]    - Called after each page: (tweets, pageNum, cursor).
 * @param {Function} [opts.onRateLimit] - Callback on back-off.
 * @param {Function} [opts.onCooldown]  - Callback on cooldown.
 * @param {Function} [opts.onLog]       - Logger callback.
 * @param {Function} [opts.shouldStop]  - Returns `true` when user requests stop.
 * @param {Function} [opts.shouldPause] - Returns a Promise that blocks while paused.
 * @param {number}   [opts.count=50]  - Bookmarks per page.
 * @returns {Promise<{totalTweets: number, stopped: boolean, reason: string}>}
 */
export async function fetchFolderBookmarks({
  queryId,
  folderId,
  creds,
  onPage,
  onRateLimit,
  onCooldown,
  onLog,
  shouldStop,
  shouldPause,
  count = 50,
}) {
  let cursor = null;
  let pageNum = 0;
  let totalTweets = 0;
  let consecutiveEmpty = 0;
  const state = { consecutive429s: 0 };

  while (true) {
    if (shouldStop?.()) return { totalTweets, stopped: true, reason: 'user_stopped' };
    if (shouldPause) await shouldPause();

    const variables = {
      bookmark_collection_id: folderId,
      count,
      includePromotedContent: false,
    };
    if (cursor) variables.cursor = cursor;

    const { result, abort, reason } = await fetchWithRetry({
      queryId, operationName: 'BookmarkFolderTimeline', variables, creds,
      state, onRateLimit, onCooldown, onLog,
    });

    if (abort) return { totalTweets, stopped: true, reason };

    state.consecutive429s = 0;
    const { tweets, bottomCursor } = parseBookmarksPage(result.data);
    pageNum++;

    if (tweets.length > 0) {
      consecutiveEmpty = 0;
      totalTweets += tweets.length;
      onPage?.(tweets, pageNum, bottomCursor);
    } else {
      consecutiveEmpty++;
    }

    if (shouldStopPaginating({ bottomCursor, currentCursor: cursor, consecutiveEmpty })) {
      break;
    }

    cursor = bottomCursor;
    await sleep(jitteredDelay());
  }

  return { totalTweets, stopped: false, reason: 'complete' };
}
