/**
 * Shared utilities for rate limiting and timing.
 *
 * Centralizes constants and helpers used across the fetcher, folder, and
 * other modules so values stay consistent and aren't duplicated.
 */

/** Base delay between API calls (milliseconds). */
export const BASE_DELAY_MS = 2500;

/** Low end of the jitter multiplier range applied to BASE_DELAY_MS. */
const JITTER_MIN = 0.7;

/** High end of the jitter multiplier range applied to BASE_DELAY_MS. */
const JITTER_MAX = 1.5;

/** Maximum retry attempts for a single failing page request. */
export const MAX_RETRIES = 5;

/** Duration of a cooldown pause after repeated 429s (milliseconds). */
export const COOLDOWN_MS = 300_000; // 5 minutes

/** Consecutive 429 responses before entering cooldown. */
export const CONSECUTIVE_429_COOLDOWN = 3;

/** Consecutive 429 responses before giving up entirely. */
export const CONSECUTIVE_429_STOP = 5;

/** Consecutive empty pages before treating pagination as finished. */
export const MAX_CONSECUTIVE_EMPTY = 5;

/**
 * Return a promise that resolves after {@link ms} milliseconds.
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate a jittered delay based on {@link BASE_DELAY_MS}.
 *
 * The multiplier is randomly chosen between {@link JITTER_MIN} and
 * {@link JITTER_MAX} to avoid machine-like request patterns.
 * @returns {number} Delay in milliseconds.
 */
export function jitteredDelay() {
  const multiplier = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
  return BASE_DELAY_MS * multiplier;
}
