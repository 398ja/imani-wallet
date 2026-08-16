# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-06-14

### Added
- `parseLocaleAmount(input, currency, options?)` — locale-aware string → minor-units parser. Handles
  the four shipped wallet locales (`en-US`, `de-DE`, `es-ES`, `fr-FR`) plus graceful fallback for any
  other browser-reported locale; accepts U+0020 / U+00A0 / U+202F as equivalent group separators on
  fr-FR for mobile-keyboard compatibility; one-way period-fallback (no comma fallback for en-US — see
  SC-004); unsigned by contract (rejects leading `+` / `-`); rejects scientific notation; right-zero-pads
  one-fractional-digit input to the currency's decimals cap (e.g. `5,5 EUR → 550 minor units`); reports
  trailing decimal separators as a distinct `incomplete` reason for typing-in-progress states.
- `Money.fromLocaleString(input, currency, options?)` — convenience wrapper over `parseLocaleAmount`.
- Five named errors thrown by `Money.fromLocaleString`: `EmptyAmountError`, `IncompleteAmountError`,
  `InvalidAmountError`, `TooManyDecimalsError`, `OverflowError` — 1:1 with the parser's reason union.
- `Money.format({locale?})` and standalone `formatMoney(amount, currency, {locale?})` — when a locale
  is supplied, the formatter delegates digit-grouping and decimal-separator to
  `Intl.NumberFormat(locale, ...)`; currency symbol still comes from the registry. Existing callers
  pass no options and see no behaviour change.

### Backwards-compatible
- No breaking changes. Existing `Money.format()` / `formatMoney(amount, currency)` callers continue
  to render with the currency's bundled separators.

Spec: `imani-apps/specs/046-locale-decimal-separator/`.

## [0.1.0] - 2026-02-24

### Added
- Currency registry with 25+ built-in currencies (EUR, USD, XAF, XOF, SAT, BTC, JPY, etc.)
- `Money` class with immutable integer-based arithmetic (add, subtract, multiply, split)
- `isZeroDecimal(code)` — single source of truth replacing 12+ duplicate inline arrays
- `getDecimals(code)` — currency decimal places lookup
- `isSat(code)` — SAT/SATS denomination check
- `toMinorUnits(major, currency)` / `toMajorUnits(minor, currency)` — safe conversion
- `formatMoney(minor, currency)` — locale-aware formatting
- `splitAmount(total, ratio)` — remainder-safe proportional splitting
- `registerCurrency(code, config)` — runtime custom currency registration
- Browser bundle (IIFE) for vanilla JS `<script>` tag usage via `window.ImaniMoney`
