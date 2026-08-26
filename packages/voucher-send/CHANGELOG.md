# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-06-02

### Added

- **Spec 039 — `reconcileQrShares()` pure function** for converting
  active pending-QR-share records into terminal outcomes (`sent`,
  `closed-by-self-spend`, `expired-without-claim`, or deferred). Pure
  callback-driven contract: callers wire it to the wallet's IDB +
  mint NUT-07 proof-state lookup. Returns a `ReconcileQrSharesSummary`.
  Contract:
  `imani-apps/specs/039-reliable-qr-transfers/contracts/reconcile-trigger.md`.
- New type exports (`src/types/qr-share.ts`): `PendingQrShare`,
  `PendingQrShareStatus`, `ReconcileVoucherRow`, `ProofRef`,
  `ProofState`, `ProofStateMap`, `ReconcileTransactionRow`,
  `AddTransactionResult`, `ReconcileQrSharesDeps`,
  `ReconcileQrSharesSummary`.

7-case vitest suite covers happy path, self-spend, expired, deferred,
mixed batch with per-share failure isolation, idempotent re-run, and
commit-await ordering. Full module suite: 440 / 440 green.

---

## [0.1.2] - 2026-02-24

### Changed
- Replaced inline zero-decimal currency list with `@imani/money` dependency
