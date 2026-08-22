/**
 * Bridge to imani-apps' unextracted `shared/*.js` modules.
 *
 * `shared/tokenRedemption.js` is the canonical redemption coordinator — the one
 * imani-apps' own migration doc calls a crown jewel: "extract whole, never
 * rewrite". It carries ~14 specs' worth of production lessons (claim
 * contention, escrow acknowledgement, provenance verification, pending-receive
 * recovery, a five-source face_unit fallback). Reimplementing it against the
 * NUT specs would reproduce the protocol and none of the scar tissue, on the
 * one path where being wrong loses real money.
 *
 * ---------------------------------------------------------------------------
 * These are CLASSIC SCRIPTS, and they are loaded as classic scripts.
 *
 * Importing them as ESM does not work, and the reason is worth stating because
 * it looks like it should. Under ESM every top-level binding is module-scoped,
 * so a dependent evaluating a bare `api` or `resolveDecimals` resolves nothing.
 * Some of these files paper over that by self-assigning `window.X` and so
 * survive a side-effect import; `shared/format.js` has neither an export nor a
 * window assignment, which makes it simply unreachable that way.
 *
 * Loaded via <script> tags, every top-level `function` lands on globalThis and
 * every top-level `const` lands in the global lexical environment — both
 * resolvable as bare identifiers from any later script AND from module code.
 * The files then satisfy each other exactly as they do in the vanilla app, with
 * no shims to drift out of sync.
 *
 * `shared/currency.js` is the one exception: a real ES module, imported as one.
 *
 * ponytail: this pulls a slice of the pre-React world into an app that is
 * otherwise on clean package boundaries. The real fix is Wave 3 of their
 * extraction plan — `@imani/token-redemption` — serving both apps. Debt, not a
 * pattern to copy.
 */
import * as NostrTools from 'nostr-tools'

// `?url` rather than a hardcoded /@fs path: Vite rewrites these to the served
// URL in dev and emits them as assets on build, so the same code works in both.
import formatUrl from '../../shared/format.js?url'
import gatewayConfigUrl from '../../shared/gateway-config.js?url'
import tokenSecurityLibUrl from '../../shared/lib/token-security.browser.js?url'
import tokenSecurityUrl from '../../shared/tokenSecurityIntegration.js?url'
import nostrUrl from '../../shared/nostr.js?url'
import apiUrl from '../../shared/api.js?url'
import walletStorageUrl from '../../shared/walletStorageIntegration.js?url'
import tokenRedemptionUrl from '../../shared/tokenRedemption.js?url'

import { getWallet } from './wallet'
import { getSigner } from './nap'
// Not re-exported from the package index, so imported from source — the alias
// already points at src/, and this is the exact derivation the store itself
// uses, which is the whole point of not recomputing it here.
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'

declare global {
  interface Window {
    NostrTools?: unknown
    NostrUtils?: {
      setAuthCredentials(privateKeyHex: string, publicKeyHex: string): void
    }
    api?: Record<string, (...args: never[]) => unknown>
    TokenSecurity?: unknown
    ImaniCurrency?: unknown
    TokenRedemption?: {
      redeem(token: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>
    }
    walletStorageIntegration?: {
      init(opts: { walletStorage: unknown }): Promise<void>
      atomicallyWrite(input: { vouchers?: unknown[]; transactions?: unknown[] }): Promise<void>
    }
  }
}

/** Load one classic script and resolve when it has executed. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
    if (existing) return resolve()

    const el = document.createElement('script')
    el.src = src
    // Dynamically inserted scripts default to async; these must run in order.
    el.async = false
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(el)
  })
}

/**
 * Restore the `token_id` that shared/storage.js would have synthesised.
 *
 * In the vanilla app `saveVoucher` (shared/storage.js) derives `token_id`
 * before anything else sees the row. We do not load that file, so the voucher
 * reaches `_persistRedeemed` without one — and `_buildReceiveTransactionRow`
 * returns null on a missing `token_id`, because the atomic write keys on the
 * content-derived id (Principle III). Observed directly: `atomicallyWrite`
 * received `token_id: null` and `transactions: []`, so the coupon persisted and
 * its receive transaction silently did not. The merchant screen's Transactions
 * section was empty by construction, for every coupon ever received.
 *
 * The voucher row itself survived because WalletStorage auto-derives the id on
 * write — which is exactly what made this invisible.
 *
 * The row is rebuilt with tokenRedemption's OWN `_buildReceiveTransactionRow`
 * (a classic-script global, so it is reachable), not a local imitation of it.
 *
 * ponytail: a wrapper around someone else's module. The real fix is token_id
 * synthesis living in the extracted package rather than in the 10.5k-line
 * storage.js we decline to load — Wave 3, same place this whole bridge goes.
 */
/**
 * Correlation the DM carries and the redemption path cannot pass through.
 *
 * `_buildReceiveTransactionRow` reads `metadata.bundle_id` and nothing else of
 * this kind, and the rebuild branch below calls it with `{}` — which is the
 * live branch for DM receives, so extending `toLegacyMetadata` alone would
 * still land a row with no bundle and no request on it. Rather than patch the
 * vendored file, the poller declares what it knows for the duration of one
 * redeem and the write stamps it on, whichever branch built the row.
 *
 * Held on the in-flight redeem rather than keyed by token id, because there is
 * no token id both ends agree on: `TokenRedemption.redeem()` SWAPS the token
 * at the mint, so the row it writes is keyed on the fingerprint of a token
 * that did not exist when the DM arrived. Keying the registration on the
 * received token — the obvious thing, and what this did first — matched
 * nothing on staging and left every arrival with `bundleId: null`, so a
 * merchant's till could not tell that two coupons were one €7 payment.
 *
 * One slot is enough: `DmPollService` awaits `redeemToken` inside a sequential
 * `for` loop at both of its call sites, so redeems never overlap.
 */
let pending: { bundleId?: string; requestId?: string } | undefined

/** Run one redeem with the DM's bundle/request ids attached to whatever it writes. */
export async function withCorrelation<T>(
  ids: { bundleId?: string; requestId?: string },
  redeem: () => Promise<T>,
): Promise<T> {
  pending = ids.bundleId || ids.requestId ? ids : undefined
  try {
    return await redeem()
  } finally {
    // Cleared even when the redeem throws: a failed receive must not stamp its
    // request id onto the next coupon that happens to arrive.
    pending = undefined
  }
}

/** Fill in bundle/request ids the row's builder had no way to know. */
function stampCorrelation(rows: unknown[]): unknown[] {
  const ids = pending
  if (!ids) return rows
  return rows.map((row) => {
    const t = row as Record<string, unknown>
    // `||`, not `??` — the vendored builder writes `null`, not `undefined`.
    return {
      ...t,
      bundleId: t.bundleId || ids.bundleId,
      requestId: t.requestId || ids.requestId,
    }
  })
}

/** Exported for the correlation test; `loadLegacyRedemption` is the real caller. */
export function installTokenIdFill(): void {
  const wsi = window.walletStorageIntegration
  if (!wsi) return
  const write = wsi.atomicallyWrite.bind(wsi)
  const buildRow = (globalThis as unknown as Record<string, unknown>)
    ._buildReceiveTransactionRow as ((v: unknown, m: unknown) => unknown) | undefined

  wsi.atomicallyWrite = async (input) => {
    const vouchers = await Promise.all(
      (input.vouchers ?? []).map(async (row) => {
        const v = row as Record<string, unknown>
        if (v.token_id || typeof v.token !== 'string') return row
        return { ...v, token_id: await tokenIdFrom(v.token) }
      }),
    )
    // Only fills the gap this function exists for; a caller that supplied its
    // own transactions keeps them untouched.
    const transactions =
      input.transactions?.length || !buildRow
        ? input.transactions
        : vouchers.map((v) => buildRow(v, {})).filter(Boolean)

    return write({ vouchers, transactions: transactions && stampCorrelation(transactions) })
  }
}

let loaded: Promise<void> | undefined

/**
 * Install prerequisites, then load the vanilla modules in dependency order.
 * Idempotent — the DM poller and any manual-claim surface both call it.
 */
export function loadLegacyRedemption(): Promise<void> {
  if (loaded) return loaded

  loaded = (async () => {
    // nostr.js expects the nostr-tools UMD bundle as a global. Point at the npm
    // package we already depend on rather than imani-apps' vendored lib/ copy,
    // so there is only one version of it in the page.
    window.NostrTools ??= NostrTools

    // tokenRedemption uses exactly getItem/setItem — not the 10.5k-line
    // shared/storage.js. This MUST be assigned: the DOM already defines a
    // global `Storage` constructor, so the `typeof Storage !== 'undefined'`
    // guard passes on its own and `Storage.getItem(...)` then throws. The
    // failure lands at the call site, not the guard.
    ;(window as unknown as Record<string, unknown>).Storage = {
      getItem: (k: string) => localStorage.getItem(k),
      setItem: (k: string, v: string) => localStorage.setItem(k, v),
    }

    // Currency resolution (feature 007-fix-voucher-currency). Must be published
    // BEFORE tokenRedemption.js executes: that file installs its own fallback
    // mirror only `if (!window.ImaniCurrency)`, and reads `__currencyApi` at
    // module-evaluation time.
    //
    // Do not hand-shim this. A guessed shim does not sit alongside the mirror,
    // it suppresses it — which surfaced as
    // `__currencyApi.normalizeFaceUnit is not a function` deep in _doRedeem.
    const currency = await import('../../shared/currency.js')
    window.ImaniCurrency ??= Object.freeze({
      UNKNOWN: currency.UNKNOWN,
      normalizeFaceUnit: currency.normalizeFaceUnit,
      resolveFaceUnit: currency.resolveFaceUnit,
    })

    // Dependency order. api.js constructs its singleton at load, so everything
    // it reads has to already be present.
    await loadScript(formatUrl) // resolveDecimals + formatting helpers
    await loadScript(gatewayConfigUrl) // GatewayConfig
    // ImaniTokenSecurity — load-bearing, not optional hardening.
    //
    // Without it tokenSecurityIntegration falls back to
    // `fallback_${token.slice(0,50)}_${token.length}`. Every voucher this stack
    // issues shares a CBOR header and a length, so ALL of them collapse onto
    // ONE fingerprint. tokenRedemption keys its cross-tab claim ledger on that
    // value, so coupon #2 onwards short-circuits as "already DONE" against
    // coupon #1's voucher_id and is never redeemed — and it seeds the gateway
    // Idempotency-Key too. Observed: two distinct tokens, same `fallback_…`,
    // second one dropped. The real fingerprint is sorted proof secrets + mint
    // URL. `var ImaniTokenSecurity = (…)()` makes it a classic-script global.
    await loadScript(tokenSecurityLibUrl) // ImaniTokenSecurity
    await loadScript(tokenSecurityUrl) // TokenSecurity (needs ImaniTokenSecurity)
    await loadScript(nostrUrl) // NostrUtils  (needs NostrTools)
    await loadScript(apiUrl) // api          (needs NostrUtils, GatewayConfig)
    await loadScript(walletStorageUrl) // walletStorageIntegration
    await loadScript(tokenRedemptionUrl) // TokenRedemption

    if (!window.TokenRedemption) {
      throw new Error('tokenRedemption.js loaded but window.TokenRedemption is unset')
    }

    // How a redeemed coupon actually reaches IndexedDB.
    //
    // `_persistRedeemed` writes through `walletStorageIntegration.atomicallyWrite`
    // (voucher row + transaction row in ONE IDB transaction) and falls back to a
    // bare global `saveVoucher` — shared/storage.js's slot — when that bridge is
    // absent. We deliberately do not load shared/storage.js, so the fallback was
    // an unguarded `ReferenceError: saveVoucher is not defined`: the mint swap
    // succeeded, the local write threw, and the coupon existed only as a backend
    // escrow. Supplying the bridge takes the atomic path instead, which is both
    // the better one and the reason a receive-transaction row exists at all.
    //
    // It gets THE SAME WalletStorage instance the UI reads, so an arriving
    // coupon lands in the store the merchant list is already subscribed to.
    if (!window.walletStorageIntegration) {
      throw new Error('walletStorageIntegration.js loaded but its global is unset')
    }
    await window.walletStorageIntegration.init({ walletStorage: getWallet() })
    installTokenIdFill()
  })()

  return loaded
}

/**
 * The only way callers should reach the legacy layer.
 *
 * `loadLegacyRedemption()` is memoised, so it brings `window.api` up exactly
 * once — but credentials must be re-supplied on EVERY use, because a
 * lock/reunlock cycle zeroes the key held by the legacy layer. Splitting those
 * two steps means each new caller has to remember the second one, and the
 * failure when they don't is "NIP-98 authentication required but Nostr
 * credentials not set" from a code path that looks perfectly wired. The pay
 * screen hit exactly that. Both steps live here so there is nothing to forget.
 */
export async function legacyApi(): Promise<NonNullable<Window['api']>> {
  await loadLegacyRedemption()
  setLegacyCredentials(getSigner().privkeyHex(), getSigner().pubkey)
  if (!window.api) throw new Error('api.js loaded but window.api is unset')
  return window.api
}

/**
 * Give the legacy API layer the credentials it signs NIP-98 requests with.
 *
 * Without this `api.inspectVoucher` only warns and falls back, but `api.receive`
 * — the actual mint swap — is authenticated and fails hard. Call after unlock,
 * and again after any reunlock, since a lock zeroes the key.
 */
export function setLegacyCredentials(privkeyHex: string, pubkeyHex: string): void {
  // Two SEPARATE credential stores, and setting only one is a silent half-fix:
  //
  //  - NostrUtils.setAuthCredentials → NIP-42 relay AUTH.
  //  - api.setNostrCredentials       → the NIP-98 HTTP signing keys the gateway
  //    client reads as `_nostrPublicKey` / `_nostrPrivateKey`.
  //
  // Wiring only the first still logs "Auth credentials set for NIP-42" while
  // every authenticated request fails with "NIP-98 authentication required but
  // Nostr credentials not set" — which is exactly how this was missed once.
  // Note the argument order differs: (pubkey, privkey) here.
  window.NostrUtils?.setAuthCredentials(privkeyHex, pubkeyHex)
  ;(window.api as unknown as {
    setNostrCredentials?(publicKeyHex: string, privateKeyHex?: string | null): void
  })?.setNostrCredentials?.(pubkeyHex, privkeyHex)
}
