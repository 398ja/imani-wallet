/**
 * ExchangeRateAdapter — host-injected rate provider for the unified-total
 * computation (spec 040).
 *
 * The package never imports a concrete rate provider; the host
 * (browser wallet shell) wires `shared/exchangeRateAdapter.js` which
 * wraps `shared/exchange.js`. Tests wire deterministic adapters.
 *
 * All amounts flow in minor units. `fromDecimals` / `toDecimals` make
 * precision explicit so the aggregator can stay integer-clean.
 *
 * See specs/040-unified-balance-display/contracts/wallet-balance-extensions.md
 * for the full contract (whitelist-before-delegate guard, semantics per
 * method, regression test).
 */

export interface ExchangeRateAdapter {
  /**
   * Convert `amountMinor` from `fromCurrency` to `toCurrency`, returning the
   * converted amount in minor units of `toCurrency`. Strictly synchronous +
   * cache-only — MUST NOT trigger a network fetch.
   *
   * Returns `null` when either currency is outside `supportedTargets()`, or
   * when the underlying provider cannot produce a usable rate (offline + no
   * cached or static fallback path).
   *
   * Identity case (`fromCurrency === toCurrency`): MUST return `amountMinor`
   * unchanged.
   */
  toDisplay(
    amountMinor: number,
    fromCurrency: string,
    fromDecimals: number,
    toCurrency: string,
    toDecimals: number,
  ): number | null;

  /**
   * Optional cheap synchronous probe for a specific `(from, to)` pair.
   * NOT used by the Settings UI (consumes supportedTargets()) and NOT used
   * by resolveDefaultDisplayCurrency() (also consumes supportedTargets()).
   * Exists for ad-hoc callers (diagnostics, future single-pair UIs).
   * MUST return `true` for `from === to`.
   */
  supports(from: string, to: string): boolean;

  /**
   * Returns the set of currency codes that may appear as a display-currency
   * target. Consumed by the Settings UI dropdown and by
   * resolveDefaultDisplayCurrency().
   *
   * Today (as wired by shared/exchangeRateAdapter.js):
   *   ['eur', 'usd', 'xaf', 'xof', 'sat']
   *
   * Callers MUST NOT cache this indefinitely — the host may ship an updated
   * shared/exchange.js with a wider set in a future release.
   */
  supportedTargets(): string[];

  /**
   * Best-effort async refresh of the underlying rate cache. May trigger a
   * network call. Resolves regardless of success. Wired by the host to
   * `online` window event + the periodic-catch-up timer + the existing
   * `balance-updated` re-render chain.
   */
  refresh(): Promise<void>;
}

/**
 * Per-currency aggregate consumed by `computeUnifiedTotal` and
 * `resolveDefaultDisplayCurrency`. Amounts in minor units of the bucket's
 * currency.
 */
export interface VoucherBucket {
  currency: string;
  amount: number;
  decimals: number;
}

export interface UnifiedTotalInput {
  buckets: VoucherBucket[];
  displayCurrency: string;
  displayDecimals: number;
  rateLookup: ExchangeRateAdapter;
}

export interface UnifiedTotalOutput {
  displayCurrency: string;
  total: number | null;
  decimals: number;
  unconvertible: string[];
}
