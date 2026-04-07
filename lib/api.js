/**
 * GraphQL request construction and header assembly.
 *
 * Builds authenticated requests against X.com's internal GraphQL API.
 * Headers are assembled from credentials captured by the service worker
 * plus a fresh `ct0` CSRF cookie read before each request.
 *
 * The `X-Client-Transaction-Id` header is mutated on every call by
 * incrementing a random digit — a lightweight anti-bot evasion
 * technique borrowed from Twillot.
 */

/**
 * Public bearer token identifying the X.com web application.
 * Not user-specific — the same value is used by all logged-in sessions.
 * @const {string}
 */
const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/**
 * Default feature flags captured from live X.com requests.
 * These may drift over time; when the service worker captures a fresh
 * set via webRequest the captured version takes precedence.
 * @const {Object<string, boolean>}
 */
const DEFAULT_FEATURES = {
  graphql_timeline_v2_bookmark_timeline: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  responsive_web_media_download_video_enabled: false,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_grok_share_attachment_enabled: false,
};

/**
 * Mutate a transaction ID by incrementing a random digit position.
 *
 * X.com's anti-bot layer expects a changing transaction ID on each
 * request.  This simple mutation produces a new-looking value without
 * needing the full generation algorithm.
 *
 * @param {string|null} transactionId
 * @returns {string|null} Mutated ID, or null if input was null.
 */
function incrementTransactionId(transactionId) {
  if (!transactionId) return null;
  const chars = transactionId.split('');
  const digitPositions = [];
  for (let i = 0; i < chars.length; i++) {
    if (/\d/.test(chars[i])) digitPositions.push(i);
  }
  if (digitPositions.length === 0) return transactionId;
  const pos = digitPositions[Math.floor(Math.random() * digitPositions.length)];
  chars[pos] = String((parseInt(chars[pos], 10) + 1) % 10);
  return chars.join('');
}

/**
 * Read the current `ct0` CSRF cookie via the Chrome cookies API.
 *
 * Called before every request because the cookie rotates during long
 * sessions and a stale value causes 403 errors.
 *
 * @returns {Promise<string|null>}
 */
export async function getFreshCt0() {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: 'https://x.com', name: 'ct0' }, (cookie) => {
      resolve(cookie ? cookie.value : null);
    });
  });
}

/**
 * Retrieve stored credentials (auth headers + query IDs) from
 * `chrome.storage.local`, namespaced by user ID.
 *
 * @returns {Promise<{userId: string|null, creds: object|null}>}
 */
export async function getCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const userId = items.xarchive_user_id;
      if (!userId) {
        resolve({ userId: null, creds: null });
        return;
      }
      const creds = items[`xarchive_creds_${userId}`] || null;
      resolve({ userId, creds });
    });
  });
}

/**
 * Build the headers object for a GraphQL request.
 *
 * Always reads a fresh `ct0` cookie.  Mutates the stored transaction
 * ID in-place so the next call produces a different value.
 *
 * @param {object} creds - Stored credentials from the service worker.
 * @returns {Promise<Object<string, string>>}
 */
async function buildHeaders(creds) {
  const ct0 = await getFreshCt0();
  const csrfToken = ct0 || creds?.['x-csrf-token'] || '';
  const transactionId = incrementTransactionId(creds?.['x-client-transaction-id']);

  const headers = {
    'Authorization': `Bearer ${BEARER_TOKEN}`,
    'X-Csrf-Token': csrfToken,
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Client-Language': 'en',
    'Content-Type': 'application/json',
  };

  if (creds?.['x-client-uuid']) {
    headers['X-Client-Uuid'] = creds['x-client-uuid'];
  }

  if (transactionId) {
    headers['X-Client-Transaction-Id'] = transactionId;
    // Update the stored value so the next mutation starts from here.
    if (creds) creds['x-client-transaction-id'] = transactionId;
  }

  return headers;
}

/**
 * Return the feature flags to send with a GraphQL request.
 *
 * Prefers live-captured features (from the service worker) over the
 * baked-in defaults.
 *
 * @param {object} creds
 * @returns {Object<string, boolean>}
 */
function getFeatures(creds) {
  if (creds?.captured_features) {
    try {
      return JSON.parse(decodeURIComponent(creds.captured_features));
    } catch {
      // Malformed — fall through to defaults.
    }
  }
  return DEFAULT_FEATURES;
}

/**
 * Construct a full GraphQL GET request URL with encoded query parameters.
 *
 * @param {string} queryId
 * @param {string} operationName
 * @param {object} variables
 * @param {object} features
 * @returns {string}
 */
function buildGraphQLUrl(queryId, operationName, variables, features) {
  const params = new URLSearchParams();
  params.set('variables', JSON.stringify(variables));
  params.set('features', JSON.stringify(features));
  return `https://x.com/i/api/graphql/${queryId}/${operationName}?${params.toString()}`;
}

/**
 * Execute a GraphQL GET request and return a normalized result.
 *
 * Handles HTTP-level errors (429, 401/403, other) as well as
 * GraphQL-level rate-limit errors (error code 88).
 *
 * @param {string} queryId
 * @param {string} operationName
 * @param {object} variables
 * @param {object} creds
 * @returns {Promise<{error: string|null, status: number, rateLimit: object, data: object|null}>}
 */
export async function graphqlRequest(queryId, operationName, variables, creds) {
  const features = getFeatures(creds);
  const url = buildGraphQLUrl(queryId, operationName, variables, features);
  const headers = await buildHeaders(creds);

  const response = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'include',
  });

  const rateLimit = {
    limit: response.headers.get('x-rate-limit-limit'),
    remaining: response.headers.get('x-rate-limit-remaining'),
    reset: response.headers.get('x-rate-limit-reset'),
  };

  if (response.status === 429) {
    return { error: 'rate_limited', status: 429, rateLimit, data: null };
  }

  if (response.status === 401 || response.status === 403) {
    return { error: 'auth_error', status: response.status, rateLimit, data: null };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { error: 'http_error', status: response.status, message: text, rateLimit, data: null };
  }

  const data = await response.json();

  // GraphQL-level rate limit (HTTP 200 but body contains error code 88).
  if (data.errors) {
    const rateLimitError = data.errors.find((e) => e.code === 88);
    if (rateLimitError) {
      return { error: 'rate_limited', status: 200, rateLimit, data: null };
    }
    return { error: 'graphql_error', errors: data.errors, rateLimit, data: null };
  }

  return { error: null, status: response.status, rateLimit, data };
}
