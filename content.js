/**
 * xarchive content script — ISOLATED world.
 *
 * Runs at document_start on x.com / twitter.com pages.  Reads the
 * `twid` cookie to extract the logged-in user's numeric ID and
 * stores it in chrome.storage.local so the options page and service
 * worker can namespace credentials per-user.
 *
 * No MAIN world injection is needed — the twid cookie is readable
 * from the isolated world via document.cookie.
 */
(function () {
  const match = document.cookie.match(/twid=u%3D(\d+)/);
  if (match) {
    chrome.storage.local.set({ xarchive_user_id: match[1] });
  }
})();
