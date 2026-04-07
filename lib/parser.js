/**
 * GraphQL response parsing — extract bookmarks from API responses.
 *
 * X.com's internal GraphQL API returns deeply nested timeline objects.
 * This module normalizes them into a flat, consistent bookmark schema.
 *
 * Key edge cases handled:
 *   - `TweetWithVisibilityResults` wrapper (must be unwrapped).
 *   - `TweetTombstone` for deleted / suspended tweets.
 *   - Null `tweet_results.result` for unavailable tweets.
 *   - `note_tweet` text preferred over `legacy.full_text` for >280 chars.
 *   - Two response paths (`bookmark_timeline_v2` vs `bookmark_timeline`).
 *   - Folder timeline path (`bookmark_collection_timeline`).
 */

/**
 * Parse a single page of the bookmarks GraphQL response.
 *
 * @param {object} data - Raw API response JSON.
 * @returns {{tweets: object[], bottomCursor: string|null}}
 */
export function parseBookmarksPage(data) {
  const instructions = getInstructions(data);
  if (!instructions) {
    return { tweets: [], bottomCursor: null };
  }

  const tweets = [];
  let bottomCursor = null;

  for (const instruction of instructions) {
    if (instruction.type !== 'TimelineAddEntries' || !instruction.entries) continue;

    for (const entry of instruction.entries) {
      const entryId = entry.entryId || '';

      if (entryId.startsWith('tweet-')) {
        const tweet = extractTweet(entry);
        if (tweet) tweets.push(tweet);
      }

      if (entryId.startsWith('cursor-bottom-')) {
        bottomCursor = entry.content?.value || null;
      }
    }
  }

  return { tweets, bottomCursor };
}

/**
 * Navigate the response to find the `instructions` array.
 *
 * X.com uses different top-level keys depending on the operation
 * and API version.
 *
 * @param {object} data
 * @returns {object[]|null}
 */
function getInstructions(data) {
  return (
    data?.data?.bookmark_timeline_v2?.timeline?.instructions ||
    data?.data?.bookmark_timeline?.timeline?.instructions ||
    data?.data?.bookmark_collection_timeline?.timeline?.instructions ||
    null
  );
}

/**
 * Extract and normalize a single tweet from a timeline entry.
 *
 * Returns a minimal "unavailable" stub when the tweet data is missing
 * or the tweet is a tombstone (deleted / suspended).
 *
 * @param {object} entry - A `TimelineAddEntries` entry.
 * @returns {object|null}
 */
function extractTweet(entry) {
  const itemContent = entry.content?.itemContent;
  if (!itemContent) return null;

  const sortIndex = entry.sortIndex || null;
  let result = itemContent.tweet_results?.result;

  if (!result) {
    const tweetId = (entry.entryId || '').replace('tweet-', '');
    return {
      tweet_id: tweetId,
      sort_index: sortIndex,
      status: 'unavailable',
      unavailable_reason: 'No tweet data returned',
      folders: [],
    };
  }

  // Unwrap the visibility wrapper — the actual tweet is inside `.tweet`.
  if (result.__typename === 'TweetWithVisibilityResults') {
    result = result.tweet;
  }

  if (result.__typename === 'TweetTombstone') {
    const tweetId = (entry.entryId || '').replace('tweet-', '');
    const reason = result.tombstone?.text?.text || 'Tweet unavailable';
    return {
      tweet_id: tweetId,
      sort_index: sortIndex,
      status: 'unavailable',
      unavailable_reason: reason,
      folders: [],
    };
  }

  return normalizeTweet(result, sortIndex);
}

/**
 * Normalize a raw tweet result into the xarchive bookmark schema.
 *
 * @param {object} result  - The `tweet_results.result` object.
 * @param {string|null} sortIndex
 * @returns {object}
 */
function normalizeTweet(result, sortIndex) {
  const legacy = result.legacy || {};
  const core = result.core?.user_results?.result;
  const userLegacy = core?.legacy || {};

  // Prefer note_tweet text for tweets over 280 characters.
  const noteText = result.note_tweet?.note_tweet_results?.result?.text;
  const fullText = noteText || legacy.full_text || '';

  const tweetId = result.rest_id || legacy.id_str || '';

  return {
    tweet_id: tweetId,
    sort_index: sortIndex,
    status: 'available',
    created_at: legacy.created_at || null,
    full_text: fullText,
    lang: legacy.lang || null,
    source: result.source || null,
    conversation_id: legacy.conversation_id_str || null,
    in_reply_to_tweet_id: legacy.in_reply_to_status_id_str || null,
    in_reply_to_user_id: legacy.in_reply_to_user_id_str || null,
    folders: [],
    author: extractAuthor(core, userLegacy),
    metrics: extractMetrics(legacy, result),
    entities: extractEntities(legacy),
    media: extractMedia(legacy),
    quoted_tweet: extractQuotedTweet(result),
    card: extractCard(result),
  };
}

/**
 * Extract author information from the tweet's `core` user object.
 * @returns {{user_id, screen_name, name, profile_image_url, verified, followers_count}}
 */
function extractAuthor(core, userLegacy) {
  return {
    user_id: core?.rest_id || userLegacy?.id_str || null,
    screen_name: userLegacy?.screen_name || null,
    name: userLegacy?.name || null,
    profile_image_url: userLegacy?.profile_image_url_https || null,
    verified: userLegacy?.verified || false,
    followers_count: userLegacy?.followers_count || 0,
  };
}

/**
 * Extract engagement metrics.
 * @returns {{likes, retweets, replies, bookmarks, views}}
 */
function extractMetrics(legacy, result) {
  return {
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    bookmarks: legacy.bookmark_count || 0,
    views: parseInt(result.views?.count, 10) || 0,
  };
}

/**
 * Extract URLs, hashtags, and user mentions from legacy entities.
 * @returns {{urls: object[], hashtags: string[], mentions: object[]}}
 */
function extractEntities(legacy) {
  const entities = legacy.entities || {};
  return {
    urls: (entities.urls || []).map((u) => ({
      url: u.url,
      expanded_url: u.expanded_url,
      display_url: u.display_url,
    })),
    hashtags: (entities.hashtags || []).map((h) => h.text),
    mentions: (entities.user_mentions || []).map((m) => ({
      screen_name: m.screen_name,
      user_id: m.id_str,
    })),
  };
}

/**
 * Extract media items (photos, videos, animated GIFs).
 *
 * Photos are returned with `?format=jpg&name=orig` for original
 * resolution.  Videos include all MP4 variants sorted by bitrate
 * (highest first).
 *
 * @returns {Array<{type, url, alt_text, thumbnail_url?, variants?, duration_ms?}>}
 */
function extractMedia(legacy) {
  // Prefer extended_entities (includes all media); fall back to entities.
  const extEntities = legacy.extended_entities || legacy.entities || {};
  const mediaItems = extEntities.media || [];

  return mediaItems.map((m) => {
    const item = {
      type: m.type, // photo | video | animated_gif
      url: m.type === 'photo'
        ? `${m.media_url_https}?format=jpg&name=orig`
        : m.media_url_https,
      alt_text: m.ext_alt_text || null,
    };

    if (m.type === 'video' || m.type === 'animated_gif') {
      item.thumbnail_url = m.media_url_https;
      item.variants = (m.video_info?.variants || [])
        .filter((v) => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
        .map((v) => ({
          bitrate: v.bitrate || 0,
          content_type: v.content_type,
          url: v.url,
        }));
      item.duration_ms = m.video_info?.duration_millis || null;
    }

    return item;
  });
}

/**
 * Extract a quoted tweet (recursive, one level deep).
 *
 * Handles `TweetWithVisibilityResults` and `TweetTombstone` wrappers
 * inside the quoted tweet as well.
 *
 * @returns {{tweet_id, full_text, author}|{tweet_id, status, full_text, author}|null}
 */
function extractQuotedTweet(result) {
  const quoted = result.quoted_status_result?.result;
  if (!quoted) return null;

  let q = quoted;
  if (q.__typename === 'TweetWithVisibilityResults') {
    q = q.tweet;
  }
  if (q.__typename === 'TweetTombstone') {
    return { tweet_id: null, status: 'unavailable', full_text: null, author: null };
  }

  const legacy = q.legacy || {};
  const core = q.core?.user_results?.result;
  const userLegacy = core?.legacy || {};
  const noteText = q.note_tweet?.note_tweet_results?.result?.text;

  return {
    tweet_id: q.rest_id || legacy.id_str || null,
    full_text: noteText || legacy.full_text || null,
    author: {
      screen_name: userLegacy?.screen_name || null,
      name: userLegacy?.name || null,
    },
  };
}

/**
 * Extract link-preview card data.
 * @returns {{type, url, title, description}|null}
 */
function extractCard(result) {
  const card = result.card?.legacy;
  if (!card) return null;

  const bindings = {};
  for (const pair of card.binding_values || []) {
    bindings[pair.key] = pair.value?.string_value || pair.value?.scribe_value?.description || null;
  }

  return {
    type: card.name || null,
    url: bindings.card_url || bindings.url || null,
    title: bindings.title || null,
    description: bindings.description || null,
  };
}

/**
 * Parse the `BookmarkFoldersSlice` response into a folder list.
 *
 * @param {object} data - Raw API response JSON.
 * @returns {{folders: Array<{id: string, name: string}>, cursor: string|null}}
 */
export function parseFolderList(data) {
  const slice = data?.data?.viewer?.user_results?.result?.bookmark_collections_slice;
  if (!slice) return { folders: [], cursor: null };

  const items = slice.items || [];
  const folders = items.map((item) => ({
    id: item.id || item.collection_id,
    name: item.name,
  }));

  const cursor = slice.slice_info?.next_cursor || null;
  return { folders, cursor };
}
