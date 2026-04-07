/**
 * Bookmark folder enumeration and cross-referencing.
 *
 * Phase 1 of the export fetches the folder list via
 * `BookmarkFoldersSlice`.  Phase 2 iterates through each folder with
 * {@link fetchFolderContents}, recording which tweet IDs belong to
 * which folders.  These mappings are merged into the final JSON in
 * the exporter module.
 *
 * Folders are an X Premium feature — free accounts will return an
 * empty list, which is handled gracefully.
 */

import { graphqlRequest } from './api.js';
import { parseFolderList } from './parser.js';
import { upsertFolders, addFolderTweets } from './db.js';
import { fetchFolderBookmarks } from './fetcher.js';
import { BASE_DELAY_MS, sleep } from './utils.js';

/**
 * Fetch all bookmark folders for the logged-in user.
 *
 * Handles pagination (though folder lists are typically small) and
 * persists results into IndexedDB.
 *
 * @param {object} opts
 * @param {string}   opts.queryId - GraphQL query ID for "BookmarkFoldersSlice".
 * @param {object}   opts.creds   - Stored auth credentials.
 * @param {Function} [opts.onLog] - Logger callback (message, level).
 * @returns {Promise<Array<{id: string, name: string}>>} Folder list.
 */
export async function fetchAllFolders({ queryId, creds, onLog }) {
  if (!queryId) {
    onLog?.('No query ID for BookmarkFoldersSlice. Skipping folders.', 'warn');
    return [];
  }

  const allFolders = [];
  let cursor = null;

  while (true) {
    const variables = {};
    if (cursor) variables.cursor = cursor;

    const result = await graphqlRequest(queryId, 'BookmarkFoldersSlice', variables, creds);

    if (result.error) {
      if (result.error === 'auth_error') {
        onLog?.('Auth error fetching folders. Skipping folder support.', 'warn');
      } else {
        onLog?.(`Error fetching folders: ${result.error}. Skipping folder support.`, 'warn');
      }
      break;
    }

    const { folders, cursor: nextCursor } = parseFolderList(result.data);
    allFolders.push(...folders);

    if (!nextCursor) break;
    cursor = nextCursor;
    await sleep(BASE_DELAY_MS);
  }

  if (allFolders.length > 0) {
    await upsertFolders(allFolders);
    onLog?.(`Found ${allFolders.length} bookmark folder(s).`, 'success');
  } else {
    onLog?.('No bookmark folders found (X Premium feature).', 'info');
  }

  return allFolders;
}

/**
 * Fetch bookmarks for every folder and store tweet-to-folder mappings.
 *
 * Iterates sequentially (one folder at a time) to stay within rate
 * limits.  Respects the caller's stop/pause signals between folders.
 *
 * @param {object} opts
 * @param {Array}    opts.folders          - Folders from {@link fetchAllFolders}.
 * @param {string}   opts.queryId          - Query ID for "BookmarkFolderTimeline".
 * @param {object}   opts.creds            - Stored auth credentials.
 * @param {Function} [opts.onLog]          - Logger callback.
 * @param {Function} [opts.onFolderProgress] - (current, total, folderName).
 * @param {Function} [opts.shouldStop]     - Returns true when user requests stop.
 * @param {Function} [opts.shouldPause]    - Promise that blocks while paused.
 * @param {Function} [opts.onRateLimit]    - Callback on back-off.
 * @param {Function} [opts.onCooldown]     - Callback on cooldown.
 */
export async function fetchFolderContents({
  folders,
  queryId,
  creds,
  onLog,
  onFolderProgress,
  shouldStop,
  shouldPause,
  onRateLimit,
  onCooldown,
}) {
  if (!queryId) {
    onLog?.('No query ID for BookmarkFolderTimeline. Skipping folder contents.', 'warn');
    return;
  }

  for (let i = 0; i < folders.length; i++) {
    if (shouldStop?.()) break;

    const folder = folders[i];
    onLog?.(`Fetching folder "${folder.name}" (${i + 1}/${folders.length})...`, 'info');
    onFolderProgress?.(i + 1, folders.length, folder.name);

    const folderTweetEntries = [];

    const result = await fetchFolderBookmarks({
      queryId,
      folderId: folder.id,
      creds,
      onPage: (tweets) => {
        for (const tweet of tweets) {
          folderTweetEntries.push({
            tweet_id: tweet.tweet_id,
            folder_id: folder.id,
          });
        }
      },
      onRateLimit,
      onCooldown,
      onLog,
      shouldStop,
      shouldPause,
    });

    // Persist whatever we collected before checking for early exit.
    if (folderTweetEntries.length > 0) {
      await addFolderTweets(folderTweetEntries);
      onLog?.(`Folder "${folder.name}": ${folderTweetEntries.length} bookmarks.`, 'info');
    } else {
      onLog?.(`Folder "${folder.name}": empty.`, 'info');
    }

    // Break immediately if the folder fetch was stopped mid-flight,
    // rather than sleeping and waiting for the next loop iteration.
    if (result.stopped) break;

    // Rate-limit delay between folders (skip after the last one).
    if (i < folders.length - 1) {
      await sleep(BASE_DELAY_MS);
    }
  }
}
