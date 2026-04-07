/**
 * IndexedDB storage layer via Dexie.
 *
 * All persistent data lives here:
 *   - **bookmarks** — one row per bookmarked tweet, keyed by `tweet_id`.
 *   - **folders** — bookmark folder metadata (X Premium feature).
 *   - **folder_tweets** — many-to-many mapping of tweets to folders.
 *   - **export_state** — cursor / page state for resume capability.
 *
 * The schema uses Dexie's declarative index syntax.  The compound index
 * `[tweet_id+folder_id]` on `folder_tweets` enables fast deduplication
 * without loading the entire table into memory.
 */

import Dexie from '../vendor/dexie.mjs';

const db = new Dexie('xarchive');

db.version(1).stores({
  bookmarks: 'tweet_id, sort_index, status, created_at',
  folders: 'id, name',
  folder_tweets: '++id, tweet_id, folder_id, [tweet_id+folder_id]',
  export_state: 'key',
});

// ---------------------------------------------------------------------------
// Bookmark operations
// ---------------------------------------------------------------------------

/**
 * Bulk-upsert an array of bookmarks.
 * @param {object[]} bookmarks
 */
export async function upsertBookmarks(bookmarks) {
  await db.bookmarks.bulkPut(bookmarks);
}

/** @returns {Promise<object[]>} All stored bookmarks. */
export async function getAllBookmarks() {
  return db.bookmarks.toArray();
}

/** @returns {Promise<number>} Total bookmark count. */
export async function getBookmarkCount() {
  return db.bookmarks.count();
}

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------

/**
 * Bulk-upsert an array of folders.
 * @param {Array<{id: string, name: string}>} folders
 */
export async function upsertFolders(folders) {
  await db.folders.bulkPut(folders);
}

/** @returns {Promise<Array<{id: string, name: string}>>} All folders. */
export async function getAllFolders() {
  return db.folders.toArray();
}

// ---------------------------------------------------------------------------
// Folder-tweet mapping
// ---------------------------------------------------------------------------

/**
 * Batch-add folder-tweet mappings.
 *
 * The `folder_tweets` table is cleared at the start of each export
 * (via {@link clearFolderData}), so within a single run each
 * `[tweet_id, folder_id]` pair is unique and no deduplication is needed.
 *
 * @param {Array<{tweet_id: string, folder_id: string}>} entries
 */
export async function addFolderTweets(entries) {
  if (entries.length > 0) {
    await db.folder_tweets.bulkAdd(entries);
  }
}

/**
 * Build a lookup map from tweet ID to an array of folder IDs.
 *
 * Used once during export assembly to merge folder assignments into
 * the final JSON without per-bookmark queries.
 *
 * @returns {Promise<Map<string, string[]>>}
 */
export async function buildFolderMap() {
  const allEntries = await db.folder_tweets.toArray();
  const map = new Map();
  for (const entry of allEntries) {
    if (!map.has(entry.tweet_id)) {
      map.set(entry.tweet_id, []);
    }
    map.get(entry.tweet_id).push(entry.folder_id);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Export state (for resume)
// ---------------------------------------------------------------------------

/**
 * Persist a key-value pair for export resume state.
 * @param {string} key
 * @param {*} value
 */
export async function saveExportState(key, value) {
  await db.export_state.put({ key, value, updated_at: Date.now() });
}

/**
 * Read a previously persisted export state value.
 * @param {string} key
 * @returns {Promise<*|null>}
 */
export async function getExportState(key) {
  const record = await db.export_state.get(key);
  return record ? record.value : null;
}

/** Clear all export resume state. */
export async function clearExportState() {
  await db.export_state.clear();
}

// ---------------------------------------------------------------------------
// Folder reset
// ---------------------------------------------------------------------------

/**
 * Clear all folder-related data (folder list + tweet-to-folder mappings).
 *
 * Must be called before each export's Phase 1/2 so that stale mappings
 * from a previous run (e.g. tweets removed from folders, deleted folders)
 * don't bleed into the new export.
 */
export async function clearFolderData() {
  await Promise.all([
    db.folders.clear(),
    db.folder_tweets.clear(),
  ]);
}

// ---------------------------------------------------------------------------
// Full reset
// ---------------------------------------------------------------------------

/** Delete all data from every table (bookmarks, folders, mappings, state). */
export async function clearAllData() {
  await Promise.all([
    db.bookmarks.clear(),
    db.folders.clear(),
    db.folder_tweets.clear(),
    db.export_state.clear(),
  ]);
}

