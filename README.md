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

## How It Works

1. Install the extension and browse X.com normally
2. The extension passively captures authentication credentials from your session
3. Click the extension icon to open the export page
4. Click "Start Export" -- the extension fetches all bookmarks via paginated API calls
5. Download the complete JSON file when finished

## Project Status

In development. See [PLAN.md](PLAN.md) for the implementation plan and [FINDINGS.md](FINDINGS.md) for research findings.

## License

MIT
