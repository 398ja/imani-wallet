/**
 * runCatchupTick — pure function implementing the unified-pipeline
 * catch-up loop (FR-006, FR-007, FR-018, FR-019).
 *
 * Triggers (bridge-side, NOT inside this function): boot,
 * `visibilitychange → visible`, `online`, SSE-reconnect. Per FR-006
 * each trigger fires ONE catch-up tick that:
 *
 *   1. Loads the persisted watermark, computes `since = watermark - 60s`
 *      (FR-007), or `since = now - 7 * 86400` if fresh install.
 *   2. Queries the gateway for kind-1059 events addressed to the
 *      authenticated identity since that cursor, capped at `limit`.
 *   3. Processes each event through the canonical
 *      `processGiftWrapFromApi → processNip17Dm → TokenRedemption.redeem`
 *      lineage (passed in as a callback).
 *   4. Per FR-019, advances the watermark + processedEventIds set AFTER
 *      atomic write success — NOT before. A processing failure on event
 *      #2 of a 5-event batch (the "deferred" outcome class — transient
 *      receive failure or atomic-write failure) DOES break the batch and
 *      defers events #3-5 to the next tick. This is deliberate: a
 *      deferred event MUST NOT pull the watermark past its own
 *      createdAt (FR-019), and continuing past it in the same batch
 *      would either (a) advance the watermark to a later event's
 *      createdAt — losing the deferred event next tick — or (b) keep a
 *      complex per-event watermark cap that's harder to reason about.
 *      The next tick re-queries from the same since cursor and the
 *      dedup gate suppresses events #1 / already-processed; events
 *      #2-5 (and any newer arrivals) re-process cleanly.
 *   5. If `response.events.length === limit`, fires a follow-up query
 *      with `since = max(events.map(e => e.createdAt))` (NOT `+1` — the
 *      same-second-collision case at the boundary is handled by
 *      client-side dedup against processedEventIds; see contracts/catch-up-query.md).
 *
 * Single-flight + coalesce is bridge-side (page-lifecycle state, not
 * the loop's responsibility).
 *
 * All dependencies are injected as callbacks so the function is pure
 * (no `window`, no `localStorage`, no `fetch`) and trivially testable.
 */

import { classifyEventOutcome, type EventOutcome } from './classifyEventOutcome';
import { loadDmWatermark, saveDmWatermark, type WatermarkStorage } from './watermark';

/**
 * Minimal NostrEvent shape consumed by the catch-up tick. The gateway
 * `/api/v1/nostr/query` endpoint returns this shape (NostrEventDto on
 * the Java side); the catch-up tick relies only on these fields.
 */
export interface CatchupNostrEvent {
  id: string;
  pubkey: string;
  createdAt: number;
  kind: number;
  tags: ReadonlyArray<ReadonlyArray<string>>;
  content: string;
  sig: string;
}

/**
 * Result of processing one event. The catch-up tick passes this to
 * `classifyEventOutcome` to decide watermark / processedEventIds
 * advancement.
 */
export type ProcessResult =
  | { outcome: Exclude<EventOutcome, 'duplicate_event'> }
  // duplicate_event is determined by dedupHas BEFORE process is called;
  // process never returns it.
  ;

/**
 * Dependencies the bridge wires up. Keep this surface minimal — every
 * new field is a new bridge-side responsibility.
 */
export interface CatchupTickDeps {
  /** Authenticated identity pubkey hex (the recipient on the pTag filter). */
  userPubkeyHex: string;
  /**
   * Query the gateway for kind-1059 events. The bridge wraps the existing
   * `nostrApi.queryEvents({kinds, pTags, since, limit})` call.
   */
  queryEventsFn(args: { kinds: number[]; pTags: string[]; since: number; limit: number }): Promise<CatchupNostrEvent[]>;
  /**
   * Process one gift wrap. The bridge wraps the existing
   * `processGiftWrapFromApi → processNip17Dm → TokenRedemption.redeem`
   * lineage. Returns the FR-019 outcome enum.
   */
  processFn(event: CatchupNostrEvent): Promise<ProcessResult>;
  /** Watermark storage (typically localStorage). */
  watermarkStorage: WatermarkStorage;
  /** Returns true if event_id is already in the per-identity dedup set. */
  dedupHas(eventId: string): boolean;
  /** Add event_id to the per-identity dedup set. */
  dedupAdd(eventId: string): void;
  /** Optional logger. Defaults to a no-op. */
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  /** Optional now() — Unix seconds. Defaults to Math.floor(Date.now() / 1000). */
  now?: () => number;
  /** Optional per-batch limit. Defaults to 50 per data-model.md. */
  batchLimit?: number;
  /** Optional max number of batches per tick. Defaults to 20 — prevents pathological loops. */
  maxBatchesPerTick?: number;
  /** Optional fresh-install lookback in seconds. Defaults to 7 * 86400 per R-4. */
  freshInstallLookbackSeconds?: number;
}

/** Summary of one tick. Useful for telemetry + tests. */
export interface CatchupTickSummary {
  /** Total events successfully processed end-to-end. */
  processed: number;
  /** Total events that advanced the watermark (success + drop classes). */
  advanced: number;
  /** Total events deferred (transient failure → next trigger picks up). */
  deferred: number;
  /** Total batches issued (1 + multi-batch follow-ups). */
  batches: number;
  /** Total events seen across all batches (pre-dedup). */
  seen: number;
  /** Total events deduped at the dedupHas gate. */
  deduped: number;
  /** Watermark value after the tick (may be unchanged if all batches were empty). */
  watermarkAfter: number | null;
}

const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_MAX_BATCHES = 20;
const DEFAULT_FRESH_INSTALL_LOOKBACK_SEC = 7 * 86400;
const KIND_GIFT_WRAP = 1059;

/**
 * Run one catch-up tick end-to-end. Returns a summary; never throws on
 * per-event errors (those advance / defer the watermark per FR-019). A
 * full-tick failure (e.g. `queryEventsFn` itself throws) DOES propagate
 * — the bridge's single-flight wrapper logs + clears the in-flight flag.
 */
export async function runCatchupTick(deps: CatchupTickDeps): Promise<CatchupTickSummary> {
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const maxBatches = deps.maxBatchesPerTick ?? DEFAULT_MAX_BATCHES;
  const lookback = deps.freshInstallLookbackSeconds ?? DEFAULT_FRESH_INSTALL_LOOKBACK_SEC;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const logger = deps.logger ?? {};

  // 1. Compute initial since cursor. loadDmWatermark already applies the
  //    FR-007 60s buffer, so we just fall back to fresh-install otherwise.
  let watermark = loadDmWatermark(deps.userPubkeyHex, deps.watermarkStorage, {
    warn: logger.warn ?? (() => {}),
  });
  let since: number;
  if (watermark === null) {
    since = now() - lookback;
    logger.info?.('[dmPoll] catchup-fresh-install', { lookbackSeconds: lookback, since });
  } else {
    since = watermark;
  }

  let processed = 0;
  let advanced = 0;
  let deferred = 0;
  let batches = 0;
  let seen = 0;
  let deduped = 0;

  // 2. Multi-batch loop. Terminates when (a) the response is short of
  //    `limit`, (b) we hit maxBatchesPerTick, (c) since stops advancing.
  for (let batchIdx = 0; batchIdx < maxBatches; batchIdx++) {
    const events = await deps.queryEventsFn({
      kinds: [KIND_GIFT_WRAP],
      pTags: [deps.userPubkeyHex],
      since,
      limit: batchLimit,
    });
    batches++;
    seen += events.length;

    // Empty batch → done.
    if (events.length === 0) break;

    // 3. Process each event in order. The gateway returns ascending by
    //    createdAt (then id) per the contract — see contracts/catch-up-query.md.
    //
    // FR-019 invariant: the watermark may only advance to createdAts of
    // events whose outcome advances the watermark. So `maxCreatedAtThisBatch`
    // is updated INSIDE the advancing branch only — a deferred event MUST
    // NOT pull the watermark past its own createdAt, because the next tick
    // has to re-fetch that exact event.
    let maxCreatedAtThisBatch = since;
    for (const event of events) {
      // Dedup gate first — FR-019 duplicate_event row.
      if (deps.dedupHas(event.id)) {
        deduped++;
        const decision = classifyEventOutcome('duplicate_event');
        if (decision.shouldAdvanceWatermark) {
          advanced++;
          maxCreatedAtThisBatch = Math.max(maxCreatedAtThisBatch, event.createdAt);
        }
        continue;
      }

      let outcome: EventOutcome;
      try {
        const result = await deps.processFn(event);
        outcome = result.outcome;
      } catch (err) {
        // processFn MUST classify internally; an unclassified throw is a
        // bridge bug. Defensive: treat as transient so the next tick retries.
        logger.warn?.('[dmPoll] catchup-process-uncaught', {
          eventId: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
        outcome = 'transient_receive_within_budget';
      }

      const decision = classifyEventOutcome(outcome);

      if (decision.shouldMarkProcessed) {
        deps.dedupAdd(event.id);
      }
      if (decision.shouldAdvanceWatermark) {
        advanced++;
        if (outcome === 'success') processed++;
        maxCreatedAtThisBatch = Math.max(maxCreatedAtThisBatch, event.createdAt);
      } else {
        deferred++;
        // FR-019: a deferred event MUST NOT advance the watermark past its
        // createdAt — the next tick has to re-fetch it. Break the batch so
        // subsequent events also wait (they may depend on this one; the
        // next tick re-fetches the whole tail).
        break;
      }
    }

    // 4. Persist watermark advance for this batch + no-progress
    //    termination (Copilot review #296 — C). Capture the pre-write
    //    `since` so the no-progress comparison isn't trivially true
    //    after the in-memory cursor update.
    const sinceBeforeBatch = since;
    if (maxCreatedAtThisBatch > sinceBeforeBatch) {
      since = maxCreatedAtThisBatch;
      saveDmWatermark(deps.userPubkeyHex, since, deps.watermarkStorage, {
        warn: logger.warn ?? (() => {}),
      });
      watermark = since;
    }

    // No-progress termination: if the batch returned events but the
    // max createdAt didn't advance past the pre-batch `since`, the
    // next query would return the identical (already-deduped) batch.
    // Bail out instead of looping `maxBatchesPerTick` times against
    // the gateway with no new work.
    if (maxCreatedAtThisBatch === sinceBeforeBatch && events.length > 0) {
      logger.info?.('[dmPoll] catchup-no-progress-terminate', {
        seen: events.length,
        deduped,
        since: sinceBeforeBatch,
      });
      break;
    }

    // 5. Multi-batch termination: if response was short of `limit`, no
    //    more events are available. Per contracts/catch-up-query.md the
    //    follow-up query uses `since = max(createdAt)` (NOT `+1`) — the
    //    boundary-overlap event is suppressed by the dedup gate above.
    if (events.length < batchLimit) break;
  }

  return {
    processed,
    advanced,
    deferred,
    batches,
    seen,
    deduped,
    watermarkAfter: watermark,
  };
}
