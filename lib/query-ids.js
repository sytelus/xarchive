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
 * Extract query IDs from a JS bundle's source text.
 *
 * @param {string} js       - Bundle source code.
 * @param {Object<string, string>} queryIds - Accumulator (mutated in place).
 */
function extractIdsFromBundle(js, queryIds) {
  for (const pattern of SCRAPE_PATTERNS) {
    // Reset lastIndex since we reuse the regex across bundles.
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(js)) !== null) {
      // Patterns alternate between (qid, opName) and (opName, qid)
      // depending on which key comes first.  Detect by checking which
      // capture looks like an operation name (starts with uppercase).
      let qid, opName;
      if (/^[A-Z]/.test(match[1])) {
        [, opName, qid] = match;
      } else {
        [, qid, opName] = match;
      }
      if (REQUIRED_OPERATIONS.includes(opName)) {
        queryIds[opName] = qid;
      }
    }
  }
}

/**
 * Extract query IDs from the JS bundles found in an HTML page.
 *
 * @param {string} html       - Page HTML containing `<script>` bundle URLs.
 * @param {Object<string, string>} queryIds - Accumulator (mutated in place).
 * @param {number} maxBundles  - Max bundles to fetch from this page.
 * @param {Function} [onLog]   - Logger callback.
 * @returns {Promise<void>}
 */
async function scrapeIdsFromPage(html, queryIds, maxBundles, onLog) {
  // Match any JS bundle URL from X.com's CDN.  The path typically contains
  // "client-web" but we cast a wider net to catch variations.
  const bundlePattern = /https:\/\/[^"'\s]+\.js(?=["'\s])/g;
  const allJsUrls = [...new Set(html.match(bundlePattern) || [])];
  // Filter to likely client bundles (contain "client-web" or "responsive-web").
  const bundleUrls = allJsUrls.filter((u) =>
    u.includes('client-web') || u.includes('responsive-web')
  );

  onLog?.(`Found ${bundleUrls.length} client bundle(s) to scan (${allJsUrls.length} total JS URLs).`, 'info');

  for (const url of bundleUrls.slice(0, maxBundles)) {
    try {
      const resp = await fetch(url);
      const js = await resp.text();

      // Diagnostic: check if any of our target operation names exist in this
      // bundle at all, even if the regex patterns don't match the surrounding
      // structure.  This helps debug pattern mismatches.
      const missing = REQUIRED_OPERATIONS.filter((op) => !queryIds[op]);
      for (const op of missing) {
        if (js.includes(`"${op}"`)) {
          onLog?.(`Bundle contains "${op}" — attempting extraction...`, 'info');
          // Try to extract the queryId near this operation name with a
          // very permissive pattern: find "OperationName" then search
          // nearby for anything that looks like a query ID.
          const escapedOp = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const nearby = new RegExp(`"${escapedOp}"[\\s\\S]{0,200}`, 'g');
          const ctx = nearby.exec(js);
          if (ctx) {
            // Look for a query-ID-shaped string (alphanumeric, 15+ chars)
            // near the operation name.
            const qidMatch = ctx[0].match(/"([A-Za-z0-9_-]{15,})"/);
            if (qidMatch && qidMatch[1] !== op) {
              onLog?.(`Extracted ${op} → ${qidMatch[1]} (nearby-match fallback)`, 'success');
              queryIds[op] = qidMatch[1];
            }
          }
        }
      }

      // Standard extraction with structured patterns.
      extractIdsFromBundle(js, queryIds);

      if (REQUIRED_OPERATIONS.every((op) => queryIds[op])) {
        onLog?.('All query IDs found.', 'success');
        return;
      }
    } catch {
      // Individual bundle fetch failures are non-fatal.
    }
  }

  // If we still haven't found everything, try ALL JS URLs (not just
  // client-web bundles) — X.com may have moved definitions to a
  // differently-named chunk.
  const remaining = REQUIRED_OPERATIONS.filter((op) => !queryIds[op]);
  if (remaining.length > 0) {
    const otherUrls = allJsUrls.filter((u) => !bundleUrls.includes(u));
    onLog?.(`Still missing ${remaining.join(', ')}. Scanning ${Math.min(otherUrls.length, 10)} other JS files...`, 'info');
    for (const url of otherUrls.slice(0, 10)) {
      try {
        const resp = await fetch(url);
        const js = await resp.text();
        // Only bother if the bundle mentions one of our operations.
        if (remaining.some((op) => js.includes(`"${op}"`))) {
          extractIdsFromBundle(js, queryIds);
        }
      } catch {
        // Non-fatal.
      }
      if (REQUIRED_OPERATIONS.every((op) => queryIds[op])) {
        onLog?.('All query IDs found.', 'success');
        return;
      }
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
