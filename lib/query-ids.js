/**
 * Query ID management with fallback JS bundle scraping.
 *
 * X.com's GraphQL endpoints use rotating query IDs (change every 2–4
 * weeks).  The primary capture mechanism is the service worker's
 * `webRequest.onSendHeaders` listener — it passively records IDs from
 * the user's normal browsing.
 *
 * When IDs haven't been captured yet, {@link scrapeQueryIdsFromBundles}
 * fetches X.com's homepage, locates the JS client bundles, and
 * extracts IDs using regex patterns.  This is a resilient fallback
 * that avoids the need for any hardcoded values.
 */

/** GraphQL operations we need query IDs for. */
const REQUIRED_OPERATIONS = ['Bookmarks', 'BookmarkFoldersSlice', 'BookmarkFolderTimeline'];

/**
 * Extract any stored query IDs from the credentials object.
 *
 * The service worker stores them as `queryId_<OperationName>` keys.
 *
 * @param {object|null} creds - Credentials from `chrome.storage.local`.
 * @returns {Object<string, string>} Map of operation name to query ID.
 */
export function getStoredQueryIds(creds) {
  if (!creds) return {};
  const ids = {};
  for (const op of REQUIRED_OPERATIONS) {
    if (creds[`queryId_${op}`]) {
      ids[op] = creds[`queryId_${op}`];
    }
  }
  return ids;
}

/**
 * Check whether we have the minimum query IDs needed to start an export.
 *
 * Only `Bookmarks` is required.  `BookmarkFoldersSlice` and
 * `BookmarkFolderTimeline` are optional (folder support degrades
 * gracefully without them).
 *
 * @param {Object<string, string>} queryIds
 * @returns {boolean}
 */
export function hasRequiredQueryIds(queryIds) {
  return !!queryIds.Bookmarks;
}

/**
 * Extract query IDs from the JS bundles found in an HTML page.
 *
 * @param {string} html - Page HTML containing `<script>` bundle URLs.
 * @param {Object<string, string>} queryIds - Accumulator (mutated in place).
 * @param {number} maxBundles - Max bundles to fetch from this page.
 * @returns {Promise<void>}
 */
async function scrapeIdsFromPage(html, queryIds, maxBundles) {
  const bundlePattern = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s]+\.js/g;
  const bundleUrls = [...new Set(html.match(bundlePattern) || [])];

  for (const url of bundleUrls.slice(0, maxBundles)) {
    try {
      const resp = await fetch(url);
      const js = await resp.text();

      // Pattern A: queryId appears before operationName.
      const patternA = /queryId:\s*"([A-Za-z0-9_-]+)"[^}]{0,300}operationName:\s*"([^"]+)"/g;
      let match;
      while ((match = patternA.exec(js)) !== null) {
        const [, qid, opName] = match;
        if (REQUIRED_OPERATIONS.includes(opName)) queryIds[opName] = qid;
      }

      // Pattern B: operationName appears before queryId.
      const patternB = /operationName:\s*"([^"]+)"[^}]{0,300}queryId:\s*"([A-Za-z0-9_-]+)"/g;
      while ((match = patternB.exec(js)) !== null) {
        const [, opName, qid] = match;
        if (REQUIRED_OPERATIONS.includes(opName)) queryIds[opName] = qid;
      }

      if (REQUIRED_OPERATIONS.every((op) => queryIds[op])) return;
    } catch {
      // Individual bundle fetch failures are non-fatal.
    }
  }
}

/**
 * Scrape query IDs from X.com's JS client bundles.
 *
 * First tries the homepage bundles.  If folder-related IDs are still
 * missing, also fetches the bookmarks page — its lazily-loaded chunks
 * typically contain `BookmarkFoldersSlice` and `BookmarkFolderTimeline`
 * which aren't in the homepage bundles.
 *
 * @returns {Promise<Object<string, string>|null>} Map of operation
 *   name to query ID, or null if none were found.
 */
export async function scrapeQueryIdsFromBundles() {
  try {
    const queryIds = {};
    const fetchOpts = {
      credentials: 'include',
      headers: { 'User-Agent': navigator.userAgent },
    };

    // Pass 1: homepage bundles (usually finds Bookmarks).
    const homeHtml = await (await fetch('https://x.com', fetchOpts)).text();
    await scrapeIdsFromPage(homeHtml, queryIds, 10);

    // Pass 2: bookmarks page bundles if folder IDs still missing.
    // The folder operations are often in lazily-loaded chunks that
    // only appear when the bookmarks page is loaded.
    if (!queryIds.BookmarkFoldersSlice || !queryIds.BookmarkFolderTimeline) {
      try {
        const bmHtml = await (await fetch('https://x.com/i/bookmarks', fetchOpts)).text();
        await scrapeIdsFromPage(bmHtml, queryIds, 10);
      } catch {
        // Non-fatal — folder support degrades gracefully.
      }
    }

    return Object.keys(queryIds).length > 0 ? queryIds : null;
  } catch {
    return null;
  }
}

/**
 * Persist discovered query IDs into `chrome.storage.local`, merging
 * them with any existing credentials for the given user.
 *
 * @param {string|null} userId
 * @param {Object<string, string>} queryIds - Operation name to ID map.
 * @returns {Promise<void>}
 */
export async function storeQueryIds(userId, queryIds) {
  const storageKey = `xarchive_creds_${userId || 'unknown'}`;
  return new Promise((resolve) => {
    chrome.storage.local.get(storageKey, (existing) => {
      const merged = { ...(existing[storageKey] || {}) };
      for (const [op, qid] of Object.entries(queryIds)) {
        merged[`queryId_${op}`] = qid;
      }
      chrome.storage.local.set({ [storageKey]: merged }, resolve);
    });
  });
}
