/**
 * @vitest-environment node
 */
/**
 * A card-purchase coupon gets past the till's receipt gate (#152).
 *
 * #152 made `refuseIfUnwarranted` refuse an unsigned `processor` warrant,
 * which was the only warrant the purchase issuer produced. This drives the
 * purchase issuer's REAL `discharge` to the issuance request it sends, takes
 * the warrant out exactly as the gateway carries it (verbatim, into the
 * voucher's signed bytes), and puts it through the till's REAL validation
 * builder and receipt gate.
 *
 * Lives under `src/` because the receipt gate pulls browser modules that the
 * services typecheck project cannot load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'

import { discharge, type Obligation } from '../../../services/purchase-issuer/discharge'
import { refuseIfUnwarranted } from '../dmPoll'
import { parseIssuanceWarrant } from '../issuanceWarrant'
import { issuerDelegationTemplate } from '../issuerDelegation'
import { paymentRail } from '../issuedVoucher'
import { buildValidationRecord } from '../voucherValidationRecord'
import type { ParsedVoucherToken, SignedVoucherFields } from '../voucherToken'

const STALL_SK = '7'.repeat(63) + '1'
const STALL = getPublicKey(hexToBytes(STALL_SK))
const LOCK = '11'.repeat(32)
const NOW = 1_800_000_000_000
const VOUCHER_ID = '0b9f1f5e-6c3c-4f43-9a63-2f1d6b2f8a10'

/** The stall's delegation, built with the till's own template and signed by the stall. */
const DELEGATION = JSON.stringify(
  finalizeEvent(
    issuerDelegationTemplate({
      delegatePubkey: getPublicKey(hexToBytes(LOCK)),
      expiresAt: Math.floor(NOW / 1000) + 400 * 86_400,
      createdAt: Math.floor(NOW / 1000),
    }),
    hexToBytes(STALL_SK),
  ),
)

const OBLIGATION: Obligation = {
  id: 'evt_card_1',
  paymentRequestId: '0123456789abcdef0123456789abcdef',
  stallPubkey: STALL,
  faceValue: 2500,
  faceUnit: 'GBP',
  faceDecimals: 2,
  memo: 'Voucher',
  recipient: { kind: 'pubkey', pubkey: 'c'.repeat(64) },
  attempts: 0,
  processorReference: 'pi_3PzCard',
}

/** Run the real discharge against a gateway that records the issuance body. */
async function mintedWarrant(): Promise<string> {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/api/v1/wallet/vouchers')) {
        bodies.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ voucher_id: 'v1', issuer_id: STALL, token: 'cashuB1' }), {
          status: 201,
        })
      }
      return new Response(JSON.stringify({ event_id: 'dm1' }), { status: 200 })
    }),
  )
  await discharge('http://gw', OBLIGATION, {
    credentialFor: async () => ({
      stallPubkey: STALL,
      credentialId: 'cred-1',
      lockKeyHex: LOCK,
      delegation: DELEGATION,
    }),
    tokenFor: async () => '',
    now: () => NOW,
    sleep: async () => {},
  })
  return bodies[0].issuance_warrant as string
}

/** The coupon the gateway mints, carrying the warrant in its signed tags. */
function couponCarrying(warrant: string): ParsedVoucherToken {
  return {
    mintUrl: 'https://mint.example',
    unit: 'sat',
    tokenAmount: 2500,
    proofCount: 1,
    voucher: {
      voucherId: VOUCHER_ID,
      issuerId: STALL,
      unit: 'GBP',
      faceValue: 2500,
      faceDecimals: 2,
      issuanceRatio: 1,
      issuanceWarrant: warrant,
    } as unknown as SignedVoucherFields,
  } as ParsedVoucherToken
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a card purchase coupon at the till', () => {
  // The whole path: the purchase issuer signs, the till builds its validation
  // record and the receipt gate that refuses processor claims lets this one
  // through, so the customer can spend what they paid for.
  it('is verified and accepted on receipt', async () => {
    const warrant = await mintedWarrant()
    const { record } = buildValidationRecord(couponCarrying(warrant), {
      signatureValid: true,
      legacyCanonical: false,
    } as never)
    expect(record.warrant).toBe('verified')
    expect(() => refuseIfUnwarranted({ voucherId: VOUCHER_ID, validation: record })).not.toThrow()
  })

  // The stall's ledger still reads it as a card sale with its Stripe
  // reference, so reconciliation against the dashboard keeps working.
  it('still shows the stall it was paid by card, with the processor reference', async () => {
    const warrant = await mintedWarrant()
    expect(paymentRail(parseIssuanceWarrant(warrant))).toEqual({
      kind: 'card',
      reference: 'pi_3PzCard',
    })
  })

  // The control: the same coupon carrying the old unsigned processor warrant
  // is still refused, so the acceptance above is the delegation's doing.
  it('still refuses the same coupon with an unsigned processor warrant', async () => {
    const warrant = JSON.parse(await mintedWarrant())
    const processor = JSON.stringify({
      form: 'processor',
      sale_total: warrant.sale_total,
      face_decimals: warrant.face_decimals,
      unit: warrant.unit,
      nonce: warrant.nonce,
      ref: warrant.ref,
    })
    const { record } = buildValidationRecord(couponCarrying(processor), {
      signatureValid: true,
      legacyCanonical: false,
    } as never)
    expect(record.warrant).toBe('claimed')
    expect(() => refuseIfUnwarranted({ voucherId: VOUCHER_ID, validation: record })).toThrow(
      /no usable authorisation/,
    )
  })
})
