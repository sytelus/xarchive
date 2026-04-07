/**
 * xarchive content script — ISOLATED world.
 *
 * Runs on x.com / twitter.com pages to extract the logged-in user's
 * identity and store it in chrome.storage.local for the options page.
 *
 * Two pieces of data are captured:
 *   1. **User ID** (numeric) — from the `twid` cookie at document_start.
 *   2. **Screen name** (@handle) — from the page DOM after load, by
 *      finding the profile link in X.com's navigation sidebar.
 *
 * No MAIN world injection is needed — both are readable from the
 * isolated world.
 */

// --- User ID (from cookie, available immediately) ---
(function () {
  const match = document.cookie.match(/twid=u%3D(\d+)/);
  if (match) {
    chrome.storage.local.set({ xarchive_user_id: match[1] });
  }
})();

// --- Screen name (from DOM, after page renders) ---
// X.com's SPA renders a navigation link to the user's profile in the
// sidebar.  We poll briefly after load since React hydration may delay
// the element's appearance.
function captureScreenName() {
  // The nav sidebar contains a link like href="/username" with a
  // data-testid of "AppTabBar_Profile_Link".
  const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  if (profileLink) {
    const href = profileLink.getAttribute('href'); // e.g. "/elonmusk"
    if (href && href.startsWith('/')) {
      const screenName = href.slice(1).split('/')[0]; // strip leading /
      if (screenName && !screenName.includes('?')) {
        chrome.storage.local.set({ xarchive_screen_name: screenName });
        return true;
      }
    }
  }
  return false;
}

// Poll a few times after DOM is ready, since React hydration may not
// have rendered the sidebar yet when the content script runs.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => tryCapture());
} else {
  tryCapture();
}

function tryCapture() {
  if (captureScreenName()) return;
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    if (captureScreenName() || attempts >= 10) {
      clearInterval(interval);
    }
  }, 1000);
}
