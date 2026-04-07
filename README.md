# xarchive

A Chrome browser extension (Manifest V3) that exports all bookmarks from X.com for a logged-in user, including bookmark folder assignments, and saves them as a complete JSON file.

## Why

- X.com has no native bookmark export feature. The official data archive excludes bookmarks entirely.
- The official API v2 caps at 800 bookmarks with no folder support.
- xarchive uses X.com's internal GraphQL API to export your complete bookmark collection with no limit.

## Features

- Exports all bookmarks (no 800-bookmark cap)
- Includes bookmark folder assignments (X Premium feature)
- Rich data per bookmark: full text, author info, media URLs, engagement metrics, quoted tweets, entities
- Handles long-form tweets (note tweets), deleted tweets, and visibility-restricted tweets
- Resumable exports with persistent progress tracking
- Conservative rate limiting to protect your account
- JSON output format

## Installation

xarchive is not on the Chrome Web Store. Install it as an unpacked extension:

1. **Download the source** -- clone this repository or download and extract the ZIP:
   ```
   git clone https://github.com/sytelus/xarchive.git
   ```
2. **Open Chrome's extension page** -- navigate to `chrome://extensions/`
3. **Enable Developer mode** -- toggle the switch in the top-right corner
4. **Load the extension** -- click "Load unpacked" and select the `xarchive` folder (the one containing `manifest.json`)
5. **Pin it (optional)** -- click the puzzle-piece icon in Chrome's toolbar and pin xarchive for easy access

The extension icon should now appear in your toolbar.

## Usage

1. **Browse X.com while logged in** -- the extension passively captures authentication credentials from your session in the background. Visit your Bookmarks page at least once so the extension can capture the required API query IDs.
2. **Open the export page** -- click the xarchive extension icon. A new tab opens showing the status dashboard.
3. **Check status indicators** -- all three dots (credentials, query IDs, user session) should be green. If any are yellow or red, follow the on-screen hints.
4. **Start the export** -- click "Start Export". The extension fetches your bookmarks via paginated API calls with built-in rate limiting. Progress is shown in real time.
5. **Download the JSON** -- when the export completes, click "Download JSON" to save the file.

### Tips

- **Large collections**: Exports are resumable. If you close the tab or the export is interrupted, reopen the extension and you'll be prompted to resume from where you left off.
- **Rate limiting**: The extension uses conservative delays (2.5s+ between requests) to protect your account. If X.com throttles requests, the extension backs off automatically and resumes after a cooldown.
- **Folders**: If you have X Premium, bookmark folder assignments are included automatically.
- **Re-downloading**: After a completed export, you can close and reopen the extension tab -- the download button remains available until you clear the stored data.

## Project Status

See [PLAN.md](PLAN.md) for the implementation plan and [FINDINGS.md](FINDINGS.md) for research findings.

## License

MIT
