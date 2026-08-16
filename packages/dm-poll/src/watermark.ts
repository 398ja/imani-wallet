/**
 * Watermark helpers for the unified receive pipeline's catch-up loop.
 *
 * The watermark is a per-identity Unix-seconds cursor that tracks "I have
 * processed every kind-1059 gift wrap addressed to me up through this
 * createdAt." On boot / visibilitychange / online / SSE-reconnect, the
 * catch-up loop queries the gateway for events with
 * `createdAt > watermark - 60s` (the 60s buffer absorbs clock skew + relay
 * propagation per FR-007), processes each event through the canonical
 * `TokenRedemption.redeem` pipeline, and advances the watermark
 * per-event after each successful atomic write.
 *
 * Spec mapping:
 *   - FR-006 (catch-up query uses the watermark)
 *   - FR-007 (60s buffer)
 *   - FR-019 (per-event outcome table — only advance after success)
 *   - data-model.md invariant 2 (monotonic; never regresses)
 *
 * Persistence is delegated to a callback so the package stays
 * environment-agnostic: the browser bridge supplies a localStorage shim
 * (keyed `imani_dm_watermark:<userPubkeyHex>` per spec-006 user-scoped
 * storage); tests supply an in-memory shim.
 */

/**
 * Storage backend the watermark helpers call into. Synchronous since the
 * underlying primitives (localStorage / in-memory map) are sync; an
 * IDB-backed backend would wrap async reads behind a thin caller-side
 * promise — out of scope here.
 */
export interface WatermarkStorage {
  /** Return the stored string for the key, or `null` if absent. */
  getItem(key: string): string | null;
  /** Write the string for the key. May throw on quota / corrupt-store. */
  setItem(key: string, value: string): void;
}

/**
 * Optional logger surface. The bridge wires this to `console.warn`; tests
 * default to a no-op spy.
 */
export interface WatermarkLogger {
  warn(...args: unknown[]): void;
}

/**
 * FR-007: the 60s buffer the catch-up query subtracts from the stored
 * watermark to absorb clock skew + relay propagation delay.
 */
export const WATERMARK_BUFFER_SECONDS = 60;

/**
 * Issue #304 — the 30s grace the persisted watermark is held back from
 * the last successfully processed event's `createdAt`. Combined with the
 * 60s buffer, the next catch-up query covers a 90s look-back window —
 * generous enough that a brief SSE disconnect (typically < 10s of
 * propagation + < 5s of reconnect latency) cannot shift the query window
 * past in-flight events. Re-processing an event already in
 * `processedEventIds` is a clean no-op via `dedupHas`, so the grace
 * does not produce duplicate writes.
 */
export const WATERMARK_GRACE_SECONDS = 30;

/**
 * Compute the storage key for a given identity. Spec-006 user-scoped
 * storage convention: `<feature_key>:<userPubkeyHex>`.
 */
export function watermarkKey(userPubkeyHex: string): string {
  if (!userPubkeyHex || typeof userPubkeyHex !== 'string') {
    throw new Error('watermarkKey: userPubkeyHex must be a non-empty string');
  }
  return `imani_dm_watermark:${userPubkeyHex.toLowerCase()}`;
}

/**
 * Load the watermark for an identity. Returns the buffered "since" value
 * (stored value minus FR-007's 60s buffer), or `null` for fresh installs
 * / corrupt entries.
 *
 * Corrupt entries: log `[dmPoll] watermark-corrupt` and return `null`. The
 * caller treats null as "use the FR-007 fresh-install default" (typically
 * `now - 7 * 86400`).
 *
 * @returns The buffered watermark in Unix seconds, or null.
 */
export function loadDmWatermark(
  userPubkeyHex: string,
  storage: WatermarkStorage,
  logger: WatermarkLogger = { warn: () => {} }
): number | null {
  const key = watermarkKey(userPubkeyHex);
  const raw = storage.getItem(key);
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== raw.trim()) {
    logger.warn('[dmPoll] watermark-corrupt', { key, raw });
    return null;
  }
  return Math.max(0, parsed - WATERMARK_BUFFER_SECONDS);
}

/**
 * Persist the watermark for an identity. Enforces monotonicity:
 * `max(current, candidate)` — a stale write that's lower than the current
 * value is a no-op and returns the unchanged current value (data-model.md
 * invariant 2).
 *
 * @param candidate Unix seconds. Must be a non-negative integer. Negative
 *                  / non-integer / non-finite values are rejected with a
 *                  `RangeError`.
 * @returns The watermark value AFTER the write (may equal the existing
 *          value if monotonicity blocked the candidate).
 */
export function saveDmWatermark(
  userPubkeyHex: string,
  candidate: number,
  storage: WatermarkStorage,
  logger: WatermarkLogger = { warn: () => {} }
): number {
  if (!Number.isFinite(candidate) || candidate < 0 || !Number.isInteger(candidate)) {
    throw new RangeError(
      `saveDmWatermark: candidate must be a non-negative integer (got ${candidate})`
    );
  }
  const key = watermarkKey(userPubkeyHex);
  const rawCurrent = storage.getItem(key);

  // Tri-state the existing value: absent, valid integer, or corrupt.
  // Per Copilot review #296 (A) — empty string is treated as "absent"
  // for the no-op gate (matches the loadDmWatermark behaviour), AND
  // a corrupt value ALWAYS triggers a normalising write even if
  // `next === current` (we want the bad bytes gone, not preserved).
  let current = 0;
  let existingState: 'absent' | 'valid' | 'corrupt' = 'absent';
  if (rawCurrent !== null && rawCurrent !== undefined && rawCurrent !== '') {
    const parsed = Number.parseInt(rawCurrent, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && String(parsed) === rawCurrent.trim()) {
      current = parsed;
      existingState = 'valid';
    } else {
      existingState = 'corrupt';
      logger.warn('[dmPoll] watermark-corrupt', { key, raw: rawCurrent, action: 'overwrite' });
    }
  }
  // Issue #304 — apply the grace window before monotonicity. Holding the
  // stored value back by WATERMARK_GRACE_SECONDS ensures the next
  // catch-up query still covers events whose createdAt fell into the
  // disconnect window (typically the trailing 30s before the candidate).
  // Clamp at zero so we never write a negative value.
  const graced = Math.max(0, candidate - WATERMARK_GRACE_SECONDS);
  const next = Math.max(current, graced);
  if (next === current && existingState === 'valid') {
    // Monotonicity blocked a lower-or-equal graced candidate against a
    // clean existing value. No write — preserve the canonical bytes.
    return current;
  }
  // Either:
  //   - absent existing value (first-time write)
  //   - corrupt existing value (force normalisation; current would have
  //     been parsed as 0, so `next` is `candidate`)
  //   - valid existing value with `next > current` (monotonic advance)
  storage.setItem(key, String(next));
  return next;
}
