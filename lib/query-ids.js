/**
 * Query ID management — discovery, caching, and fallback scraping.
 *
 * X.com's GraphQL endpoints use rotating query IDs (change every 2–4
 * weeks).  Three discovery mechanisms, tried in order:
 *
 *   1. **Passive capture** — the service worker's `webRequest.onSendHeaders`
 *      listener records IDs from the user's normal X.com browsing.
 *   2. **Background tab** ({@link captureQueryIdsViaTab}) — opens
 *      `x.com/i/bookmarks` in a hidden tab so the webRequest listener
 *      can capture IDs from real API calls.  This reliably finds
 *      `Bookmarks` and `BookmarkFoldersSlice` but NOT
 *      `BookmarkFolderTimeline` (which only fires when the user opens
 *      a specific folder).
 *   3. **JS bundle scraping** ({@link scrapeQueryIdsFromBundles}) —
 *      fetches X.com's compiled JS bundles and regex-extracts all
 *      operation IDs from source code, including `BookmarkFolderTimeline`.
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
 * Regex patterns for extracting queryId/operationName pairs from
 * minified JS bundles.
 *
 * X.com's webpack bundles define GraphQL operations as object literals.
 * The minifier may output keys with or without quotes, with varying
 * whitespace, and in either order.  We try multiple patterns to be
 * resilient against minifier changes.
 *
 * Each pattern captures (queryId, operationName) or
 * (operationName, queryId) depending on order.
 */
const SCRAPE_PATTERNS = [
  // queryId:"..." ... operationName:"..." (unquoted keys)
  /queryId:\s*"([A-Za-z0-9_-]+)"[^}]{0,500}operationName:\s*"([^"]+)"/g,
  // operationName:"..." ... queryId:"..." (reversed, unquoted keys)
  /operationName:\s*"([^"]+)"[^}]{0,500}queryId:\s*"([A-Za-z0-9_-]+)"/g,
  // "queryId":"..." ... "operationName":"..." (quoted keys — common in minified code)
  /"queryId"\s*:\s*"([A-Za-z0-9_-]+)"[^}]{0,500}"operationName"\s*:\s*"([^"]+)"/g,
  // "operationName":"..." ... "queryId":"..." (quoted, reversed)
  /"operationName"\s*:\s*"([^"]+)"[^}]{0,500}"queryId"\s*:\s*"([A-Za-z0-9_-]+)"/g,
];

/**
 * Extract query IDs from a JS bundle's source text using the
 * structured regex patterns.
 *
 * @param {string} js       - Bundle source code.
 * @param {Object<string, string>} queryIds - Accumulator (mutated in place).
 * @param {Function} [onLog] - Logger callback.
 */
function extractIdsFromBundle(js, queryIds, onLog) {
  for (let i = 0; i < SCRAPE_PATTERNS.length; i++) {
    const pattern = SCRAPE_PATTERNS[i];
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(js)) !== null) {
      let qid, opName;
      if (/^[A-Z]/.test(match[1])) {
        [, opName, qid] = match;
      } else {
        [, qid, opName] = match;
      }
      if (REQUIRED_OPERATIONS.includes(opName)) {
        onLog?.(`Pattern ${i + 1} matched: ${opName} → ${qid}`, 'success');
        queryIds[opName] = qid;
      }
    }
  }
}

/**
 * For each missing operation, search the bundle for the operation name
 * string and log the surrounding context.  If found, attempt a
 * permissive nearby extraction as a fallback.
 *
 * @param {string} js - Bundle source code.
 * @param {Object<string, string>} queryIds - Accumulator (mutated in place).
 * @param {string} bundleLabel - Short label for log messages.
 * @param {Function} [onLog]
 */
function diagnosticSearch(js, queryIds, bundleLabel, onLog) {
  const missing = REQUIRED_OPERATIONS.filter((op) => !queryIds[op]);
  for (const op of missing) {
    const idx = js.indexOf(`"${op}"`);
    if (idx === -1) continue;

    // Log 120 chars before and 120 chars after for debugging.
    const start = Math.max(0, idx - 120);
    const end = Math.min(js.length, idx + op.length + 122);
    const context = js.slice(start, end).replace(/\n/g, ' ');
    onLog?.(`[${bundleLabel}] Found "${op}" at offset ${idx}. Context: ...${context}...`, 'info');

    // Permissive fallback: look for a query-ID-shaped string within
    // 300 chars before or after the operation name.
    const regionStart = Math.max(0, idx - 300);
    const regionEnd = Math.min(js.length, idx + op.length + 300);
    const region = js.slice(regionStart, regionEnd);

    // Match strings that look like query IDs: 15+ alphanumeric/dash/underscore
    // chars, excluding the operation name itself.
    const candidates = [...region.matchAll(/"([A-Za-z0-9_-]{15,})"/g)]
      .map((m) => m[1])
      .filter((s) => s !== op && !/^[a-z_]+$/.test(s));

    if (candidates.length > 0) {
      onLog?.(`[${bundleLabel}] Nearby ID candidates for "${op}": ${candidates.join(', ')}`, 'info');
      // Use the first candidate that looks like a query ID (contains
      // mixed case or has the typical X.com ID shape).
      queryIds[op] = candidates[0];
      onLog?.(`Extracted ${op} → ${candidates[0]} (nearby-match fallback)`, 'success');
    } else {
      onLog?.(`[${bundleLabel}] "${op}" found in bundle but no query ID candidate nearby.`, 'warn');
    }
  }
}

/**
 * Extract query IDs from the JS bundles found in an HTML page.
 *
 * Scanning strategy:
 *   1. Fetch all JS URLs from the page HTML.
 *   2. Prioritise "client-web" / "responsive-web" bundles.
 *   3. For each bundle, try structured regex extraction, then
 *      a diagnostic nearby-search fallback.
 *   4. If still missing, scan non-client-web bundles.
 *
 * @param {string} html       - Page HTML containing `<script>` bundle URLs.
 * @param {Object<string, string>} queryIds - Accumulator (mutated in place).
 * @param {number} maxBundles  - Max bundles to fetch per tier.
 * @param {Function} [onLog]   - Logger callback.
 * @returns {Promise<void>}
 */
async function scrapeIdsFromPage(html, queryIds, maxBundles, onLog) {
  // Collect all JS URLs from the page.
  const bundlePattern = /https:\/\/[^"'\s]+\.js(?=["'\s])/g;
  const allJsUrls = [...new Set(html.match(bundlePattern) || [])];

  // Tier 1: likely client bundles.
  const clientBundles = allJsUrls.filter((u) =>
    u.includes('client-web') || u.includes('responsive-web')
  );
  // Tier 2: everything else.
  const otherBundles = allJsUrls.filter((u) => !clientBundles.includes(u));

  onLog?.(`JS URLs: ${clientBundles.length} client bundles, ${otherBundles.length} other.`, 'info');

  // Scan a tier of bundles.
  async function scanTier(urls, label) {
    for (const url of urls.slice(0, maxBundles)) {
      const shortUrl = url.split('/').pop();
      try {
        const resp = await fetch(url);
        const js = await resp.text();
        onLog?.(`Scanning ${label}: ${shortUrl} (${(js.length / 1024).toFixed(0)} KB)`, 'info');

        // Standard structured extraction.
        extractIdsFromBundle(js, queryIds, onLog);

        // Diagnostic + fallback for any still-missing operations.
        diagnosticSearch(js, queryIds, shortUrl, onLog);

        if (REQUIRED_OPERATIONS.every((op) => queryIds[op])) {
          onLog?.('All query IDs found.', 'success');
          return true;
        }
      } catch (err) {
        onLog?.(`Failed to fetch ${shortUrl}: ${err.message || err}`, 'warn');
      }
    }
    return false;
  }

  // Tier 1: client bundles.
  if (await scanTier(clientBundles, 'client bundle')) return;

  // Tier 2: other JS files (only if still missing operations).
  const remaining = REQUIRED_OPERATIONS.filter((op) => !queryIds[op]);
  if (remaining.length > 0) {
    onLog?.(`Still missing: ${remaining.join(', ')}. Scanning other JS files...`, 'info');
    if (await scanTier(otherBundles, 'other JS')) return;
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
 * @param {Function} [onLog] - Logger callback.
 * @returns {Promise<Object<string, string>|null>} Map of operation
 *   name to query ID, or null if none were found.
 */
export async function scrapeQueryIdsFromBundles(onLog) {
  try {
    const queryIds = {};
    const fetchOpts = {
      credentials: 'include',
      headers: { 'User-Agent': navigator.userAgent },
    };

    // Pass 1: homepage bundles (usually finds Bookmarks).
    onLog?.('Fetching x.com homepage to find JS bundles...', 'info');
    const homeHtml = await (await fetch('https://x.com', fetchOpts)).text();
    await scrapeIdsFromPage(homeHtml, queryIds, 15, onLog);

    // Pass 2: bookmarks page bundles if folder IDs still missing.
    if (!queryIds.BookmarkFoldersSlice || !queryIds.BookmarkFolderTimeline) {
      try {
        onLog?.('Folder IDs not in homepage bundles. Trying bookmarks page...', 'info');
        const bmHtml = await (await fetch('https://x.com/i/bookmarks', fetchOpts)).text();
        await scrapeIdsFromPage(bmHtml, queryIds, 15, onLog);
      } catch {
        // Non-fatal — folder support degrades gracefully.
      }
    }

    const found = Object.keys(queryIds);
    if (found.length > 0) {
      onLog?.(`Bundle scraping found: ${found.join(', ')}`, 'success');
    } else {
      onLog?.('Bundle scraping found no query IDs.', 'warn');
    }
    return found.length > 0 ? queryIds : null;
  } catch (err) {
    onLog?.(`Bundle scraping failed: ${err.message || err}`, 'warn');
    return null;
  }
}

/**
 * Open X.com's bookmarks page in a hidden background tab so the
 * service worker's webRequest listener can capture live query IDs
 * and auth headers from the real API calls X.com makes on load.
 *
 * More reliable than bundle scraping because it captures the actual
 * IDs the server is using right now.  The tab is closed automatically
 * once the IDs are captured or after a timeout.
 *
 * @param {string|null} userId - Used to read back stored credentials.
 * @param {Function}    [onLog] - Logger callback.
 * @returns {Promise<Object<string, string>|null>} Discovered query IDs,
 *   or null if the tab approach failed.
 */
export async function captureQueryIdsViaTab(userId, onLog) {
  let tabId = null;
  try {
    onLog?.('Opening x.com/i/bookmarks in background to capture query IDs...', 'info');
    const tab = await chrome.tabs.create({
      url: 'https://x.com/i/bookmarks',
      active: false,
    });
    tabId = tab.id;

    // Poll storage until the webRequest listener captures the IDs.
    const storageKey = `xarchive_creds_${userId || 'unknown'}`;
    const deadline = Date.now() + 15_000; // 15 s timeout

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const result = await chrome.storage.local.get(storageKey);
      const creds = result[storageKey];
      const ids = getStoredQueryIds(creds);
      if (ids.Bookmarks) {
        onLog?.(`Captured query IDs: ${Object.keys(ids).join(', ')}`, 'success');
        return ids;
      }
    }

    onLog?.('Timed out waiting for query IDs from background tab.', 'warn');
    return null;
  } catch (err) {
    onLog?.(`Background tab failed: ${err.message || err}`, 'warn');
    return null;
  } finally {
    if (tabId != null) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

/**
 * Open a specific bookmark folder in a background tab to capture
 * the `BookmarkFolderTimeline` query ID.
 *
 * The main bookmarks page (used by {@link captureQueryIdsViaTab})
 * triggers `Bookmarks` and `BookmarkFoldersSlice` but NOT
 * `BookmarkFolderTimeline` — that only fires when viewing a folder.
 *
 * Tries multiple URL formats since X.com's routing may vary:
 *   - `/i/bookmarks/folder/<id>` (path-based)
 *   - `/i/bookmarks/<id>` (short path)
 *
 * @param {string}      folderId - A folder ID from Phase 1.
 * @param {string|null} userId   - For reading back stored credentials.
 * @param {Function}    [onLog]
 * @returns {Promise<string|null>} The captured query ID, or null.
 */
export async function captureFolderQueryIdViaTab(folderId, userId, onLog) {
  const storageKey = `xarchive_creds_${userId || 'unknown'}`;

  // Try multiple URL formats — X.com's SPA routing is undocumented.
  const urlCandidates = [
    `https://x.com/i/bookmarks/folder/${folderId}`,
    `https://x.com/i/bookmarks/${folderId}`,
  ];

  for (const folderUrl of urlCandidates) {
    let tabId = null;
    try {
      onLog?.(`Trying folder URL: ${folderUrl}`, 'info');
      const tab = await chrome.tabs.create({ url: folderUrl, active: false });
      tabId = tab.id;

      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const result = await chrome.storage.local.get(storageKey);
        const creds = result[storageKey];
        if (creds?.[`queryId_BookmarkFolderTimeline`]) {
          const qid = creds[`queryId_BookmarkFolderTimeline`];
          onLog?.(`Captured BookmarkFolderTimeline → ${qid}`, 'success');
          return qid;
        }
      }
      onLog?.(`No BookmarkFolderTimeline captured from ${folderUrl.split('/').pop()}`, 'info');
    } catch (err) {
      onLog?.(`Tab failed for ${folderUrl}: ${err.message || err}`, 'warn');
    } finally {
      if (tabId != null) {
        chrome.tabs.remove(tabId).catch(() => {});
      }
    }
  }

  onLog?.('Could not capture BookmarkFolderTimeline from any folder URL format.', 'warn');
  return null;
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
