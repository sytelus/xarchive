# xarchive - Chrome Extension Project Plan

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Research Findings](#2-research-findings)
3. [Existing Extension Deep-Dive](#3-existing-extension-deep-dive)
4. [Architecture](#4-architecture)
5. [Known Issues & Workarounds](#5-known-issues--workarounds)
6. [Implementation Plan](#6-implementation-plan)
7. [Data Schema](#7-data-schema)
8. [References](#8-references)

---

## 1. Executive Summary

**xarchive** is a Chrome extension (Manifest V3) that exports all bookmarks from X.com (Twitter) for a logged-in user, including bookmark folder assignments, and saves them as a complete JSON file.

### Why This Is Hard

- X.com has **no native bookmark export** feature. The official data archive download excludes bookmarks entirely.
- The **official API v2 caps at 800 bookmarks** with no workaround. It also has **no bookmark folder support**.
- The **internal GraphQL API** (used by X.com's web client) has no 800-bookmark limit and supports folders, but it has undocumented rate limits, rotating query IDs, and anti-bot measures.
- Chrome's **Manifest V3 service workers** terminate after 30 seconds of inactivity, making long-running exports challenging.

### Chosen Approach (Revised After Extension Study)

**Hybrid intercept + direct API calls from an options page tab.** The service worker passively captures auth headers and query IDs via `chrome.webRequest.onSendHeaders`. All heavy lifting (API calls, pagination, storage, export assembly) runs in the **options page** (a full tab that stays alive as long as it's open), avoiding service worker lifecycle complexity entirely. This architecture is proven by Twillot, the most feature-complete existing extension. A supplementary MAIN world content script provides fallback credential and query ID capture.

---

## 2. Research Findings

### 2.1 X.com Bookmark API Landscape

#### Official API v2 (NOT suitable)

| Aspect | Detail |
|---|---|
| Endpoint | `GET /2/users/{id}/bookmarks` |
| Auth | OAuth 2.0 with PKCE |
| Max results | **800 most recent bookmarks** (hard ceiling, confirmed by X engineering) |
| Rate limit | 180 requests / 15-minute window |
| Bookmark folders | **Not supported** |
| Verdict | **Unusable** for our goal of complete export |

#### Internal GraphQL API (our target)

X.com's web client uses internal GraphQL endpoints at:
```
https://x.com/i/api/graphql/{queryId}/{operationName}
```

Relevant operations:

| Operation | Method | Purpose |
|---|---|---|
| `Bookmarks` | GET | Fetch bookmarked tweets (paginated, no 800 limit) |
| `BookmarkFoldersSlice` | GET | List all bookmark folders |
| `BookmarkFolderTimeline` | GET | Fetch tweets within a specific folder |
| `BookmarkSearchTimeline` | GET | Search within bookmarks |

Users have successfully exported **112,000+ bookmarks** using this API.

#### Query ID Rotation

**Critical issue:** X.com rotates GraphQL `queryId` values every 2-4 weeks. These IDs are embedded in the site's JavaScript bundles (`responsive-web/client-web*.js`). Any hardcoded IDs will break.

**Our strategy:** Intercept query IDs from live requests made by the X.com web app (see Architecture), with a fallback of scraping them from X.com's JS bundles using regex:
```
queryId:\s*"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:\s*"([^"]+)"
```

### 2.2 Authentication Requirements

Every request to X.com's internal GraphQL API requires these headers:

| Header | Value | Source |
|---|---|---|
| `Authorization` | `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA` | Hardcoded constant (public, identifies web app) |
| `Cookie` | Must include `auth_token` and `ct0` | From browser session |
| `X-Csrf-Token` | Must match the `ct0` cookie value exactly | CSRF protection |
| `X-Twitter-Active-User` | `"yes"` | Required |
| `X-Twitter-Auth-Type` | `"OAuth2Session"` | Required |
| `X-Twitter-Client-Language` | `"en"` | Required |
| `X-Client-Transaction-Id` | Algorithmically generated | Newer anti-bot measure |

**Chrome extension advantage:** With `host_permissions` for `x.com`, the extension can use `chrome.cookies` API to read `ct0` and make `fetch()` calls with `credentials: 'include'` that automatically carry the user's session cookies.

#### X-Client-Transaction-Id

This is a newer anti-bot header. Generation requires fetching X.com's homepage HTML and an "ondemand.s" JavaScript file, then running a generation algorithm. Libraries exist:
- [XClientTransaction (Python)](https://github.com/iSarabjitDhiman/XClientTransaction)
- [XClientTransactionJS (JavaScript)](https://github.com/swyxio/XClientTransactionJS)

**Our strategy:** First try without it (many endpoints don't enforce it for authenticated users). If needed, intercept a valid transaction ID from a live request, or port the generation algorithm to JavaScript.

### 2.3 Rate Limiting

| Aspect | Detail |
|---|---|
| Rate limit signal | HTTP 429 response or JSON error code 88 |
| Observed safe interval | 2-2.5 seconds between paginated requests |
| Recommended jitter | Random multiplier 0.7x-1.5x on base delay |
| Backoff strategy | Exponential: `base_delay * 2^attempt` |
| Cooldown trigger | After 3 consecutive 429 responses |
| Cooldown duration | 300 seconds (5 minutes) |
| Max retries per request | 3-5 |

### 2.4 Response Structure

Bookmarks use cursor-based pagination. Each page returns:

```
data.bookmark_timeline_v2.timeline.instructions[]
  -> type: "TimelineAddEntries"
  -> entries[]
     -> Tweet entries (entryId: "tweet-{id}")
        -> content.itemContent.tweet_results.result
     -> Cursor entries (entryId: "cursor-bottom-{value}")
        -> content.value  (pass as next page's cursor)
```

Pagination terminates when no `cursor-bottom-*` entry is present or when a page returns zero tweet entries.

**Pagination quirk:** Empty pages (containing only cursor entries, no tweets) are possible and should NOT be treated as the end. Only the absence of a bottom cursor signals completion.

### 2.5 Available Data Per Bookmark

| Field | Path | Notes |
|---|---|---|
| Tweet ID | `rest_id` | |
| Full text | `legacy.full_text` | Short tweets |
| Long-form text | `note_tweet.note_tweet_results.result.text` | For tweets >280 chars |
| Created at | `legacy.created_at` | |
| Author screen name | `core.user_results.result.legacy.screen_name` | |
| Author display name | `core.user_results.result.legacy.name` | |
| Author avatar | `core.user_results.result.legacy.profile_image_url_https` | |
| Author verified | `core.user_results.result.legacy.verified` | |
| Author followers | `core.user_results.result.legacy.followers_count` | |
| Like count | `legacy.favorite_count` | |
| Retweet count | `legacy.retweet_count` | |
| Reply count | `legacy.reply_count` | |
| Bookmark count | `legacy.bookmark_count` | |
| View count | `views.count` | |
| Media | `legacy.extended_entities.media[]` | type: photo/video/animated_gif |
| Video URLs | `media[].video_info.variants[]` | Sort by bitrate for best quality |
| URLs | `legacy.entities.urls[]` | Includes expanded_url |
| Hashtags | `legacy.entities.hashtags[]` | |
| Mentions | `legacy.entities.user_mentions[]` | |
| Quote tweet | `quoted_status_result.result` | Nested tweet object |
| Reply to | `legacy.in_reply_to_status_id_str` | |
| Conversation ID | `legacy.conversation_id_str` | Thread grouping |
| Language | `legacy.lang` | |
| Source | `source` | Client app used |

### 2.6 Bookmark Folders

Folders are an X Premium feature. The GraphQL API provides:

**List folders** (`BookmarkFoldersSlice`):
- Variables: `{}` (or with cursor for pagination)
- Response path: `data.viewer.user_results.result.bookmark_collections_slice`
- Returns folder ID, name, and metadata

**Fetch tweets in folder** (`BookmarkFolderTimeline`):
- Variables: `{"bookmark_collection_id": "<folder_id>", "count": 50}`
- Response path: `data.bookmark_collection_timeline.timeline.instructions`
- Same tweet structure as main bookmarks

**Strategy for folder assignment:** Fetch all folders first, then fetch tweets in each folder. Cross-reference tweet IDs to build a map of `tweet_id -> [folder_ids]`. Merge this with the main bookmark list.

**Warning:** The official API v2 folder endpoint has a hard cap of 20 results with no pagination. The internal GraphQL endpoint does not appear to have this limit but should be tested.

### 2.7 Existing Open-Source Projects

#### Most Relevant to Study

| Project | Approach | Stars | Folder Support | Key Lesson |
|---|---|---|---|---|
| [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) | UserScript interceptor | ~2,300 | No | Most popular; requires manual scrolling |
| [tweetxvault](https://github.com/lhl/tweetxvault) | Python CLI, direct GraphQL | ~8 | No | Auto query ID discovery, incremental sync, crash-safe checkpoints |
| [Twillot](https://github.com/twillot-app/twillot) | Chrome Extension (MV3) | ~132 | **Yes** | Only OSS extension with folders; reports of account freezing |
| [twitter-api-client](https://github.com/trevorhobenshield/twitter-api-client) | Python library | ~1,900 | Partial | Comprehensive GraphQL wrapper |
| [twitter-cli](https://github.com/public-clis/twitter-cli) | Python CLI | ~2,200 | No | TLS fingerprint anti-detection |
| [x-bookmark-exporter](https://github.com/CHIHI913/x-bookmark-exporter) | Chrome Extension (MV3) | 0 | No | Three-layer architecture (Main World + Content Script + Service Worker) |
| [bookmark-export](https://github.com/sahil-lalani/bookmark-export) | Chrome Extension | ~20 | No | Simple webRequest-based approach |

#### Key Reference Projects

| Project | Purpose |
|---|---|
| [TwitterInternalAPIDocument](https://github.com/fa0311/TwitterInternalAPIDocument) | Complete documentation of all internal GraphQL operations |
| [XClientTransactionJS](https://github.com/swyxio/XClientTransactionJS) | JavaScript implementation of X-Client-Transaction-Id generation |

---

## 3. Existing Extension Deep-Dive

Source-code-level study of all open-source Chrome extensions and the leading userscript for X.com bookmark export.

### 3.1 Comparative Overview

| | [Twillot](https://github.com/twillot-app/twillot) | [x-bookmark-exporter](https://github.com/CHIHI913/x-bookmark-exporter) | [bookmark-export](https://github.com/sahil-lalani/bookmark-export) | [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) |
|---|---|---|---|---|
| **Type** | Chrome ext (MV3) | Chrome ext (MV3) | Chrome ext (MV3) | UserScript |
| **Stars** | ~132 | 0 | ~20 | ~2,300 |
| **Stack** | TS, SolidJS, Vite/CRXJS | TS, Preact, Vite/CRXJS | Plain JS (no build) | TS, Preact, Vite |
| **API approach** | Direct GraphQL calls | Passive response intercept | Direct API replay | Passive XHR intercept |
| **Auth capture** | `webRequest.onSendHeaders` | Injected fetch/XHR hooks | `webRequest.onBeforeSendHeaders` | `unsafeWindow` XHR hook |
| **Pagination** | Cursor-based, automatic | Scroll-based (auto-scroll) | Cursor-based, recursive | Manual scrolling |
| **Rate limiting** | None (zero delay!) | 1.5s scroll delay | None | N/A (manual) |
| **Folders** | **Yes** | No | No | No |
| **Persistence** | IndexedDB | None (in-memory Map) | None | Dexie (IndexedDB) |
| **Export: JSON** | Yes | No | Yes | Yes |
| **Export: CSV** | Yes | Yes (JP) | No | Yes |
| **Runtime** | Options page tab | Service worker | Service worker | Page context |

### 3.2 Twillot - Detailed Analysis (Most Instructive)

**Architecture:** Monorepo (`pnpm`) with `exporter/`, `packages/utils/`, and other sub-packages. The key architectural insight is that **all heavy logic runs in the options page** (a full browser tab), not the service worker. The service worker is minimal (~17 lines): it opens the options page on icon click and passively captures auth headers via `webRequest.onSendHeaders`.

**Auth capture (dual-prong):**
1. Content script (ISOLATED world, 6 lines): reads `twid` cookie from `document.cookie` to get user ID
2. Service worker: `webRequest.onSendHeaders` listener filtered to `{urls: [Host + '/i/api/graphql/*'], types: ['xmlhttprequest']}` captures `Authorization`, `X-Csrf-Token`, `X-Client-Uuid`, `X-Client-Transaction-Id` headers. Stored in `chrome.storage.local` with `user:{uid}:{key}` namespacing.

**Direct API calls:** Options page makes `fetch()` calls directly to `x.com/i/api/graphql/{queryId}/{operation}` with `credentials: 'include'`. Uses `declarativeNetRequest` rule to inject `Origin: https://x.com` header on all requests (essential for CORS).

**Bookmark folders:**
- `BookmarkFoldersSlice` (queryId `i78YDd0Tza-dV4SYs58kRg`): Lists all folders. Variables: `{}`
- `BookmarkFolderTimeline` (queryId `e1T8IKkMr-8iQk7tNOyD_g`): Fetches tweets in a folder. Variables: `{bookmark_collection_id, cursor, includePromotedContent}`
- Tweets stored with a `folder` field (single folder name, not array -- Twillot assumes one folder per tweet)

**Transaction ID handling:** Captured ID is mutated via `incrementFirstNumber()` -- randomly increments one digit per request for lightweight anti-fingerprinting.

**Rate limit tracking:** Reads `X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining`, `X-Rate-Limit-Reset` from response headers. On 429, pauses until reset time + 5s buffer, then resumes at full speed.

**Critical flaws discovered:**
1. **Zero delay between API calls** -- pages fetched back-to-back in a `while(true)` loop with 5 parallel sync streams. This explains reported account freezing.
2. **Hardcoded GraphQL query IDs** -- will break on rotation (every 2-4 weeks)
3. **Overly broad declarativeNetRequest** -- forces `Origin: https://x.com` on ALL main_frame + xmlhttprequest to `*.x.com/*`, interfering with normal browsing (GitHub issue #127)
4. **15-second fetch timeout** -- may be too short for large pages on slow connections

**Worth adopting:**
- Options page as runtime (avoids SW lifecycle entirely)
- `declarativeNetRequest` for origin spoofing (but scoped more narrowly)
- `webRequest.onSendHeaders` for passive header capture
- Per-user storage namespacing (`user:{uid}:{key}`)
- `twid` cookie parsing for user ID
- Response header rate limit tracking
- Transaction ID mutation technique

### 3.3 x-bookmark-exporter (CHIHI913) - Detailed Analysis

**Three-layer architecture:**
```
MAIN world (injected/main.js) --postMessage--> Content Script --runtime.sendMessage--> Service Worker
```

**Script injection:** Content script creates a `<script>` tag pointing to `chrome.runtime.getURL('injected/main.js')`. Script self-removes from DOM after loading (`script.onload = () => script.remove()`). Only injected if URL contains `/i/bookmarks`.

**Dual API hooking:** Patches both `window.fetch` AND `XMLHttpRequest.prototype.open/send`. Fetch hook clones responses (`response.clone()`) to avoid consuming the body stream. XHR hook stashes URL in `_xbeUrl` property during `open()`, then wraps `onreadystatechange` during `send()`. Pattern: `/\/graphql\/.+\/Bookmarks/`.

**Passive interception model:** Does NOT make its own API calls. Relies on user scrolling to trigger X.com's own pagination. An `AutoScroller` class exists but is dead code (never imported). The active scroll function does 10 scrolls at 500ms intervals.

**Critical flaws:**
1. **In-memory-only store** -- `Map<string, Post>` in service worker has no persistence. Service worker termination loses all data.
2. **Dead code** -- `AutoScroller` with sophisticated stop conditions is never used
3. **Conditional injection** only on initial load -- X.com is a SPA, so navigating to bookmarks after page load misses the hook
4. **`window.postMessage('*')` target origin** -- any iframe could receive the data
5. **No JSON export** -- only CSV and clipboard Markdown

**Worth adopting:**
- Dual fetch + XHR hooking pattern
- `response.clone()` for non-destructive interception
- Self-removing script tag injection
- `TweetWithVisibilityResults` unwrapping (`result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result`)
- Note tweet text preference (`note_tweet.note_tweet_results.result.text` over `legacy.full_text`)
- Recursive quoted tweet extraction
- Original-resolution image URLs (`?format=jpg&name=orig`)

### 3.4 bookmark-export (sahil-lalani) - Detailed Analysis

**Simplest approach:** No build step, no dependencies, ~270 lines of vanilla JS. Service worker does everything.

**Auth capture:** `webRequest.onBeforeSendHeaders` captures `Authorization`, `Cookie`, `X-Csrf-Token` from all requests to `x.com`/`twitter.com`. Also captures GraphQL query ID dynamically from URL pattern `/graphql/([^/]+)/Bookmarks` -- the key resilience technique.

**API replay:** Constructs `fetch()` calls using captured credentials. Recursive pagination: `getBookmarks(nextCursor, totalImported, allTweets)` until no cursor or zero new tweets. Page size: 100.

**Critical flaws:**
1. **Overly broad `host_permissions: *://*/*`** -- grants access to all URLs
2. **`externally_connectable`** for unrelated domains -- security concern
3. **No rate limiting** -- hammers API at full speed
4. **Only captures first media item** per tweet
5. **No user info** (author name/handle) in export
6. **Data URL size limits** for export file -- fails on large exports
7. **Hardcoded feature flags** (27 flags)

**Worth adopting:**
- Dynamic query ID capture from URL patterns via `webRequest` -- most resilient approach to query ID rotation
- Simple, minimal architecture as reference point

### 3.5 twitter-web-exporter (UserScript) - Detailed Analysis

**Most mature project** (~2,300 stars). UserScript for Tampermonkey/Violentmonkey, not a Chrome extension. Uses `unsafeWindow` to hook `XMLHttpRequest.prototype.open`. Modular extension system with interceptors per data type (bookmarks, likes, followers, etc.).

**Storage:** Dexie (IndexedDB wrapper) for large datasets. Data table UI injected into the page.

**Worth adopting:**
- Dexie for IndexedDB (simpler API than raw IDB)
- Comprehensive type system for Twitter's internal API
- `TweetTombstone` and `TweetUnavailable` handling
- Context validation (`webpackChunk_twitter_responsive_web` check)
- i18n support pattern

### 3.6 Lessons Learned - What xarchive Must Do Differently

| Problem in existing tools | xarchive solution |
|---|---|
| **Twillot: Zero delay between API calls** -> account freezing | 2.5s base delay + random jitter between all requests |
| **Twillot: Hardcoded query IDs** -> breaks every 2-4 weeks | Dynamic capture from `webRequest` URL patterns (bookmark-export's technique) with JS bundle scraping fallback |
| **x-bookmark-exporter: In-memory store** -> data loss on SW termination | IndexedDB persistence (via Dexie) in the options page context |
| **x-bookmark-exporter: Scroll-dependent** -> incomplete, requires user interaction | Direct API calls with cursor-based pagination |
| **bookmark-export: No user info** -> unusable export | Full data extraction (author, metrics, media, quotes, entities) |
| **bookmark-export: First media only** -> data loss | Extract ALL media items with original-resolution URLs |
| **All except Twillot: No folder support** | Full folder enumeration and cross-referencing |
| **Twillot: Single folder per tweet assumption** | Support array of folder IDs per tweet |
| **Twillot: Broad declarativeNetRequest** -> breaks normal browsing | Scope rule to only extension-initiated requests (use `initiatorDomains` or narrower condition) |
| **x-bookmark-exporter: SPA navigation misses hook** | Inject on all x.com pages OR use `webRequest` which doesn't depend on injection timing |
| **bookmark-export: Data URL export** -> size limits | Blob + `URL.createObjectURL` or offscreen document for large exports |

### 3.7 Recommended Technique Synthesis

The optimal approach combines the best techniques from each project:

| Capability | Source | Technique |
|---|---|---|
| **Runtime context** | Twillot | Options page tab (avoids SW lifecycle) |
| **Auth capture** | Twillot + bookmark-export | `webRequest.onSendHeaders` (passive, clean, no injection needed) |
| **Query ID capture** | bookmark-export | Dynamic from `webRequest` URL regex: `/graphql/([^/]+)/Bookmarks/` |
| **Feature flags capture** | Twillot | Intercept from live request query parameters |
| **Origin spoofing** | Twillot | `declarativeNetRequest` rule (but narrower scope) |
| **API calls** | Twillot | Direct `fetch()` from options page with `credentials: 'include'` |
| **Transaction ID** | Twillot | Capture + `incrementFirstNumber()` mutation per request |
| **Rate limiting** | tweetxvault (CLI) | 2.5s base delay, jitter, exponential backoff, 300s cooldown |
| **Pagination** | Twillot + bookmark-export | Cursor-based with bottom cursor extraction |
| **Bookmark folders** | Twillot | `BookmarkFoldersSlice` + `BookmarkFolderTimeline` endpoints |
| **Data extraction** | x-bookmark-exporter | Dual paths, note_tweet, recursive quotes, all media, tombstones |
| **Storage** | twitter-web-exporter | Dexie (IndexedDB) for scalable persistence |
| **Export** | Custom | Blob-based JSON download via `chrome.downloads` API |
| **User ID** | Twillot | `twid` cookie parsing |
| **Fallback auth** | Custom | `chrome.cookies.get()` for `ct0` |

---

## 4. Architecture

### 4.1 High-Level Design (Revised)

Key insight from studying Twillot: **run heavy logic in the options page, not the service worker.** The options page is a regular browser tab that stays alive as long as it's open -- no 30-second termination, no state loss, full DOM/Blob access.

```
┌─────────────────────────────────────────────────────────┐
│  X.com Tab                                              │
│  (User's normal browsing - no injection required)       │
└─────────────────────────┬───────────────────────────────┘
                          │ webRequest events (passive)
┌─────────────────────────▼───────────────────────────────┐
│  Service Worker (background.js) - MINIMAL               │
│  - chrome.webRequest.onSendHeaders listener             │
│    → captures auth headers + query IDs from GraphQL     │
│      requests X.com makes naturally                     │
│  - Stores credentials in chrome.storage.local           │
│  - Opens options page on extension icon click           │
│  - declarativeNetRequest rule for Origin header         │
└────────────┬────────────────────────────────────────────┘
             │ chrome.storage.local (shared state)
┌────────────▼────────────────────────────────────────────┐
│  Options Page / Export Tab (options.html + options.js)   │
│  THE MAIN RUNTIME - stays alive as long as tab is open  │
│  - Reads auth credentials from chrome.storage.local     │
│  - Makes direct fetch() calls to GraphQL API            │
│    (credentials: 'include' carries cookies)             │
│  - Cursor-based pagination with rate limiting           │
│  - Stores bookmarks in IndexedDB (via Dexie)            │
│  - Fetches folders and cross-references                 │
│  - Assembles final JSON and triggers download           │
│  - Shows full progress UI with controls                 │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Content Script (content.js) - FALLBACK only            │
│  ISOLATED world, reads twid cookie for user ID          │
│  Only 6 lines of code (matches Twillot's approach)      │
└─────────────────────────────────────────────────────────┘
```

**Why this is better than the original service-worker-centric design:**
- No 30-second termination risk -- the options page tab is a full browsing context
- No keepalive hacks needed
- Full DOM and Blob access for JSON assembly and download
- IndexedDB available directly (no offscreen document needed)
- Simpler architecture -- fewer moving parts, fewer message-passing layers
- Proven in production by Twillot

### 4.2 Component Details

#### 4.2.1 Service Worker (`background.js`) - Minimal

**~30 lines of code.** Only two responsibilities:

1. **Passive auth capture** via `chrome.webRequest.onSendHeaders`:
   - Filter: `{urls: ['https://x.com/i/api/graphql/*'], types: ['xmlhttprequest']}`
   - Extracts: `Authorization`, `X-Csrf-Token`, `X-Client-Uuid`, `X-Client-Transaction-Id`
   - Extracts query IDs from URL: `/graphql/([^/]+)/(Bookmarks|BookmarkFoldersSlice|BookmarkFolderTimeline)/`
   - Extracts `features` parameter from URL query string
   - Stores all captured data in `chrome.storage.local` namespaced by user ID

2. **Open options page** on extension icon click: `chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage())`

No popup needed -- clicking the icon opens the full export UI directly.

#### 4.2.2 Content Script (`content.js`) - Minimal

**~10 lines of code.** ISOLATED world, `document_start`.

Reads the `twid` cookie from `document.cookie` to extract the logged-in user ID (`u%3D{numeric_id}`). Sends it to `chrome.storage.local`.

This is a fallback -- the `webRequest` listener captures everything else. No MAIN world injection, no fetch/XHR hooking, no bridge script needed. This dramatically simplifies the architecture.

#### 4.2.3 Options Page (`options.html` + `options.js`) - The Core

A full-page UI that opens in its own tab. This is where all export logic runs.

**Modules:**

| Module | Responsibility |
|---|---|
| `options.js` | Main entry, UI state management, user interactions |
| `lib/api.js` | GraphQL request construction, URL encoding, header assembly |
| `lib/fetcher.js` | Pagination loop, cursor management, rate limiting, retry logic |
| `lib/parser.js` | Response parsing, tweet extraction, tombstone handling |
| `lib/folders.js` | Folder enumeration and folder-tweet cross-referencing |
| `lib/db.js` | Dexie (IndexedDB) storage for bookmarks and export state |
| `lib/exporter.js` | JSON assembly, Blob creation, download trigger |
| `lib/query-ids.js` | Query ID management with fallback JS bundle scraping |

**UI states:**
- **Waiting for credentials:** Prompts user to visit x.com if no auth captured yet
- **Ready:** Shows "Start Export" button with estimated time
- **Exporting:** Progress bar, bookmark count, pages fetched, current phase (folders/bookmarks), pause/stop buttons
- **Rate limited:** Shows countdown timer, auto-resumes
- **Complete:** Total counts, download button, export summary
- **Error:** Error details with retry option

#### 4.2.4 DeclarativeNetRequest Rule (`rules.json`)

Injects `Origin: https://x.com` header on the extension's own requests. Scoped narrowly (lesson from Twillot's overly broad rule):

```json
[{
  "id": 1,
  "priority": 1,
  "action": {
    "type": "modifyHeaders",
    "requestHeaders": [{
      "header": "Origin",
      "operation": "set",
      "value": "https://x.com"
    }]
  },
  "condition": {
    "urlFilter": "https://x.com/i/api/graphql/*",
    "resourceTypes": ["xmlhttprequest"],
    "initiatorDomains": ["$EXTENSION_ID"]
  }
}]
```

The `initiatorDomains` restriction (using the extension's own origin) prevents interfering with normal X.com browsing -- a fix for Twillot's issue #127.

### 4.3 Export Flow

```
1. User installs extension
2. User navigates to x.com normally
3. Service worker passively captures auth headers + query IDs from
   any GraphQL request X.com makes (e.g., loading timeline)
4. User clicks extension icon -> options page opens in new tab
5. Options page reads credentials from chrome.storage.local
6. User clicks "Start Export"
7. Options page executes:
   a. Re-read ct0 cookie via chrome.cookies.get() (freshness check)
   b. Fetch bookmark folders (BookmarkFoldersSlice)
      - Paginate until all folders listed
      - Store folder metadata in IndexedDB
   c. For each folder, fetch bookmarks (BookmarkFolderTimeline)
      - Paginate with 2.5s delay + jitter between pages
      - Build tweet_id -> [folder_ids] map
   d. Fetch main bookmark timeline (Bookmarks)
      - Paginate with 2.5s delay + jitter
      - After each page: parse tweets, store in IndexedDB, update UI
      - On 429: exponential backoff, then resume
      - Persist cursor to IndexedDB for resume capability
   e. Cross-reference: merge folder assignments into bookmark data
   f. Assemble final JSON from IndexedDB
   g. Create Blob, trigger download via <a> click or chrome.downloads
8. User receives complete JSON file
```

### 4.4 Manifest Configuration (Revised)

```json
{
  "manifest_version": 3,
  "name": "xarchive",
  "version": "1.0.0",
  "description": "Export all your X.com bookmarks with folder assignments",
  "permissions": [
    "storage",
    "unlimitedStorage",
    "cookies",
    "webRequest",
    "declarativeNetRequest",
    "declarativeNetRequestWithHostAccess",
    "downloads"
  ],
  "host_permissions": [
    "https://x.com/*",
    "https://twitter.com/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://x.com/*", "https://twitter.com/*"],
      "js": ["content.js"],
      "run_at": "document_start"
    }
  ],
  "options_page": "options.html",
  "action": {},
  "declarative_net_request": {
    "rule_resources": [{
      "id": "ruleset_1",
      "enabled": true,
      "path": "rules.json"
    }]
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

**Changes from original plan:**
- Removed `notifications` and `offscreen` (not needed with options page runtime)
- Added `webRequest` (passive header capture)
- Added `declarativeNetRequest` + `declarativeNetRequestWithHostAccess` (origin spoofing)
- Replaced popup with `options_page` (clicked icon opens full tab)
- Single content script in ISOLATED world (no MAIN world injection, no bridge)
- Added `declarative_net_request.rule_resources`

---

## 5. Known Issues & Workarounds

### 5.1 Query ID Rotation

**Issue:** X.com rotates GraphQL query IDs every 2-4 weeks. Hardcoded IDs will break.

**Workaround (primary):** Intercept query IDs from live requests. When the user visits X.com, the web app makes GraphQL requests that contain current query IDs in the URL. Our MAIN world script captures these.

**Workaround (fallback):** If the user hasn't navigated to bookmarks yet (so no bookmark-specific query IDs were captured), fetch X.com's main JS bundle and extract query IDs using regex. The bundles follow the pattern `https://abs.twimg.com/responsive-web/client-web*/main.*.js`.

**Workaround (last resort):** Maintain a manually-updated list of query IDs as a static fallback, but warn the user if these are being used since they may be stale.

### 5.2 Service Worker Termination (Largely Mitigated)

**Issue:** Chrome MV3 service workers are killed after 30 seconds of inactivity.

**Mitigation:** By running all heavy logic in the **options page** (a regular tab), this is largely a non-issue. The service worker only needs to stay alive long enough to process `webRequest` events, which are instantaneous. The options page stays alive as long as the user keeps the tab open.

**Remaining concern:** If the user closes the options page tab mid-export, progress must be recoverable.

**Workaround:**
1. **Persistent state:** After every page fetch, save current cursor and accumulated bookmark IDs to IndexedDB
2. **Resume on reopen:** When the options page loads, check for incomplete export state and offer to resume from last cursor

### 5.3 Rate Limiting (HTTP 429)

**Issue:** X.com throttles requests that are too frequent. Hitting rate limits repeatedly may trigger additional anti-bot measures.

**Workaround:**
```
Base delay between pages:    2.5 seconds
Jitter range:                0.7x - 1.5x (random multiplier)
On 429, retry with:          base_delay * 2^attempt + random(0, 1000ms)
Max retries per page:        5
After 3 consecutive 429s:    Pause for 300 seconds
After 5 consecutive 429s:    Stop and prompt user to try later
```

### 5.4 Account Freezing Risk

**Issue:** Twillot users have reported account freezing after exporting large bookmark sets. This likely results from excessive API calls in a short window.

**Workaround:**
1. Conservative rate limiting (2.5s base delay, not 0.5s)
2. Randomized jitter to avoid machine-like request patterns
3. Include realistic headers (`User-Agent`, `Referer`, `Origin`) matching the browser
4. Stop immediately on any non-429 error that suggests account issues (403, 401)
5. Warn the user before starting about potential risks

### 5.5 Empty Pages in Pagination

**Issue:** A page may return entries containing only cursor entries and no tweet entries. Treating this as end-of-data causes incomplete exports.

**Workaround:** Only stop pagination when:
- No `cursor-bottom-*` entry is present in the response, OR
- The bottom cursor value is identical to the one from the previous request (infinite loop guard), OR
- A configurable maximum number of consecutive empty pages is reached (e.g., 5)

### 5.6 Deleted/Suspended Tweet Tombstones

**Issue:** Bookmarked tweets from deleted or suspended accounts return `null` in `tweet_results.result` or a `__typename` of `"TweetTombstone"`.

**Workaround:** Handle gracefully:
- If `tweet_results.result` is `null`, record the tweet ID with a `"status": "unavailable"` marker
- If `__typename` is `"TweetTombstone"`, extract any available tombstone reason
- Include these in the output so the user knows their bookmark count is accurate even if some content is gone

### 5.7 Response Path Variations

**Issue:** X.com has changed the response structure between versions. Both `bookmark_timeline` and `bookmark_timeline_v2` paths have been observed.

**Workaround:** Try both paths:
```javascript
const instructions =
  response.data?.bookmark_timeline_v2?.timeline?.instructions ||
  response.data?.bookmark_timeline?.timeline?.instructions;
```

### 5.8 Feature Flags Changes

**Issue:** The `features` parameter in GraphQL requests contains ~19 boolean flags that X.com changes without notice. Wrong flags can cause 400 errors or missing data.

**Workaround (primary):** Capture the exact `features` object from an intercepted live request.

**Workaround (fallback):** Maintain a known-good default set and log any errors that may indicate flag changes.

### 5.9 Large Export Memory Pressure (Largely Mitigated)

**Issue:** Exporting tens of thousands of bookmarks means holding a large JSON structure in memory.

**Mitigation:** By using IndexedDB (via Dexie) in the options page context, individual bookmarks are stored as separate records, not held in memory. The options page has the same memory budget as a regular tab (~4GB on 64-bit Chrome).

**Remaining concern:** Final JSON assembly reads all records and creates a single Blob.

**Workaround:**
1. Stream records from IndexedDB in chunks during JSON assembly
2. Use `Blob` constructor with array of string chunks rather than building one giant string
3. If export is extremely large (50K+), offer option to split into multiple JSON files

### 5.10 X-Client-Transaction-Id Enforcement

**Issue:** This newer anti-bot header may be required for some endpoints. It requires algorithmic generation using data from X.com's homepage.

**Workaround (primary):** Intercept a valid `X-Client-Transaction-Id` from a live request and reuse it. While the ID is intended to be per-request, reusing a recent one may work.

**Workaround (fallback):** Port the generation algorithm from [XClientTransactionJS](https://github.com/swyxio/XClientTransactionJS) into the extension.

**Workaround (minimal):** Omit the header entirely and see if requests succeed. Many authenticated endpoints don't enforce it.

### 5.11 `ct0` Cookie Rotation

**Issue:** The `ct0` cookie (CSRF token) can change during a long session.

**Workaround:** Before each API call (or batch of calls), re-read the `ct0` cookie via `chrome.cookies.get()` rather than relying on a cached value.

### 5.12 Bookmark Folder Limitations

**Issue:** The official API v2 folder endpoint caps at 20 results with no pagination. The internal GraphQL `BookmarkFolderTimeline` endpoint's limits are undocumented.

**Workaround:** Use `BookmarkFolderTimeline` with cursor-based pagination. If it also caps, fall back to cross-referencing: fetch all bookmarks from the main timeline, then for each folder, fetch its (potentially limited) list, and note any gaps.

### 5.13 Tweets in Multiple Folders

**Issue:** A bookmark can exist in the main "All Bookmarks" list and also in one or more folders. We need to deduplicate while preserving folder assignments.

**Workaround:** Use a Map keyed by tweet ID. As bookmarks are fetched from each source (main timeline + each folder), merge entries:
```javascript
// Pseudocode
if (map.has(tweetId)) {
  map.get(tweetId).folders.push(folderId);
} else {
  map.set(tweetId, { ...tweetData, folders: [folderId] });
}
```

---

## 6. Implementation Plan

### Phase 1: Project Setup & Skeleton

**Goal:** Working extension that loads on X.com and opens an options page.

**Tasks:**
- [ ] Initialize project structure
- [ ] Create manifest.json with all required permissions
- [ ] Create minimal service worker (icon click handler)
- [ ] Create minimal content script (twid cookie reader)
- [ ] Create options page with basic HTML/CSS skeleton
- [ ] Create `rules.json` for declarativeNetRequest
- [ ] Create placeholder icons
- [ ] Test: extension loads, icon click opens options page, content script runs on x.com

**Files:**
```
xarchive/
  manifest.json
  rules.json              # declarativeNetRequest origin spoofing
  background.js           # Service worker (minimal - ~30 lines)
  content.js              # Content script (minimal - ~10 lines)
  options.html            # Full export UI
  options.js              # Main export logic entry point
  options.css             # Styling
  lib/
    api.js                # GraphQL request construction
    fetcher.js            # Pagination loop, rate limiting, retry
    parser.js             # Response parsing and data extraction
    folders.js            # Folder enumeration and cross-referencing
    db.js                 # Dexie (IndexedDB) storage layer
    exporter.js           # JSON assembly and download
    query-ids.js          # Query ID management and fallback
  icons/
    icon16.png
    icon48.png
    icon128.png
```

### Phase 2: Credential Capture

**Goal:** Reliably capture auth credentials from X.com browsing.

**Tasks:**
- [ ] Implement `webRequest.onSendHeaders` listener in service worker
  - Filter: `{urls: ['https://x.com/i/api/graphql/*'], types: ['xmlhttprequest']}`
  - Extract: `Authorization`, `X-Csrf-Token`, `X-Client-Uuid`, `X-Client-Transaction-Id`
- [ ] Extract query IDs from URL patterns: `/graphql/([^/]+)/(Bookmarks|BookmarkFoldersSlice|BookmarkFolderTimeline)/`
- [ ] Extract `features` parameter from URL query string
- [ ] Store all captured data in `chrome.storage.local` (namespaced by user ID)
- [ ] Implement `twid` cookie parsing in content script
- [ ] Add fallback: read `ct0` cookie via `chrome.cookies.get()` in options page
- [ ] Show credential capture status in options page UI
- [ ] Test: verify credentials captured when user browses X.com normally
- [ ] Test: verify query IDs captured when user visits bookmarks page

### Phase 3: Core Bookmark Fetching

**Goal:** Fetch all bookmarks from the main timeline with pagination.

**Tasks:**
- [ ] Implement GraphQL request construction in `api.js`
  - URL encoding of `variables` and `features` parameters
  - Header assembly (Authorization, X-Csrf-Token, X-Twitter-* headers)
  - Transaction ID mutation (`incrementFirstNumber()` per request)
  - `credentials: 'include'` for cookie forwarding
- [ ] Implement Dexie schema in `db.js` (bookmarks table, export_state table)
- [ ] Implement cursor-based pagination loop in `fetcher.js`
- [ ] Implement response parsing in `parser.js`:
  - Navigate both `bookmark_timeline_v2` and `bookmark_timeline` paths
  - Extract tweet entries (`entryId.startsWith('tweet-')`)
  - Extract bottom cursor (`entryId.startsWith('cursor-bottom-')`)
  - Handle `TweetWithVisibilityResults` wrapper
  - Handle `TweetTombstone` and null `tweet_results.result`
  - Prefer `note_tweet` text over `legacy.full_text`
  - Extract all media (not just first), with `?format=jpg&name=orig` for photos
  - Recursive quoted tweet extraction
- [ ] Implement rate limiting in `fetcher.js`:
  - 2.5s base delay between pages with random jitter (0.7x-1.5x)
  - Track rate limit headers from responses
  - Exponential backoff on 429: `base_delay * 2^attempt + random(0,1000ms)`
  - Cooldown: 300s after 3 consecutive 429s
  - Stop after 5 consecutive 429s
- [ ] Persist each page's bookmarks to IndexedDB immediately
- [ ] Persist cursor position to IndexedDB after each page (resumability)
- [ ] Re-read `ct0` cookie before each request batch (rotation safety)
- [ ] Update options page UI with real-time progress
- [ ] Implement pause/resume/stop controls
- [ ] Test: export for account with <100 bookmarks
- [ ] Test: export for account with 1000+ bookmarks
- [ ] Test: resume after page refresh

### Phase 4: Bookmark Folders

**Goal:** Fetch folder list and folder-specific bookmarks; cross-reference with main timeline.

**Tasks:**
- [ ] Implement `BookmarkFoldersSlice` call in `folders.js`
- [ ] Implement `BookmarkFolderTimeline` call with pagination per folder
- [ ] Apply same rate limiting as main bookmark fetching
- [ ] Build `tweet_id -> [folder_id, folder_id, ...]` map (array, not single value -- unlike Twillot's limitation)
- [ ] Merge folder assignments into bookmark records in IndexedDB
- [ ] Handle non-Premium accounts gracefully (folders API may return error or empty)
- [ ] Show folder fetching progress in UI (folder X of Y, bookmarks per folder)
- [ ] Test: verify folder assignments are correctly captured
- [ ] Test: verify tweets in multiple folders get all folder IDs

### Phase 5: Data Assembly & Download

**Goal:** Produce the final JSON output and download it.

**Tasks:**
- [ ] Read all bookmarks from IndexedDB
- [ ] Cross-reference folder assignments
- [ ] Assemble output JSON matching schema (see Section 7)
- [ ] Create Blob and trigger download via `<a>` element click or `chrome.downloads.download()`
- [ ] Generate filename: `xarchive_{screen_name}_{YYYY-MM-DD}.json`
- [ ] Include export metadata (timestamp, counts, duration)
- [ ] Offer option to clear IndexedDB after successful download
- [ ] Test: verify JSON output is valid and complete
- [ ] Test: verify large exports (10K+ bookmarks) download successfully

### Phase 6: Robustness & Edge Cases

**Goal:** Handle all known edge cases for reliability.

**Tasks:**
- [ ] Handle deleted/suspended tweet tombstones (record with `status: "unavailable"`)
- [ ] Handle empty pagination pages (only cursors, no tweets) -- continue, don't stop
- [ ] Implement infinite loop detection (same cursor repeated)
- [ ] Implement max consecutive empty pages guard (5)
- [ ] Implement query ID fallback: scrape from X.com JS bundles if not captured
- [ ] Handle network errors with retry
- [ ] Handle options page tab closed during export (warn user, state persisted for resume)
- [ ] Validate export completeness (count bookmarks vs pages * page_size estimate)
- [ ] Handle 401/403 errors (credentials expired -- prompt re-auth)
- [ ] Test: export with deleted/suspended bookmarks
- [ ] Test: export during rate limiting
- [ ] Test: resume after closing and reopening options page

### Phase 7: Polish & Quality

**Goal:** Production-ready extension.

**Tasks:**
- [ ] Design extension icons (16, 48, 128px)
- [ ] Polish options page UI (clear status messages, progress visualization)
- [ ] Add time estimate based on bookmark count and rate limiting
- [ ] Add export summary on completion
- [ ] Test on Chrome stable, Chrome Beta, Edge
- [ ] Performance testing for very large collections (10K+)
- [ ] Security review: no credential leaks, proper origin validation, no XSS
- [ ] Verify declarativeNetRequest rule doesn't interfere with normal browsing

---

## 7. Data Schema

### 7.1 Output JSON Structure

> Note: `sort_index` field added based on x-bookmark-exporter's finding that this preserves bookmark ordering (which differs from tweet chronological order).

```json
{
  "export_metadata": {
    "tool": "xarchive",
    "version": "1.0.0",
    "exported_at": "2024-01-15T10:30:00.000Z",
    "user": {
      "screen_name": "username",
      "user_id": "123456789"
    },
    "stats": {
      "total_bookmarks": 1500,
      "available_bookmarks": 1487,
      "unavailable_bookmarks": 13,
      "total_folders": 5,
      "pages_fetched": 15,
      "export_duration_seconds": 120
    }
  },
  "folders": [
    {
      "id": "folder_id_1",
      "name": "Tech Articles"
    },
    {
      "id": "folder_id_2",
      "name": "Funny Tweets"
    }
  ],
  "bookmarks": [
    {
      "tweet_id": "1234567890",
      "sort_index": "1789012345678901234",
      "status": "available",
      "created_at": "2024-01-10T15:30:00.000Z",
      "full_text": "This is the tweet text...",
      "lang": "en",
      "source": "Twitter for iPhone",
      "conversation_id": "1234567890",
      "in_reply_to_tweet_id": null,
      "in_reply_to_user_id": null,
      "folders": ["folder_id_1"],
      "author": {
        "user_id": "987654321",
        "screen_name": "author_handle",
        "name": "Author Name",
        "profile_image_url": "https://pbs.twimg.com/...",
        "verified": false,
        "followers_count": 1500
      },
      "metrics": {
        "likes": 42,
        "retweets": 10,
        "replies": 5,
        "bookmarks": 3,
        "views": 1200
      },
      "entities": {
        "urls": [
          {
            "url": "https://t.co/abc",
            "expanded_url": "https://example.com/article",
            "display_url": "example.com/article"
          }
        ],
        "hashtags": ["tech", "programming"],
        "mentions": [
          {
            "screen_name": "mentioned_user",
            "user_id": "111222333"
          }
        ]
      },
      "media": [
        {
          "type": "photo",
          "url": "https://pbs.twimg.com/media/...",
          "alt_text": "Description of image"
        },
        {
          "type": "video",
          "thumbnail_url": "https://pbs.twimg.com/...",
          "variants": [
            {
              "bitrate": 2176000,
              "content_type": "video/mp4",
              "url": "https://video.twimg.com/..."
            }
          ],
          "duration_ms": 30000
        }
      ],
      "quoted_tweet": {
        "tweet_id": "1111111111",
        "full_text": "The quoted tweet text...",
        "author": {
          "screen_name": "quoted_author",
          "name": "Quoted Author"
        }
      },
      "card": {
        "type": "summary_large_image",
        "url": "https://example.com",
        "title": "Article Title",
        "description": "Article description..."
      }
    },
    {
      "tweet_id": "9999999999",
      "status": "unavailable",
      "unavailable_reason": "Tweet deleted by author",
      "folders": []
    }
  ]
}
```

---

## 8. References

### API Documentation
- [X API v2 Bookmarks](https://docs.x.com/x-api/tweets/bookmarks/introduction) - Official API (800 limit)
- [TwitterInternalAPIDocument](https://github.com/fa0311/TwitterInternalAPIDocument/blob/master/docs/markdown/GraphQL.md) - Complete internal GraphQL API docs
- [X.com Home Timeline API Design](https://trekhleb.dev/blog/2024/api-design-x-home-timeline/) - Response structure analysis

### Open-Source Tools (Study)
- [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) - Most popular UserScript interceptor (~2,300 stars)
- [tweetxvault](https://github.com/lhl/tweetxvault) - Python CLI with auto query ID discovery and incremental sync
- [Twillot](https://github.com/twillot-app/twillot) - Chrome extension with folder support (~132 stars)
- [twitter-api-client](https://github.com/trevorhobenshield/twitter-api-client) - Python GraphQL API library (~1,900 stars)
- [twitter-cli](https://github.com/public-clis/twitter-cli) - Python CLI with anti-detection (~2,200 stars)
- [x-bookmark-exporter](https://github.com/CHIHI913/x-bookmark-exporter) - MV3 extension with three-layer architecture
- [bookmark-export](https://github.com/sahil-lalani/bookmark-export) - Simple Chrome extension

### Anti-Bot Measures
- [XClientTransaction (Python)](https://github.com/iSarabjitDhiman/XClientTransaction) - Transaction ID generation
- [XClientTransactionJS](https://github.com/swyxio/XClientTransactionJS) - JavaScript port

### Chrome Extension Development
- [Chrome MV3 Migration Guide](https://developer.chrome.com/docs/extensions/develop/migrate) - MV2 to MV3 differences
- [Chrome Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) - Termination behavior
- [Content Scripts World](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#world) - MAIN vs ISOLATED world

### Community Discussions
- [X Dev Community: Pagination stops after 3 pages](https://devcommunity.x.com/t/bookmarks-api-v2-stops-paginating-after-3-pages-no-next-token-returned/257339)
- [X Dev Community: 800 bookmark limit](https://devcommunity.x.com/t/bookmark-retrieves-only-800-most-recent/169433)
- [X Dev Community: Folder API caps at 20](https://devcommunity.x.com/t/bookmark-folder-limits-api-downloads-to-20-not-100-and-no-pagination/258508)
- [Console script gist](https://gist.github.com/gd3kr/948296cf675469f5028911f8eb276dbc) - 174 stars, many community variants
