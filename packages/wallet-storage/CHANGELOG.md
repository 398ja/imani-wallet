# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-06-05

### Added

- **Spec 041 SA-006 — client-mint provenance fields on `VoucherRow`.** Four
  new optional fields populated by the spec-041 client-side voucher minting
  orchestrator (Phase 3 of that spec):

  - `purchase_id?: string` — the atomic-purchase id the row was materialized
    for. Lets the wallet UI look up the saved voucher from the saga's
    `VOUCHER_CREATED` SSE callback via the new `getVoucherByPurchaseId`
    method.
  - `materialized_at?: string` — ISO-8601 of the moment the browser
    finished unblinding + IDB write. Distinct from `created_at` (row
    first-save) and `swap_completed_at` (spec-038 receive marker; never
    set on client-mint rows).
  - `proof_sum?: number` — sum of proof amounts in this voucher's token,
    in sats. The orchestrator validates this equals the quoted
    `amount_sats` before writing (FR-011 step 6); carrying it on the row
    lets consumers cross-check without re-decoding the cashu V4 token.
  - `keyset_ids?: string[]` — distinct keyset ids referenced by the
    proofs. Typically a one-element array (single-keyset materialization
    per spec 041); the type accepts multi-keyset for forward compatibility.
    Public identifiers — NOT secret material.

- `source_transport` union extended with `'client_mint' | 'gateway_mint'`
  (was spec-038's `'sse' | 'catchup' | 'manual' | 'cashback' |
  'escrow_recovery'`). `'client_mint'` marks rows materialized by the
  browser via the spec-041 orchestrator (no gateway proof custody);
  `'gateway_mint'` is the explicit legacy label.

- **New method `getVoucherByPurchaseId(purchaseId)`** (plan.md M1). Linear
  scan via `getAllVouchers` filtered by `purchase_id` — no IDB secondary
  index added. For typical wallets (< 1000 vouchers) this completes in
  well under 10ms and is not on the loadtest hot path. Returns null on
  missing match or empty input; does not throw.

- 5 new tests in `WalletStorage.test.ts` `spec 041` describe block:
  happy-path round-trip of all five SA-006 fields; null on absent match;
  empty-input fast-return; legacy rows without `purchase_id` ignored;
  `gateway_mint` discriminator accepted without forcing other fields.
  Full suite: 40/40 green.

### Compatibility

- All four new fields are optional. Existing rows (spec-024 baseline,
  spec-038 receive provenance) deserialize unchanged.
- The `source_transport` union widening is additive — consumers that
  only check for the spec-038 values continue to work; spec-041 values
  are simply additional discriminators they may not need to handle.

## [0.3.0] - 2026-06-01

### Added

- **`atomicallyWrite({vouchers, transactions})` — spec 038 FR-014.** Commits
  N voucher rows AND M transaction rows in a SINGLE readwrite IDB
  transaction spanning both stores. Either ALL rows land or NONE do —
  closes the FR-019 "voucher saved but tx write failed" partial-state
  class by construction. Same idempotent `read-merge-write` semantics as
  `saveVoucher` / `addTransaction`; auto-derives `token_id` from `token`
  when absent; rejects pre-transaction on token shape failure.
- **Voucher schema — four new optional FR-020 receive-provenance fields**
  on `VoucherRow`:
  - `received_via_event_id` — the kind-1059 gift-wrap event id this
    voucher came from.
  - `swap_completed_at` — ISO-8601 of the moment `api.receive` returned
    success. Absence marks a pre-spec-038 legacy-receive row (FR-008's
    detection heuristic + Phase 6 recovery affordance read this).
  - `swap_proof_ids` — keyset ids of proofs freshly issued by the swap
    (public identifiers, not secrets — FR-022).
  - `source_transport` — which code path produced this voucher
    (`sse`/`catchup`/`manual`/`cashback`/`escrow_recovery`); the
    FR-021 backfill writes `'manual'` for legacy rows that have
    `swap_completed_at` set but no `source_transport`.
- `WalletStorageInvalidTokenError.source` gains the
  `'atomicallyWrite_backstop'` variant.

### Changed

- NO destructive migration. The four new fields are all optional;
  existing voucher rows load and render unchanged.

## [0.2.0] - 2026-05-17

### Added

- Bulk-ops surface (`removeVouchers`, `clearAndReplaceAllVouchers`,
  `removeTransactions`, `clearAndReplaceAllTransactions`) — single
  readwrite IDB transactions for spec 025's `shared/storage.js` cutover.

## [0.1.0] - 2026-05-16

### Added

- Initial release: `WalletStorage` class with `saveVoucher` /
  `addTransaction` / read accessors + cross-tab `BroadcastChannel`
  invalidation. Closes finding #4 of the 2026-05-16 redemption-path
  code review (RMW race on `localStorage.imani_vouchers` /
  `localStorage.imani_transactions`).
