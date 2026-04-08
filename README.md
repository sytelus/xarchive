<p align="center">
  <img src="icons/icon128.png" alt="xarchive icon" width="80" />
</p>

<h1 align="center">xarchive</h1>

<p align="center">
  <strong>Export your entire X.com (Twitter) bookmark collection -- no limits, with folders.</strong>
</p>

<p align="center">
  <a href="https://github.com/sytelus/xarchive/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sytelus/xarchive" alt="MIT License" /></a>
  <a href="https://github.com/sytelus/xarchive/releases"><img src="https://img.shields.io/github/v/release/sytelus/xarchive?include_prereleases&label=version" alt="Version" /></a>
  <img src="https://img.shields.io/badge/chrome-MV3-brightgreen" alt="Chrome MV3" />
  <img src="https://img.shields.io/badge/build-zero--dependency-blue" alt="Zero dependency" />
</p>

---

X.com has no bookmark export. The official data archive excludes bookmarks entirely, and the API v2 caps at 800 with no folder support. **xarchive** is a Chrome extension that uses X.com's internal GraphQL API to export your complete bookmark collection -- every bookmark, every folder, unlimited.

## Features

- **Unlimited export** -- no 800-bookmark cap
- **Folder assignments** -- includes X Premium bookmark folders
- **Rich data** -- full text, author info, media URLs, engagement metrics, quoted tweets, entities
- **Robust** -- handles long-form tweets, deleted tweets, and visibility-restricted tweets
- **Pause / resume** -- stop mid-run and download what you have so far
- **Account-safe** -- conservative rate limiting (2.5s+ delays) with automatic backoff
- **Built-in viewer** -- browse your exported bookmarks in a Twitter-like dark UI
- **Zero dependencies** -- pure JavaScript, no build step, no npm install
- **Privacy-first** -- runs entirely in your browser; no data is sent anywhere

## Quick Start

1. **Clone the repo**
   ```bash
   git clone https://github.com/sytelus/xarchive.git
   ```
2. **Load in Chrome** -- go to `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, select the `xarchive` folder
3. **Browse X.com** -- visit any page on x.com so the extension can capture auth credentials in the background
4. **Export** -- click the xarchive icon in your toolbar, verify the three status dots are green, and click **Start Export**
5. **Download** -- when complete, click **Download JSON**

> **How long?** Each page fetches ~100 bookmarks with a ~3s delay. Roughly: 1,000 bookmarks in ~30s, 10,000 in ~5 min.

## Updating

```bash
cd xarchive && git pull
```
Then go to `chrome://extensions/` and click the refresh icon on the xarchive card.

## Usage Details

### Controls

| Button | When available | What it does |
|--------|---------------|--------------|
| **Start Export** | Idle, stopped, or complete | Clears stored data and begins a fresh export |
| **Pause** | Exporting | Pauses the current run (can be resumed) |
| **Resume** | Paused | Continues from where it left off |
| **Stop** | Exporting or paused | Ends the run; partial data available for download |
| **Download JSON** | Stopped or complete | Downloads collected bookmarks as JSON |

### Tips

- **Partial downloads** -- stop mid-run and still download everything collected so far.
- **Folders** -- if you have X Premium, folder assignments are included automatically.
- **Re-download** -- close and reopen the extension tab; the download button persists until you start a new export.
- **Rate limiting** -- the extension uses 2.5s+ delays between requests. If X.com throttles, it backs off automatically.

## Bookmark Viewer

`viewer.html` is a standalone bookmark browser that lets you explore your exported JSON in a dark-themed UI.

**Open it:**
- **Local file** -- open `viewer.html` in any browser and drag-and-drop your JSON file (or click to pick).
- **From a URL** -- append `?url=<json-url>` to load a hosted file:
  ```
  viewer.html?url=https://example.com/bookmarks.json
  ```

**What it offers:**
- Folder sidebar with counts and search filter
- Full-text search across tweet text, authors, handles, and URLs
- Sort by newest or oldest
- Virtual scrolling -- smooth even with tens of thousands of bookmarks
- Tweet cards with author info, metrics, media, quoted tweets, and folder tags
- Press `/` to jump to the search box
- IndexedDB caching -- reload the page without re-parsing

## How It Works

xarchive uses Chrome's Manifest V3 APIs to passively capture auth headers from your normal X.com browsing, then makes paginated GraphQL requests from the extension's options page. Query IDs are discovered dynamically (they rotate every 2-4 weeks), with JS bundle scraping as a fallback. All data is stored locally in IndexedDB via [Dexie](https://dexie.org/).

For the technically curious, see [PLAN.md](PLAN.md) for the architecture and [FINDINGS.md](FINDINGS.md) for research on X.com's internal APIs.

## Privacy & Security

- **No external servers** -- everything runs locally in your browser.
- **No tracking** -- no analytics, telemetry, or data collection of any kind.
- **Your credentials stay local** -- auth tokens are captured from your existing X.com session and never leave the extension.
- **Open source** -- audit the code yourself.

## Contributing

Contributions are welcome! Please [open an issue](https://github.com/sytelus/xarchive/issues) for bugs or feature requests, or submit a pull request.

Since xarchive is a zero-dependency Chrome extension with no build step, contributing is straightforward: edit the JS files, reload the extension in `chrome://extensions/`, and test.

## License

[MIT](LICENSE)
