/**
 * JSON assembly and download.
 *
 * {@link assembleExport} reads all bookmarks and folders from IndexedDB,
 * merges in folder assignments, and returns the final JSON structure.
 * {@link downloadJSON} triggers the browser download.
 */

import { getAllBookmarks, getAllFolders, buildFolderMap } from './db.js';

/**
 * Build the final export payload from IndexedDB.
 *
 * Merges folder assignments into each bookmark's `folders` array and
 * computes summary statistics for the metadata header.
 *
 * @param {object} opts
 * @param {string} opts.userId    - Logged-in user's numeric ID.
 * @param {number} opts.startTime - Epoch ms when the export started.
 * @returns {Promise<object>} Complete JSON-serialisable export object.
 */
export async function assembleExport({ userId, startTime }) {
  const bookmarks = await getAllBookmarks();
  const folders = await getAllFolders();
  const folderMap = await buildFolderMap();

  // Merge folder IDs into each bookmark.
  for (const bm of bookmarks) {
    const folderIds = folderMap.get(bm.tweet_id);
    if (folderIds && folderIds.length > 0) {
      bm.folders = folderIds;
    }
  }

  const availableCount = bookmarks.filter((b) => b.status === 'available').length;
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  return {
    export_metadata: {
      tool: 'xarchive',
      version: '1.0.0',
      exported_at: new Date().toISOString(),
      user_id: userId || 'unknown',
      stats: {
        total_bookmarks: bookmarks.length,
        available_bookmarks: availableCount,
        unavailable_bookmarks: bookmarks.length - availableCount,
        total_folders: folders.length,
        export_duration_seconds: durationSeconds,
      },
    },
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    bookmarks,
  };
}

/**
 * Trigger a browser download of the export JSON.
 *
 * Uses `chrome.downloads` (preferred in MV3) with a fallback to a
 * programmatic `<a>` click for environments where the API is unavailable.
 *
 * @param {object} data   - The export payload from {@link assembleExport}.
 * @param {string} userId - Used in the filename.
 * @returns {string} The generated filename.
 */
export function downloadJSON(data, userId) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().split('T')[0];
  const filename = `xarchive_${userId || 'bookmarks'}_${date}.json`;

  if (chrome.downloads) {
    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return filename;
}
