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
  retryOnTransientMintError,
} from '@imani/dm-poll'

import { announceArrival, type ArrivedVoucher } from './arrivalToast'
import { announceQueued, settleQueued } from './queuedToast'
import { announceRefusal } from './refusalToast'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import { attestRedemption, nullifierFor } from './attestation'
import { attestationForReceivedCoupon } from './cashAttestation'
import { getSigner } from './nap'
import { postPaymentReceipt } from './paymentReceipt'
import { createDmCryptoAdapter, toLegacyMetadata } from './dmCrypto'
import { resetChunkAssembly } from './dmChunks'
import { loadMerchant } from './merchant'
import { licenceFromToken } from './licences'
import { checkRedemption } from './redemptionLedger'
import { parseVoucherToken, type VoucherValidation } from './voucherToken'
import { getWallet, notifyWalletChanged, recordReceiptByNullifier } from './wallet'
import { legacyApi, withCorrelation } from './legacyBridge'

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

/** Marks that this device has already forgotten its pre-reassembly tombstones. */
const CHUNK_AMNESTY_KEY = 'imani-wallet:dm-poll:chunk-amnesty'

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
 * Runs at most once per device — after that the tombstones are honest again,
 * because anything newly abandoned was abandoned by code that could reassemble.
 */
function grantChunkAmnesty(): void {
  try {
    if (localStorage.getItem(CHUNK_AMNESTY_KEY)) return

    const abandoned = readSet(PROCESSED_KEY).size
    localStorage.removeItem(PROCESSED_KEY)
    localStorage.setItem(CHUNK_AMNESTY_KEY, new Date().toISOString())

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
 * All three unauthorised states are refused together — no warrant, a warrant
 * signed as `none`, and a warrant that was present and did not hold. They are
 * different claims and the merchant-facing copy says so, but at the till they
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

export function refuseIfUnwarranted(meta: Record<string, unknown> | undefined): void {
  const validation = meta?.validation as VoucherValidation | undefined
  if (!validation?.signatureValid) return

  // Never checked, so there is nothing to refuse on. Distinct from `absent`,
  // which IS a checked answer meaning the coupon carried no warrant.
  if (validation.warrant === undefined) return

  if (
    validation.warrant !== 'absent' &&
    validation.warrant !== 'unwarranted' &&
    validation.warrant !== 'failed'
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
      refuseIfAnotherStalls(meta, currentPubkey, token)
      refuseIfUnwarranted(meta)
      await refuseIfOverRedeemed(meta)

      // Computed BEFORE the redeem, because it is derived from the RECEIVED
      // token and `redeem()` swaps that token at the mint — afterwards the
      // bytes it hashes no longer exist anywhere. Riding the correlation slot
      // is what puts it on the row, which is what makes self-audit possible on
      // a device that has been wiped.
      const attestationNullifier = nullifierFor(token)

      // Retry a rate-limited redemption instead of losing the coupon.
      //
      // The gateway limits /api/v1/wallet/receive to 10 requests a minute per
      // pubkey, and dm-poll redeems in a tight sequential loop, so any wallet
      // receiving more than ten coupons in a minute trips it. Without this the
      // failure was silent and permanent: DmPollService logged, moved on, and
      // the coupon was never redeemed. Measured at 120 coupons: 320 rate-limit
      // errors and 50 coupons stored (#39).
      //
      // Waits out the window rather than guessing a safe rate. The wallet
      // cannot know what limit is enforced, and a rate it guesses will drift
      // from the server's — whereas Retry-After is the server saying it.
      let voucher: Voucher
      try {
        voucher = (await retryOnTransientMintError(
        () =>
          withCorrelation(
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
          ),
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
            announceQueued(meta?.voucherId as string | undefined, delayMs)
          },
        },
        )) as unknown as Voucher
      } finally {
        // The wait is over, whichever way it went — and `finally` because the
        // way that matters most is the one that throws. A toast saying "still
        // receiving" left open above a redemption that has given up is worse
        // than never having shown it: it is the wallet asserting something
        // untrue about the customer's money, indefinitely.
        //
        // Dismissed rather than left to expire so it cannot briefly overlap
        // the arrival toast below, which would read as two separate payments.
        settleQueued(meta?.voucherId as string | undefined)
      }

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
      announceArrival(toArrivedVoucher(voucher), currentPubkey)

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
        senderPubkeyHex: String(
          meta?.senderPubkey ?? opts?.senderPubkey ?? meta?.issuerId ?? '',
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
    service.on('redemption:refused', announceRefusal)
  }

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
  // Half-assembled coupons are DECRYPTED fragments of someone's money, held in
  // memory. They must not survive a logout, and must not be visible to the next
  // account: `startDmPoll` calls this on an identity change, and without it the
  // previous user's pieces would still be sitting in the assembly map. Losing a
  // genuine half-transfer costs nothing, because its wraps are still on the
  // relay and were never marked processed.
  resetChunkAssembly()
}
