# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.4.1] - 2026-06-11

### Changed
- PR #345 review follow-ups:
  - `followSync.reconcile` now emits an upsert only when a remote entry is
    missing locally or actually differs (syncState/order/relayHint/petname), so a
    steady-state sync produces zero IndexedDB writes and no `onChange` re-render
    churn.
  - `ProfileService.startFollowSync` no longer silently falls back to an empty
    entry list when an adapter lacks `listEntries`; it shims from `list()`+
    `getEntry()`, else fails fast — the coordinator always sees real local state.

## [0.4.0] - 2026-06-11

### Added
- Spec 044 (#1/#2) — denormalized kind-0 profile snapshot on the follow entry for
  instant, local-first rendering of the followed list:
  - `FollowEntry`: `displayName` / `picture` / `nip05` / `profileUpdatedAt`;
    `FollowProfileSnapshot` type.
  - `LocalFollowAdapter` / `MemoryFollowAdapter`: persist the snapshot; new
    `setProfile()`; `add()` is now an upsert that preserves an existing merchant
    flag + profile snapshot on re-add. `MemoryFollowAdapter` gains `setMerchant()`.
  - `FollowManager.setProfile()` and `ProfileService.setFollowProfile()`.

## [0.3.0] - 2026-06-11

### Added
- Spec 044 — local NIP-02 follow list with a merchant discriminator:
  - `FollowManager`: `listCustomers()` / `listMerchants()` subsets, `getEntry()`,
    `setMerchant()`, `selfPubkey` self-exclusion, `invalidate()`.
  - `LocalFollowAdapter`: DB v2 with `merchant`/`merchantCheckedAt`/`order`/
    `syncState`/`relayHint`/`petname` fields + back-fill migration.
  - `FollowSyncCoordinator` + `NostrFollowSource`: background relay sync over a
    single metadata-preserving kind-3 (pull → reconcile → publish → mark-synced).
  - `isConfiguredMerchant()` merchant-definition util.
  - `ProfileService`: `listCustomers`/`listMerchants`/`getFollowEntry`/
    `setFollowMerchant`/`startFollowSync`/`syncFollowsNow`/`getFollowSyncState`/
    `stopFollowSync`.

## [0.2.1] - 2026-03-10

### Fixed
- Merchant profile field mapping dropping app-specific fields (categories, active, paymentMethods, issuanceCurrency, voucherValidityDays) when loaded through ImaniApiAdapter
- Snake_case/camelCase field conflicts causing payment methods to not persist after save

## [0.2.0] - 2026-01-31

### Added
- Profile name search functionality

### Changed
- Improved UX for profile lookups
- Refactored for nostrdb proxy architecture
