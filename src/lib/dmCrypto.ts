import { nip17, nip44 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import {
  extractToken as extractTokenFromText,
  parseTokenTransferMessage as parseTextMessage,
} from '@imani/dm-poll'
import type { CryptoAdapter, GiftWrapEvent, UnwrappedDm, TokenMetadata } from '@imani/dm-poll'

import { getSigner } from './nap'

/**
 * The JSON payload the gateway actually sends.
 *
 * Captured from a live delivery, not inferred. Note it is snake_case —
 * `PayloadBuilder.DmPayload`, the sender-side type in @imani/voucher-send, is
 * camelCase (`faceValue`, `issuerId`). They are NOT the same shape, and reading
 * a received DM with the sender's type yields undefined for every field that
 * matters, including the issuer the farmer list groups by.
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
      const privkey = getSigner().privkeyHex()

      try {
        console.log('[dmCrypto] unwrapping', event.id.slice(0, 8))
        const rumor = nip17.unwrapEvent(event as never, hexToBytes(privkey))
        console.log('[dmCrypto] unwrapped ok, content bytes:', rumor.content.length)
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
        voucherId: payload.voucher_id,
      }

      // `expiresAt` is NOT on dm-poll's published TokenMetadata, which is why it
      // rides an intersection rather than the interface. Dropping it here is
      // what left every DM-received coupon with a null expiry: /inspect is the
      // only other source tokenRedemption will take an expiry from, and it 404s
      // on this deployment, so the DM payload is the sole one that arrives.
      return { ...metadata, expiresAt: payload.expires_at ?? undefined } as TokenMetadata
    },

    extractToken(content: string): string | null {
      return asPayload(content)?.token ?? extractTokenFromText(content)
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
 * issuer_id null, and since the farmer list groups by issuer, it rendered as
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
    sender_pubkey: senderPubkey,
  }
}

/** Exposed for the unwrap path used outside dm-poll (tests, diagnostics). */
export const conversationKey = nip44.getConversationKey
