import { nip17, nip44 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import {
  extractToken as extractTokenFromText,
  parseTokenTransferMessage as parseTextMessage,
} from '@imani/dm-poll'
import type { CryptoAdapter, GiftWrapEvent, UnwrappedDm, TokenMetadata } from '@imani/dm-poll'

import { checkIssuer } from './issuerAllowlist'
import { checkMintAndUnit } from './trustedMint'
import { getSigner } from './nap'
import { isTillSaleMessage } from './tillSales'
import { buildValidationRecord } from './voucherValidationRecord'
import { terminalCredentialFromToken } from './notMoney'
import { asChunk, looksLikeChunk, offerChunkFrom } from './dmChunks'
import {
  heldWrapDecision,
  holdTransferSignatureWrap,
  parseTransferSignature,
  sealAuthorOf,
} from './transferSignature'
import {
  parseVoucherToken,
  verifyVoucher,
  type ParsedVoucherToken,
  type VoucherValidation,
} from './voucherToken'

/** `terminalDelivery.ENROLLED_DM_TYPE`, matched here without loading the delivery module. */
function isEnrolledMessage(content: string): boolean {
  try {
    return (JSON.parse(content) as { type?: unknown })?.type === 'imani-terminal-enrolled/1'
  } catch {
    return false
  }
}

/** `terminalDelivery.CREDENTIAL_DM_TYPE` (a renewal is one too, with `renews`). */
function isCredentialMessage(content: string): boolean {
  try {
    return (JSON.parse(content) as { type?: unknown })?.type === 'imani-terminal-credential/1'
  } catch {
    return false
  }
}

/**
 * A JSON object naming a `type` other than a token transfer: one of the app's own messages
 * (`imani-terminal-*`, a transfer signature, a chunk). None of them is a payment, and the text
 * regex must not be let loose on one.
 */
function typedAppMessage(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { type?: unknown } | null
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      typeof parsed.type === 'string' &&
      parsed.type !== 'cashu_token_transfer'
    )
  } catch {
    return false
  }
}

/**
 * The JSON payload the gateway actually sends.
 *
 * Captured from a live delivery, not inferred. Note it is snake_case —
 * `PayloadBuilder.DmPayload`, the sender-side type in @imani/voucher-send, is
 * camelCase (`faceValue`, `issuerId`). They are NOT the same shape, and reading
 * a received DM with the sender's type yields undefined for every field that
 * matters, including the issuer the merchant list groups by.
 */
interface TokenTransferPayload {
  type: 'cashu_token_transfer'
  version?: string
  token: string
  memo?: string | null
  amount_hint?: number
  unit?: string
  voucher_id?: string
  face_value?: number
  face_unit?: string
  face_decimals?: number
  token_amount?: number
  backing_strategy?: string
  issuer_id?: string
  sender_pubkey?: string
  /** Unix epoch SECONDS. Absent or null when the issuer set no expiry. */
  expires_at?: number | null
  expired?: boolean
  /**
   * Correlation, both forwarded end to end and both dropped here until now.
   *
   * `request_id` is the NUT-18V payment request the sender was paying, and
   * `bundle_id` groups the parts of one multi-voucher send. Verified along the
   * whole chain rather than assumed: gateway-core's `Nip17DmSendPublisher`
   * puts `payment_request_id` and `bundle_*` in the body it POSTs to
   * customer-wallet, `WalletInternalController.sendTokenDm` extracts every one
   * of them onto `SendTokenDmRequest`, and `TokenTransferMessage` serialises
   * them as `request_id` / `bundle_id` / `bundle_total` / `bundle_part_index`
   * / `bundle_part_count` in the rumor this parses.
   *
   * Without them a merchant's till cannot tell that two arriving coupons are
   * one €7 payment for one request, and settles neither.
   *
   * The ids are what the till settles by. The other three (`bundle_total`,
   * `bundle_part_index`, `bundle_part_count`) are read too, since #94, but
   * only as DECLARED display hints: what the sender says the bundle holds,
   * shown as "expected" beside the parts that actually redeemed. They are a
   * count and a total the sender chose, so nothing that books, caps or
   * settles money reads them — the till still sums the rows it has.
   */
  request_id?: string | null
  bundle_id?: string | null
  bundle_total?: number | null
  bundle_part_index?: number | null
  bundle_part_count?: number | null
}

/**
 * Fields that are real but are not on dm-poll's published `TokenMetadata`, so
 * they ride an intersection rather than the interface.
 *
 * Dropping `expiresAt` here is what once left every DM-received coupon with a
 * null expiry: `/inspect` is the only other source tokenRedemption will take one
 * from, and it 404s on this deployment, so the DM payload was the sole one that
 * arrived. `requestId` and `bundleId` are absent from the interface for the same
 * reason.
 */
function ride(payload: TokenTransferPayload) {
  return {
    expiresAt: payload.expires_at ?? undefined,
    requestId: payload.request_id ?? undefined,
    bundleId: payload.bundle_id ?? undefined,
    // Declared, not trusted (see the payload comment). Dropped unless a bundle
    // id rides with them and each is a sane non-negative integer, so a garbled
    // declaration degrades to today's per-part behaviour rather than to a
    // "0 of NaN" on screen.
    ...(payload.bundle_id ? declaredBundle(payload) : {}),
  }
}

function declaredBundle(payload: TokenTransferPayload): {
  bundleTotal?: number
  bundlePartIndex?: number
  bundlePartCount?: number
} {
  const total = wholeNumber(payload.bundle_total)
  const index = wholeNumber(payload.bundle_part_index)
  const count = wholeNumber(payload.bundle_part_count)
  // All three or none: a count without an index cannot be deduped, and a
  // total without a count cannot say "1 of 2".
  if (total === undefined || index === undefined || count === undefined || count < 1) return {}
  return { bundleTotal: total, bundlePartIndex: index, bundlePartCount: count }
}

function wholeNumber(value: unknown): number | undefined {
  // A digit string too: a JSON serialiser on the relaying side may render a
  // long as a string, and that is the same number rather than a garbled one.
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

/** A voucher token whose issuer signature did not check out. */
const REJECTED = Symbol('voucher-signature-invalid')

/**
 * Reads the signed voucher out of a token, if it is one and if it is genuine.
 *
 * Three outcomes, and the middle one is the point:
 *
 * - `undefined` — not a voucher token (plain ecash, or unparseable). There are no
 *   issuer claims to check, and this must keep flowing: a customer receiving
 *   ordinary Cashu is not doing anything wrong.
 * - `REJECTED` — it IS a voucher and the signature failed. Not a degraded case to
 *   carry forward with a warning flag: the only way to produce one is to alter a
 *   voucher after the issuer signed it. Refuse the message.
 * - the voucher — genuine, with what was checked and the value it may be credited
 *   for.
 */
function verifiedVoucherFrom(token: string | undefined):
  | { parsed: ParsedVoucherToken; validation: { faceValue: number; record: VoucherValidation } }
  | typeof REJECTED
  | undefined {
  if (!token) return undefined

  let parsed: ParsedVoucherToken
  try {
    parsed = parseVoucherToken(token)
  } catch {
    return undefined
  }

  const { signatureValid, legacyCanonical } = verifyVoucher(parsed.voucher)
  if (!signatureValid) {
    console.warn(
      '[dmCrypto] rejecting voucher with invalid issuer signature:',
      parsed.voucher.voucherId,
      'claimed issuer',
      parsed.voucher.issuerId.slice(0, 16),
    )
    return REJECTED
  }

  // The signature proves the bytes were not altered. It does NOT prove who
  // signed them: `issuerPublicKey` is inside the voucher, so a self-issued one
  // verifies perfectly (Finding 2 of the audit review). This is the other half
  // — is the signing key one this build was told to trust?
  //
  // Refuses only when an allowlist IS configured, so a deployment that has not
  // set `VITE_VOUCHER_ISSUER_PUBKEYS` behaves exactly as before. See
  // `issuerAllowlist.ts` for why unset must mean allow here and means refuse
  // for licences.
  //
  // Placed with the signature check rather than at the till, because this is a
  // statement about the coupon's provenance and holds identically for a
  // customer receiving one and a stall taking one back. The cross-stall check
  // is the opposite: it depends on who is asking, so it lives at the till.
  if (checkIssuer(parsed) === 'unknown-issuer') {
    console.warn(
      '[dmCrypto] rejecting voucher signed by an unrecognised issuer key:',
      parsed.voucher.voucherId,
      'key',
      parsed.voucher.issuerPublicKey.slice(0, 16),
    )
    return REJECTED
  }

  // Where the value actually is. Neither check above says anything about it:
  // the signature covers the voucher's terms and names no mint, so a copy of a
  // genuine coupon backed by proofs at a mint nobody has heard of passes both.
  //
  // Placed here for the same reason as the issuer check, and it is the same kind
  // of statement: a fact about the coupon that holds identically for a customer
  // receiving one and a stall taking one back. It is also a precondition of the
  // wallet swapping its own receives, because from that point the mint URL is
  // not a field we record but the address we send money to. See
  // `docs/explanation/the-wallet-swaps-its-own-receives.md`.
  const backing = checkMintAndUnit(parsed)
  // Only a foreign UNIT is refused here. A REJECTED voucher makes `extractToken`
  // return null, and dm-poll marks a wrap with no token PROCESSED, so it is never
  // offered again. That is right for a unit, which no configuration can change,
  // and wrong for anything about the MINT: a list that has not loaded, a
  // deployment that names no mint, or a mint the two services' settings disagree
  // on would each have dropped genuine coupons for good (imani-wallet#133 review,
  // HIGH-2). Those are answered at redemption instead, where the adapter's
  // `checkBacking` defers or HOLDS the delivery: nothing is swapped, nothing is
  // consumed, and the coupon is shown as waiting to be verified.
  if (backing === 'wrong-unit') {
    console.warn(
      '[dmCrypto] rejecting voucher whose proofs are not in sat:',
      parsed.voucher.voucherId,
      backing,
      parsed.mintUrl,
      parsed.unit,
    )
    return REJECTED
  }

  // The record itself is built where cashback builds its own (#156), so the two
  // receive paths cannot drift in what they write. Only the gates above are
  // this path's.
  const { faceValue, record, warrantRefusal } = buildValidationRecord(parsed, {
    signatureValid,
    legacyCanonical,
  })
  if (record.cappedAtFaceValue) {
    // Reached when tokenAmount * ratio exceeds what was issued, which on a
    // legacy voucher is what a rewritten ratio looks like.
    console.warn(
      '[dmCrypto] voucher value clamped to signed face value:',
      parsed.voucher.voucherId,
    )
  }

  if (warrantRefusal !== undefined) {
    // Recorded, not refused. Refusing an unwarranted or badly-warranted coupon
    // is a policy decision nobody has taken, and taking it here would break
    // every coupon issued before this shipped. The merchant is shown the state
    // instead; `validationStatus` decides what the badge says.
    console.warn(
      '[dmCrypto] issuance warrant refused for voucher:',
      parsed.voucher.voucherId,
      warrantRefusal,
    )
  }

  return { parsed, validation: { faceValue, record } }
}

function asPayload(content: string): TokenTransferPayload | null {
  try {
    const parsed = JSON.parse(content) as TokenTransferPayload
    return parsed?.type === 'cashu_token_transfer' && typeof parsed.token === 'string'
      ? parsed
      : null
  } catch {
    return null // Not JSON — a legacy text DM.
  }
}

/**
 * dm-poll's CryptoAdapter, backed by the wallet's own key.
 *
 * Two deviations from imani-apps' vanilla adapter, both forced and both narrow:
 *
 * 1. `parseTokenTransferMessage` handles the JSON `cashu_token_transfer`
 *    envelope first. dm-poll's own TokenParser only regex-parses the legacy
 *    human-readable form ("🎁 Token Transfer: 1.00 USD"), and the gateway's
 *    TokenDmTransferAdapter emits JSON. Text falls through to the package's
 *    parser unchanged, so legacy DMs keep working.
 *
 * 2. `getTokenFingerprint` is content-derived (sha256(token)[0:32]) to match
 *    wallet-storage's token_id rule (spec 017), so a coupon delivered twice
 *    collapses onto one row instead of duplicating.
 */
export function createDmCryptoAdapter(): CryptoAdapter {
  return {
    /**
     * The `recipientPrivkey` argument is deliberately ignored — the key comes
     * from the signer, per unwrap.
     *
     * `DmPollService` stores whatever key it was constructed with as a plain
     * STRING on its config and passes that here. Strings are immutable, so the
     * signer's `clearKey()` — which zeroes its own bytes and drops its
     * reference — cannot reach that copy. Handing the poller a key therefore
     * left a full plaintext copy of it alive for the lifetime of the service,
     * and the poller went on decrypting gift wraps while the wallet was
     * "locked". signer.ts states the opposite as its contract: "Between lock and
     * reunlock there is no key in memory to steal" (RFC §28.6). Reading it here
     * makes the signer the only holder, so eviction actually evicts.
     */
    async unwrapNip17Dm(event: GiftWrapEvent): Promise<UnwrappedDm | null> {
      // Outside the try below: a locked wallet is TRANSIENT and must not be
      // mistaken for a malformed wrap. Throwing lets dm-poll record the real
      // reason and retry after its cooldown; the event is not consumed, because
      // `eventTracker.add` only runs on the success paths.
      // IW-14: assert the wallet is unlocked without materialising the key here. The unwrap
      // below borrows it for exactly as long as it needs.
      getSigner().withPrivkey(() => undefined)

      /**
       * A transfer signature's wrap held unprocessed at the relay (#99),
       * decided from its id alone, so a held wrap costs no decryption on each
       * catch-up. `hold` keeps it unprocessed, `release` hands dm-poll an
       * empty non-token DM so it is marked processed, and `reread` (its
       * coupon is here but the cached signature is gone) falls through to a
       * normal unwrap, which offers it again below.
       */
      const decision = heldWrapDecision(event.id)
      if (decision === 'hold' || decision === 'release') {
        return {
          eventId: event.id,
          senderPubkey: '',
          content: '',
          createdAt: event.created_at,
          ...(decision === 'hold' ? { hold: true } : {}),
        }
      }

      try {
        console.log('[dmCrypto] unwrapping', event.id.slice(0, 8))
        const rumor = getSigner().withPrivkey((key) => nip17.unwrapEvent(event as never, key))
        console.log('[dmCrypto] unwrapped ok, content bytes:', rumor.content.length)

        /**
         * A coupon too big for one DM arrives in pieces, and this is the only
         * place they are legible.
         *
         * The chunk envelope is INSIDE the encrypted rumor — the outer wrap
         * carries nothing but a `p` tag — so the gateway cannot reassemble it
         * and says so outright ("decrypt on client and reassemble plaintext").
         * Everything downstream of here, `extractToken` included, is
         * synchronous and expects a whole `cashu_token_transfer`, so the
         * pieces are made whole HERE and the rest of the pipeline never learns
         * that a coupon was ever split.
         *
         * Returning null for an incomplete transfer is what keeps the earlier
         * pieces alive: dm-poll only marks an event processed on a success
         * path, so the wraps are re-read and re-offered until the last one
         * lands. Before this existed a chunk fell through to the text parser,
         * yielded no token, and was classified `non_token_dm` — marked
         * processed and never retried. That is how a 200 and two 150s were
         * sent, acked by two relays, and never seen again.
         */
        const chunk = asChunk(rumor.content)
        if (chunk) {
          const offer = await offerChunkFrom(chunk, event.id)
          const tag = {
            transfer: chunk.transfer_id.slice(0, 8),
            index: chunk.chunk_index,
            of: chunk.chunk_total,
          }
          switch (offer.kind) {
            case 'complete':
              console.log(
                offer.redelivery
                  ? '[dmCrypto] offering a reassembled coupon again (its last attempt did not finish)'
                  : '[dmCrypto] reassembled a chunked coupon',
                { transfer: tag.transfer, chunks: chunk.chunk_total, bytes: offer.payload.length },
              )
              return {
                eventId: event.id,
                senderPubkey: rumor.pubkey,
                content: offer.payload,
                createdAt: rumor.created_at,
              }
            case 'done':
              // A straggler from a transfer whose coupon is durably handled
              // (#204: only ever recorded once the completing event is
              // processed). An empty non-token DM, so dm-poll marks it
              // processed and stops re-reading it.
              console.log('[dmCrypto] chunk of a transfer already received; releasing it', tag)
              return { eventId: event.id, senderPubkey: rumor.pubkey, content: '', createdAt: rumor.created_at }
            case 'pending':
            case 'in_delivery':
              // HELD, not failed and not processed: the wrap stays on the relay
              // and is offered again. `in_delivery` is a sibling of a coupon
              // being redeemed right now, or waiting on a retry; consuming it
              // would be the #204 tombstone by another route.
              console.log(
                offer.kind === 'pending'
                  ? '[dmCrypto] holding chunk until its siblings arrive'
                  : '[dmCrypto] holding chunk while its coupon is redeemed',
                tag,
              )
              return { eventId: event.id, senderPubkey: rumor.pubkey, content: '', createdAt: rumor.created_at, hold: true }
            case 'refused':
              // Did not verify. Null, so dm-poll records a retryable failure
              // and the relay's copies can be tried again.
              return null
          }
        }

        /**
         * A chunk this build could not accept. NULL, not a fall-through.
         *
         * `asChunk` refuses an envelope whose shape it cannot use — too many
         * pieces, an impossible index, a missing field. Falling through to the
         * plain return below hands the raw chunk JSON to the rest of the
         * pipeline, which finds no token in it, classifies it `non_token_dm`,
         * and marks the event PROCESSED. The wrap is then never offered again,
         * so the coupon is destroyed by a client-side limit — exactly how a 200
         * and two 150s were lost once already.
         *
         * Null is the retryable answer: dm-poll records it in `failedTracker`
         * and only its success paths call `eventTracker.add`. So a build that
         * later accepts the shape, as this one now does for transfers above the
         * old 16-chunk ceiling, still finds the wrap on the relay and pays the
         * customer.
         *
         * Distinguished from a non-chunk by `looksLikeChunk`, which tests only
         * `type`. A DM that was never a chunk still falls through unchanged.
         */
        if (looksLikeChunk(rumor.content)) {
          console.warn(
            '[dmCrypto] refusing a chunk envelope this build cannot read; ' +
              'keeping the event unprocessed so a later build can recover it',
            event.id.slice(0, 8),
          )
          return null
        }

        /**
         * A sender's signature over a transfer (#91), which arrives in a gift
         * wrap of its own beside the coupon. `holdTransferSignatureWrap` never
         * throws, verifies before it stores anything, and queues the receipt
         * only once the coupon has also been redeemed here AND was sent by the
         * same key. Awaited, because its answer decides the wrap's fate: one
         * that did not pair is HELD (left unprocessed at the relay, #99), so a
         * flood that evicts the local copy cannot lose it. Anything else flows
         * on unchanged, carries no token, and dm-poll marks it processed as
         * the non-token DM it is.
         *
         * `rumor.pubkey` is NOT authenticated: nostr-tools' `unwrapEvent`
         * checks neither the seal's signature nor that the seal and rumor
         * agree on the author. So the seal is opened again here and must be
         * validly signed by the same key the rumor names, or the payload is
         * not offered at all. Even then, what really binds the signer is the
         * payload's own identity `sig`, and what binds it to the COUPON is the
         * sender check in `transferSignature.queueIfPaired`.
         */
        /**
         * A till's sale record (#160 phase 6, wallet#202). It carries no token: dm-poll marks it
         * processed as a non-token DM, which is fine, because filing it is the collector's job and
         * the collector reads the inbox itself, from its own cursor, verifying every row against
         * this stall's attestation. This only makes the sale show up now rather than at next login.
         */
        if (isTillSaleMessage(rumor.content)) {
          const stall = getSigner().pubkey
          void import('./tillSalesNet').then((m) => m.collectTillSalesForOwner(stall)).catch(() => 0)
        }
        /**
         * A till saying it holds its credential (#160 phase 6, found by the local gate). Read only
         * by the Terminals screen's poll before, so an owner on any other screen, or on a restored
         * phone, kept the till Waiting. The collector verifies the notice against the roster.
         */
        if (isEnrolledMessage(rumor.content)) {
          const stall = getSigner().pubkey
          void import('./terminalDeliveryNet').then((m) => m.collectEnrolled(stall)).catch(() => 0)
        }

        /**
         * A terminal credential or renewal that reached THIS wallet (#160 owner report). It is
         * never redeemed (`extractToken` returns null for it); it is announced as what it is,
         * "Terminal setup request from <stall>", from its signed metadata. A personal wallet
         * only gets one when its key was enrolled as a till, which is the wrong path.
         */
        if (isCredentialMessage(rumor.content)) {
          const me = getSigner().pubkey
          void import('./notMoneyNotice').then((m) => m.announceTerminalDm(rumor.content, me)).catch(() => false)
        }

        const transferSignature = parseTransferSignature(rumor.content)
        if (transferSignature) {
          const sealAuthor = getSigner().withPrivkey((key) => sealAuthorOf(event as never, key))
          if (sealAuthor && sealAuthor === rumor.pubkey) {
            const hold = await holdTransferSignatureWrap(transferSignature, sealAuthor, event)
            if (hold) {
              return {
                eventId: event.id,
                senderPubkey: rumor.pubkey,
                content: rumor.content,
                createdAt: rumor.created_at,
                hold: true,
              }
            }
          } else {
            console.warn('[dmCrypto] transfer signature in a wrap whose seal does not match its rumor')
          }
        }

        return {
          eventId: event.id,
          senderPubkey: rumor.pubkey,
          content: rumor.content,
          createdAt: rumor.created_at,
        }
      } catch (e) {
        console.log('[dmCrypto] unwrap threw:', e instanceof Error ? e.message : String(e))
        // A wrap we cannot open is not addressed to us, or is malformed. Null
        // rather than a throw so one bad event does not stall the poll — and it
        // is not lost either: dm-poll tracks it as failed and retries it after a
        // cooldown, since only the success paths mark an event processed.
        return null
      }
    },

    parseTokenTransferMessage(content: string): TokenMetadata | null {
      const payload = asPayload(content)
      if (!payload) return parseTextMessage(content)

      const metadata: TokenMetadata = {
        memo: payload.memo ?? undefined,
        faceValue: payload.face_value,
        faceUnit: payload.face_unit,
        faceDecimals: payload.face_decimals,
        tokenAmount: payload.token_amount ?? payload.amount_hint,
        backingStrategy: payload.backing_strategy as TokenMetadata['backingStrategy'],
        issuerId: payload.issuer_id,
        // The PAYER, which is a different question from the issuer and has its
        // own field on the wire. Dropping it here is what sent every settlement
        // receipt to the stall that minted a coupon rather than the customer
        // who spent it: dmPoll had nothing else to fall back to but `issuerId`.
        //
        // Deliberately NOT overridden by the signed voucher below. The voucher
        // is signed by the ISSUER at mint time and cannot know who would later
        // spend it, so it carries no opinion about the payer. This stays as the
        // envelope wrote it.
        senderPubkey: payload.sender_pubkey,
        voucherId: payload.voucher_id,
      }

      // Everything above came off the envelope, which the SENDER writes. The
      // gift wrap authenticates who sent it and nothing about what they claim,
      // and the mint never sees these fields — it checks proofs. So a genuine
      // low-value token could be announced at any face value at all.
      //
      // The voucher is inside the token, signed. Prefer it, for every field it
      // covers. `signed` stays undefined for plain (non-voucher) ecash, which
      // has no issuer claims to check and must keep flowing.
      const signed = verifiedVoucherFrom(payload.token)
      if (signed === REJECTED) return null
      if (!signed) return { ...metadata, ...ride(payload) } as TokenMetadata

      const { parsed, validation } = signed
      const v = parsed.voucher
      return {
        ...metadata,
        faceValue: validation.faceValue,
        faceUnit: v.unit,
        faceDecimals: v.faceDecimals,
        tokenAmount: parsed.tokenAmount,
        backingStrategy: v.backingStrategy as TokenMetadata['backingStrategy'],
        issuerId: v.issuerId,
        voucherId: v.voucherId,
        memo: v.memo ?? metadata.memo,
        ...ride(payload),
        // The signed expiry outranks the envelope's.
        expiresAt: v.expiresAt ?? payload.expires_at ?? undefined,
        validation: validation.record,
      } as TokenMetadata
    },

    /**
     * Also the refusal gate, because `parseTokenTransferMessage` alone is not one.
     *
     * GiftWrapProcessor reads the token FIRST and then folds a null metadata away
     * as "no metadata" (`parseTokenTransferMessage(...) ?? {}`), so REJECTED above
     * changed nothing: a voucher whose issuer signature failed was still swapped
     * at the mint and saved — with an EMPTY envelope, which also made
     * `refuseIfOverRedeemed` skip it for want of a `validation`. Returning null
     * here is what makes the rejection real: no token, so `process` drops the wrap
     * (classified `non_token_dm` — marked processed, never retried).
     *
     * This is the one receive path, so it holds for a coupon arriving from a
     * merchant and for one arriving from another customer alike.
     */
    extractToken(content: string): string | null {
      const payload = asPayload(content)
      if (!payload) {
        // An app message of another type (a terminal credential, a renewal, a till's renew
        // request, a sale record, an enrolled notice) is never a payment. dm-poll's text regex
        // would otherwise find the `cashuB…` credential token inside one and swap it at the mint:
        // the 1 sat in a personal wallet's balance when its npub was enrolled as a till (#160).
        if (typedAppMessage(content)) return null
        return extractTokenFromText(content)
      }
      // A terminal credential is authority, not value, whatever envelope it arrives in.
      if (terminalCredentialFromToken(payload.token)) return null
      return verifiedVoucherFrom(payload.token) === REJECTED ? null : payload.token
    },

    getTokenFingerprint(token: string): string {
      return bytesToHex(sha256(new TextEncoder().encode(token))).slice(0, 32)
    },
  }
}

/**
 * The same wire-shape gap, in the other direction.
 *
 * `parseTokenTransferMessage` above must return camelCase because that is
 * dm-poll's published `TokenMetadata`. imani-apps' tokenRedemption — which
 * dm-poll hands that metadata straight to — reads snake_case:
 * `metadata.issuer_id`, `.face_value`, `.face_unit`, `.face_decimals`,
 * `.token_amount`, `.backing_strategy`, `.memo`, `.sender_pubkey`. Every one of
 * them was silently undefined, and nothing threw: the coupon persisted with
 * issuer_id null, and since the merchant list groups by issuer, it rendered as
 * nothing at all.
 *
 * `expires_at` is the same defect, found later and one field short of the
 * original fix: it reaches the wallet as epoch SECONDS on the DM payload, and
 * without this mapping tokenRedemption read undefined and stored null, so no
 * coupon ever had an expiry to show.
 *
 * Both spellings go through — snake_case is what tokenRedemption reads, and the
 * original keys stay for anything downstream that speaks camelCase.
 */
export function toLegacyMetadata(
  metadata: Record<string, unknown> | undefined,
  senderPubkey?: string,
): Record<string, unknown> {
  const m = metadata ?? {}
  return {
    ...m,
    issuer_id: m.issuerId,
    voucher_id: m.voucherId,
    face_value: m.faceValue,
    face_unit: m.faceUnit,
    face_decimals: m.faceDecimals,
    token_amount: m.tokenAmount,
    backing_strategy: m.backingStrategy,
    memo: m.memo,
    expires_at: m.expiresAt,
    request_id: m.requestId,
    bundle_id: m.bundleId,
    // The PAYLOAD's sender outranks the ENVELOPE's signer.
    //
    // The gateway signs every gift wrap it relays with its own key, so
    // `senderPubkey` here — the rumor's author — is the gateway on every
    // merchant-delivered and atomic-send coupon, and only coincidentally the
    // payer on a direct wallet-to-wallet wrap. `sender_pubkey` on the payload is
    // the party the gateway is relaying FOR, which is the one the recipient
    // should see credited and the one owed a settlement receipt.
    //
    // The fallback keeps a bare NIP-17 wrap (no payload field) working, where
    // the signer genuinely is the payer.
    sender_pubkey: (m.senderPubkey as string | undefined) ?? senderPubkey,
  }
}

/** Exposed for the unwrap path used outside dm-poll (tests, diagnostics). */
export const conversationKey = nip44.getConversationKey
