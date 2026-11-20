/**
 * Forward customer receipts addressed to a stall's delegate key on to the stall (follow-up to #655).
 *
 * A card coupon is delivered by this service, NIP-98-signed with the credential's lock key, so the
 * gateway names that key as the coupon's sender. A customer wallet older than #655 therefore posts
 * its redemption receipt (and the customer's signed attestation inside it) to the delegate, NIP-44
 * encrypted to the delegate. Nobody else holds that key, so only this service can read it.
 *
 * Each pass, per credential whose stored delegation verifies (signed by the stall, `coupon:issue`,
 * naming exactly this lock key): drain the delegate's receipt queue, decrypt, re-encrypt the SAME
 * payload delegate -> stall and post it as a receipt from the delegate to the stall. The stall's
 * existing drain decrypts with `recipientPubkeyHex` (the delegate) as counterparty, so no stall
 * wallet change is needed. The gateway's existing rule (authenticated key == recipient) already
 * admits this post; nothing new is trusted server-side.
 *
 * No spoofing is added: we only forward to the stall that signed a delegation to our own key, and
 * the attestation inside is the customer's own signature, which the stall verifies against its
 * sale row (`mayFileAttestation`) regardless of who carried it.
 *
 * The original is acknowledged only once the forward is accepted (201, or 409 on a retry: the
 * forwarded id is derived from the original, so a re-run collides instead of duplicating). An
 * undecryptable receipt is acknowledged too: no retry will make it readable.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as nip44 from 'nostr-tools/nip44'
import { getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'

import { DELEGATION_D_TAG, DELEGATION_KIND, DELEGATION_SCOPE } from './delegatedWarrant'
import { authorization, type StallCredential } from './issuer'

export const RECEIPTS_PATH = '/api/v1/payment-receipts'
const DRAIN_LIMIT = 50
const HEX_64 = /^[0-9a-f]{64}$/

interface Delivery {
  receiptId?: string
  ciphertextBase64?: string
  recipientPubkeyHex?: string
  consumeToken?: string
}

export interface ForwardResult {
  forwarded: number
  dropped: number
  failed: number
}

/**
 * The stall this credential may forward to, or null.
 *
 * Signature, author, kind, `d`, scope and delegate are checked; expiry is NOT. A receipt for a
 * coupon minted under a delegation that has since lapsed is still the stall's receipt.
 */
export function forwardTarget(credential: StallCredential): string | null {
  if (!credential.delegation) return null
  let event: Event
  try {
    event = JSON.parse(credential.delegation) as Event
  } catch {
    return null
  }
  if (!event || typeof event !== 'object' || event.kind !== DELEGATION_KIND || !Array.isArray(event.tags)) return null
  const stall = credential.stallPubkey.toLowerCase()
  if (String(event.pubkey).toLowerCase() !== stall) return null
  let signed = false
  try {
    signed = verifyEvent(event)
  } catch {
    signed = false
  }
  if (!signed) return null
  const tag = (name: string) => event.tags.filter((t) => t[0] === name).map((t) => t[1])
  const d = tag('d')
  const scope = tag('scope')
  const p = tag('p')
  if (d.length !== 1 || d[0] !== DELEGATION_D_TAG) return null
  if (scope.length !== 1 || scope[0] !== DELEGATION_SCOPE) return null
  if (p.length !== 1 || p[0] !== getPublicKey(hexToBytes(credential.lockKeyHex))) return null
  return HEX_64.test(stall) ? stall : null
}

/** Deterministic so a retried forward is a 409 at the gateway, not a second receipt. */
export function forwardedReceiptId(originalReceiptId: string): string {
  return bytesToHex(sha256(new TextEncoder().encode('imani:receipt-forward:' + originalReceiptId)))
}

async function signedPost(baseUrl: string, path: string, payload: unknown, lockKeyHex: string, fetchImpl: typeof fetch) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`
  const body = JSON.stringify(payload)
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization('POST', url, body, lockKeyHex) },
    body,
    signal: AbortSignal.timeout(10_000),
  })
}

/** One credential's queue, one batch. Never throws. */
export async function forwardReceipts(
  baseUrl: string,
  credential: StallCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ForwardResult> {
  const result: ForwardResult = { forwarded: 0, dropped: 0, failed: 0 }
  const stall = forwardTarget(credential)
  if (!stall) return result
  try {
    const delegateKey = hexToBytes(credential.lockKeyHex)
    const delegate = getPublicKey(delegateKey)
    const drained = await signedPost(baseUrl, `${RECEIPTS_PATH}/drain`, { limit: DRAIN_LIMIT }, credential.lockKeyHex, fetchImpl)
    if (!drained.ok) return result
    const body = (await drained.json()) as { receipts?: Delivery[]; nonce?: string }
    const toAck: string[] = []
    for (const d of body.receipts ?? []) {
      if (!d.receiptId || !d.consumeToken) continue
      const customer = d.recipientPubkeyHex?.toLowerCase()
      let plaintext: string
      try {
        if (!customer || !HEX_64.test(customer) || !d.ciphertextBase64) throw new Error('malformed')
        plaintext = nip44.decrypt(d.ciphertextBase64, nip44.getConversationKey(delegateKey, customer))
        JSON.parse(plaintext)
      } catch {
        toAck.push(d.consumeToken)
        result.dropped++
        continue
      }
      const payload = JSON.parse(plaintext) as { faceValue?: unknown; faceUnit?: unknown }
      const response = await signedPost(
        baseUrl,
        RECEIPTS_PATH,
        {
          receiptId: forwardedReceiptId(d.receiptId),
          senderPubkeyHex: stall,
          recipientPubkeyHex: delegate,
          ciphertextBase64: nip44.encrypt(plaintext, nip44.getConversationKey(delegateKey, stall)),
          // Push-body hints only, from the payload the customer wrote.
          ...(typeof payload.faceValue === 'number' && payload.faceValue >= 0 ? { faceValue: payload.faceValue } : {}),
          ...(typeof payload.faceUnit === 'string' && /^[A-Za-z]{2,8}$/.test(payload.faceUnit) ? { faceUnit: payload.faceUnit } : {}),
        },
        credential.lockKeyHex,
        fetchImpl,
      )
      if (response.status === 201 || response.status === 200 || response.status === 202 || response.status === 409) {
        toAck.push(d.consumeToken)
        result.forwarded++
      } else {
        result.failed++
      }
    }
    if (body.nonce && toAck.length > 0) {
      await signedPost(baseUrl, `${RECEIPTS_PATH}/ack`, { nonce: body.nonce, consumeTokens: toAck }, credential.lockKeyHex, fetchImpl)
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'receipt_forward_failed', reason: error instanceof Error ? error.message : String(error) }))
  }
  return result
}

/** Every credential, sequentially. Logs only when something moved. */
export async function forwardAllReceipts(
  baseUrl: string,
  credentials: StallCredential[],
  fetchImpl: typeof fetch = fetch,
): Promise<ForwardResult> {
  const total: ForwardResult = { forwarded: 0, dropped: 0, failed: 0 }
  for (const c of credentials) {
    const r = await forwardReceipts(baseUrl, c, fetchImpl)
    total.forwarded += r.forwarded
    total.dropped += r.dropped
    total.failed += r.failed
  }
  if (total.forwarded + total.dropped + total.failed > 0) {
    console.log(JSON.stringify({ event: 'receipts_forwarded', ...total }))
  }
  return total
}
