import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The row a redemption writes, built by imani-apps' vendored coordinator.
 *
 * Reached through `new Function` because `shared/tokenRedemption.js` is a
 * classic script with no export for it — the same reason the wallet loads the
 * file via a <script> tag rather than importing it (see legacyBridge). Worth the
 * two lines: this builder names every field it copies, so anything the wallet
 * puts on the metadata and does not list here is dropped in silence, which is
 * exactly how the Checks section came to read "Not checked" on every coupon the
 * wallet had in fact verified.
 */
const buildReceiveTransactionRow = new Function(
  readFileSync('shared/tokenRedemption.js', 'utf8') + '; return _buildReceiveTransactionRow;',
)() as (voucher: Record<string, unknown>, metadata?: Record<string, unknown>) => Record<string, unknown> | null

const voucher = { token_id: 'tok-1', voucher_id: 'vou-1', face_value: 1000, face_unit: 'gbp' }
const validation = { signatureValid: true, signedFaceValue: 1000, legacyCanonical: true }

describe('_buildReceiveTransactionRow', () => {
  it('carries the verification result onto the row', () => {
    expect(buildReceiveTransactionRow(voucher, { validation })?.validation).toEqual(validation)
  })

  it('leaves it absent for plain ecash, which has no issuer claim to check', () => {
    expect(buildReceiveTransactionRow(voucher, {})?.validation).toBeUndefined()
  })
})
