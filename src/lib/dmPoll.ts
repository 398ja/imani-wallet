import {
  createDmPollService,
  type DmPollService,
  type EventFilter,
  type GiftWrapEvent,
  type NostrdbAdapter,
  type Profile,
  type RedemptionAdapter,
  type RedemptionOptions,
  type StorageAdapter,
  type SubscriptionHandle,
  type Voucher,
  RedemptionRefusedError,
} from '@imani/dm-poll'

import { announceArrival, type ArrivedVoucher } from './arrivalToast'
import { attestRedemption, nullifierFor } from './attestation'
import { createDmCryptoAdapter, toLegacyMetadata } from './dmCrypto'
import { loadMerchant } from './merchant'
import { checkRedemption } from './redemptionLedger'
import type { VoucherValidation } from './voucherToken'
import { getWallet, notifyWalletChanged } from './wallet'
import { legacyApi, withCorrelation } from './legacyBridge'

/**
 * Gateway REST, same-origin: `/api/v1/...` reaches customer-wallet through the
 * proxy rule that already routes `/api`. See branding.ts for why the old
 * `/customer` prefix went away — the edge rewrite that would reproduce it drops
 * the query string, and the SSE subscription below is all query string.
 */
const GATEWAY = ''

/**
 * Reads go through the gateway's nostrdb, never straight to a relay — that is
 * @imani/dm-poll's stated contract, and it is what gives us server-side chunk
 * reassembly. Writes (sending) still go browser → relay.
 */
export function nostrdbAdapter(): NostrdbAdapter {
  return {
    isAvailable: () => true,

    async queryEvents(filter: EventFilter): Promise<GiftWrapEvent[]> {
      const response = await fetch(`${GATEWAY}/api/v1/nostr/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        // `pTags`, NOT the Nostr-standard `#p`. The gateway's query DTO reads
        // pTags and silently IGNORES `#p` — verified: filtering `#p` on an
        // all-zero pubkey returns the full unfiltered set. Sending `#p` here
        // would feed the wallet every gift wrap on the box, none of which it
        // can decrypt, and the bug would look like flaky delivery rather than a
        // filter that never applied.
        body: JSON.stringify({
          kinds: filter.kinds,
          pTags: filter.pTags,
          authors: filter.authors,
          since: filter.since,
          limit: filter.limit,
        }),
      })
      if (!response.ok) throw new Error(`nostr/query failed: ${response.status}`)

      const body = (await response.json()) as { events?: RawEvent[] }
      return (body.events ?? []).map(toGiftWrap)
    },

    subscribeEvents(filter, onEvent, onError): SubscriptionHandle {
      // The gateway exposes SSE at /api/v1/nostr/subscribe. EventSource cannot
      // set headers, so this relies on the NAP session cookie being
      // same-origin — which is exactly why Vite proxies the gateway rather than
      // the app talking to :28082 directly.
      const params = new URLSearchParams()
      for (const kind of filter.kinds ?? []) params.append('kinds', String(kind))
      for (const p of filter.pTags ?? []) params.append('pTags', p)

      const source = new EventSource(`${GATEWAY}/api/v1/nostr/subscribe?${params}`)
      // Every reconnect is a hole. SSE only ever carries what arrives while the
      // socket is up: the gateway does not replay, so a wrap delivered during
      // the gap — the ten-minute stream cap, a network flap, or Android
      // freezing a backgrounded WebView mid-stream — is gone for good unless
      // something re-queries. Nothing did. `start()` ran the only catch-up of
      // the session, and a coupon that landed six seconds after the WebView was
      // frozen never reached the merchant's list.
      source.onopen = () => onSseOpen?.()
      const onFrame = (message: MessageEvent) => {
        try {
          onEvent(toGiftWrap(JSON.parse(message.data) as RawEvent))
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)))
        }
      }
      // BOTH, because the gateway names its frames and `onmessage` cannot hear
      // a named one. SseEmitterManager sends `SseEmitter.event().name("event")`,
      // which puts `event: event` on the wire, and the EventSource spec
      // dispatches that to a listener registered for the type "event" —
      // `onmessage` fires ONLY for frames with no name. So every gift wrap the
      // gateway pushed was received by the browser, parsed by EventSource, and
      // dropped on the floor for want of a listener. Silent by construction:
      // the stream is open, the bytes arrive, nothing errors, and the coupon
      // shows up only when the catch-up query runs on the next load.
      //
      // `onmessage` is kept for an unnamed frame, so a gateway that stops
      // naming them does not break this the other way round.
      source.onmessage = onFrame
      source.addEventListener('event', onFrame as EventListener)
      // Not every `error` here is a failure. The gateway caps every nostr SSE
      // stream at ten minutes (gateway-customer NostrQueryController
      // SSE_TIMEOUT_MS) and expects the client to come back — verified on
      // staging, where the backend logs `sse_cleanup reason=timeout` exactly
      // 600s after `sse_register`. EventSource handles that itself: it goes to
      // CONNECTING and redials. Reporting it as an error made DmPollService
      // abandon SSE and drop to 30s polling for the rest of the session, ten
      // minutes into every session, with a red console error to match.
      //
      // CLOSED is the real signal — the browser only gives up when the request
      // itself is unusable (401/404/502, wrong content-type), which is exactly
      // when the polling fallback is worth taking.
      source.onerror = () => {
        if (source.readyState !== EventSource.CLOSED) return
        onError(new Error('nostr SSE subscription failed'))
      }

      return {
        id: `giftwrap-${filter.pTags?.[0]?.slice(0, 8) ?? 'all'}`,
        stop: () => source.close(),
        isActive: () => source.readyState !== EventSource.CLOSED,
      }
    },

    async getProfile(pubkey: string): Promise<Profile | null> {
      // /api/v1/nostr/profiles/{pubkey} 404s on this build. Profile lookup is
      // cosmetic — never fail a coupon receipt over a display name.
      try {
        const r = await fetch(`${GATEWAY}/api/v1/nostr/profiles/${pubkey}`, {
          credentials: 'include',
        })
        return r.ok ? ((await r.json()) as Profile) : null
      } catch {
        return null
      }
    },
  }
}

/** The gateway serialises `createdAt`; GiftWrapEvent wants `created_at`. */
interface RawEvent {
  id: string
  pubkey: string
  kind: number
  createdAt?: number
  created_at?: number
  tags: string[][]
  content: string
  sig?: string
}

function toGiftWrap(raw: RawEvent): GiftWrapEvent {
  return {
    id: raw.id,
    pubkey: raw.pubkey,
    kind: 1059,
    created_at: raw.created_at ?? raw.createdAt ?? 0,
    tags: raw.tags ?? [],
    content: raw.content,
    sig: raw.sig ?? '',
  } as GiftWrapEvent
}

const PROCESSED_KEY = 'imani-wallet:dm-poll:processed'
const RECEIVED_KEY = 'imani-wallet:dm-poll:received'

function readSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/**
 * Vouchers land in the same IndexedDB the rest of the wallet reads, so an
 * arriving coupon shows up on the merchant list through WalletStorage's existing
 * broadcast — no extra plumbing between receive and render.
 */
/**
 * The coupon's face-minor-units-per-sat, from the redemption result or derived.
 *
 * Same definition as imani-apps' `calculateIssuanceRatio`: face_value /
 * token_amount. Deriving is the documented fallback — the vanilla app
 * back-computes exactly this from group totals when building merchant groups.
 */
function issuanceRatio(v: Record<string, unknown>): number | undefined {
  const supplied = Number(v.issuance_ratio)
  if (Number.isFinite(supplied) && supplied > 0) return supplied

  const face = Number(v.face_value)
  const sats = Number(v.token_amount)
  if (!Number.isFinite(face) || !Number.isFinite(sats) || sats <= 0) return undefined
  return face / sats
}

/**
 * Narrow a redeemed `Voucher` to the handful of fields the arrival toast reads.
 *
 * `Voucher` comes from the wallet-lib bridge and is structurally looser than
 * `ArrivedVoucher`, so this used to be written `voucher as unknown as
 * Parameters<typeof announceArrival>[0]`. A double cast through `unknown` tells
 * the compiler to stop checking entirely: if `ArrivedVoucher` gained a required
 * field, or one of these were renamed upstream, the cast would keep compiling
 * and the toast would quietly render `undefined`. Reading the fields one by one
 * costs nothing at runtime and puts them back under the type checker, so a
 * rename upstream fails the build here instead of on someone's screen.
 */
function toArrivedVoucher(voucher: Voucher): ArrivedVoucher {
  const v = voucher as Partial<ArrivedVoucher>
  return {
    voucher_id: v.voucher_id,
    face_value: v.face_value,
    face_unit: v.face_unit,
    face_decimals: v.face_decimals,
    sender_pubkey: v.sender_pubkey,
    memo: v.memo,
  }
}

function storageAdapter(): StorageAdapter {
  return {
    async saveVoucher(voucher: Voucher) {
      const v = voucher as unknown as Record<string, unknown>
      const token = String(v.token ?? '')
      await getWallet().saveVoucher({
        token_id: createDmCryptoAdapter().getTokenFingerprint(token) as string,
        voucher_id: v.voucher_id as string | undefined,
        token,
        amount: Number(v.token_amount ?? v.amount ?? 0),
        face_value: v.face_value as number | undefined,
        face_unit: v.face_unit as string | undefined,
        face_decimals: v.face_decimals as number | undefined,
        token_amount: v.token_amount as number | undefined,
        backing_strategy: v.backing_strategy as string | undefined,
        // Face minor units per sat. tokenRedemption resolves this through its
        // inspect → metadata → merchant-profile chain and hands it over on the
        // voucher; dropping it made VoucherGrouper fall back to `|| 1`, which
        // silently groups coupons of DIFFERENT ratios together. Invisible on
        // EUR coupons whose ratio really is 1, wrong for anything else.
        issuance_ratio: issuanceRatio(v),
        issuer_id: v.issuer_id as string | undefined,
        // tokenRedemption has already written this row through
        // walletStorageIntegration, and mergeRow skips undefined — so omitting
        // this would not clobber the expiry today. Carried anyway so the two
        // writers agree on the row's shape rather than one silently depending
        // on the other having run first.
        expires_at: v.expires_at as number | undefined,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    },

    async hasTokenBeenReceived(fingerprint: string) {
      return readSet(RECEIVED_KEY).has(fingerprint)
    },
    async markTokenAsReceived(fingerprint: string) {
      const seen = readSet(RECEIVED_KEY)
      seen.add(fingerprint)
      localStorage.setItem(RECEIVED_KEY, JSON.stringify([...seen]))
    },
    async getProcessedEventIds() {
      return [...readSet(PROCESSED_KEY)]
    },
    async saveProcessedEventIds(ids: string[]) {
      localStorage.setItem(PROCESSED_KEY, JSON.stringify(ids))
    },
  }
}

/**
 * Refuses a coupon that would take its voucher past what the issuer signed.
 *
 * The only check that looks across redemptions. A signature proves the coupon
 * is genuine and the faceValue clamp bounds any single presentation, but neither
 * notices one genuine £10 voucher being redeemed for £10 four times.
 *
 * Silent when the voucher was never verified (`validation` absent, i.e. plain
 * ecash or a pre-verification row) or carries no signed ceiling — there is
 * nothing to enforce, and inventing a bound would refuse honest coupons.
 *
 * Exported for its own test: it is reached in production only through
 * `redemptionAdapter`, which needs the legacy bridge and a live
 * `window.TokenRedemption`, and this is the money decision in it.
 */
export async function refuseIfOverRedeemed(meta: Record<string, unknown> | undefined): Promise<void> {
  const validation = meta?.validation as VoucherValidation | undefined
  const voucherId = typeof meta?.voucherId === 'string' ? meta.voucherId : undefined
  if (!validation?.signatureValid || !voucherId) return

  const requested = Number(meta?.faceValue ?? 0)
  const check = await checkRedemption({
    voucherId,
    requested,
    signedFaceValue: validation.signedFaceValue,
  })
  if (check.allowed) return

  throw new RedemptionRefusedError(
    `Voucher ${voucherId} has already paid out ${check.alreadyRedeemed} of ` +
      `${check.signedFaceValue}; refusing a further ${requested}.`,
    voucherId,
    check.alreadyRedeemed,
    check.signedFaceValue,
  )
}

/**
 * Redemption, delegated to imani-apps' canonical coordinator.
 *
 * This is the only caller of `saveVoucher` in dm-poll's flow — without a
 * RedemptionAdapter a token is unwrapped, silently dropped, and permanently
 * marked processed.
 *
 * `TokenRedemption.redeem` swaps the token at the mint so the customer owns
 * fresh proofs, then persists and acknowledges the backend escrow. That
 * receive → save → ack sequence is what makes a crash mid-redemption
 * recoverable instead of losing the coupon (spec-021), and it is the main
 * reason this bridges rather than reimplements.
 */
function redemptionAdapter(): RedemptionAdapter {
  return {
    async redeem(token: string, options?: RedemptionOptions) {
      // Loads the legacy layer and re-supplies NIP-98 credentials, which
      // api.receive signs with. Re-supplied on every redeem so a lock/reunlock
      // cycle in between cannot leave the legacy layer holding a zeroed key.
      await legacyApi()
      const redemption = window.TokenRedemption
      if (!redemption) throw new Error('TokenRedemption unavailable')

      const opts = options as unknown as Record<string, unknown> | undefined
      // Around the redeem, because the row is written inside it. The ids come
      // off the DM payload (see dmCrypto) and the row builder has no other way
      // to reach them — this is what lets a merchant's till recognise two
      // arriving coupons as the two halves of one payment request.
      const meta = opts?.metadata as Record<string, unknown> | undefined

      // BEFORE the swap, which is the whole reason the check lives here rather
      // than anywhere downstream: refusing now leaves the token untouched and
      // still the sender's, and their send reclaims at their next login. The
      // same refusal one line later — after redemption.redeem — would have
      // already taken the money at the mint.
      await refuseIfOverRedeemed(meta)

      // Computed BEFORE the redeem, because it is derived from the RECEIVED
      // token and `redeem()` swaps that token at the mint — afterwards the
      // bytes it hashes no longer exist anywhere. Riding the correlation slot
      // is what puts it on the row, which is what makes self-audit possible on
      // a device that has been wiped.
      const attestationNullifier = nullifierFor(token)

      const voucher = (await withCorrelation(
        {
          bundleId: meta?.bundleId as string | undefined,
          requestId: meta?.requestId as string | undefined,
          attestationNullifier,
          // The EXACT figures the attestation commits to, stamped alongside the
          // nullifier so the reconciliation sweep republishes a byte-identical
          // commitment. The row's own `amount` is NOT usable for this: it comes
          // off the voucher (`token_amount`), while the attestation commits
          // `meta.faceValue`, and those can differ. A sweep reading `amount`
          // would publish a SECOND, conflicting commitment for one redemption,
          // which is worse than the gap it set out to close.
          attestedValue: Number(meta?.faceValue ?? 0),
          attestedUnit: String(meta?.faceUnit ?? ''),
          // What the wallet checked about this coupon. The vendored builder
          // reads `metadata.validation`, but the row that survives is rebuilt
          // from empty metadata (see legacyBridge.withCorrelation), so without
          // this the merchant's Checks section reads "Not checked" on a coupon
          // whose signature verified.
          validation: meta?.validation as Record<string, unknown> | undefined,
        },
        () =>
          redemption.redeem(token, {
            ...options,
            metadata: toLegacyMetadata(meta, opts?.senderPubkey as string | undefined),
            // Spec-039 canonical source value. It is plumbed onto ctx.source and
            // gates the inspect-before-save precondition, so it must be a
            // recognised value rather than something descriptive.
            source: 'dm-poll',
            // dm-poll already deduped by fingerprint before calling us.
            skipDuplicateCheck: true,
          }),
      )) as unknown as Voucher

      // tokenRedemption wrote straight into IndexedDB, and this tab does not
      // hear its own BroadcastChannel post — see notifyWalletChanged.
      notifyWalletChanged()

      // Say so on screen. This is the ONLY announcement most arrivals ever get:
      // the "payment on its way" toast is driven by the Artemis queue, and the
      // only thing that enqueues to it is the atomic-send saga. A coupon
      // delivered by any other route — merchant Sell, the legacy bridge, a
      // direct NIP-17 gift wrap — moved the balance and wrote a history row in
      // complete silence.
      //
      // After notifyWalletChanged, so the balance behind the toast is already
      // the new one when the user looks. Never throws (see announceArrival), so
      // it cannot turn a completed redemption into a reported failure.
      announceArrival(toArrivedVoucher(voucher))

      // The public half of the record. `txRecords` writes the merchant's own
      // history sealed to their own key, which nobody else can read — so a
      // customer has no way to confirm their coupon was honoured, and an
      // auditor no way to see the books add up. This publishes the one fact
      // that makes both possible, carrying neither the stall's identity nor
      // the amount.
      //
      // The token is passed rather than the row: the nullifier must bind to
      // the token's own bytes, which only the parties to the payment hold. A
      // tag derived from `token_id` — which appears in the merchant's UI —
      // could be pre-published by anyone who had seen the coupon, framing an
      // honest redemption as a replay.
      //
      // After the redemption, and never throwing (see attestRedemption): the
      // proofs are already burnt by this point, so a relay refusing the record
      // must not turn a completed redemption into a reported failure.
      // `validation.signatureValid`, not merely "we have a faceValue". The
      // face value of a coupon with no verified voucher is whatever the SENDER
      // wrote in the envelope, and signing an attestation over that would be
      // the merchant vouching for a number nobody established.
      const validation = meta?.validation as { signatureValid?: boolean } | undefined
      // MERCHANTS only. dmPoll runs in every wallet, so without this a CUSTOMER
      // receiving a coupon would publish a public record of it too — a privacy
      // leak in a feature whose entire purpose is privacy, and a lie besides:
      // an attestation means "I honoured this", which a customer never did.
      //
      // `loadMerchant(...) !== null` is the same predicate the Settings row and
      // the /settings/ledger route use: the stall record's EXISTENCE, not
      // `coupon:issue`. A merchant who has closed their stall still has to
      // attest the coupons they take while winding down.
      if (loadMerchant(currentPubkey ?? '') !== null) {
        void attestRedemption({
          token,
          faceValue: Number(meta?.faceValue ?? 0),
          unit: String(meta?.faceUnit ?? ''),
          signatureValid: validation?.signatureValid === true,
          // `attestRedemption` swallows its own failures, so this catch should
          // never fire. It is here because the promise is not awaited: if that
          // contract ever broke, the rejection would be unhandled rather than
          // visible, and on a completed redemption it must be neither.
        }).catch((error) => console.error('[dmPoll] attestation failed', error))
      }

      return voucher
    },
  }
}

let service: DmPollService | undefined
/** Whose poller `service` is. An account switch must not inherit it. */
let currentPubkey: string | undefined
/** Set by `startDmPoll`, called by the SSE adapter on every (re)connect. */
let onSseOpen: (() => void) | undefined

/**
 * Re-query the window SSE may have missed.
 *
 * Cheap to over-call: dm-poll skips any event already in its processed set, so
 * a redundant catch-up costs one query and no writes.
 */
function catchUp(): void {
  void service?.fetchRecentDms()
}

/**
 * Start receiving coupons.
 *
 * `recipientPrivkey` is why this wallet holds the key at all: NIP-17 unwrapping
 * needs NIP-44 decryption, and NAP's signer contract is sign-only. See
 * lib/signer.ts.
 */
export function startDmPoll(pubkey: string): DmPollService {
  // Re-entry for the SAME identity returns the running poller — that is what
  // keeps StrictMode's mount/unmount/remount from starting a second one.
  if (service && currentPubkey === pubkey) return service

  // A DIFFERENT identity is an account switch, and inheriting the previous
  // user's poller would have it fetching gift wraps addressed to them and
  // redeeming their coupons into this session. It used to, because the guard
  // above was `if (service)` and ignored the argument entirely.
  if (service) {
    console.log('[dmPoll] identity changed, restarting the poller')
    stopDmPoll()
  }
  currentPubkey = pubkey

  service = createDmPollService({
    recipientPubkey: pubkey,
    // Empty ON PURPOSE. DmPollService keeps this as a plain string on its
    // config, and a string cannot be zeroed — so a key handed over here would
    // outlive `signer.clearKey()` and keep the poller decrypting through a lock.
    // The crypto adapter reads the key from the signer at each unwrap instead
    // (see dmCrypto's unwrapNip17Dm), which leaves the signer its only holder.
    // `getStatus().hasPrivkey` now reports false, which is the truth.
    recipientPrivkey: '',
    // Wider than the 24h default. NIP-59 randomises a gift wrap's created_at
    // into the past to frustrate timing analysis, so a coupon sent minutes ago
    // can carry a timestamp from two days back and fall outside a 24h `since`
    // window — present on the relay, invisible to the wallet.
    recentDmsSince: 7 * 24 * 60 * 60,
    nostrdbAdapter: nostrdbAdapter(),
    cryptoAdapter: createDmCryptoAdapter(),
    storageAdapter: storageAdapter(),
    redemptionAdapter: redemptionAdapter(),
    // Without this the adapter above is never called: dm-poll only redeems when
    // auto-redemption is on AND an adapter exists.
    enableAutoRedemption: true,
  })
  void service.start()
  // The first `onopen` fires after `start()` has already caught up, so it costs
  // one duplicate query per session — worth not special-casing.
  onSseOpen = catchUp
  // The socket is not the only thing a freeze breaks. Coming back to the
  // foreground catches the case where the stream looks alive to the client but
  // the gateway already reaped it (`sse_cleanup reason=keepalive failed`).
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', catchUp)
  return service
}

function onVisible(): void {
  if (document.visibilityState === 'visible') catchUp()
}

/**
 * Stop the poller and forget it.
 *
 * There is no `refreshDmPollKeys` counterpart any more, and there is nothing to
 * refresh: the service is constructed with no key, and the crypto adapter reads
 * the current one from the signer at each unwrap. A lock/reunlock cycle
 * therefore needs no re-supply — the next unwrap after a reunlock simply reads
 * the restored key, and the ones attempted while locked throw, get tracked as
 * failed, and are retried after dm-poll's cooldown.
 */
export function stopDmPoll(): void {
  onSseOpen = undefined
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('online', catchUp)
  void service?.stop()
  service = undefined
  currentPubkey = undefined
}
