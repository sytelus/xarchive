# xarchive - Research Findings

Comprehensive research findings from studying X.com's bookmark system, Chrome extension development under Manifest V3, and source-code-level analysis of every relevant open-source project.

---

## Table of Contents

1. [X.com Bookmark System Internals](#1-xcom-bookmark-system-internals)
2. [Authentication & Anti-Bot Measures](#2-authentication--anti-bot-measures)
3. [Rate Limiting & Throttling](#3-rate-limiting--throttling)
4. [GraphQL Response Structure](#4-graphql-response-structure)
5. [Bookmark Folders](#5-bookmark-folders)
6. [Pagination Deep-Dive](#6-pagination-deep-dive)
7. [Chrome Extension (MV3) Constraints](#7-chrome-extension-mv3-constraints)
8. [Open-Source Project Survey](#8-open-source-project-survey)
9. [Source-Code Analysis of Chrome Extensions](#9-source-code-analysis-of-chrome-extensions)
10. [Known Issues Catalog](#10-known-issues-catalog)
11. [Technique Catalog](#11-technique-catalog)

---

## 1. X.com Bookmark System Internals

### 1.1 Official API v2 (Unusable)

X.com provides an official Bookmarks API at `GET /2/users/{id}/bookmarks`. It is **not suitable** for complete export:

| Constraint | Detail |
|---|---|
| **Hard cap** | 800 most recent bookmarks -- confirmed by X engineering, not a bug |
| **Pagination** | Stops returning `meta.next_token` after 2-3 pages |
| **Rate limit** | 180 requests / 15-minute window (user-level) |
| **Auth** | OAuth 2.0 with PKCE; requires `bookmark.read`, `tweet.read`, `users.read` scopes |
| **Developer tier** | Basic or higher required |
| **Folder support** | None -- folder endpoint caps at 20 results with no pagination |

Sources:
- https://docs.x.com/x-api/tweets/bookmarks/introduction
- https://devcommunity.x.com/t/bookmark-retrieves-only-800-most-recent/169433
- https://devcommunity.x.com/t/bookmarks-api-v2-stops-paginating-after-3-pages-no-next-token-returned/257339
- https://devcommunity.x.com/t/bookmark-folder-limits-api-downloads-to-20-not-100-and-no-pagination/258508

### 1.2 Internal GraphQL API (Our Target)

X.com's web client uses internal GraphQL endpoints. These have **no 800-bookmark limit** -- users have exported 112,000+ bookmarks using them.

**Base URL pattern:**
```
https://x.com/i/api/graphql/{queryId}/{operationName}?variables={encoded_json}&features={encoded_json}
```

**Bookmark-related operations:**

| Operation | HTTP Method | Purpose |
|---|---|---|
| `Bookmarks` | GET | Fetch the user's bookmarked tweets (paginated) |
| `BookmarkFolderTimeline` | GET | Fetch tweets within a specific bookmark folder |
| `BookmarkFoldersSlice` | GET | List all bookmark folders |
| `BookmarkSearchTimeline` | GET | Search within bookmarks |
| `CreateBookmark` | POST | Bookmark a tweet |
| `DeleteBookmark` | POST | Remove a bookmark |
| `bookmarkTweetToFolder` | POST | Move a tweet into a folder |
| `createBookmarkFolder` | POST | Create a new folder |
| `DeleteBookmarkFolder` | POST | Delete a folder |
| `EditBookmarkFolder` | POST | Rename/modify a folder |
| `BookmarksAllDelete` | POST | Bulk delete all bookmarks |
| `RemoveTweetFromBookmarkFolder` | POST | Remove a tweet from a folder |

Source: https://github.com/fa0311/TwitterInternalAPIDocument/blob/master/docs/markdown/GraphQL.md

### 1.3 Query ID Rotation

**Critical:** X.com rotates GraphQL `queryId` values every 2-4 weeks. These IDs are embedded in the site's JavaScript bundles (files matching `responsive-web/client-web*.js`).

**Known query IDs (snapshot -- will expire):**

| Operation | Query ID |
|---|---|
| `Bookmarks` | `UyNF_BgJ5d5MbtuVukyl7A` (Twillot), `uzboyXSHSJrR-mGJqep0TQ` (tweetxvault) |
| `BookmarkFoldersSlice` | `i78YDd0Tza-dV4SYs58kRg` |
| `BookmarkFolderTimeline` | `e1T8IKkMr-8iQk7tNOyD_g` (Twillot), `hNY7X2xE2N7HVF6Qb_mu6w` (tweetxvault) |
| `BookmarkSearchTimeline` | `MAJ05S9KeZYGt-TSPQJCuQ` or `9467z_eRSDs6mi8CHRLxnA` |

**Extraction regex** for scraping current IDs from JS bundles:
```
queryId:\s*"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:\s*"([^"]+)"
```

Source: https://github.com/public-clis/twitter-cli/blob/main/twitter_cli/graphql.py

### 1.4 Request Construction

**URL construction:** JSON-encode the `variables` and `features` objects, URL-encode them, pass as query parameters:

```
https://x.com/i/api/graphql/{queryId}/{operationName}?variables={encoded}&features={encoded}
```

**Variables for `Bookmarks` endpoint:**
```json
{
  "count": 100,
  "cursor": "<pagination_cursor_string>",
  "includePromotedContent": false
}
```

**Variables for `BookmarkFolderTimeline`:**
```json
{
  "bookmark_collection_id": "<folder_id>",
  "count": 50,
  "cursor": "<pagination_cursor_string>",
  "includePromotedContent": false
}
```

**Variables for `BookmarkFoldersSlice`:**
```json
{}
```

**Feature flags** (approximately 19 boolean flags, subject to change):
```json
{
  "responsive_web_graphql_exclude_directive_enabled": true,
  "verified_phone_label_enabled": false,
  "creator_subscriptions_tweet_preview_api_enabled": true,
  "responsive_web_graphql_timeline_navigation_enabled": true,
  "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
  "c9s_tweet_anatomy_moderator_badge_enabled": true,
  "tweetypie_unmention_optimization_enabled": true,
  "responsive_web_edit_tweet_api_enabled": true,
  "graphql_is_translatable_rweb_tweet_is_translatable_enabled": true,
  "view_counts_everywhere_api_enabled": true,
  "longform_notetweets_consumption_enabled": true,
  "responsive_web_twitter_article_tweet_consumption_enabled": true,
  "tweet_awards_web_tipping_enabled": false,
  "longform_notetweets_rich_text_read_enabled": true,
  "longform_notetweets_inline_media_enabled": true,
  "rweb_video_timestamps_enabled": true,
  "responsive_web_media_download_video_enabled": true,
  "freedom_of_speech_not_reach_fetch_enabled": true,
  "standardized_nudges_misinfo": true,
  "responsive_web_enhance_cards_enabled": false,
  "graphql_timeline_v2_bookmark_timeline": true
}
```

The last flag (`graphql_timeline_v2_bookmark_timeline`) is bookmark-specific. Twillot adds it to the common set specifically for bookmark requests.

**Important:** Only include `true`-valued features to avoid HTTP 414 (URI Too Long) errors.

Sources:
- https://github.com/public-clis/twitter-cli/blob/main/twitter_cli/graphql.py
- https://github.com/twillot-app/twillot (packages/utils/api/twitter-features.ts)

### 1.5 URL Encoding Helper

From Twillot's source (`packages/utils/api/twitter-base.ts`):
```javascript
function flatten(obj, stringify = true) {
  return Object.keys(obj)
    .map(key => `${key}=${encodeURIComponent(stringify ? JSON.stringify(obj[key]) : obj[key])}`)
    .join('&');
}
```

Each variable value is JSON.stringify'd and then URL-encoded. The variables and features objects are each flattened this way.

---

## 2. Authentication & Anti-Bot Measures

### 2.1 Required HTTP Headers

Every request to X.com's internal GraphQL API requires these headers:

| Header | Value | Source |
|---|---|---|
| `Authorization` | `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA` | Hardcoded constant -- public, identifies requests as coming from the web app. Same across all users. |
| `Cookie` | Must include `auth_token=<value>; ct0=<value>` | From user's browser session |
| `X-Csrf-Token` | Must exactly match the `ct0` cookie value | CSRF protection |
| `X-Twitter-Active-User` | `"yes"` | Required |
| `X-Twitter-Auth-Type` | `"OAuth2Session"` | Required for authenticated endpoints |
| `X-Twitter-Client-Language` | `"en"` (or user's locale) | Required |
| `Content-Type` | `"application/json"` | Required |
| `User-Agent` | Chrome-like UA string | Required |
| `Origin` | `https://x.com` | Required -- this is what `declarativeNetRequest` spoofs |
| `Referer` | `https://x.com/` | Required |
| `X-Client-Transaction-Id` | Algorithmically generated value | Newer requirement, may not be enforced for all endpoints |
| `X-Client-Uuid` | UUID string | Captured from live requests |

Sources:
- https://github.com/sahil-lalani/bookmark-export (background.js)
- https://github.com/public-clis/twitter-cli/blob/main/twitter_cli/client.py

### 2.2 Chrome Extension Authentication Advantage

A Chrome extension with `host_permissions` for `https://x.com/*` can:
1. Use `chrome.cookies` API to read `ct0` cookie directly
2. Make `fetch()` calls with `credentials: 'include'` to automatically carry the user's session cookies
3. Use `chrome.webRequest.onSendHeaders` to passively capture all auth headers from X.com's own requests

This means the extension never needs the user's password or to manage sessions directly. It piggybacks on the existing browser session.

### 2.3 User ID from Cookie

The logged-in user's numeric ID is available in the `twid` cookie. The value is URL-encoded as `u%3D{numeric_id}`.

From Twillot's content script (6 lines total):
```javascript
for (const item of document.cookie.split(';')) {
  const [key, value] = item.split('=');
  if (key.includes('twid')) {
    const userId = value.replace('u%3D', '');
    // Store userId
    break;
  }
}
```

### 2.4 X-Client-Transaction-Id

This is a newer anti-bot header added by X.com. Generation algorithm requires:
1. Fetching the X.com homepage HTML
2. Fetching an "ondemand.s" JavaScript file referenced in the HTML
3. Running a generation algorithm using the HTTP method and API path

**Libraries implementing this:**
- Python: https://github.com/iSarabjitDhiman/XClientTransaction
- JavaScript: https://github.com/swyxio/XClientTransactionJS

**Twillot's approach:** Capture the header from a live request, then mutate it for each subsequent request using `incrementFirstNumber()` -- a function that randomly increments one digit in the string. This is simpler than the full generation algorithm and appears to work.

**Practical observation:** Many authenticated endpoints don't appear to enforce this header. It may be safe to try without it first.

### 2.5 `ct0` Cookie Rotation

The `ct0` cookie (CSRF token) can change during long sessions. The `X-Csrf-Token` header must always match the current `ct0` cookie value.

**Solution:** Before each API call (or batch of calls), re-read the `ct0` cookie via `chrome.cookies.get({url: 'https://x.com', name: 'ct0'})` rather than relying on a cached value.

### 2.6 Anti-Scraping Measures (2024-2025)

X.com has progressively added anti-scraping measures:
- Guest tokens bound to browser fingerprints
- Datacenter IPs permanently banned
- Increased CAPTCHA challenges
- Query ID rotation every 2-4 weeks
- Feature flag changes without notice
- `X-Client-Transaction-Id` header requirement

A Chrome extension running in the user's own browser avoids most of these since requests appear to come from a normal browsing session.

Sources:
- https://scrapfly.io/blog/posts/how-to-scrape-twitter
- https://github.com/prinsss/twitter-web-exporter

---

## 3. Rate Limiting & Throttling

### 3.1 Official API v2 Limits

| Operation | Rate Limit |
|---|---|
| GET bookmarks | 180 requests / 15-minute window |
| POST/DELETE bookmarks | 50 requests / 15-minute window |

### 3.2 Internal GraphQL API Limits

The internal API has different, undocumented rate limits. Practical observations from open-source tools:

| Signal | Detail |
|---|---|
| **HTTP 429 response** | Rate limit exceeded |
| **JSON error code 88** | Rate limit exceeded (can arrive with 200 status) |
| **Response headers** | `X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining`, `X-Rate-Limit-Reset` |

### 3.3 Rate Limit Headers

From Twillot's implementation (`packages/utils/api/twitter-base.ts`):
```javascript
// After each fetch response:
const limit = response.headers.get('X-Rate-Limit-Limit');       // e.g., "500"
const remaining = response.headers.get('X-Rate-Limit-Remaining'); // e.g., "498"
const reset = response.headers.get('X-Rate-Limit-Reset');       // Unix timestamp
```

When `remaining` hits 0, the extension should pause until `reset` timestamp + a small buffer.

Twillot calculates wait time as:
```javascript
const leftTime = reset
  ? Math.ceil((parseInt(reset) * 1000 - Date.now()) / 60000)
  : 10; // default 10 minutes if no header
```

### 3.4 Recommended Rate Limiting Configuration

Synthesized from tweetxvault and practical experience:

```
Base delay between pages:    2.5 seconds
Random jitter:               0.7x - 1.5x multiplier on base delay
On HTTP 429:                 Exponential backoff: base_delay * 2^attempt + random(0, 1000ms)
Max retries per page:        5
After 3 consecutive 429s:    Cooldown pause of 300 seconds (5 minutes)
After 5 consecutive 429s:    Stop export, prompt user to try later
```

Source: https://github.com/lhl/tweetxvault

### 3.5 Account Freezing Risk

**Critical finding from Twillot study:** Twillot users have reported account freezing after exporting large bookmark sets. Code analysis reveals the cause: **Twillot has zero delay between API calls** -- it fires pages back-to-back in a `while(true)` loop and runs up to 5 parallel sync streams simultaneously.

**Lesson:** Rate limiting isn't just about avoiding 429s -- it's about avoiding account-level punitive actions. Conservative 2.5s+ delays with randomized jitter are essential.

### 3.6 twitter-cli's Anti-Detection Techniques

The twitter-cli project uses additional techniques to avoid rate limits:
- **TLS fingerprint impersonation** via `curl_cffi` library
- **Dynamic Chrome version matching** in User-Agent
- **Request timing jitter** with randomized delays
- **Full cookie forwarding** (all cookies, not just auth-related ones)

For a Chrome extension, TLS fingerprinting is not applicable (requests already come from real Chrome), but timing jitter and realistic headers remain important.

Source: https://github.com/public-clis/twitter-cli

---

## 4. GraphQL Response Structure

### 4.1 Top-Level Response

Two known response paths (the API has shifted between them):

```javascript
// Try both:
const instructions =
  response.data?.bookmark_timeline_v2?.timeline?.instructions ||
  response.data?.bookmark_timeline?.timeline?.instructions;
```

### 4.2 Full Response Tree

```
response
  data
    bookmark_timeline_v2
      timeline
        instructions[]                    # Array of instruction objects
          type: "TimelineAddEntries"
          entries[]                        # Array of timeline entries
            entryId: "tweet-1234567890"   # Tweet entries
            sortIndex: "1234567890"       # Bookmark ordering (NOT tweet creation order)
            content
              __typename: "TimelineTimelineItem"
              itemContent
                tweet_results
                  result                   # The actual tweet object (see 4.3)
            
            entryId: "cursor-bottom-XXXX" # Pagination cursor entries
            content
              __typename: "TimelineTimelineCursor"
              cursorType: "Bottom"
              value: "<opaque_cursor_string>"
            
            entryId: "cursor-top-XXXX"    # Top cursor (for newer entries)
            content
              cursorType: "Top"
              value: "<opaque_cursor_string>"
```

### 4.3 Tweet Object Structure

```
tweet_results.result
  __typename: "Tweet"                     # or "TweetWithVisibilityResults" or "TweetTombstone"
  rest_id: "1234567890"                   # Tweet snowflake ID
  
  core
    user_results
      result
        __typename: "User"
        rest_id: "987654321"              # Author's user ID
        legacy
          screen_name: "author_handle"     # @handle without @
          name: "Author Display Name"
          profile_image_url_https: "https://pbs.twimg.com/..."
          followers_count: 1500
          verified: false
          description: "Author bio..."
  
  legacy
    full_text: "Tweet text with t.co URLs..."
    created_at: "Wed Oct 25 12:34:56 +0000 2023"
    lang: "en"
    favorite_count: 42
    retweet_count: 10
    reply_count: 5
    quote_count: 3
    bookmark_count: 7
    conversation_id_str: "1234567890"     # Thread grouping
    in_reply_to_status_id_str: null       # Parent tweet if reply
    in_reply_to_user_id_str: null
    possibly_sensitive: false
    
    entities
      urls[]
        url: "https://t.co/abc"
        expanded_url: "https://example.com/article"
        display_url: "example.com/article"
      hashtags[]
        text: "programming"
      user_mentions[]
        screen_name: "mentioned_user"
        id_str: "111222333"
    
    extended_entities                      # Richer media data than entities.media
      media[]
        type: "photo" | "video" | "animated_gif"
        media_url_https: "https://pbs.twimg.com/media/..."
        ext_alt_text: "Image description"
        sizes
          large: { w: 1920, h: 1080 }
        video_info                         # Only for video/animated_gif
          duration_millis: 30000
          variants[]
            bitrate: 2176000
            content_type: "video/mp4"
            url: "https://video.twimg.com/..."
  
  note_tweet                               # Long-form tweets (>280 chars)
    note_tweet_results
      result
        text: "The full long-form text..."
        entity_set
          urls[]                            # URLs in the long-form text
  
  quoted_status_result                     # Quoted tweet (nested)
    result                                 # Same Tweet structure, recursive
  
  views
    count: "1200"                          # View count (string)
  
  source: "<a href='...'>Twitter for iPhone</a>"  # HTML string
  
  card                                     # Link preview card
    legacy
      binding_values[]
        key: "title" | "description" | "thumbnail_image_original" | ...
        value: { string_value: "..." }
```

### 4.4 Special Tweet Types

**`TweetWithVisibilityResults`** -- wrapper for tweets with restricted visibility:
```javascript
// Unwrap:
const tweet = result.__typename === 'TweetWithVisibilityResults'
  ? result.tweet
  : result;
```

**`TweetTombstone`** -- deleted or suspended tweet:
```
tweet_results.result.__typename: "TweetTombstone"
tweet_results.result.tombstone
  text: { text: "This Tweet was deleted by the Tweet author." }
```

**`TweetUnavailable`** -- NSFW or restricted:
```
tweet_results.result.__typename: "TweetUnavailable"
tweet_results.result.reason: "NsfwLoggedOut"
```

**Null result** -- sometimes `tweet_results.result` is simply `null`.

Sources:
- https://trekhleb.dev/blog/2024/api-design-x-home-timeline/
- https://github.com/CHIHI913/x-bookmark-exporter (public/injected/main.js)
- https://github.com/prinsss/twitter-web-exporter

### 4.5 Available Data Per Bookmark

| Field | Path | Notes |
|---|---|---|
| Tweet ID | `rest_id` | Snowflake ID |
| Sort index | `entry.sortIndex` | Bookmark ordering (differs from tweet creation order) |
| Full text (short) | `legacy.full_text` | Tweets <=280 chars |
| Full text (long) | `note_tweet.note_tweet_results.result.text` | Note tweets >280 chars; prefer this over `legacy.full_text` |
| Created at | `legacy.created_at` | String format: `"Wed Oct 25 12:34:56 +0000 2023"` |
| Language | `legacy.lang` | ISO 639-1 |
| Author screen name | `core.user_results.result.legacy.screen_name` | Without `@` prefix |
| Author display name | `core.user_results.result.legacy.name` | |
| Author user ID | `core.user_results.result.rest_id` | |
| Author avatar | `core.user_results.result.legacy.profile_image_url_https` | |
| Author verified | `core.user_results.result.legacy.verified` | |
| Author followers | `core.user_results.result.legacy.followers_count` | |
| Like count | `legacy.favorite_count` | |
| Retweet count | `legacy.retweet_count` | |
| Reply count | `legacy.reply_count` | |
| Quote count | `legacy.quote_count` | |
| Bookmark count | `legacy.bookmark_count` | May be approximate |
| View count | `views.count` | String, parse as integer |
| Media | `legacy.extended_entities.media[]` | Prefer over `entities.media` -- richer data |
| Photo original URL | `media_url_https` + `?format=jpg&name=orig` | Append suffix for original resolution |
| Video best quality | `video_info.variants` filtered by `content_type === 'video/mp4'`, sorted by `bitrate` descending | |
| URLs | `legacy.entities.urls[]` | Includes `expanded_url` |
| Hashtags | `legacy.entities.hashtags[]` | `.text` field |
| Mentions | `legacy.entities.user_mentions[]` | `.screen_name` and `.id_str` |
| Quote tweet | `quoted_status_result.result` | Recursive tweet object |
| Reply parent | `legacy.in_reply_to_status_id_str` | |
| Conversation ID | `legacy.conversation_id_str` | For thread grouping |
| Source app | `source` | HTML string, needs parsing |
| Sensitive | `legacy.possibly_sensitive` | |
| Alt text | `extended_entities.media[].ext_alt_text` | Image descriptions |
| Card (link preview) | `card.legacy.binding_values[]` | Title, description, thumbnail |

### 4.6 URL Expansion in Tweet Text

Tweet text contains `t.co` shortened URLs. To get readable text, replace them with `expanded_url` from entities:

From x-bookmark-exporter's approach and Twillot's `toRecord()`:
```javascript
function expandUrls(text, urls) {
  for (const urlEntity of urls) {
    text = text.replace(urlEntity.url, urlEntity.expanded_url);
  }
  return text;
}
```

For note tweets, use `note_tweet.note_tweet_results.result.entity_set.urls` instead of `legacy.entities.urls`.

---

## 5. Bookmark Folders

### 5.1 Overview

Bookmark folders are an **X Premium** feature. Non-premium accounts may get an error or empty response when querying folder endpoints.

### 5.2 List All Folders

**Operation:** `BookmarkFoldersSlice`
**Method:** GET
**Variables:** `{}` (or `{"cursor": "<value>"}` for subsequent pages)

**Response path:**
```
data.viewer.user_results.result.bookmark_collections_slice.items[]
```

**Sample response (from Twillot docs):**
```json
{
  "data": {
    "viewer": {
      "user_results": {
        "result": {
          "bookmark_collections_slice": {
            "items": [
              { "id": "1794418757911433313", "name": "Social Science" },
              { "id": "1794165526627033447", "name": "Email Marketing" }
            ]
          }
        }
      }
    }
  }
}
```

### 5.3 Fetch Tweets in a Folder

**Operation:** `BookmarkFolderTimeline`
**Method:** GET
**Variables:**
```json
{
  "bookmark_collection_id": "<folder_id>",
  "count": 50,
  "cursor": "<pagination_cursor>",
  "includePromotedContent": false
}
```

**Response path:**
```
data.bookmark_collection_timeline.timeline.instructions[]
```

Same `TimelineAddEntries` structure as the main bookmarks timeline. Same cursor-based pagination.

### 5.4 Folder Assignment Strategy

A tweet can appear in the main "All Bookmarks" list AND in one or more folders. To capture all folder assignments:

1. Fetch all folders via `BookmarkFoldersSlice`
2. For each folder, fetch all tweets via `BookmarkFolderTimeline` (paginated)
3. Build a map: `tweet_id -> [folder_id, folder_id, ...]`
4. Fetch main bookmark timeline via `Bookmarks` (paginated)
5. Merge: for each bookmark, look up its folder assignments from the map

**Important:** Twillot stores `folder` as a single string per tweet (one folder only). This is a limitation -- a tweet can be in multiple folders. xarchive should use an array.

### 5.5 Official API v2 Folder Limitation

The official API v2 folder endpoint returns a **hard-capped 20 results with no pagination**. This makes it impossible to fully export folder contents via the official API.

Source: https://devcommunity.x.com/t/bookmark-folder-limits-api-downloads-to-20-not-100-and-no-pagination/258508

The internal GraphQL `BookmarkFolderTimeline` does not appear to have this 20-result cap, but its actual limits should be tested.

### 5.6 Folder Support in Existing Tools

| Tool | Folder Support | Implementation |
|---|---|---|
| twitter-web-exporter | No | -- |
| tweetxvault | No | -- |
| **Twillot** | **Yes** | `BookmarkFoldersSlice` + `BookmarkFolderTimeline`; single folder per tweet |
| twitter-api-client | Partial | Has `bookmarkTweetToFolder` mutation but no folder listing |
| x-bookmark-exporter | No | -- |
| bookmark-export | No | -- |
| All others | No | -- |

---

## 6. Pagination Deep-Dive

### 6.1 Cursor-Based Pagination

X.com uses cursor-based pagination for all timeline endpoints. Cursors appear as special entries within the response's `entries` array:

```json
{
  "entryId": "cursor-bottom-1789012345678901234",
  "content": {
    "__typename": "TimelineTimelineCursor",
    "cursorType": "Bottom",
    "value": "HBb2lIHQsq26xS0AAA=="
  }
}
```

- **Bottom cursor:** Used to fetch the next (older) page
- **Top cursor:** Used to fetch newer entries (not needed for full export)

To paginate: extract the `value` from the `cursor-bottom-*` entry, pass it as the `cursor` variable in the next request.

### 6.2 Cursor Extraction Code

From Twillot's `twitter-res-utils.ts`:
```javascript
function getBottomCursor(instruction) {
  const entries = instruction.entries.filter(
    e => e.content.__typename === 'TimelineTimelineCursor'
  );
  const bottom = entries.find(e => e.content.cursorType === 'Bottom');
  return bottom?.content.value;
}
```

From bookmark-export's `background.js`:
```javascript
function getNextCursor(entries) {
  const cursorEntry = entries.find(e => e.entryId.startsWith('cursor-bottom-'));
  return cursorEntry?.content?.value;
}
```

### 6.3 End-of-Pagination Detection

Pagination is complete when **any** of these conditions is met:
1. No `cursor-bottom-*` entry is present in the response
2. The bottom cursor value is identical to the previous request's cursor (infinite loop)
3. Zero tweet entries returned for multiple consecutive pages

**Critical quirk:** Empty pages (containing only cursor entries, no tweets) are possible and should **NOT** be treated as end-of-data. Only the absence of a bottom cursor is authoritative.

### 6.4 Page Size

All studied projects use a page size of **100** (`count: 100` in variables) for the main bookmarks endpoint. Twillot uses 100 for all endpoints. The folder timeline may use 50.

### 6.5 Pagination Across Official API v2

The official API v2 has a different problem: pagination stops after 2-3 pages (the response stops returning `meta.next_token`), enforcing the 800-bookmark hard ceiling. This is a documented, intentional limitation -- NOT a bug.

Sources:
- https://devcommunity.x.com/t/bookmarks-api-v2-stops-paginating-after-3-pages-no-next-token-returned/257339
- https://devcommunity.x.com/t/how-to-get-more-than-800-bookmarks/204704

### 6.6 `sortIndex` Field

Each entry has a `sortIndex` field that preserves bookmark ordering. This is different from tweet chronological order -- it represents when the user bookmarked the tweet, not when the tweet was created. The x-bookmark-exporter project correctly uses this for ordering.

---

## 7. Chrome Extension (MV3) Constraints

### 7.1 Service Worker Lifecycle

| Constraint | Detail |
|---|---|
| **Inactivity timeout** | Terminated after **30 seconds** of inactivity |
| **Timer reset** | Any Chrome API call or event resets the 30s timer |
| **Hard limit** | Single request processing hard limit of **5 minutes** |
| **Global state** | All module-level variables are **lost** on termination |
| **Restart** | Service worker restarts from scratch on next event |

**Keepalive techniques:**
- Call `chrome.runtime.getPlatformInfo()` every 25 seconds
- Maintain a `chrome.runtime.connect()` port from content script (Chrome 114+)
- Use `chrome.alarms` for periodic wakeup

**Key insight from Twillot study:** Avoid the problem entirely by running heavy logic in the options page, which is a regular tab with no termination limit.

### 7.2 Options Page as Runtime

Twillot's architecture -- confirmed by code analysis -- runs ALL export logic (API calls, pagination, storage, UI) in the options page. The service worker is only ~17 lines:
- Opens options page on icon click
- Passively captures headers via `webRequest.onSendHeaders`

The options page stays alive as long as the tab is open. It has:
- Full DOM access (Blob creation, `<a>` download triggers)
- Same memory budget as a regular tab (~4GB on 64-bit Chrome)
- IndexedDB access
- `fetch()` with `credentials: 'include'`

### 7.3 Intercepting Requests/Responses in MV3

| Method | Read request headers? | Read response body? | MV3 compatible? |
|---|---|---|---|
| `chrome.webRequest.onBeforeSendHeaders` | Yes (with `requestHeaders` extra) | No | Yes |
| `chrome.webRequest.onSendHeaders` | Yes | No | Yes |
| `chrome.webRequest.onCompleted` | Response headers only | No | Yes |
| `chrome.debugger` (CDP) | Yes | Yes (`Network.getResponseBody`) | Yes, but shows yellow infobar |
| `declarativeNetRequest` | No | No (header modification only) | Yes |
| MAIN world fetch/XHR hook | Yes (request body) | Yes (response body via clone) | Yes |
| ISOLATED world content script | No (no page context access) | No | Yes |

**For auth header capture:** `webRequest.onSendHeaders` is the cleanest approach -- passive, no injection needed, captures all headers X.com sends.

**For response interception (if needed):** MAIN world script injection with `response.clone()` is the only MV3-compatible approach that can read response bodies.

### 7.4 DeclarativeNetRequest for Origin Spoofing

When the extension's options page makes `fetch()` calls to `x.com/i/api/graphql/*`, the `Origin` header will be `chrome-extension://{id}` instead of `https://x.com`. X.com rejects this.

**Solution:** Use `declarativeNetRequest` to rewrite the `Origin` header:

```json
{
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
    "resourceTypes": ["xmlhttprequest"]
  }
}
```

**Twillot's bug:** Their rule condition is overly broad (`main_frame` + `xmlhttprequest` for ALL `*.x.com/*`), which forces `Origin: https://x.com` on normal X.com page loads too -- causing issue #127 ("Running twillot prevents twitter from loading").

**Fix:** Scope the rule using `initiatorDomains` to only affect extension-originated requests:
```json
"condition": {
  "urlFilter": "https://x.com/i/api/graphql/*",
  "resourceTypes": ["xmlhttprequest"],
  "initiatorDomains": ["<extension_id>"]
}
```

### 7.5 Required Permissions

| Permission | Purpose |
|---|---|
| `storage` | Store auth credentials in `chrome.storage.local` |
| `unlimitedStorage` | Allow IndexedDB to exceed default quotas for large exports |
| `cookies` | Read `ct0` cookie via `chrome.cookies.get()` |
| `webRequest` | Passive header capture via `onSendHeaders` |
| `declarativeNetRequest` | Origin header spoofing |
| `declarativeNetRequestWithHostAccess` | Required alongside `declarativeNetRequest` for host-permission-gated rules |
| `downloads` | Trigger file download via `chrome.downloads.download()` |
| **Host permissions:** `https://x.com/*`, `https://twitter.com/*` | Make authenticated fetch calls to X.com API |

### 7.6 Content Script World Types

| World | Access | Use case |
|---|---|---|
| `ISOLATED` (default) | Separate JS context; can read DOM and `document.cookie`; has `chrome.*` APIs | Reading cookies, DOM observation |
| `MAIN` | Same context as page's JS; can intercept `fetch`/`XHR`; NO `chrome.*` APIs | Monkey-patching network calls |

For xarchive, ISOLATED world is sufficient (just reads `twid` cookie). MAIN world injection is not needed since `webRequest` handles auth capture.

### 7.7 Content Security Policy (CSP) Constraints

- MAIN world scripts are subject to X.com's CSP
- X.com's CSP blocks `eval()` and dynamic code generation
- All monkey-patching must use static function definitions
- Chrome 130+ added `use_dynamic_url` for `web_accessible_resources` but no breaking CSP changes for content scripts specifically

### 7.8 Large File Download

Service workers lack full `Blob`/`URL.createObjectURL` support. For downloading large JSON files:

**Option A (options page context):** Create a Blob and use `<a>` click:
```javascript
const blob = new Blob([jsonString], { type: 'application/json' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'xarchive_export.json';
a.click();
URL.revokeObjectURL(url);
```

**Option B:** Use `chrome.downloads.download()` with a data URL (limited by URL size).

**Option C:** Use an offscreen document for Blob creation (if running from service worker context).

Since xarchive runs from the options page, Option A is the simplest and most reliable.

---

## 8. Open-Source Project Survey

### 8.1 Complete Catalog

#### Chrome Extensions

| Project | Stars | Active | Approach | Folders | Key Technique |
|---|---|---|---|---|---|
| [Twillot](https://github.com/twillot-app/twillot) | ~132 | Nov 2024 | Direct GraphQL from options page | **Yes** | Options page runtime; declarativeNetRequest; folder APIs |
| [x-bookmark-exporter](https://github.com/CHIHI913/x-bookmark-exporter) | 0 | Active | Response intercept via injected script | No | Three-layer architecture; dual fetch+XHR hooks |
| [bookmark-export](https://github.com/sahil-lalani/bookmark-export) | ~20 | Low (3 commits) | Direct API replay from service worker | No | Dynamic query ID capture from webRequest URL patterns |
| [canwe/x-bookmark-export](https://github.com/canwe/x-bookmark-export) | 0 | Fork | Identical fork of bookmark-export | No | Same as above |

#### UserScripts

| Project | Stars | Active | Approach | Key Technique |
|---|---|---|---|---|
| [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) | ~2,300 | Yes (v1.4.0, Feb 2026) | XHR interception via Tampermonkey | Dexie for IndexedDB; 15+ data types; i18n |

#### CLI Tools (Python)

| Project | Stars | Active | Key Technique |
|---|---|---|---|
| [tweetxvault](https://github.com/lhl/tweetxvault) | ~8 | Yes | Auto query ID discovery from JS bundles; incremental sync; crash-safe checkpoints |
| [twitter-api-client](https://github.com/trevorhobenshield/twitter-api-client) | ~1,900 | Yes | Comprehensive GraphQL library; cookie-based auth |
| [twitter-cli](https://github.com/public-clis/twitter-cli) | ~2,200 | Yes | TLS fingerprint impersonation; anti-detection; full cookie forwarding |
| [Twitter-Archive](https://github.com/jarulsamy/Twitter-Archive) | ~140 | 60 commits | OAuth 2.0 browser flow; multi-threaded media download |
| [twitter-bookmark-archiver](https://github.com/nornagon/twitter-bookmark-archiver) | ~138 | Low | OAuth 2.0; HTML export with embedded media |
| [twscrape](https://github.com/vladkens/twscrape) | Popular | Yes | Account pool management; async Python |

#### CLI Tools (JavaScript/Node.js)

| Project | Stars | Key Technique |
|---|---|---|
| [x-bookmarks-export](https://github.com/SPhillips1337/x-bookmarks-export) | 0 | OAuth2 PKCE; auto-pause on 429 |
| [fetch-twitter-bookmarks](https://github.com/helmetroo/fetch-twitter-bookmarks) | ~14 | Playwright for auth, direct HTTP for data; SQLite storage |

#### Browser Automation

| Project | Stars | Key Technique |
|---|---|---|
| [export_twitter_bookmarks_puppeteer](https://github.com/memory-lovers/export_twitter_bookmarks_puppeteer) | ~35 | Puppeteer; continuous scrolling; optional bookmark deletion |
| [twitter-bookmark-export](https://github.com/fastorder/twitter-bookmark-export) | 1 | Puppeteer; auto-resume from last position |

#### Console Scripts

| Project | Stars | Key Technique |
|---|---|---|
| [gd3kr gist](https://gist.github.com/gd3kr/948296cf675469f5028911f8eb276dbc) | 174 | DOM scraping via `querySelectorAll('article[data-testid="tweet"]')`; MutationObserver |
| [divyajyotiuk gist](https://gist.github.com/divyajyotiuk/9fb29c046e1dfcc8d5683684d7068efe) | - | GraphQL bookmark API console script |

#### Reference / Documentation Projects

| Project | Purpose |
|---|---|
| [TwitterInternalAPIDocument](https://github.com/fa0311/TwitterInternalAPIDocument) | Complete docs for all internal GraphQL operations |
| [AwesomeTwitterUndocumentedAPI](https://github.com/fa0311/AwesomeTwitterUndocumentedAPI) | Curated list of undocumented API resources |
| [XClientTransaction](https://github.com/iSarabjitDhiman/XClientTransaction) | Python implementation of transaction ID generation |
| [XClientTransactionJS](https://github.com/swyxio/XClientTransactionJS) | JavaScript port of transaction ID generation |

#### Commercial Tools (for reference)

| Tool | Type | Note |
|---|---|---|
| ArchivlyX | Chrome Extension | AI organization; encrypted; freemium |
| Circleboom | Web service | Official X Enterprise partner |
| Dewey | Web service | Multi-platform |
| xbe.pages.dev | Free web tool | Simple HTML export; limited to last 1,000 |

### 8.2 Approach Comparison

| Approach | No 800 limit? | Fully automated? | Requires dev account? | Account risk? | Folder support? |
|---|---|---|---|---|---|
| Official API v2 | No (800 max) | Yes | Yes | Low | No |
| GraphQL interception (UserScript) | Yes | No (manual scrolling) | No | Low | Possible |
| Direct GraphQL API calls (extension/CLI) | Yes | Yes | No | Medium | Yes |
| Browser automation (Puppeteer/Playwright) | Yes | Yes | No | Medium | No |
| DOM scraping (console script) | Yes | Semi | No | Low | No |

---

## 9. Source-Code Analysis of Chrome Extensions

### 9.1 Twillot (`twillot-app/twillot`) - The Most Feature-Complete

**Repository structure:**
```
/
├── exporter/              # Main bookmark export extension
│   └── src/
│       ├── manifest.ts    # CRXJS manifest definition
│       ├── background/    # Service worker (~17 lines)
│       ├── contentScript/  # Cookie reader (~6 lines)
│       ├── options/       # Full export UI + logic (THE RUNTIME)
│       └── rules.json     # declarativeNetRequest rules
├── packages/utils/        # Shared library
│   ├── api/
│   │   ├── twitter-base.ts     # fetch wrapper, auth header assembly
│   │   ├── twitter.ts          # API functions (getBookmarks, getFolders, etc.)
│   │   ├── twitter-features.ts # Feature flag constants
│   │   └── twitter-res-utils.ts # Response parsing, cursor extraction
│   ├── db/
│   │   └── tweets.ts           # IndexedDB (raw IDB) operations
│   ├── hooks/
│   │   └── useAuth.tsx         # Auth flow hook
│   ├── exporter.ts             # JSON/CSV/HTML export
│   └── types/index.ts          # All type definitions, endpoint enums
├── multi-publish/         # Separate extension
└── scripts/               # Payment integration
```

**Tech stack:** TypeScript, SolidJS, Vite + `@crxjs/vite-plugin`, Tailwind CSS, `@kobalte/core`, pnpm monorepo, Vitest.

**Manifest permissions:**
- `storage` -- for `chrome.storage.local`
- `webRequest` -- to intercept request headers
- `declarativeNetRequest` + `declarativeNetRequestWithHostAccess` -- to inject Origin header

**Service worker code (`background/index.ts`, ~17 lines):**
```typescript
chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage();
});

chrome.webRequest.onSendHeaders.addListener(
  async (details) => {
    const { url, initiator } = details;
    if (initiator !== Host) return;
    await syncAuthHeaders(details.requestHeaders);
  },
  {
    types: ['xmlhttprequest'],
    urls: [`${Host}/i/api/graphql/*`],
  },
  ['requestHeaders'],
);
```

**Content script (`contentScript/index.ts`, 6 lines):**
```typescript
for (const item of document.cookie.split(';')) {
  const [key, value] = item.split('=');
  if (key.includes('twid')) {
    setCurrentUserId(value.replace('u%3D', ''));
    break;
  }
}
```

**Auth header extraction (`syncAuthHeaders`):**
Captures four headers: `Authorization`, `X-Csrf-Token`, `X-Client-Uuid`, `X-Client-Transaction-Id`. Stored in `chrome.storage.local` with key pattern `user:{uid}:{key}`.

**Auth flow for new users:** The `useAuth` hook opens `https://x.com/i/bookmarks?twillot=reauth` in a background tab (`active: false`), polls `chrome.storage.local` every 3 seconds for captured headers, closes the tab once detected.

**API call construction (`twitter-base.ts`):**
- Retrieves stored auth headers via `getAuthInfo()`
- Assembles headers: `Authorization`, `X-Csrf-Token`, `X-Client-Uuid`, `X-Client-Transaction-Id`, `Content-Type: application/json`, `X-Twitter-Active-User: yes`, `X-Twitter-Auth-Type: OAuth2Session`
- Uses `credentials: 'include'` for cookie forwarding
- 15-second timeout via `fetchWithTimeout`
- Tracks rate limit info from response headers

**Transaction ID mutation (`incrementFirstNumber`):**
Before each request, the captured `X-Client-Transaction-Id` is slightly modified: one digit in the string is randomly incremented. This makes each request look slightly different from the original captured value.

**Pagination (`sync.tsx`):**
```typescript
while (true) {
  const response = await func(cursorEntry);
  const docs = parseResponse(response);
  if (docs.length === 0) break;
  await db.upsertRecords(docs);
  cursorEntry = getBottomCursor(response);
  if (!cursorEntry) break;
  saveCursor(category, cursorEntry);
}
```

**Critical flaw: No delay between iterations.** This is the root cause of reported account freezing. The loop fires API calls back-to-back with zero pause.

**Hardcoded query IDs (`types/index.ts`):**
```typescript
export enum EndpointQuery {
  LIST_BOOKMARKS = 'UyNF_BgJ5d5MbtuVukyl7A',
  GET_FOLDERS = 'i78YDd0Tza-dV4SYs58kRg',
  GET_FOLDER_TWEETS = 'e1T8IKkMr-8iQk7tNOyD_g',
  // ... more endpoints
}
```
These will break when X.com rotates them. No dynamic discovery mechanism exists.

**Bookmark features flag (`twitter-features.ts`):**
```typescript
export const BOOKMARK_FEATURES = {
  ...COMMON_FEATURES,
  graphql_timeline_v2_bookmark_timeline: true,
};
```

**Folder implementation:**
- `getFolders()`: Calls `BookmarkFoldersSlice` with empty variables
- `getFolderTweets(folderId, cursor?)`: Calls `BookmarkFolderTimeline` with `bookmark_collection_id`
- Tweets stored with `folder` field (single string, not array -- limitation)
- Premium-only detection: "Members request folders first, while regular users directly request bookmarks"

**Data extraction (`toRecord` in `twitter.ts`):**
Comprehensive extraction including: `sort_index`, `username`, `screen_name`, `avatar_url`, `user_id`, `tweet_id`, `full_text` (with URL expansion), `lang`, `created_at` (Unix timestamp), `possibly_sensitive`, `views_count`, `bookmark_count`, `favorite_count`, `quote_count`, `reply_count`, `retweet_count`, `bookmarked`, `favorited`, `retweeted`, `is_reply`, `is_quote_status`, `reply_tweet_url`, `media_items` (full media objects), `has_gif`, `has_image`, `has_video`, `has_quote`, `has_link`, `is_long_text`, `is_thread`, `conversations`, `quoted_tweet`, `folder`.

Long tweet handling: prefers `note_tweet.note_tweet_results.result.text` and `entity_set.urls` over `legacy.full_text`.

**Export formats (`exporter.ts`):**
- JSON: Pretty-printed with 2-space indentation
- CSV: BOM-prefixed UTF-8, escaped double-quotes, Excel-compatible
- HTML: Bootstrap-styled table with image thumbnails and collapsible JSON metadata

**DeclarativeNetRequest rule (`rules.json`):**
```json
[{
  "id": 1,
  "action": {
    "type": "modifyHeaders",
    "requestHeaders": [{"header": "Origin", "operation": "set", "value": "https://x.com"}]
  },
  "condition": {
    "urlFilter": "https://*.x.com/*",
    "resourceTypes": ["main_frame", "xmlhttprequest"]
  }
}]
```
**Bug:** Applies to `main_frame` AND all `*.x.com/*` -- too broad, interferes with normal browsing.

**Storage:** Raw IndexedDB (not Dexie) for tweet records. `chrome.storage.local` for auth tokens and sync cursors.

### 9.2 x-bookmark-exporter (`CHIHI913/x-bookmark-exporter`) - Best Interception Pattern

**Repository structure:**
```
public/injected/main.js        # MAIN world script (raw JS)
src/
  background/index.ts          # Service worker
  content/
    index.ts                   # Content script (ISOLATED)
    scroller.ts                # AutoScroller class (DEAD CODE)
  lib/
    store/index.ts             # In-memory Map store
    types/                     # TypeScript types
    exporter/                  # CSV and Markdown exporters
  popup/                       # Preact popup UI
```

**Tech stack:** TypeScript, Preact 10.26.4, Vite 6.2.5 + `@crxjs/vite-plugin` 2.0.0-beta.28.

**Manifest:** `storage`, `activeTab`, `scripting`, `downloads` permissions. NO `webRequest`. Content script in ISOLATED world only. MAIN world script injected manually.

**Script injection (`content/index.ts`):**
```typescript
function injectScript(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected/main.js');
  script.type = 'text/javascript';
  script.onload = () => script.remove(); // Self-cleanup
  (document.head || document.documentElement).appendChild(script);
}

// Only inject on bookmark pages:
if (window.location.pathname.includes('/i/bookmarks')) {
  injectScript();
}
```

**Dual API hooking (`public/injected/main.js`):**

URL pattern: `/\/graphql\/.+\/Bookmarks/`

Fetch hook:
```javascript
const originalFetch = window.fetch;
window.fetch = async function (...args) {
  const response = await originalFetch.apply(this, args);
  const url = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (BOOKMARKS_API_PATTERN.test(url)) {
    const clone = response.clone(); // Non-destructive
    const json = await clone.json();
    const posts = parseBookmarksResponse(json);
    if (posts.length > 0) {
      window.postMessage({
        type: 'X_BOOKMARK_EXPORTER_DATA',
        payload: { posts, url }
      }, '*');
    }
  }
  return response; // Original unmodified
};
```

XHR hook:
```javascript
XMLHttpRequest.prototype.open = function(method, url, ...args) {
  this._xbeUrl = url; // Stash URL
  return originalXHROpen.apply(this, [method, url, ...args]);
};
XMLHttpRequest.prototype.send = function(body) {
  if (BOOKMARKS_API_PATTERN.test(this._xbeUrl)) {
    const originalHandler = this.onreadystatechange;
    this.onreadystatechange = function() {
      if (this.readyState === 4 && this.status === 200) {
        const json = JSON.parse(this.responseText);
        // ... parse and postMessage
      }
      if (originalHandler) originalHandler.apply(this, arguments);
    };
  }
  return originalXHRSend.apply(this, arguments);
};
```

**Communication chain:**
```
MAIN world → window.postMessage('X_BOOKMARK_EXPORTER_DATA') → Content Script
Content Script → chrome.runtime.sendMessage('BOOKMARKS_RECEIVED') → Service Worker
Service Worker → chrome.tabs.sendMessage('FETCH_MORE') → Content Script
Service Worker → chrome.runtime.sendMessage('CAPTURE_PROGRESS') → Popup
```

**Deduplication (`store/index.ts`):**
```typescript
class BookmarkStore {
  private bookmarks: Map<string, Post> = new Map();
  addBookmarks(posts: Post[]): Post[] {
    const newPosts: Post[] = [];
    for (const post of posts) {
      if (!this.bookmarks.has(post.id)) {
        this.bookmarks.set(post.id, post);
        newPosts.push(post);
      }
    }
    return newPosts;
  }
}
```

**Data extraction (`normalizePost` in `main.js`):**
- Tweet ID from `rest_id`
- Text: prefers `note_tweet.note_tweet_results.result.text` over `legacy.full_text`
- `createdAt`: converted to ISO 8601
- `sortIndex`: preserves bookmark ordering
- `username` and `displayName` from `core.user_results.result`
- Constructed tweet URL: `https://x.com/{username}/status/{id}`
- All engagement metrics: likes, reposts, replies, bookmarks, views
- **All media** (not just first)
- Photo URLs with `?format=jpg&name=orig` for original resolution
- Video: highest bitrate variant selected
- Recursive quoted tweet extraction (unlimited depth)
- `TweetWithVisibilityResults` unwrapping

**Critical flaws:**
1. In-memory-only store -- data lost on service worker termination
2. `AutoScroller` class is dead code (never imported)
3. Only injects on `/i/bookmarks` initial load -- SPA navigation misses it
4. `window.postMessage('*')` target origin -- security weakness
5. No JSON export (only CSV and clipboard Markdown)
6. Silent 10,000 bookmark cap in "all" mode
7. Japanese-only UI

### 9.3 bookmark-export (`sahil-lalani/bookmark-export`) - Simplest & Most Resilient

**Repository structure:**
```
manifest.json    (702 bytes)
background.js    (9308 bytes - ALL logic)
popup.html       (708 bytes)
popup.js         (416 bytes)
package.json     (24 bytes)
```

No build step, no dependencies, no TypeScript. ~270 lines of vanilla JS.

**Auth capture (`background.js`):**
```javascript
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!(details.url.includes('x.com') || details.url.includes('twitter.com'))) return;
    const authHeader = details.requestHeaders?.find(h => h.name === 'authorization');
    const cookieHeader = details.requestHeaders?.find(h => h.name === 'cookie');
    const csrfHeader = details.requestHeaders?.find(h => h.name === 'x-csrf-token');
    // Store in chrome.storage.local
  },
  { urls: ['*://x.com/*', '*://twitter.com/*'] },
  ['requestHeaders', 'extraHeaders']
);
```

**Dynamic query ID capture (key technique):**
Also within the `webRequest` listener:
```javascript
const bookmarkMatch = details.url.match(/\/graphql\/([^/]+)\/Bookmarks/);
if (bookmarkMatch) {
  bookmarksApiId = bookmarkMatch[1];
  chrome.storage.local.set({ bookmarksApiId });
}
```

This captures the query ID from URLs the user naturally generates by browsing. It's the most resilient approach to query ID rotation.

**API replay:**
```javascript
async function getBookmarks(cursor, totalImported, allTweets) {
  const variables = { count: 100, includePromotedContent: true };
  if (cursor) variables.cursor = cursor;
  
  const url = `https://x.com/i/api/graphql/${bookmarksApiId}/Bookmarks?` +
    `features=${encodeURIComponent(JSON.stringify(FEATURES))}` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': authToken,
      'Cookie': cookie,
      'X-Csrf-Token': csrfToken,
      'Content-Type': 'application/json',
      // ... other headers
    }
  });
  
  const data = await response.json();
  // Parse tweets, extract cursor, recurse
}
```

**Credential readiness polling:**
```javascript
async function waitForRequiredData() {
  return new Promise((resolve) => {
    const checkInterval = setInterval(async () => {
      const data = await chrome.storage.local.get(['cookie', 'csrfToken', 'authToken', 'bookmarksApiId']);
      if (data.cookie && data.csrfToken && data.authToken && data.bookmarksApiId) {
        clearInterval(checkInterval);
        resolve(data);
      }
    }, 100); // Poll every 100ms
  });
}
```

**Tweet parsing (`parseTweet`):**
Minimal: only extracts `id`, `full_text`, `timestamp`, and first media item. Does not extract username, engagement metrics, or quoted tweets.

**Critical flaws:**
1. `host_permissions: "*://*/*"` -- grants access to ALL URLs (should be `https://x.com/*` only)
2. `externally_connectable` for `fft.web.app` and `foodforthought.site` -- unrelated domains, potential data leak
3. Zero rate limiting
4. Only first media item per tweet
5. No author info in export
6. Data URL for download: `data:application/json;charset=utf-8,${encodeURIComponent(json)}` -- fails for large exports
7. 27 hardcoded feature flags

### 9.4 twitter-web-exporter (UserScript, for reference)

**Not a Chrome extension** but the most mature project (~2,300 stars).

**Key implementation details:**
- Hooks `XMLHttpRequest.prototype.open` via `unsafeWindow` (Tampermonkey's page context access)
- Modular interceptor system: each data type (bookmarks, likes, followers, tweets, DMs, lists, etc.) has its own module
- Storage via **Dexie** (IndexedDB wrapper) -- handles massive datasets without memory issues
- Data table UI injected into the page with row selection, preview, export controls
- Export formats: JSON (pretty-printed), CSV (BOM for Excel), HTML (Bootstrap table with thumbnails)
- Handles `TweetTombstone`, `TweetUnavailable`, `TweetWithVisibilityResults`
- Validates page context via `webpackChunk_twitter_responsive_web` check
- i18n: English, Chinese (simplified/traditional), Japanese, Indonesian

**Tech stack:** TypeScript, Preact, Vite + `vite-plugin-monkey`, Dexie, Tailwind CSS.

---

## 10. Known Issues Catalog

### 10.1 X.com API Issues

| # | Issue | Impact | Mitigation |
|---|---|---|---|
| 1 | **Query ID rotation** every 2-4 weeks | Extension stops working | Dynamic capture from webRequest URL patterns; fallback to JS bundle scraping |
| 2 | **Official API v2 caps at 800 bookmarks** | Cannot export all bookmarks | Use internal GraphQL API instead |
| 3 | **Official API v2 folder endpoint caps at 20 results** | Cannot export all folder bookmarks | Use internal GraphQL `BookmarkFolderTimeline` |
| 4 | **Feature flags change without notice** | 400 errors or missing data | Capture flags from live requests; maintain fallback defaults |
| 5 | **Empty pagination pages** (cursors only, no tweets) | Premature pagination stop -> incomplete export | Only stop on missing bottom cursor, not empty tweet list |
| 6 | **Response path variations** (`bookmark_timeline` vs `bookmark_timeline_v2`) | Parser breaks | Try both paths |
| 7 | **Deleted/suspended tweets** return `TweetTombstone` or null | Missing data if not handled | Record with `status: "unavailable"` and any available reason |
| 8 | **`TweetWithVisibilityResults`** wrapper | Parser breaks if not unwrapped | Check `__typename` and unwrap |
| 9 | **`ct0` cookie rotation** during long sessions | CSRF validation fails | Re-read cookie before each request via `chrome.cookies.get()` |
| 10 | **`X-Client-Transaction-Id`** enforcement | Requests rejected | Capture from live request and mutate; or port generation algorithm |
| 11 | **Bookmark count (`bookmark_count`) may be approximate** | Inaccurate metrics | Accept as-is; document that it's approximate |
| 12 | **Cursor values are opaque and session-dependent** | Cannot reuse cursors across sessions | Always start fresh pagination for new exports |

### 10.2 Chrome Extension (MV3) Issues

| # | Issue | Impact | Mitigation |
|---|---|---|---|
| 13 | **Service worker terminated after 30s inactivity** | Long exports fail | Run logic in options page tab instead |
| 14 | **Service worker global state lost on termination** | Progress lost | Persist all state to IndexedDB |
| 15 | **Service workers lack Blob/createObjectURL** | Cannot create download files | Use options page context which has full DOM access |
| 16 | **Data URL size limits** for large exports | Download fails | Use Blob + createObjectURL instead |
| 17 | **declarativeNetRequest rules can be overly broad** | Interferes with normal browsing | Scope with `initiatorDomains` |
| 18 | **Content script injection misses SPA navigation** | Hook not installed if user navigates within X.com | Use webRequest (doesn't depend on injection) or inject on all pages |

### 10.3 Account Safety Issues

| # | Issue | Impact | Mitigation |
|---|---|---|---|
| 19 | **Account freezing** from rapid API calls | Account temporarily/permanently restricted | Conservative rate limiting (2.5s+ delays with jitter) |
| 20 | **Rate limit escalation** (429 -> harder limits) | Longer blocks | Exponential backoff; 5-minute cooldown after repeated 429s |
| 21 | **Anti-bot detection** from machine-like patterns | Account flagged | Random jitter; realistic headers; conservative request volume |

---

## 11. Technique Catalog

### 11.1 Authentication Techniques

| Technique | Used By | Pros | Cons |
|---|---|---|---|
| `webRequest.onSendHeaders` header capture | Twillot, bookmark-export | Passive; no injection; clean | Requires `webRequest` permission |
| MAIN world fetch/XHR monkey-patching | x-bookmark-exporter | Can read response bodies | Complex; requires injection; CSP constraints |
| `unsafeWindow` XHR hook | twitter-web-exporter | Full page context access | Tampermonkey only; not for extensions |
| `chrome.cookies.get()` for `ct0` | Custom fallback | Direct, reliable | Only gets cookie, not other headers |
| `document.cookie` parsing for `twid` | Twillot | Simple; gets user ID | Only gets user ID, not auth headers |
| OAuth 2.0 PKCE flow | Twitter-Archive, x-bookmarks-export | Official; low ban risk | Limited to 800 bookmarks |
| Username/password login via Playwright | fetch-twitter-bookmarks | Automated | "Unstable" as of Fall 2023 |

### 11.2 Query ID Discovery Techniques

| Technique | Used By | Pros | Cons |
|---|---|---|---|
| **Dynamic capture from webRequest URL** | bookmark-export | Most resilient; no hardcoding | Requires user to visit bookmarks page first |
| JS bundle scraping with regex | tweetxvault | Automated; no user action needed | Slower; bundle URLs change; may need cache |
| Hardcoded constants | Twillot, x-bookmark-exporter | Simplest | Breaks every 2-4 weeks |

### 11.3 Pagination Techniques

| Technique | Used By | Pros | Cons |
|---|---|---|---|
| **Cursor-based with direct API calls** | Twillot, bookmark-export | Fully automated; reliable | Requires auth headers; risks rate limiting |
| Scroll-based interception | x-bookmark-exporter | Lower ban risk | Requires user interaction; unreliable |
| Manual scrolling with response capture | twitter-web-exporter | Lowest ban risk | Not automated; requires user patience |

### 11.4 Storage Techniques

| Technique | Used By | Pros | Cons |
|---|---|---|---|
| **IndexedDB (Dexie)** | twitter-web-exporter | Scalable; persistent; structured queries | Async API; complexity |
| IndexedDB (raw) | Twillot | No dependency | Verbose API |
| `chrome.storage.local` | bookmark-export | Simple key-value | 10MB limit without `unlimitedStorage`; not great for large datasets |
| In-memory Map | x-bookmark-exporter | Fastest | **Data lost on SW termination** |

### 11.5 Rate Limiting Techniques

| Technique | Used By | Config |
|---|---|---|
| **Exponential backoff + jitter** | tweetxvault | 2.0s base; 2^attempt backoff; 300s cooldown |
| Response header tracking | Twillot | Reads `X-Rate-Limit-*` headers; pauses until reset + 5s |
| No rate limiting | bookmark-export, Twillot (in pagination loop) | N/A -- **causes problems** |
| Scroll timing (indirect) | x-bookmark-exporter | 1.5s between scrolls |

### 11.6 Origin Spoofing Techniques

| Technique | Used By | Pros | Cons |
|---|---|---|---|
| **`declarativeNetRequest` rule** | Twillot | Clean; declarative; MV3 native | Can be overly broad if not scoped |
| `webRequest.onBeforeRequest` header modification | (MV2 only) | Flexible | Not available in MV3 |
| No spoofing (include cookies only) | bookmark-export | Simplest | May fail if X.com checks Origin |

### 11.7 Transaction ID Techniques

| Technique | Used By | Pros | Cons |
|---|---|---|---|
| **Capture + digit mutation** | Twillot | Simple; reuses captured value | Weak simulation of real algorithm |
| Full generation algorithm | XClientTransactionJS | Accurate | Complex; requires fetching X.com homepage |
| Omit entirely | (potential) | Simplest | May be rejected on some endpoints |

### 11.8 Export/Download Techniques

| Technique | Used By | Pros | Cons |
|---|---|---|---|
| **Blob + `<a>` click** | (recommended for options page) | No size limit; works in page context | Requires DOM access |
| `chrome.downloads.download()` | Twillot | Works from any context | Needs `downloads` permission |
| Data URL | bookmark-export | No permissions needed | **Size limits; fails for large exports** |
| `URL.createObjectURL(blob)` + `link.click()` | Twillot exporter | Standard pattern | Requires Blob-capable context |
| Clipboard (`navigator.clipboard.writeText`) | x-bookmark-exporter (Markdown) | Quick sharing | Not suitable for large data |

### 11.9 Data Extraction Best Practices

Synthesized from all studied projects:

1. **Always prefer `note_tweet` text** over `legacy.full_text` for tweets >280 characters
2. **Extract ALL media items**, not just the first
3. **Append `?format=jpg&name=orig`** to photo URLs for original resolution
4. **Select highest bitrate** video variant: `variants.filter(v => v.bitrate).sort((a, b) => b.bitrate - a.bitrate)[0]`
5. **Expand `t.co` URLs** in tweet text using `entities.urls[].expanded_url`
6. **Handle `TweetWithVisibilityResults`** by checking `__typename` and unwrapping
7. **Handle `TweetTombstone`** and null `tweet_results.result` gracefully
8. **Extract recursive quoted tweets** (a quote can quote a quote)
9. **Preserve `sortIndex`** for bookmark ordering (different from tweet creation date)
10. **Parse `views.count` as integer** (it's returned as a string)
