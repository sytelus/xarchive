# CLAUDE.md

## Project Overview

xarchive is a Chrome browser extension (Manifest V3) that exports all bookmarks from X.com (Twitter) for a logged-in user, including bookmark folder assignments. Output is JSON.

## Key Architecture Decisions

- **Options page as runtime**: All heavy logic (API calls, pagination, storage, export) runs in the options page tab, NOT the service worker. The service worker only handles passive auth header capture via `webRequest.onSendHeaders`, opening the options page on icon click, and registering a dynamic `declarativeNetRequest` rule at install time.
- **No MAIN world injection needed**: Auth capture uses `webRequest` (passive, clean). Content script is ISOLATED world only (reads `twid` cookie for user ID).
- **Direct GraphQL API calls**: The extension makes its own paginated `fetch()` calls to X.com's internal GraphQL API from the options page, using `credentials: 'include'` for cookie forwarding.
- **`declarativeNetRequest` for origin spoofing**: A dynamic rule registered at install time injects `Origin: https://x.com` header, scoped to extension-originated requests via `initiatorDomains: [chrome.runtime.id]`. Static rules can't reference the extension ID, so `rules.json` is empty and the rule is created dynamically.
- **IndexedDB via Dexie** for bookmark storage (scalable, persistent, survives tab close).
- **Dynamic query ID capture**: GraphQL query IDs are captured from `webRequest` URL patterns, NOT hardcoded (they rotate every 2-4 weeks).
- **Conservative rate limiting**: 2.5s base delay between API calls with random jitter, exponential backoff on 429s, 5-minute cooldown after repeated failures.

## Key Files

- `PLAN.md` - Full implementation plan with architecture, phases, data schema
- `FINDINGS.md` - All research findings (API internals, extension study, technique catalog)
- `GOAL.md` - Project goal statement

### Source Files

| File | Purpose |
|---|---|
| `background.js` | Service worker: passive header/query-ID capture, icon click handler, dynamic DNR rule |
| `content.js` | Content script (ISOLATED world): reads `twid` cookie for user ID |
| `options.js` | Main entry point: export orchestration, UI state, event handlers |
| `options.html` | Export UI markup |
| `options.css` | Dark theme styling |
| `lib/api.js` | GraphQL request construction, header assembly, feature flags |
| `lib/fetcher.js` | Paginated fetching with retry, rate limiting, and resume support |
| `lib/parser.js` | Response parsing: tweet extraction, tombstone handling, media/entities |
| `lib/folders.js` | Folder enumeration and tweet-to-folder cross-referencing |
| `lib/db.js` | IndexedDB storage layer via Dexie |
| `lib/exporter.js` | JSON assembly and download trigger |
| `lib/query-ids.js` | Query ID management with JS bundle scraping fallback |
| `lib/utils.js` | Shared rate-limiting constants and timing helpers |
| `rules.json` | Empty — dynamic DNR rule is registered in background.js instead |
| `manifest.json` | Chrome MV3 extension manifest |

## Important Constraints

- Never hardcode GraphQL query IDs -- they rotate every 2-4 weeks
- Always use rate limiting between API calls (2.5s+ with jitter) -- Twillot's zero-delay approach caused account freezing
- Handle `TweetWithVisibilityResults`, `TweetTombstone`, and null `tweet_results.result` in response parsing
- Prefer `note_tweet.note_tweet_results.result.text` over `legacy.full_text` for tweets >280 chars
- Support array of folder IDs per tweet (not single folder like Twillot)
- Re-read `ct0` cookie before each request batch (it rotates during long sessions)
- Scope `declarativeNetRequest` rules narrowly to avoid interfering with normal X.com browsing
