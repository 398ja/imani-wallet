# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-03-12

### Added

- Unified balance display tests (Phase 5) covering multi-currency conversion, fallback behavior, snapshot compatibility, legacy backing alias, and caption generation

## [0.1.2] - 2026-03-06

### Changed

- Relaxed consolidation compatibility checks in `SelectionOptimizer` — removed backing strategy and issuance ratio constraints from `canConsolidatePair()` to allow broader voucher consolidation

## [0.1.1] - 2026-02-19

### Changed

- Added @vitest/coverage-v8 devDependency for test coverage reporting
- Escrow-based receive safety improvements in balance calculation

## [0.1.0] - 2026-02-10

### Added

- Initial implementation of `BalanceManager` for multi-currency balance aggregation
- `EventEmitter` utility for balance change notifications
- Integration adapters for browser environments
- Support for voucher face value and proof-based balance calculation

[Unreleased]: https://github.com/398ja/imani-apps/compare/@imani/wallet-balance-v0.1.3...HEAD
[0.1.3]: https://github.com/398ja/imani-apps/compare/@imani/wallet-balance-v0.1.2...@imani/wallet-balance-v0.1.3
[0.1.2]: https://github.com/398ja/imani-apps/compare/@imani/wallet-balance-v0.1.1...@imani/wallet-balance-v0.1.2
[0.1.1]: https://github.com/398ja/imani-apps/compare/@imani/wallet-balance-v0.1.0...@imani/wallet-balance-v0.1.1
[0.1.0]: https://github.com/398ja/imani-apps/releases/tag/@imani/wallet-balance-v0.1.0
