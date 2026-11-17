import { describe, expect, it } from 'vitest'

import { cashlinkSteps } from '../cashlinkFlow'
import { isVoucherByReference, tokenProofs } from '../voucherToken'
import { toByReference } from './byReference'
import { buildVoucherToken } from './voucherFixtures'

/**
 * cashu-voucher#64 phase B: the Cashlink lock and the bearer split name their predecessor by its
 * secret. A by-reference (v2) secret holds only SHA256(D), so the gateway refuses it as "not a
 * bearer voucher" unless the request carries the document as `predecessor_document`
 * (imani-gateway-customer#321). An inline or locked predecessor's body must not change.
 */
const { predecessorDocument } = cashlinkSteps

describe('predecessor_document on the Cashlink lock and bearer split bodies', () => {
  it('a by-reference predecessor carries its document, hex, exactly as its token did', () => {
    const [proof] = tokenProofs(toByReference(buildVoucherToken({}, [2, 1]).token))
    expect(isVoucherByReference(proof.secret)).toBe(true)
    expect(proof.document).toMatch(/^[0-9a-f]+$/)
    expect(predecessorDocument(proof)).toEqual({ predecessor_document: proof.document })
  })

  it('an inline (v1) predecessor sends no document: the body is byte-identical to before', () => {
    const [proof] = tokenProofs(buildVoucherToken({}, [2, 1]).token)
    expect(isVoucherByReference(proof.secret)).toBe(false)
    expect(predecessorDocument(proof)).toEqual({})
    expect(JSON.stringify({ a: 1, ...predecessorDocument(proof) })).toBe('{"a":1}')
  })

  it('a stray document on a proof that is not by reference is never sent', () => {
    const [proof] = tokenProofs(buildVoucherToken({}, [2, 1]).token)
    expect(predecessorDocument({ ...proof, document: 'ab'.repeat(40) })).toEqual({})
  })
})
