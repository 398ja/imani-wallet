# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-06-01

### Added

- **`reconcileVoucherTxOrphans()`** — FR-015 + FR-021 boot orphan
  reconciliation. Walks `wallet_vouchers` once and (1) writes a missing
  transaction row for any voucher whose `swap_completed_at` is set but
  whose tx row by `token_id` is absent (historical / pre-spec-038 partial
  writes), and (2) backfills `source_transport='manual'` on legacy rows
  that have `swap_completed_at` set but no `source_transport`. Pure
  function with all dependencies as callbacks (storage, recorder, logger);
  idempotent; per-voucher failure-isolated. 9 new vitest tests cover the
  decision matrix.

### Notes

- Scope is HISTORICAL — FR-015 backstops pre-spec-038 orphans, NOT the
  atomic-write-throws case (FR-014 is all-or-nothing; the watermark-non-
  advancement recovery path covers that).
- The bridge in `voucher/js/home.js` (T024b) wires this before
  `DmPollService.start()` so the reconcile runs on a quiescent IDB.

## [0.4.0] - 2026-06-01

### Added

- **Spec 038 foundational surface** — four new exports for the unified
  receive pipeline:
  - `watermark.ts` — `loadDmWatermark` / `saveDmWatermark` / `watermarkKey`
    + `WATERMARK_BUFFER_SECONDS`. Per-identity monotonic cursor for
    catch-up loop; FR-007's 60s buffer applied on read; FR-018
    monotonicity enforced on write; corrupt values yield null + a
    `[dmPoll] watermark-corrupt` warning.
  - `runCatchupTick.ts` — pure function implementing the FR-006 catch-up
    loop body. Takes `queryEventsFn`, `processFn`, `watermarkStorage`,
    `dedupHas`, `dedupAdd` callbacks (no `window` / no `localStorage` /
    no `fetch`); returns a `Promise<CatchupTickSummary>`. Implements
    FR-019's per-event outcome table, multi-batch pagination with
    compound `(createdAt, id)` cursor strategy (same-second collision
    handled by client-side dedup), and the FR-019 "deferred event halts
    batch" semantics.
  - `retryOnTransientMintError.ts` — bounded retry helper for transient
    `api.receive` failures (FR-016: 3 retries at 1s/4s/15s backoff).
    Throws `RetryExhaustedError` on budget exhaustion; propagates
    terminal errors untouched.
  - `classifyEventOutcome.ts` — pure FR-019 outcome → decision map.
    Returns `{shouldMarkProcessed, shouldAdvanceWatermark,
    retryEligible}`. Frozen lookup table — adding a new outcome
    requires editing both spec.md and this map.

### Notes

- All four surfaces are environment-agnostic; the browser bridge in
  `shared/dmPoll.js` (spec 038 T030) supplies localStorage / fetch /
  navigator.locks adapters.
- 52 new vitest tests added across the four files (watermark 18, retry
  9, classifier 11, runCatchupTick 14).

## [0.3.0] - 2026-02-19

### Added

- Escrow-based receive safety with `_acknowledgeEscrow` and `recoverPendingReceives` methods
- pTags filter fix to correctly match recipient pubkeys in gift-wrapped DMs

### Changed

- Improved failed event deduplication to prevent duplicate processing

## [0.2.0] - 2025-01-26

### Added

- `FailedEventTracker` class for tracking and retrying failed DM processing
- Configurable retry mechanism with exponential backoff
- Failed event persistence via `StorageAdapter`
- `getFailedEvents()` and `retryFailedEvents()` methods on `DmPollService`

### Changed

- `DmPollService` now tracks failed events instead of silently dropping them
- Improved error handling in DM processing pipeline

## [0.1.0] - 2025-01-24

### Added

- Initial implementation of `DmPollService` for NIP-17 DM polling
- `StorageAdapter` interface for pluggable storage backends
- `BrowserStorageAdapter` default implementation using localStorage
- Support for Cashu token extraction from gift-wrapped DMs
- Auto-redemption callback integration
- Configurable polling intervals and relay lists

[Unreleased]: https://github.com/398ja/imani-apps/compare/dm-poll-v0.3.0...HEAD
[0.3.0]: https://github.com/398ja/imani-apps/compare/dm-poll-v0.2.0...dm-poll-v0.3.0
[0.2.0]: https://github.com/398ja/imani-apps/compare/dm-poll-v0.1.0...dm-poll-v0.2.0
[0.1.0]: https://github.com/398ja/imani-apps/releases/tag/dm-poll-v0.1.0
