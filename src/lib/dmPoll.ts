import {
  createDmPollService,
  type DmPollService,
  type EventFilter,
  type GiftWrapEvent,
  type NostrdbAdapter,
  type Profile,
  type RedemptionAdapter,
  type RedemptionErrorEvent,
  type RedemptionOptions,
  type StorageAdapter,
  type SubscriptionHandle,
  type Voucher,
  RedemptionRefusedError,
  retryOnTransientMintError,
} from '@imani/dm-poll'

import {
  announceBundleArrival,
  resumeBundleArrivals,
  stopBundleArrivals,
  type ArrivedVoucher,
} from './arrivalToast'
import { announceQueued, settleQueued, type QueuedBundleSeed } from './queuedToast'
import { gatesSealed, receivesOpen } from './receiveGate'
import { REFUSAL_MESSAGES, announceRefusal } from './refusalToast'
import {
  announceUnsaved,
  dropAcknowledgedReceipts,
  listUnsavedReceipts,
  type ReceiveStatusLookup,
  resumeUnsavedReceipts,
} from './unsavedReceipt'
import { recordRefusal } from './refusedCoupons'
import { heldCoupons, recordHeld, releaseHeld } from './heldCoupons'
import { clearReceiveTrouble, fromRedemptionError, fromRedemptionUnsaved } from './receiveTrouble'
import { announceHeld } from './heldToast'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import { attestRedemption, nullifierFor, publishRedeemed } from './attestation'
import { attestationForReceivedCoupon } from './cashAttestation'
import { getSigner } from './nap'
import { postPaymentReceipt } from './paymentReceipt'
import { receiptAddressee } from './receiptAddressee'
import {
  awaitsHeldWrap,
  noteTransferReceived,
  resetHeldTransfers,
  resumeTransferReceipts,
  transferIdFor,
} from './transferSignature'
import { createDmCryptoAdapter, toLegacyMetadata } from './dmCrypto'
import { confirmChunkDeliveries, resetChunkAssembly } from './dmChunks'
import { cancelDeferredWrite, deferWrite, flushDeferredWrites } from './deferredWrite'
import { loadMerchant } from './merchant'
import { licenceFromToken } from './licences'
import { ForeignVoucherRefusedError, MERCHANT_FOREIGN_VOUCHER, MERCHANT_STATUS_UNKNOWN, refuseForeignVouchers } from './merchantVouchers'
import { checkPart, checkRedemption, redeemLockName } from './redemptionLedger'
import { exactFaceValue, parseVoucherToken, type VoucherValidation } from './voucherToken'
import { raiseHomecomingAlert } from './terminalHomecoming'
import { getWallet, notifyWalletChanged, recordReceiptByNullifier } from './wallet'
import { legacyApi, withCorrelation } from './legacyBridge'
import { claimToFile } from './merchantClaim'
import { shopAttributionFor } from './shopTakings'
import { withWebLock } from './webLock'
import { CALLS_PER_RECEIVE, receivePacer } from './receivePacer'
import { checkTokenBacking, loadTrustedMints, onTrustedMintsChange } from './trustedMint'
import { couponReference, fullyRedeemedMessage, isVoucherFullyRedeemed } from './fullyRedeemed'
import { refusalOf } from './cardPaymentState'
import type { SpendSource } from './spendSource'
import { createHeldPartPuller, type HeldPartPuller, type IncomingPart } from './heldPartPull'
import { openBundles } from './bundleArrival'

/**
 * A receive the mint refused as redeemed in full (cashu-mint#540), as dm-poll's terminal refusal.
 * Anything else is returned unchanged.
 */
export function asFullyRedeemedRefusal(failure: unknown, meta: Record<string, unknown> | undefined): unknown {
  // imani-wallet#277: the gateway refused a card voucher whose payment was refunded or disputed.
  const card = refusalOf(failure)
  if (card) {
    const voucherId = typeof meta?.voucherId === 'string' ? meta.voucherId : ''
    console.warn('[dmPoll] coupon refused by the gateway: card payment refunded', {
      reference: couponReference(voucherId),
      status: card.status,
    })
    return new RedemptionRefusedError(
      REFUSAL_MESSAGES['payment-refunded'].detail,
      voucherId,
      0,
      card.remainingMinor,
      'payment-refunded',
    )
  }
  if (!isVoucherFullyRedeemed(failure)) return failure
  const voucherId = typeof meta?.voucherId === 'string' ? meta.voucherId : ''
  const signed = Number((meta?.validation as { signedFaceValue?: unknown } | undefined)?.signedFaceValue ?? 0)
  console.warn('[dmPoll] coupon refused by the mint: redeemed in full', { reference: couponReference(voucherId) })
  return new RedemptionRefusedError(
    fullyRedeemedMessage(voucherId),
    voucherId,
    Number.isFinite(signed) ? signed : 0,
    Number.isFinite(signed) ? signed : 0,
    'fully-redeemed',
  )
}

/**
 * Gateway REST, same-origin: `/api/v1/...` reaches customer-wallet through the
 * proxy rule that already routes `/api`. See branding.ts for why the old
 * `/customer` prefix went away — the edge rewrite that would reproduce it drops
 * the query string, and the SSE subscription below is all query string.
 */
const GATEWAY = ''


/**
 * Backoffs for a rate-limited redemption.
 *
 * The gateway's limiter is a one-minute window and it answers `Retry-After:
 * 60`, so the sequence has to be able to outlast a full window. dm-poll's
 * default (1s, 4s, 15s) exhausts itself inside one and drops the coupon.
 *
 * Rises past 60s because several coupons arriving together are all waiting on
 * the same window: the first through consumes the allowance the next is
 * waiting for.
 */
export const RATE_LIMIT_BACKOFFS_MS: readonly number[] = [5_000, 20_000, 65_000, 65_000]

/** A 429 from the gateway, however the layers below have reshaped it. */
export function isRateLimited(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status
  if (status === 429) return true
  // The legacy bridge rebuilds errors and does not always carry `status`, so
  // the message is a fallback rather than the primary test.
  return /rate limit/i.test(String((error as Error | undefined)?.message ?? ''))
}

/**
 * Reads go through the gateway's nostrdb, never straight to a relay — that is
 * @imani/dm-poll's stated contract.
 *
 * It does NOT give us chunk reassembly, which this comment claimed for a long
 * time and which cost three real coupons. A DM too big to send whole is split
 * into `cashu_dm_chunk` envelopes INSIDE the encrypted rumor, so the gateway
 * cannot see them and refuses to try ("decrypt on client and reassemble
 * plaintext" — NostrdbChunkReassemblyService). `lib/dmChunks.ts` does the
 * reassembly, wired into `unwrapNip17Dm` in lib/dmCrypto.ts.
 *
 * Writes (sending) still go browser → relay.
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
          // Forwarded so the fetcher can PAGE. Without it every query returns
          // the same newest page and a wallet holding more coupons than one
          // page can carry never sees the rest (#38).
          until: filter.until,
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
      // Profile lookup is cosmetic — never fail a coupon receipt over a
      // display name.
      //
      // A 404 here is NORMAL and not a broken endpoint, which is what this
      // comment used to claim. /api/v1/nostr/profiles/{pubkey} serves 200 with
      // the kind-0 when one exists; it answers 404 when that pubkey has simply
      // never published one. The pubkey we pass is the DM's rumor author, and
      // coupon DMs are gift-wrapped by the GATEWAY's own identity rather than
      // the merchant's (attribution rides on issuer_id inside the payload, see
      // issue.ts). The gateway is infrastructure and publishes no kind-0, so
      // the common case is a 404 by design. Every consumer treats the profile
      // as optional and falls back to a short pubkey, so nothing is lost.
      //
      // The TIMEOUT is what makes that promise true. DmPollService awaits this
      // inside its sequential redemption loop, so a fetch that never settles
      // does not just lose a display name: it stalls every remaining coupon
      // behind it, silently and forever. Observed while recording a fixture —
      // 5 gift wraps fetched, coupon 1 redeemed and stored, then nothing. No
      // error, no timeout, no further iteration; the wallet simply held 1 of 5
      // and looked like a delivery fault in the gateway.
      //
      // catch covers the abort too, so a slow profile is treated exactly like
      // a missing one.
      try {
        const r = await fetch(`${GATEWAY}/api/v1/nostr/profiles/${pubkey}`, {
          credentials: 'include',
          signal: AbortSignal.timeout(5000),
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
 * The received-token set, held in memory and mirrored to storage.
 *
 * **Why a mirror rather than reading through.** `hasTokenBeenReceived` runs
 * once per event in the poll loop and `markTokenAsReceived` re-read the whole
 * set again to add one entry — each call a synchronous `getItem` plus a
 * `JSON.parse` of every fingerprint the wallet has ever banked. Measured on a
 * 2000-event catch-up against a 5000-entry set: ~350MB parsed and ~2s of
 * blocking main-thread work, all of it re-deriving a value that had not
 * changed. That was the dominant cost of a catch-up once the write side was
 * coalesced.
 *
 * The adapter OWNS this key — dm-poll reaches storage only through here — so
 * the in-memory copy cannot drift behind another writer. It is loaded once,
 * lazily, and every read is answered from it thereafter.
 *
 * **Not deferred on write, deliberately.** This set is the first line of
 * defence against crediting a coupon twice, so the `setItem` stays
 * synchronous; what is removed here is the redundant READ, which costs
 * nothing to skip because memory already holds the answer.
 */
let receivedCache: Set<string> | null = null

/**
 * Whether the mirror is known to match what is on disk.
 *
 * False after a write that threw — quota, private browsing — which is the one
 * state in which "it is already in memory" stops implying "it is already
 * saved". `markTokenAsReceived` consults this so a failed write is retried on
 * the next receive instead of being masked forever by its own memory hit.
 */
let receivedPersisted = true

/**
 * A ceiling on the received set, so it cannot grow for the life of the wallet.
 *
 * It had none. Every coupon a merchant ever banked added a fingerprint that
 * was never removed, and the whole set is re-serialised on each addition — so
 * a busy stall's wallet got permanently slower at receiving money, with no
 * bound and no way back short of clearing storage.
 *
 * **The cap is what bounds the WRITE, so it is sized small deliberately.**
 * Every receive serialises the whole set synchronously, which makes the cost
 * of one receive proportional to the cap: at 20000 fingerprints that is ~700KB
 * of blocking `JSON.stringify` per coupon, which is worse than the unbounded
 * growth it was meant to fix. 2000 keeps it near 70KB while still covering far
 * more than the seven-day window the poll actually re-reads — and the window
 * is the only thing this set has to outlast, because a wrap older than that is
 * never offered again.
 *
 * **Trimming is safe because this set is not the last line of defence.** It is
 * a fast local "I have seen this already" that saves a pointless mint round
 * trip. The MINT is what actually prevents a double-spend: re-presenting a
 * spent token returns an already-redeemed error, which dm-poll recognises
 * (`isAlreadyRedeemedError`) and handles by marking the token received and
 * moving on. So the worst case for an evicted fingerprint is one wasted round
 * trip that fails safely, and never a coupon credited twice.
 */
const MAX_RECEIVED = 2000

function receivedSet(): Set<string> {
  if (receivedCache === null) {
    const loaded = readSet(RECEIVED_KEY)
    // TRIMMED AT LOAD, not on the first receive.
    //
    // Every wallet upgrading to this build carries a set written while it was
    // unbounded, and the trim in `markTokenAsReceived` only runs when a coupon
    // arrives — so the first receive after an upgrade paid for the whole
    // oversized set at once. Measured with 50000 legacy entries: a 403ms
    // synchronous stall, at the exact moment a customer is standing at the
    // counter watching a coupon land.
    //
    // Doing it here moves that cost to poller startup, where nothing is
    // waiting on it, and it happens once. `keep` takes the NEWEST entries,
    // matching the oldest-first eviction on the write path.
    if (loaded.size > MAX_RECEIVED) {
      const keep = [...loaded].slice(-MAX_RECEIVED)
      receivedCache = new Set(keep)
      // Written back immediately so the next session loads the small set
      // rather than re-trimming this one forever.
      try {
        localStorage.setItem(RECEIVED_KEY, JSON.stringify(keep))
      } catch {
        // Quota. The mirror is correct for this session; the flag below is
        // what gets the write retried.
        receivedPersisted = false
      }
    } else {
      receivedCache = loaded
    }
  }
  return receivedCache
}

/**
 * Drop the mirror so the next read reloads from storage.
 *
 * For sign-out and for tests. An account switch must not answer the next
 * user's "have I seen this?" from the previous user's memory.
 */
export function resetReceivedCache(): void {
  receivedCache = null
  // A fresh load from storage is by definition in agreement with it, so the
  // owed-write flag resets with the mirror it describes.
  receivedPersisted = true
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

/**
 * The sender's bundle declaration off the parsed DM, whole or not at all (#94).
 *
 * dmCrypto already drops a partial or garbled one, so this only narrows the
 * types. Display hints: nothing that books or caps money reads the result.
 */
function declaredBundleOf(
  meta: Record<string, unknown> | undefined,
): { bundleId: string; index: number; count: number; total: number } | undefined {
  const bundleId = meta?.bundleId
  const index = meta?.bundlePartIndex
  const count = meta?.bundlePartCount
  const total = meta?.bundleTotal
  if (
    typeof bundleId !== 'string' ||
    typeof index !== 'number' ||
    typeof count !== 'number' ||
    typeof total !== 'number'
  ) {
    return undefined
  }
  return { bundleId, index, count, total }
}

/**
 * What a rate-limited part tells the arrival toast before anything has landed,
 * so the first part being held back opens the payment's one toast at "0 of 2"
 * instead of a separate "Still receiving" (#94). Declared figures, display only.
 */
function queuedSeed(
  meta: Record<string, unknown> | undefined,
  envelopeSigner: string | undefined,
): QueuedBundleSeed | undefined {
  const declared = declaredBundleOf(meta)
  const unit = meta?.faceUnit
  if (!declared || typeof unit !== 'string') return undefined
  return {
    declaredTotal: declared.total,
    declaredCount: declared.count,
    // The payer, in the same order the arrival and the receipt use.
    senderPubkey: (meta?.senderPubkey as string | undefined) ?? envelopeSigner,
    recipientPubkey: currentPubkey,
    unit,
    decimals: typeof meta?.faceDecimals === 'number' ? meta.faceDecimals : undefined,
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
      // Answered from memory. This runs once per event in the poll loop, and
      // re-parsing the whole set from storage to answer it was the single
      // largest cost of a catch-up.
      return receivedSet().has(fingerprint)
    },
    async markTokenAsReceived(fingerprint: string) {
      const seen = receivedSet()
      // The early return is on "already in memory AND memory is on disk", not
      // on memory alone. A previous write that hit quota leaves the two
      // disagreeing, and returning early on the memory hit would mean the
      // fingerprint NEVER reaches storage — it would be re-offered to the mint
      // on every future session, which is exactly the cost this set exists to
      // avoid. While a write is owed, every mark retries it.
      if (receivedPersisted && seen.has(fingerprint)) return
      seen.add(fingerprint)
      // Oldest first. `Set` iterates in insertion order, so the first value is
      // the longest-banked fingerprint and the least likely to be offered
      // again — the poll only looks back seven days.
      while (seen.size > MAX_RECEIVED) {
        const oldest = seen.values().next().value
        if (oldest === undefined) break
        seen.delete(oldest)
      }
      // SYNCHRONOUS, and it must stay that way. This set is the first line of
      // defence against crediting a coupon twice, and it is keyed on the
      // token fingerprint precisely so it can be trusted when the
      // processed-event cache below cannot. Deferring it would open a window
      // in which a crash loses the record of a redemption that really
      // happened. (The mint is the BACKSTOP -- see `MAX_RECEIVED` -- but a
      // backstop that costs a network round trip is not a reason to be
      // careless with the local record.)
      //
      // The READ that used to precede this is gone — memory already holds the
      // set — but the write itself is unchanged and still lands before this
      // resolves.
      try {
        localStorage.setItem(RECEIVED_KEY, JSON.stringify([...seen]))
        receivedPersisted = true
      } catch (error) {
        // Quota or private browsing. The mirror still dedupes for this
        // session, which is strictly better than the previous behaviour of
        // letting the exception escape into dm-poll's redemption path.
        console.warn('[dmPoll] could not persist the received-token set', error)
        receivedPersisted = false
      }
    },
    async getProcessedEventIds() {
      return [...readSet(PROCESSED_KEY)]
    },
    async saveProcessedEventIds(ids: string[]) {
      // The one moment a chunked coupon's transfer may be remembered as
      // completed (#204). dm-poll calls this only after an outcome it will not
      // retry (saved, already held, refused for good), so a transfer whose
      // completing event is in `ids` is durably handled. Before this, the
      // transfer was tombstoned the moment its pieces decoded, and a reload or
      // any retryable failure in the redemption stranded the coupon.
      confirmChunkDeliveries(ids)
      // Deferred and coalesced, unlike `markTokenAsReceived` above.
      //
      // dm-poll calls this once per event it finishes, and `localStorage` is
      // synchronous, so a catch-up over a week of wraps re-serialised the whole
      // set on every one of them: measured at ~134MB across ~1800 blocking
      // writes for a 2000-event pass, all on the main thread. Sizing the set to
      // the 7-day fetch window is what made that reachable.
      //
      // Safe to defer BECAUSE it is only a cache. Losing the tail of it costs
      // a re-read of wraps the wallet already handled, and the re-read is
      // caught by the received set above, which is written synchronously. The
      // two have different durability needs and now get different treatment.
      // `ids` is captured per call rather than read back inside the callback:
      // dm-poll owns this array and hands over the complete state each time, so
      // the last queued call already carries the newest value.
      deferWrite(PROCESSED_KEY, () => {
        try {
          localStorage.setItem(PROCESSED_KEY, JSON.stringify(ids))
        } catch {
          // Quota. The in-memory tracker still dedupes for this session.
        }
      })
    },
  }
}

/**
 * Marks that this device has already forgotten its pre-reassembly tombstones.
 *
 * **Versioned, because the amnesty is needed more than once.** The key used to
 * be unversioned, so the one-shot fired for the chunk-reassembly fix and could
 * never fire again — which made it useless for the NEXT defect that abandoned
 * coupons the same way. Bumping the suffix is how a later fix declares that the
 * tombstones written before it are not to be trusted.
 *
 * v2: coupons abandoned by the 16-chunk ceiling. A transfer split more ways had
 * every piece refused, fell through to the text parser as a non-token DM, and
 * was marked processed forever. Those wraps are still on the relay, and this is
 * the only thing standing between the customer and their money.
 */
const CHUNK_AMNESTY_KEY = 'imani-wallet:dm-poll:chunk-amnesty:v2'

/** The unversioned key the first amnesty used. Cleaned up, not read. */
const LEGACY_CHUNK_AMNESTY_KEY = 'imani-wallet:dm-poll:chunk-amnesty'

/**
 * Forget, once, that this wallet gave up on the coupons it could not reassemble.
 *
 * Fixing the reassembly is not enough to recover the coupons it already lost. A
 * chunk that arrived before `lib/dmChunks.ts` existed was classified
 * `non_token_dm`, and that outcome carries `shouldMarkProcessed: true` with
 * `retryEligible: false` — the event id went into `PROCESSED_KEY` and the
 * poller skips it forever. The gift wraps are still on the relay (verified: 11
 * of them for the recipient whose coupons went missing), so the ONLY thing
 * standing between the customer and their money is this local tombstone.
 *
 * Clearing the whole processed set is safe and is the reason this is a blunt
 * instrument rather than a targeted one. The set is a performance shortcut, not
 * a correctness boundary: re-processing an already-redeemed coupon is caught by
 * `hasTokenBeenReceived`, which keys on the TOKEN's fingerprint and is left
 * untouched here. So the worst case is one wasted pass over old wraps, while
 * the best case is three real coupons arriving.
 *
 * Runs at most once per device PER VERSION of this key — after that the
 * tombstones are honest again, because anything newly abandoned was abandoned
 * by code that could reassemble. A later fix that invalidates that assumption
 * again must bump the key rather than add a second mechanism.
 */
function grantChunkAmnesty(): void {
  try {
    if (localStorage.getItem(CHUNK_AMNESTY_KEY)) return

    const abandoned = readSet(PROCESSED_KEY).size
    // Any queued write for this key is dropped first. The amnesty's whole
    // purpose is to REMOVE these ids, and a deferred save queued moments
    // earlier would land afterwards and put every one of them straight back.
    cancelDeferredWrite(PROCESSED_KEY)
    localStorage.removeItem(PROCESSED_KEY)
    localStorage.setItem(CHUNK_AMNESTY_KEY, new Date().toISOString())
    // The v1 marker has done its job and its presence would only be misleading
    // to read later. Removed here so the storage carries one answer, not two.
    localStorage.removeItem(LEGACY_CHUNK_AMNESTY_KEY)

    if (abandoned > 0) {
      console.log(
        '[dmPoll] re-examining events this wallet gave up on before it could ' +
          `reassemble chunked coupons (${abandoned} event ids forgotten)`,
      )
    }
  } catch {
    // localStorage can throw in private-browsing modes. A wallet that cannot
    // run the amnesty still works for every coupon arriving from now on, so
    // this must not stop the poller from starting.
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
 *
 * `token` is the presented coupon. When it parses, the part is checked at its
 * CUMULATIVE credit (`checkPart`): the floor of the voucher's exact running
 * total less what is already booked, rather than `meta.faceValue`, which is
 * this part rounded on its own. Per-part rounding let 2000 one-sat parts at
 * ratio 0.5 (each worth 0.5, each rounded to 1) book 2000 against a face of
 * 1000; cumulative rounding books 1000 and the exact ceiling holds with no
 * allowance, while an honest split still books the full face. Without a
 * token, or one that does not parse, the rounded `faceValue` is checked.
 *
 * Resolves to the cumulative credit when one was computed, which the caller
 * must BOOK in place of `meta.faceValue` (the row, the attestation and the
 * arrival all read that field). Undefined means nothing changed.
 */
export async function refuseIfOverRedeemed(
  meta: Record<string, unknown> | undefined,
  token?: string,
): Promise<number | undefined> {
  const validation = meta?.validation as VoucherValidation | undefined
  const voucherId = typeof meta?.voucherId === 'string' ? meta.voucherId : undefined
  if (!validation?.signatureValid || !voucherId) return undefined

  const exact = exactOf(token)
  const { requested, check } =
    exact === undefined
      ? await (async () => {
          const requested = Number(meta?.faceValue ?? 0)
          return {
            requested,
            check: await checkRedemption({
              voucherId,
              requested,
              signedFaceValue: validation.signedFaceValue,
            }),
          }
        })()
      : await checkPart({ voucherId, exact, signedFaceValue: validation.signedFaceValue }).then(
          ({ credit, check }) => ({ requested: credit, check }),
        )
  if (check.allowed) return exact === undefined ? undefined : requested

  throw new RedemptionRefusedError(
    `Voucher ${voucherId} has already paid out ${check.alreadyRedeemed} of ` +
      `${check.signedFaceValue}; refusing a further ${requested}.`,
    voucherId,
    check.alreadyRedeemed,
    check.signedFaceValue,
  )
}

/** The token's unrounded value in face minor units, or undefined if unreadable. */
function exactOf(token: string | undefined): number | undefined {
  if (!token) return undefined
  try {
    return exactFaceValue(parseVoucherToken(token))
  } catch {
    return undefined
  }
}

/**
 * Refuses a coupon that is a claim on a different stall.
 *
 * A coupon is honoured by the stall that issued it and by nobody else. The
 * signature says the voucher is genuine; it says nothing about whether THIS
 * stall is the one that owes against it. `services/wallet-api/redeem.ts` has
 * always drawn that line (`REFUSAL.ANOTHER_STALL`) and this path did not, so a
 * till would take another stall's coupon, credit the customer, and publish an
 * attestation claiming it had honoured it.
 *
 * Two harms, and the FIRST is the likelier one:
 *
 *  1. A customer at the wrong counter. The merchant credits a coupon they can
 *     never redeem and absorbs the loss silently. No malice needed.
 *  2. A public attestation misattributing the redemption. The committed value
 *     is the coupon's own signed face value, so the number is true — what is
 *     false is the claim of entitlement, which is what an auditor reads it as.
 *
 * **Only a stall may refuse on these grounds, and only for coupons it did not
 * issue.** `loadMerchant` rather than `isMerchant`, deliberately, and matching
 * the attestation gate in `redemptionAdapter` below: a stall that has switched
 * "Open for business" off is still a stall, and its comment there — "a merchant
 * who has closed their stall still has to attest the coupons they take while
 * winding down" — applies with equal force to refusing coupons that were never
 * theirs. Two gates disagreeing about who a wallet is would be worse than
 * either answer.
 *
 * A CUSTOMER wallet never reaches this check, and must not: a customer holding
 * a coupon is the ordinary case, and refusing it would break the product. The
 * role model makes that unambiguous — `merchant.ts` says an account is a
 * merchant "if and only if" it has a stall record, so there is no wallet that
 * is both at once.
 *
 * A TERMINAL never reaches it either, and that is by construction rather than
 * by luck: ADR 0005 has a payment request name the stall's own pubkey as
 * recipient, "so redeemed coupons are gift-wrapped to the stall and never to
 * the terminal that asked for them". The poller on a terminal device receives
 * no coupons at all.
 *
 * Silent for plain ecash and for anything whose signature did not verify. The
 * former carries no issuer claim to check; the latter was already refused by
 * `dmCrypto`, and double-handling it here would only confuse the reason.
 *
 * **Silent for a LICENCE, and that exception is load-bearing.** A licence is a
 * voucher too (ADR 0007), delivered by the same gift-wrapped DM and landing in
 * the same store — but it is issued by US and sent TO the stall, so its
 * `issuerId` is never the receiving stall's own key. Without this branch, the
 * check would refuse every subscription a merchant ever bought, which is a
 * worse outage than the bug it closes: a stall could not renew. `licences.ts`
 * exists for exactly this hazard, and its rule is the one used here — a voucher
 * is a licence when the ISSUER SAID SO in signed `merchant_metadata`, which a
 * sender cannot forge without breaking `verifyVoucher`.
 *
 * Synchronous, unlike its sibling: this reads no storage, so making it async
 * would only invite a caller to forget the `await` and get a check that always
 * passes.
 */
/**
 * Refuses a coupon that nothing outside the issuing service authorised.
 *
 * **Before the mint swap**, for the same reason `refuseIfAnotherStalls` is: a
 * refusal one line later, after `redeem()`, would already have taken the money
 * at the mint and left the customer with neither the coupon nor the goods.
 *
 * **Every recipient refuses, not only the issuing stall (#159, Option B).**
 * Unlike `refuseIfAnotherStalls`, this has no merchant guard, deliberately: a
 * customer's wallet receiving a coupon by DM refuses it exactly as the issuing
 * stall's till would. The alternative — refusing only at the till and letting
 * customers hold these — was rejected because it lets a customer pay for a
 * coupon the stall that issued it will then refuse to honour. Refusing on
 * receipt keeps the coupon the sender's (it reclaims at their next login)
 * rather than the customer's useless asset.
 *
 * The cost is that a sale that cannot produce a verifiable warrant cannot be
 * delivered to anyone. A terminal is the case that matters: its key is not
 * the stall's, so it can only send `none`. Sell therefore refuses on a
 * terminal before anything is minted (`mayWarrantSale` in warrantSigner.ts).
 * The `delegated` form is verified since #152 (`issuerDelegation.ts`) and the
 * card purchase issuer signs with it; terminals at the counter do not yet.
 *
 * All four unauthorised states are refused together — no warrant, a warrant
 * signed as `none`, a warrant that was present and did not hold, and an
 * unsigned `processor` claim nobody here can check (#152). They are
 * different claims and the merchant-facing copy says so, but on receipt they
 * have one answer: nobody outside the service that minted this says the stall
 * it names issued it.
 *
 * **Why absence is refused and not merely noted.** While only a failed warrant
 * was refused, omitting the warrant was strictly safer for an attacker than
 * forging one: a forgery was caught and an absence sailed through. That made
 * the scheme opt-out for exactly the party it was written to catch.
 *
 * A row whose validation predates this field is NOT refused — `warrant` is
 * undefined there, the question was never asked, and refusing on a check that
 * never ran would reject good coupons for a reason nobody could act on.
 */
/**
 * The customer's attestation for a coupon just received, or undefined.
 *
 * Re-parses the token rather than taking figures off `meta`, because a warrant
 * is inside the SIGNED bytes and the envelope is not. Cheap: the token is
 * already in hand, and this runs once per redemption.
 *
 * Never throws. The redemption has already happened when this is called, so an
 * exception would turn a completed one into a reported failure over evidence
 * that was optional — the same posture `postPaymentReceipt` takes.
 */
function attestReceived(token: string): string | undefined {
  try {
    const { voucher } = parseVoucherToken(token)
    const signer = getSigner()
    // The SIGNER's own pubkey, not the caller's notion of who is logged in.
    // They are the same key in practice, and taking it from the signer means
    // the attestation names whoever actually signed it - so the two can never
    // disagree about who attested.
    return attestationForReceivedCoupon(
      voucher.issuanceWarrant,
      voucher.issuerId,
      signer.pubkey,
      (digest) => signer.withPrivkey((key) => bytesToHex(schnorr.sign(digest, key))),
    )
  } catch (error) {
    console.warn('[dmPoll] could not attest a received coupon', error)
    return undefined
  }
}

/**
 * The home-coming check for one coupon (#160 phase 6). Only for this stall's own coupons, read
 * from the SIGNED voucher. Never throws and never refuses.
 */
export function homecomingAlertFor(
  meta: Record<string, unknown> | undefined,
  stallPubkey: string | undefined,
  token: string,
): void {
  try {
    if (!stallPubkey) return
    const { voucher } = parseVoucherToken(token)
    if (voucher.issuerId.toLowerCase() !== stallPubkey.toLowerCase()) return
    const id = typeof meta?.voucherId === 'string' ? meta.voucherId : voucher.voucherId
    // Not awaited: an alert never holds up a redemption. Never rejects.
    void raiseHomecomingAlert(stallPubkey.toLowerCase(), voucher.issuanceWarrant, id)
  } catch {
    // Not a voucher, or unreadable: there is no till to check.
  }
}

export function refuseIfUnwarranted(meta: Record<string, unknown> | undefined): void {
  const validation = meta?.validation as VoucherValidation | undefined
  if (!validation?.signatureValid) return

  // Never checked, so there is nothing to refuse on. Distinct from `absent`,
  // which IS a checked answer meaning the coupon carried no warrant.
  if (validation.warrant === undefined) return

  if (
    validation.warrant !== 'absent' &&
    validation.warrant !== 'unwarranted' &&
    validation.warrant !== 'failed' &&
    // An unsigned `processor` warrant (#152). It names a payment record but
    // carries no signature, and nothing on this device can check the record,
    // so it is the issuing service's word alone: the trust a warrant exists to
    // remove. Any merchant session could mint one. The card path signs a
    // `delegated` warrant instead, which verifies (`issuerDelegation.ts`).
    validation.warrant !== 'claimed'
  ) {
    return
  }

  const voucherId = typeof meta?.voucherId === 'string' ? meta.voucherId : ''

  throw new RedemptionRefusedError(
    `Coupon ${voucherId || '(unknown)'} carries no usable authorisation from the stall ` +
      'that issued it. Refusing before the mint swap, so the coupon stays the sender\u2019s.',
    voucherId,
    0,
    validation.signedFaceValue,
    'unwarranted',
  )
}

/**
 * The owner rule of 2026-10-13 on the DM path: a merchant account takes only its own stall's
 * vouchers. `refuseIfAnotherStalls` answers it synchronously for a verified voucher on a device
 * holding the stall's record; this asks the rest through `refuseForeignVouchers` (relay role,
 * unverified issuer, licence and credential exemptions), before the swap. A refusal is terminal and
 * nothing moved, so the coupon stays the sender's.
 */
export async function refuseForeignForMerchant(
  meta: Record<string, unknown> | undefined,
  account: string | undefined,
  token: string,
): Promise<void> {
  if (!account) return
  try {
    await refuseForeignVouchers([token], account)
  } catch (e) {
    if (!(e instanceof ForeignVoucherRefusedError)) throw e
    const voucherId = typeof meta?.voucherId === 'string' ? meta.voucherId : ''
    if (e.reason === 'unknown') {
      // Not terminal: the role may be known on the next tick. Thrown as an ordinary error, which
      // dm-poll treats as transient and retries; nothing was swapped.
      throw new Error(`${MERCHANT_STATUS_UNKNOWN} (coupon ${voucherId || 'unknown'})`)
    }
    const validation = meta?.validation as VoucherValidation | undefined
    throw new RedemptionRefusedError(
      `Coupon ${voucherId || '(unknown)'}: ${MERCHANT_FOREIGN_VOUCHER} Refusing before the mint swap, so the ` +
        'coupon stays the sender\u2019s.',
      voucherId,
      0,
      validation?.signedFaceValue ?? 0,
      'another-stall',
    )
  }
}

export function refuseIfAnotherStalls(
  meta: Record<string, unknown> | undefined,
  stallPubkey: string | undefined,
  /**
   * The coupon's own bytes, for the licence exception above.
   *
   * Passed rather than read off `meta`, because whether something is a licence
   * is a property of the SIGNED voucher and `meta` is the envelope-derived
   * shape. Optional so the check degrades to "not a licence" rather than
   * throwing when a caller has no token to hand.
   */
  token?: string,
): void {
  const validation = meta?.validation as VoucherValidation | undefined
  if (!validation?.signatureValid) return

  // Not a stall, so not our question. A customer receiving a coupon is the
  // ordinary case and every coupon they hold is somebody else's claim.
  if (!stallPubkey || loadMerchant(stallPubkey) === null) return

  // From the SIGNED voucher, never the envelope. `dmCrypto` overwrites the
  // envelope's `issuer_id` with the voucher's `issuerId` whenever the signature
  // verified, so by here this is the issuer's own attested claim — but the
  // guard is cheap and the failure it prevents is crediting on a sender-written
  // field.
  const issuerId = typeof meta?.issuerId === 'string' ? meta.issuerId : undefined
  if (!issuerId) return

  if (issuerId.toLowerCase() === stallPubkey.toLowerCase()) return

  // A subscription we sold this stall. Arrives from another issuer BY DESIGN.
  if (licenceFromToken(token) !== null) return

  const voucherId = typeof meta?.voucherId === 'string' ? meta.voucherId : ''

  throw new RedemptionRefusedError(
    `Coupon ${voucherId || '(unknown)'} is a claim on stall ${issuerId.slice(0, 16)}…, ` +
      'which is the only stall that can honour it. Refusing before the mint swap, so the ' +
      'coupon stays the sender’s and reclaims at their next login.',
    voucherId,
    // Not a ceiling breach, and these fields say so rather than inventing
    // numbers: nothing has been redeemed against this voucher HERE, and the
    // signed face value is whatever the other stall issued.
    0,
    validation.signedFaceValue,
    'another-stall',
  )
}

/**
 * Redemptions under way: swapped (or about to be) and not yet written.
 *
 * For logout (review of #326, owner rule 2026-10-18): stopping the poller ends
 * NEW deliveries but not one already inside `redeem`, which swaps at the mint
 * and THEN writes the coupon. Logout must see that write before its final
 * backup check, or it deletes a coupon that exists only in IndexedDB.
 */
let redemptionsInFlight = 0
const drainWaiters = new Set<() => void>()
/**
 * Bumped by `stopDmPoll`. An adapter refuses every redeem once its poller has
 * been stopped (second check of #326): `DmPollService.stop()` does not end a
 * catch-up batch already looping, so without this the batch's NEXT gift wrap
 * swapped at the mint after the drain had answered "nothing in flight", and
 * after the wipe, burning proofs that were then written nowhere.
 */
let pollerGeneration = 0

function countingInFlight(adapter: RedemptionAdapter): RedemptionAdapter {
  const generation = pollerGeneration
  return {
    ...adapter,
    async redeem(...args: Parameters<RedemptionAdapter['redeem']>) {
      if (generation !== pollerGeneration || gatesSealed()) {
        // Before anything is swapped, so the delivery stays the sender's and
        // unprocessed: the next poller (this account after a refused logout,
        // or the next login) offers it again. Sealed: this tab let go of the
        // store for another tab (#353), and a poller restarted since (a resume
        // from a refused logout elsewhere) must not swap into a closed store.
        throw Object.assign(new Error('redemption deferred: the poller was stopped'), {
          code: 'RECEIVE_DEFERRED',
        })
      }
      redemptionsInFlight++
      try {
        return await adapter.redeem(...args)
      } finally {
        redemptionsInFlight--
        if (redemptionsInFlight === 0) for (const wake of [...drainWaiters]) wake()
      }
    },
  }
}

/**
 * Resolve once no redemption is in flight, or after `timeoutMs`. Returns
 * whether it drained. Never throws.
 */
export function drainDmPoll(timeoutMs: number): Promise<boolean> {
  if (redemptionsInFlight === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      drainWaiters.delete(wake)
      resolve(true)
    }
    const timer = setTimeout(() => {
      drainWaiters.delete(wake)
      resolve(redemptionsInFlight === 0)
    }, timeoutMs)
    drainWaiters.add(wake)
  })
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
    // Where the value is, asked by dm-poll before every redeem (#131). Plain ecash
    // and vouchers alike: a rogue mint does not need to forge a coupon to be paid.
    checkBacking: checkTokenBacking,
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
      let meta = opts?.metadata as Record<string, unknown> | undefined

      // BEFORE the swap, which is the whole reason these checks live here
      // rather than anywhere downstream: refusing now leaves the token
      // untouched and still the sender's, and their send reclaims at their next
      // login. The same refusal one line later — after redemption.redeem —
      // would have already taken the money at the mint.
      //
      // Whose coupon is it, before how much is left on it. A coupon this stall
      // cannot honour has no ceiling worth computing, and asking that question
      // first means the refusal names the real reason rather than whichever
      // check happened to fire.
      //
      // Check, swap and write run under one Web Lock per voucher. Within a
      // tab dm-poll is sequential, but every tab runs its own poller over the
      // same history, and two parts of one voucher checked in two tabs would
      // both read the same priors: each would book its credit from the same
      // base, and the ceiling and the `issued` bound would each be checked
      // against rows the other was about to write. Where there is no Locks API
      // this runs as before. Per device only: a second till on another
      // device is not serialised by this, see ADR 0015 (#97).
      const lockName = typeof meta?.voucherId === 'string' && meta.voucherId !== ''
        ? redeemLockName(meta.voucherId)
        : undefined
      const checkSwapAndWrite = async (): Promise<Voucher> => {
        refuseIfAnotherStalls(meta, currentPubkey, token)
        // Owner rule 2026-10-13, the cases the synchronous check above cannot see: a stall known
        // only from the relay (this device holds no stall record), an unverified voucher, and an
        // account whose role cannot be checked (fail closed). Own coupons never ask.
        await refuseForeignForMerchant(meta, currentPubkey, token)
        refuseIfUnwarranted(meta)
        // Trigger (a) of the home-coming roster check (#160 phase 6, decision 5 Q2): a coupon a
        // till sold, coming home to its stall, under a credential the stall's list never had.
        // An alert only: the coupon is honoured, because the customer paid.
        homecomingAlertFor(meta, currentPubkey, token)
        // The part's CUMULATIVE credit, when the token could be read: what is
        // booked and honoured from here on, in place of the per-part rounding
        // dmCrypto put on `faceValue`. See `refuseIfOverRedeemed`.
        //
        // Only for a coupon coming HOME, the one case its row is filed against
        // the issuance (see merchantClaim.ts). A customer's figure is untouched.
        const credit = await refuseIfOverRedeemed(meta, token)
        const issuer = typeof meta?.issuerId === 'string' ? meta.issuerId.toLowerCase() : ''
        if (credit !== undefined && issuer !== '' && issuer === currentPubkey?.toLowerCase()) {
          meta = { ...meta, faceValue: credit }
        }

        // Computed BEFORE the redeem, because it is derived from the RECEIVED
        // token and `redeem()` swaps that token at the mint — afterwards the
        // bytes it hashes no longer exist anywhere. Riding the correlation slot
        // is what puts it on the row, which is what makes self-audit possible on
        // a device that has been wiped.
        const attestationNullifier = nullifierFor(token)

        // Read against local history BEFORE the swap and outside the retry, so
        // the bound it applies (an `issued` row here, capped at what that issue
        // has left) sees the same rows `refuseIfOverRedeemed` just checked.
        const claim = await claimToFile(meta, currentPubkey, exactOf(token))

        // Retry a rate-limited redemption instead of losing the coupon.
        //
        // The gateway limits /api/v1/wallet/receive per pubkey: 10 a minute
        // until imani-gateway-customer 0.19.2, 120 by default from then
        // (`gateway.customer.ratelimit.receive`). At 10, any wallet receiving
        // more than ten coupons in a minute trips it. Without this the
        // failure was silent and permanent: DmPollService logged, moved on, and
        // the coupon was never redeemed. Measured at 120 coupons: 320 rate-limit
        // errors and 50 coupons stored (#39).
        //
        // Waits out the window rather than guessing a safe rate. The wallet
        // cannot know what limit is enforced, and a rate it guesses will drift
        // from the server's — whereas Retry-After is the server saying it.
        //
        // #110 adds pacing IN FRONT of this, not instead of it. Waiting out a
        // 429 is right for the stray one; as the only mechanism it meant an
        // 8-part bundle fired 32 calls at a 10/min budget, drew 16 429s, and
        // the acks caught in them were dropped. The pacer keeps a bundle under
        // the budget; this retry still catches whatever else spent it.
        //
        // Pacing is per CALL: tokenRedemption passes every api.receive (every
        // retry layer included) through the gate installed by
        // installPacingGates. Acks are exempt from the limit (#120), unpaced.
        installPacingGates(redemption)
        let voucher: Voucher
        try {
          voucher = (await retryOnTransientMintError(
          async () => {
            return withCorrelation(
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
            // The issuing stall, stamped for the same reason as the figures
            // beside it: the reconciliation sweep republishes from the ROW, and
            // without this a swept attestation would carry no issuer commitment
            // even though the original did — so a gap closed by the sweep would
            // silently lose the property this whole version bump exists for.
            attestedIssuer: typeof meta?.issuerId === 'string' ? meta.issuerId : undefined,
            // The id a customer-to-customer transfer signature is keyed on
            // (#91), so the sender's payload can be filed on this row once it
            // pairs. Computed here because the swap below changes the token.
            transferId: transferIdFor(token),
            // The part's unrounded value, on every VERIFIED coupon and not only
            // one coming home: a customer's rows are the priors of the next part
            // too, and a prior without it is legacy history to the ceiling.
            exactValue: (meta?.validation as VoucherValidation | undefined)?.signatureValid
              ? exactOf(token)
              : undefined,
            // A verified credit of 0 is booked as 0. The vendored row builder
            // reads `face_value || token_amount` and would otherwise book the
            // token's sats as face units.
            zeroCredit:
              (meta?.validation as VoucherValidation | undefined)?.signatureValid === true &&
              Number(meta?.faceValue) === 0,
            // What the wallet checked about this coupon. The vendored builder
            // reads `metadata.validation`, but the row that survives is rebuilt
            // from empty metadata (see legacyBridge.withCorrelation), so without
            // this the merchant's Checks section reads "Not checked" on a coupon
            // whose signature verified.
            validation: meta?.validation as Record<string, unknown> | undefined,
            // Files the row against the voucher the stall ISSUED, so its claimed
            // figure and redemption ceiling see it (#90). See merchantClaim.ts.
            claim,
            // #402: an online shop's hand-in names its terminal on the stall's row. See shopTakings.ts.
            terminalPubkey: claim ? shopAttributionFor(opts?.senderPubkey, currentPubkey) : undefined,
            // #402: the order an online shop spent it on, kept on the row (legacyBridge).
            spendSource: (meta as { spendSource?: SpendSource } | undefined)?.spendSource,
          },
          (correlationId) =>
            redemption.redeem(token, {
              ...options,
              // The redeem's own correlation id rides in the metadata onto the
              // voucher row, so this coupon's row is stamped with this coupon's
              // ids even while another coupon is mid-redeem (#145).
              metadata: {
                ...toLegacyMetadata(meta, opts?.senderPubkey as string | undefined),
                correlation_id: correlationId,
              },
              // Spec-039 canonical source value. It is plumbed onto ctx.source and
              // gates the inspect-before-save precondition, so it must be a
              // recognised value rather than something descriptive.
              source: 'dm-poll',
              // dm-poll already deduped by fingerprint before calling us.
              skipDuplicateCheck: true,
            }),
            )
          },
          {
            isTransient: isRateLimited,
            // Long enough to outlast a one-minute window, which the short
            // default (1s/4s/15s) cannot: it would exhaust its budget inside the
            // window it is waiting for and drop the coupon anyway.
            backoffsMs: RATE_LIMIT_BACKOFFS_MS,
            onRetry: ({ attempt, delayMs }) => {
              console.info(`[dmPoll] rate limited, retrying in ${delayMs}ms (attempt ${attempt})`)
              // Say so on screen. Until this, a coupon waiting out the limiter
              // and a coupon that failed looked exactly alike — which is the one
              // thing a person cannot be left guessing about when it is their
              // money (#40).
              //
              // A part of a multi-coupon payment attaches to that payment's
              // one toast instead (#94), so a queued part reads "1 of 2 still
              // receiving" rather than as a second payment.
              announceQueued(
                meta?.voucherId as string | undefined,
                delayMs,
                meta?.bundleId as string | undefined,
                queuedSeed(meta, opts?.senderPubkey as string | undefined),
              )
            },
          },
          )) as unknown as Voucher
        } catch (failure) {
          // #301 review: the redemption gave up on the receive pacer (#300). dm-poll
          // keeps the delivery unprocessed, but in SSE mode nothing re-polls on a
          // timer, so without this the retry waited for the stream's ten-minute
          // redial. One catch-up, shortly after, offers it again.
          if ((failure as { deferredBy?: unknown } | null)?.deferredBy === 'receive-gate-timeout') {
            scheduleDeferredCatchUpFor(token)
          }
          // cashu-mint#540: gateway-customer declared this home-coming coupon and the mint refused
          // it as redeemed in full (400 VOUCHER_FULLY_REDEEMED). Nothing was swapped. Terminal: as
          // a typed refusal, dm-poll marks the delivery handled and announces it, rather than
          // retrying a coupon whose answer cannot change.
          throw asFullyRedeemedRefusal(failure, meta)
        } finally {
          // The wait is over, whichever way it went — and `finally` because the
          // way that matters most is the one that throws. A toast saying "still
          // receiving" left open above a redemption that has given up is worse
          // than never having shown it: it is the wallet asserting something
          // untrue about the customer's money, indefinitely.
          //
          // Dismissed rather than left to expire so it cannot briefly overlap
          // the arrival toast below, which would read as two separate payments.
          settleQueued(meta?.voucherId as string | undefined, meta?.bundleId as string | undefined)
        }
        return voucher
      }
      const voucher = lockName ? await withWebLock(lockName, checkSwapAndWrite) : await checkSwapAndWrite()
      deferredRetries.delete(token)

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
      //
      // `currentPubkey` is OUR key — the wallet this landed in. It scopes the
      // inbox row the toast now also files, and the preference check that gates
      // both; without it the toast still shows but nothing reaches the bell.
      //
      // One coupon of a multi-coupon payment updates that payment's ONE toast
      // and bell row instead of raising its own (#94). The sender's declared
      // total and count ride along as display hints only: the row above was
      // written from the coupon itself, and nothing here touches it. A coupon
      // with no usable declaration takes the plain `announceArrival` path.
      // A licence is not a payment either: no money toast, no "+…" and no `voucher_received`
      // row, but its own notice naming the PLAN ("Imani Essentials plan activated", or "renewed"), from
      // the token's signed metadata, as `licences.ts` reads it for the balance. Never the seller's
      // key: no npub is shown to end users.
      const licence = licenceFromToken(token)
      if (licence) {
        // Lazily, like every toast module on this path: sonner touches the DOM at import.
        const voucherId = String(meta?.voucherId ?? '')
        const voucherKey = licence.subscriptionId + ':' + voucherId
        void (async () => {
          // A renewal when this device already held ANOTHER licence of the same subscription. This
          // one is already in the store by now, under its post-swap token, so it is told apart by
          // its SIGNED voucher id (a renewal is a new voucher), not by the token string.
          let renewal = false
          try {
            const { listVouchers } = await import('./wallet')
            const { licenceIn } = await import('./licences')
            const signedId = (t: string): string | null => {
              try {
                return parseVoucherToken(t).voucher.voucherId
              } catch {
                return null
              }
            }
            const own = signedId(token)
            renewal = (await listVouchers()).some((row) => {
              if (licenceIn(row)?.subscriptionId !== licence.subscriptionId) return false
              const other = signedId(row.token)
              return other !== null && other !== own
            })
          } catch {
            // Wording only: "activated" is right enough when the store cannot be read.
          }
          const m = await import('./notMoneyNotice')
          m.showNotice(m.licenceNotice(voucherKey, licence, { renewal }), currentPubkey)
        })().catch(() => undefined)
      } else void announceBundleArrival(
        toArrivedVoucher(voucher),
        declaredBundleOf(meta),
        currentPubkey,
        opts?.deliveryEventId as string | undefined,
      )

      // And tell the SENDER it landed. They have no other way to know: the
      // money left their balance when they sent the gift wrap, and whether it
      // was ever claimed is invisible from their side.
      //
      // NOT gated on being a merchant, unlike attestRedemption below: that
      // attests "I honoured this", which only a merchant does, while this says
      // "your coupon arrived", which every recipient owes the sender.
      //
      // Fire-and-forget and never throws: the proofs are already burnt, so a
      // gateway that refuses the receipt must not turn a completed redemption
      // into a reported failure.
      void postPaymentReceipt({
        // The PAYER, in three descending degrees of confidence — and NOT the
        // issuer, which is the bug this ordering replaces.
        //
        // `issuerId` used to come first, on the reasoning that the gateway
        // signs the gift wrap so the envelope's signer is never the payer.
        // The premise is right and the conclusion was wrong: `issuerId` is who
        // MINTED the coupon, which on a merchant-issued coupon is the stall.
        // So when A paid B with a coupon A had bought from a merchant, B's
        // redemption told the MERCHANT their coupon was claimed and told A
        // nothing — the reported defect exactly. The merchant learns about a
        // redemption through `attestRedemption` below, which is the mechanism
        // that actually means "I honoured this".
        //
        //   1. `meta.senderPubkey` — the payload's own `sender_pubkey`, which
        //      gateway-core sets from the send row (Nip17DmSendPublisher). This
        //      is the authoritative answer whenever the gateway relayed.
        //   2. `opts.senderPubkey` — the envelope's signer, correct for a bare
        //      wallet-to-wallet NIP-17 wrap with no payload field.
        //   3. `issuerId` — last resort only. For a merchant delivering a
        //      coupon straight to a customer the stall IS the sender, so this
        //      still reaches the right party in the one case it is right, and
        //      is now unreachable in the case where it was wrong.
        //
        // A card sale's sender is the stall's DELEGATE (the purchase issuer), whose receipt queue
        // nobody drains; `receiptAddressee` sends those to the stall instead (card receipts).
        senderPubkeyHex: receiptAddressee(
          String(meta?.senderPubkey ?? opts?.senderPubkey ?? meta?.issuerId ?? ''),
          token,
        ),
        deliveryEventId: String(opts?.deliveryEventId ?? ''),
        voucherId: meta?.voucherId as string | undefined,
        // Amounts ONLY from a verified voucher.
        //
        // dmCrypto is explicit that envelope fields are sender-written and
        // unchecked: "a genuine low-value token could be announced at any face
        // value at all". attestRedemption below refuses to sign over an
        // unverified face value for that reason, and a notification asserting
        // one to the sender is the same claim in a friendlier place.
        //
        // Omitted rather than guessed: postPaymentReceipt renders "Your
        // voucher was claimed" without an amount, which is true either way.
        ...(meta?.validation as { signatureValid?: boolean } | undefined)?.signatureValid === true
          ? {
              faceValue: meta?.faceValue == null ? undefined : Number(meta.faceValue),
              faceUnit: meta?.faceUnit == null ? undefined : String(meta.faceUnit),
              faceDecimals: meta?.faceDecimals == null ? undefined : Number(meta.faceDecimals),
            }
          : {},
        // Signed here, on the customer's own device, over the SALE the coupon's
        // warrant describes. Gated on the same `signatureValid` as the amounts
        // above and for the same reason: envelope fields are sender-written,
        // and attesting over an unverified figure would sign a claim the
        // sender chose.
        //
        // Undefined whenever the coupon carries no warrant, which is every
        // coupon issued before warrants shipped. That is a normal state, not a
        // failure, and the receipt goes out exactly as it does today.
        cashAttestation:
          (meta?.validation as { signatureValid?: boolean } | undefined)?.signatureValid === true
            ? attestReceived(token)
            : undefined,
        // The sender's own bundle declaration, handed back so their claim
        // receipts for one multi-coupon payment collapse into one (#94).
        bundle: declaredBundleOf(meta),
      })

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
          // The stall that ISSUED the coupon, for the v2 issuer commitment.
          // Off the signed voucher (dmCrypto overwrites the envelope's value
          // with it whenever the signature verified), so this is the issuer's
          // own claim rather than a sender-written one.
          issuerId: typeof meta?.issuerId === 'string' ? meta.issuerId : undefined,
        })
          // Record WHERE it was published, on the row it belongs to (DEV-246).
          //
          // Null means no relay accepted it, and then nothing is written: a row
          // must never claim a public record that does not exist. The sweep
          // finds it as a gap later, and that is what stamps it.
          //
          // Still fire-and-forget. The write-back is as far off the redemption
          // path as the publish it records, and for the same reason — the
          // proofs are burnt and the row is saved before either runs.
          .then((receipt) => (receipt ? recordReceiptByNullifier(receipt) : undefined))
          // `attestRedemption` swallows its own failures, so this catch should
          // never fire. It is here because the promise is not awaited: if that
          // contract ever broke, the rejection would be unhandled rather than
          // visible, and on a completed redemption it must be neither.
          .catch((error) => console.error('[dmPoll] attestation failed', error))
        // Voucher ledger v2 (#310): the stall's device publishes the encrypted REDEEMED event, from
        // the same step and with the same fire-and-forget posture. `publishRedeemed` checks the flag,
        // re-verifies the issuer signature and publishes only this stall's own, non-credential
        // vouchers. It never rejects; the catch is the same belt-and-braces as above, and the
        // try covers a synchronous throw, so no failure here can reach the redemption.
        try {
          void publishRedeemed({ token, signatureValid: validation?.signatureValid === true }).catch((error) =>
            console.error('[dmPoll] ledger v2 publish failed', error),
          )
        } catch (error) {
          console.error('[dmPoll] ledger v2 publish failed', error)
        }
      } else {
        // A CUSTOMER received it, so the only public record this wallet may
        // make is a kind-7378 transfer receipt (#91), never a 7377: see
        // `TRANSFER_RECEIPT_KIND` for why the two claims cannot share a kind.
        //
        // Queued only if the sender also signed this transfer, which
        // `noteTransferReceived` checks, and only a signature by the key that
        // actually SENT this coupon pairs: the payload's `sender_pubkey`
        // (which gateway-core sets from the send row), else the envelope's
        // signer for a bare wallet-to-wallet wrap. Never `issuerId`, which is
        // who minted the coupon, not who paid. A coupon from an older build or
        // straight from a stall therefore leaves no public trace. The credited
        // value, unit and decimals are passed only when the voucher verified,
        // for the reason `attestRedemption` gives, so a sender-written
        // envelope figure is never committed to.
        //
        // Fire-and-forget and never throwing, like everything else here: the
        // proofs are already burnt, and a relay refusing a receipt must not
        // turn a completed redemption into a reported failure.
        const couponSender = meta?.senderPubkey ?? opts?.senderPubkey
        void noteTransferReceived({
          token,
          sender: typeof couponSender === 'string' ? couponSender : undefined,
          ...(validation?.signatureValid === true
            ? {
                credited: Number(meta?.faceValue),
                unit: meta?.faceUnit == null ? undefined : String(meta.faceUnit),
                decimals: meta?.faceDecimals == null ? undefined : Number(meta.faceDecimals),
              }
            : {}),
        })
          // Not paired, and its signature's wrap is held at the relay (#99):
          // the cached copy was evicted, so re-read the wrap now.
          .then((paired) => {
            if (!paired && awaitsHeldWrap(token)) catchUp()
          })
          .catch((error) => console.error('[dmPoll] transfer receipt failed', error))
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
  // The trusted-mint list first, in case the start-up load failed: a coupon
  // deferred for want of it is offered again by this very query (#133). Free once
  // the list has loaded.
  const polling = service
  void loadTrustedMints().then(() => polling?.fetchRecentDms())
  void flushUnacknowledgedEscrows()
  // #410 G14: a gift locked to this wallet whose claim failed (or whose key could not be lent) is
  // tried again on every catch-up. Never throws.
  void import('./lockedGiftsApp').then((m) => m.sweepLockedGifts()).catch(() => undefined)
  // #402: checkout codes (resume, the store's `GET /mine` fallback, expiry). Never throws.
  if (currentPubkey) void import('./checkoutCodesApp').then((m) => m.reconcileCheckoutCodesNow(currentPubkey!)).catch(() => 0)
  // #402: a split's change is locked to this wallet's own key, and no ordinary send can spend it until
  // it is unlocked (a €1 send failed on it, 2026-11-01). Never throws.
  if (currentPubkey) void import('./selfLockedCouponsApp').then((m) => m.unlockSelfLockedCouponsNow(currentPubkey!)).catch(() => 0)
  // #402: rows a checkout code's carve left overstated (the balance showing more than the shop can take).
  void import('./couponFaceRepair').then((m) => m.restateOverstatedRowsNow()).catch(() => 0)
}

/**
 * In-session recovery for a receive that failed (#314).
 *
 * dm-poll keeps a failed delivery for a retry, but behind its one-hour
 * cooldown, and in SSE mode nothing re-polls on a timer anyway. So a coupon
 * whose receive failed was in practice picked up only by the merchant's NEXT
 * session, while the till's strip said the wallet "will keep trying". This is
 * the keeping-trying: the same delivery is offered again on a short backoff,
 * a bounded number of times, for as long as this poller runs.
 *
 * Safe to repeat: every try reuses the token's idempotency key
 * (`rcv_<fingerprint>`, tokenRedemption), spends from its per-token call budget
 * and waits in the pacer. A receive the gateway already settled comes back as
 * that settlement, never as a second receive.
 *
 * Logout (#331/#340/#353): no try starts once the receive gate is closed or the
 * poller is stopped. `stopDmPoll` clears the timers, and the adapter refuses a
 * redeem from a stopped poller as RECEIVE_DEFERRED in any case. The delivery
 * stays unprocessed, so the next session still receives it: deferred, not lost.
 */
export const RECEIVE_RETRY_BACKOFFS_MS: readonly number[] = [10_000, 30_000, 90_000, 300_000]
/** gift wrap id → its pending in-session retry. Per poller: cleared by stopDmPoll. */
const receiveRetries = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>()

function scheduleReceiveRetry(polling: DmPollService, eventId: string, attempt = 0): void {
  if (!eventId || attempt >= RECEIVE_RETRY_BACKOFFS_MS.length) return
  // Only for the poller that is running now (review of #314): a stopped poller's in-flight
  // redeem can still report its failure after stopDmPoll cleared the timers, and must not
  // arm a new one, let alone one bound to the next account's poller.
  if (service !== polling) return
  const pending = receiveRetries.get(eventId)
  if (pending) {
    // One chain per delivery: a failure reported by the chain's own try (or by
    // a catch-up of the same wrap) does not start a second, faster one.
    if (pending.attempt >= attempt) return
    clearTimeout(pending.timer)
  }
  const timer = setTimeout(() => {
    void retryReceive(polling, eventId, attempt)
  }, RECEIVE_RETRY_BACKOFFS_MS[attempt])
  receiveRetries.set(eventId, { attempt, timer })
}

async function retryReceive(polling: DmPollService | undefined, eventId: string, attempt: number): Promise<void> {
  // Logout started, or this tab let go of the store: nothing is tried. The
  // delivery is still unprocessed and the next session offers it again.
  if (polling === undefined || service !== polling || !receivesOpen() || gatesSealed()) {
    receiveRetries.delete(eventId)
    return
  }
  console.info('[dmPoll] trying a failed receive again', { eventId: eventId.substring(0, 8), attempt: attempt + 1 })
  let received = false
  try {
    received = (await polling.replayEvent(eventId)) === true
  } catch (error) {
    console.warn('[dmPoll] retry of a failed receive did not complete', error)
  }
  if (receiveRetries.get(eventId)?.attempt === attempt) receiveRetries.delete(eventId)
  if (received || service !== polling) return
  // Still waiting in dm-poll's failed list (a deferral emits no error, so the
  // chain is carried on from here rather than by the next error event).
  const stillFailed =
    typeof polling.getFailedEvents !== 'function' ||
    polling.getFailedEvents().some((f) => f.eventId === eventId)
  if (stillFailed) scheduleReceiveRetry(polling, eventId, attempt + 1)
}

/** dm-poll's `redemption:error`: start the in-session retry unless it has given up for good. */
function onReceiveFailed(polling: DmPollService, event: RedemptionErrorEvent | undefined): void {
  if (!event?.eventId || event.retryable === false) return
  scheduleReceiveRetry(polling, event.eventId)
}

function clearReceiveRetries(): void {
  for (const { timer } of receiveRetries.values()) clearTimeout(timer)
  receiveRetries.clear()
}

/** How long after a receive-gate deferral the coupon is offered again (#301 review). */
export const DEFERRED_RETRY_MS = 5_000
/**
 * How many early catch-ups one token may schedule (#301 second check). A pacer
 * that never frees would otherwise re-defer the same coupon every gate timeout
 * plus 5 s for the whole session. Past the cap the coupon waits for the
 * ordinary offers (SSE reopen, online, visibility), as before #301.
 */
export const MAX_DEFERRED_RETRIES_PER_TOKEN = 3
let deferredRetryTimer: ReturnType<typeof setTimeout> | undefined
/** token → early catch-ups it has scheduled. Per poller: cleared by stopDmPoll. */
const deferredRetries = new Map<string, number>()

/** Schedules the early catch-up unless this token has used its share. */
function scheduleDeferredCatchUpFor(token: string): void {
  const used = deferredRetries.get(token) ?? 0
  if (used >= MAX_DEFERRED_RETRIES_PER_TOKEN) return
  deferredRetries.set(token, used + 1)
  scheduleDeferredCatchUp()
}

/**
 * One catch-up shortly after a redemption deferred on the receive pacer. The
 * deferral returned its pacer wait, so the retry queues afresh; coalesced, so a
 * bundle of deferred parts costs one query. Scoped to the poller that was
 * running, so a logout in between cannot re-poll under the next account.
 */
function scheduleDeferredCatchUp(): void {
  if (deferredRetryTimer !== undefined) return
  const polling = service
  deferredRetryTimer = setTimeout(() => {
    deferredRetryTimer = undefined
    if (polling !== undefined && service === polling) catchUp()
  }, DEFERRED_RETRY_MS)
}

/**
 * The trusted mints changed: the gateway answered after a failure, or named a
 * mint it did not name before (#133 review, MEDIUM-2). Every deferred delivery is
 * offered again by a catch-up, and every HELD one by id, however old, since a
 * coupon held longer than the poll window would otherwise never be offered again.
 */
function onMintsChanged(): void {
  catchUp()
  void reofferHeld()
}

async function reofferHeld(): Promise<void> {
  const polling = service
  const owner = currentPubkey
  if (!polling || !owner) return
  const held = heldCoupons(owner)
  // Anything the poller has since consumed (redeemed, or refused for a reason no
  // configuration can change) is no longer waiting.
  for (const coupon of held) {
    if (typeof polling.hasProcessed === 'function' && polling.hasProcessed(coupon.eventId)) {
      releaseHeld(owner, coupon.eventId)
    }
  }
  const waiting = heldCoupons(owner)
  if (waiting.length === 0 || typeof polling.reofferEvents !== 'function') return
  const since = Math.min(...waiting.map((c) => c.createdAt)) - 60
  await polling.reofferEvents(
    waiting.map((c) => c.eventId),
    since,
  )
}

let stopMintListener: (() => void) | undefined

/**
 * Acknowledge escrows an earlier redemption left HELD (#110). Never throws.
 *
 * `_acknowledgeEscrow` used to promise "retry on next startup" to an escrow
 * recovery that is disabled (#95), so a rate-limited ack was never retried and
 * the escrow stayed HELD indefinitely. tokenRedemption now keeps unacked
 * receive_ids per account; this is the next-poll/startup retry it relies on.
 */
/**
 * Route every `/wallet/receive*` call tokenRedemption makes through the page's
 * pacer, one reservation per call (#110 review C). Idempotent. Acks are not
 * paced: imani-gateway-customer#120 exempts the POST ack path from the limit,
 * so `_ackGate` stays tokenRedemption's no-op.
 */
function installPacingGates(redemption: object): void {
  const r = redemption as { _receiveGate?: (signal?: AbortSignal) => Promise<void> }
  // The signal is #301's: tokenRedemption aborts it when its step timeout gives
  // up on the gate, so the abandoned wait never books a slot.
  r._receiveGate = (signal?: AbortSignal) => receivePacer().acquire(CALLS_PER_RECEIVE, signal)
}

async function flushUnacknowledgedEscrows(): Promise<void> {
  try {
    // Only if the legacy scripts are already loaded (signing in loads them).
    // Loading them HERE, for bookkeeping, would drag the whole classic-script
    // stack into every poller start, including the many test doubles that
    // start one; the next catch-up after they load does the flush instead.
    const redemption = (typeof window === 'undefined' ? undefined : window.TokenRedemption) as
      | { flushUnacknowledgedEscrows?: () => Promise<number>; _ackGate?: () => Promise<void> }
      | undefined
    if (redemption) installPacingGates(redemption)
    const acked = await redemption?.flushUnacknowledgedEscrows?.()
    if (acked) console.info(`[dmPoll] acknowledged ${acked} escrow(s) left over from an earlier receive`)
  } catch (error) {
    console.warn('[dmPoll] could not flush unacknowledged escrows', error)
  }
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

  // Customer transfer receipts (#91) are published after a random delay, so a
  // tab that closed while one was waiting left it queued in local storage.
  // Arms the timer for those; overdue ones get a fresh delay of one to thirty
  // minutes rather than going out beside this login. Never throws, and a
  // merchant wallet publishes none.
  resumeTransferReceipts(pubkey)

  // A multi-coupon payment still waiting on parts when the tab closed has
  // nothing to close its window (#94). Settles the overdue ones and re-arms
  // the rest. Display state only; never throws.
  resumeBundleArrivals(pubkey)

  // Settled-but-unsaved vouchers (#112) survive logout; the bell rows do not.
  resumeUnsavedReceipts(pubkey)
  // #560: then drop the ones the gateway reports ACKNOWLEDGED (saved on
  // another device or before a logout). Off the startup path, never throws,
  // and only when there is a record to check.
  if (listUnsavedReceipts(pubkey).some((r) => r.receiveId)) {
    void legacyApi()
      .then((api) => {
        const lookup = (api as unknown as { getReceiveStatuses?: ReceiveStatusLookup }).getReceiveStatuses
        return typeof lookup === 'function' ? dropAcknowledgedReceipts(pubkey, lookup.bind(api)) : 0
      })
      .catch((e: unknown) => console.warn('[unsaved-receipt] acknowledged check skipped:', e))
  }

  // Before the poller reads its processed set, not after: coupons abandoned by
  // a build that could not reassemble chunks are recoverable only if their
  // tombstones are gone by the time the first catch-up runs.
  grantChunkAmnesty()

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
    // window — present on the relay, invisible to the wallet. This window is
    // measured on WRAP time, so it needs no allowance; dm-poll's
    // `reofferEvents`, which starts from a rumor time, adds
    // GIFT_WRAP_BACKDATE_SECONDS itself (#175 review).
    recentDmsSince: 7 * 24 * 60 * 60,
    /**
     * The processed set must be able to cover the FETCH WINDOW above.
     *
     * These two numbers are one decision and were made separately, which is
     * the bug. Every poll re-reads every wrap in the 7-day window, and the
     * processed set is the only thing that stops one being unwrapped and
     * offered to the mint again. dm-poll's default cap is 100 ids.
     *
     * A 1000 GBP sale is what made that ceiling reachable: the portal splits
     * it into 5 coupons, and a coupon whose Cashu token exceeds
     * `direct_limit_bytes` is delivered as up to 16 chunk DMs. One sale is
     * therefore as many as 80 gift wraps, on top of a week of ordinary
     * traffic. Past 100, the set evicts ids that are still inside the window:
     * the next poll re-fetches them, re-processes them, and evicts the next
     * batch in turn. It never converges. Every cycle is a full round of
     * redundant unwraps and mint round-trips, which is what made the wallet
     * "unusable" rather than merely slow, and it survives a reload because
     * the set is in localStorage.
     *
     * 5000 is chosen against the window, not the sale: a week of wraps for a
     * busy stall, with room for the chunk multiplier. At ~64 bytes an id this
     * is ~320KB of localStorage, well inside the quota, and the cost of being
     * wrong in this direction is memory while the cost of being wrong in the
     * other is the churn above.
     */
    maxProcessedEvents: 5000,
    nostrdbAdapter: nostrdbAdapter(),
    cryptoAdapter: createDmCryptoAdapter(),
    storageAdapter: storageAdapter(),
    redemptionAdapter: countingInFlight(redemptionAdapter()),
    // Without this the adapter above is never called: dm-poll only redeems when
    // auto-redemption is on AND an adapter exists.
    enableAutoRedemption: true,
  })
  // Tell the stall when its till turns a coupon away.
  //
  // Subscribed BEFORE `start()`, so a refusal during the first catch-up is not
  // missed — the poller redeems as soon as it starts, and a listener attached
  // afterwards would silently drop the very first one.
  //
  // This event has been emitted since the ceiling check shipped and nothing
  // listened to it, which made every refusal indistinguishable from a coupon
  // lost in the network: no balance change, no history row, no message, in
  // front of a customer who believes they have paid.
  //
  // Guarded, because a TOAST must never be the reason the poller fails to
  // start. Several suites build a partial service double with only the methods
  // they exercise, and a hard call here turned "you get no notification" into
  // "you receive no coupons at all" — a cosmetic feature taking down the
  // money path. The guard is cheap and the failure it prevents is total.
  if (typeof service.on === 'function') {
    // A stall explains a refusal to the person at its counter; a customer is told what to do
    // about their own payment (#160 5b-5). Asked per event: the merchant record can arrive later.
    service.on('redemption:refused', (event) =>
      announceRefusal(event, currentPubkey && loadMerchant(currentPubkey) !== null ? 'stall' : 'customer'),
    )
    // And remember it against the payment it belonged to, so the payment's
    // screen still says so after the toast has gone (#145).
    const owner = currentPubkey
    service.on('redemption:refused', (event) => recordRefusal(owner ?? '', event))
    // Held, not refused (#133 review): kept visible as "waiting to be verified",
    // announced once, and forgotten when the delivery is finally redeemed.
    service.on('redemption:held', (event) => {
      if (recordHeld(owner ?? '', event)) announceHeld(event)
    })
    service.on('redemption:released', (event) => releaseHeld(owner ?? '', event?.eventId))
    service.on('redemption:success', (event) => releaseHeld(owner ?? '', event?.eventId))
    // A coupon that answered a payment request and then failed to arrive (#300). The till may
    // already show that sale Paid on gateway-core's verdict, so the failure is kept against the
    // request for it to show. A later success of the same delivery clears it.
    service.on('redemption:error', (event) => fromRedemptionError(owner ?? '', event))
    // And try it again in this session, so the strip's "will keep trying" is kept (#314).
    const emitter = service
    service.on('redemption:error', (event) => onReceiveFailed(emitter, event))
    service.on('redemption:unsaved', (event) => fromRedemptionUnsaved(owner ?? '', event))
    // #112: a voucher the gateway settled but this wallet did not save: toast, bell, operator log.
    service.on('redemption:unsaved', (event) => announceUnsaved(pubkey, event))
    service.on('redemption:success', (event) => clearReceiveTrouble(owner ?? '', event?.eventId))
  }

  // Re-offer held and deferred coupons whenever the trusted mints change. The
  // loader retries on its own backoff, so this is what makes a deferral heal
  // without a reload or a manual retry (#133 review, MEDIUM-2).
  stopMintListener?.()
  stopMintListener = onTrustedMintsChange(onMintsChanged)

  // The trusted-mint list FIRST, then the poller (#133). Its first catch-up
  // redeems at once, and every redeem asks `checkTokenBacking`; before the list
  // has loaded that answer is "defer", so starting first would park the whole
  // backlog until the next catch-up. `loadTrustedMints` never rejects, and a
  // gateway that cannot be reached leaves the list unknown, which still defers
  // rather than waving anything through. `catchUp` retries the load.
  const starting = service
  void loadTrustedMints().then(() => {
    // Not if the poller was stopped, or replaced by an account switch, meanwhile.
    if (service === starting) {
      // Then the coupons held in an earlier session, however old, in case the
      // configuration was fixed while the app was closed.
      void starting.start().then(() => {
        if (service === starting) void reofferHeld()
        // #220 B: and the parts the gateway holds for this wallet, after the relay catch-up.
        if (service === starting) void heldPartPuller?.poke('login')
      })
    }
  })
  // Startup half of the ack retry (#110). The legacy API client is signed in
  // by now, so the per-account ledger resolves to this account.
  void flushUnacknowledgedEscrows()
  // The first `onopen` fires after `start()` has already caught up, so it costs
  // one duplicate query per session — worth not special-casing.
  onSseOpen = catchUp
  heldPartPuller?.stop()
  heldPartPuller = startHeldPartPuller(pubkey, service)
  // The socket is not the only thing a freeze breaks. Coming back to the
  // foreground catches the case where the stream looks alive to the client but
  // the gateway already reaped it (`sse_cleanup reason=keepalive failed`).
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', catchUp)
  return service
}

function onVisible(): void {
  if (document.visibilityState === 'visible') {
    catchUp()
    void heldPartPuller?.poke('resume')
  }
}

/** The recipient pull of held bundle parts (imani-gateway-core#220 B), see heldPartPull.ts. */
let heldPartPuller: HeldPartPuller | undefined

function startHeldPartPuller(pubkey: string, polling: DmPollService): HeldPartPuller | undefined {
  // A partial service double in older suites has no pull entry: no pull, nothing else changes.
  if (typeof (polling as { processPulledToken?: unknown }).processPulledToken !== 'function') return undefined
  type PullApi = {
    getIncomingAtomicSends?: (o: { since: number; limit: number }) => Promise<{ items?: IncomingPart[]; next_since?: number | null }>
    ackIncomingAtomicSend?: (id: string) => Promise<unknown>
  }
  const api = async (): Promise<PullApi> => (await legacyApi()) as unknown as PullApi
  const puller = createHeldPartPuller({
    recipientPubkey: pubkey,
    async getIncoming(opts) {
      const a = await api()
      // A build of the API client without the method behaves like a gateway without the route.
      if (typeof a.getIncomingAtomicSends !== 'function') throw Object.assign(new Error('no pull'), { status: 404 })
      return a.getIncomingAtomicSends(opts)
    },
    async ack(sendId) {
      const a = await api()
      if (typeof a.ackIncomingAtomicSend !== 'function') throw Object.assign(new Error('no ack'), { status: 404 })
      return a.ackIncomingAtomicSend(sendId)
    },
    receive: (input) => polling.processPulledToken(input),
    hasOpenBundle: () => openBundles(pubkey).length > 0,
  })
  puller.start()
  return puller
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
  // First, and synchronously: from here no redeem of this poller can start,
  // so `drainDmPoll` waiting for the ones already started is enough.
  pollerGeneration++
  onSseOpen = undefined
  heldPartPuller?.stop()
  heldPartPuller = undefined
  if (deferredRetryTimer !== undefined) clearTimeout(deferredRetryTimer)
  deferredRetryTimer = undefined
  deferredRetries.clear()
  // #314: no in-session retry of a failed receive survives the poller. The
  // deliveries stay unprocessed for the next session.
  clearReceiveRetries()
  stopMintListener?.()
  stopMintListener = undefined
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('online', catchUp)
  void service?.stop()
  service = undefined
  currentPubkey = undefined
  // The pacing window belongs to the account that spent it, and so do any
  // background ack retries: one left running would ack under the next session.
  receivePacer().reset()
  try {
    ;(window.TokenRedemption as { resetAckState?: () => void } | undefined)?.resetAckState?.()
  } catch {
    /* never throws on logout */
  }
  // Half-assembled coupons are DECRYPTED fragments of someone's money, held in
  // memory. They must not survive a logout, and must not be visible to the next
  // account: `startDmPoll` calls this on an identity change, and without it the
  // previous user's pieces would still be sitting in the assembly map. Losing a
  // genuine half-transfer costs nothing, because its wraps are still on the
  // relay and were never marked processed.
  resetChunkAssembly()
  // The receipt timer is per-account too, and so is the in-memory copy of the
  // receipt queue. Dropping both loses nothing: the queue is in local storage
  // (which logout clears), and `startDmPoll` re-arms it for whoever signs in
  // next, if it is theirs.
  resetHeldTransfers()
  // Bundle wait-window timers are per account: one left armed would file the
  // previous user's "payment partly received" into whoever signs in next.
  stopBundleArrivals()
  // The received-token mirror is per-ACCOUNT state too. `startDmPoll` calls
  // this on an identity change, and a mirror left loaded would answer the next
  // user's "have I already banked this?" from the previous user's memory —
  // which, on a shared device, silently suppresses a real coupon. Dropping it
  // costs one re-read from storage on the next receive.
  resetReceivedCache()
  // Anything still queued is flushed rather than abandoned. A deferred write
  // holding the last few processed ids would otherwise be dropped on logout,
  // and those ids are what stop the next session re-reading wraps it has
  // already handled.
  flushDeferredWrites()
}
