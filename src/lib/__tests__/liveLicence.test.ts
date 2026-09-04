/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoucherRow } from '@imani/wallet-storage'
import { verifyLicence } from '@imani/licence'

import { forgetLicenceParses, licenceFromToken, licenceSignatureVerifier } from '../licences'
import { explain, forgetVerification, licenceStatus } from '../licenceStatus'
import { noticeFor, noticeText } from '../expiryNotice'
import { spendable, toMerchants, walletTotals } from '../merchants'
import { parseVoucherToken, verifyVoucher } from '../voucherToken'

/**
 * A licence minted by a REAL gateway, against a real mint.
 *
 * Every other test in the subscriptions work builds its vouchers with
 * `buildVoucherToken`, which signs with a throwaway key using this app's own
 * canonicalizer. That proves the app agrees with itself. It cannot prove the
 * app agrees with the SYSTEM — and the failures that matter live exactly there:
 * a metadata field the gateway drops, a canonical byte order the Java signer
 * writes differently, a lock key that never reaches the signed secret.
 *
 * This token was produced end to end on 2026-09-04:
 *
 *   gateway-customer, rebuilt from source with the two metadata fixes
 *   (b0fdca5 + b282e87), against imani-mint-rest with real signing keys, via
 *   `scripts/sell-subscription.mjs`. It is the actual artefact a customer
 *   would receive.
 *
 * Getting there required fixing the stack, and both faults are worth recording
 * because they are the reason nobody had run this path before:
 *
 *  - The mint client refuses plain `http` for any non-loopback host
 *    (`MintUrlValidator`), rejecting `http://imani-mint-rest:7777` in the
 *    client CONSTRUCTOR before a request was ever sent.
 *  - The mint had no signing keys. `cashu-vault-jpa` keeps them in HashiCorp
 *    Vault and persists only `t_key.vault_path`, and the test stack defines no
 *    Vault service at all — so it could serve `/v1/keys` from preload but could
 *    not sign a single blinded message.
 *
 * The token is bearer value in principle. In practice it is worth 4000 minor
 * units on a throwaway local mint whose keys are in the repo's own
 * `preload-test-data.json`, and it is a LICENCE rather than money — excluded
 * from every balance by `spendable`, which is one of the things asserted below.
 */

const TOKEN = readFileSync(join(__dirname, 'fixtures/live-licence.token'), 'utf8').trim()

/** The customer this licence was actually locked to. */
const CUSTOMER = '4728fd8ad6a2f5c8930f4065347907e22186fba6c73bd04e145dfd780b98e451'

const parsed = parseVoucherToken(TOKEN)
const ISSUER = parsed.voucher.issuerPublicKey
const EXPIRES_AT = parsed.voucher.expiresAt!
const DAY = 86_400

const row: VoucherRow = {
  token_id: 'live-licence',
  token: TOKEN,
  amount: 4000,
  face_value: 4000,
  face_unit: 'GBP',
  face_decimals: 2,
  token_amount: 4000,
  issuer_id: ISSUER,
  status: 'active',
  created_at: '2026-09-04T00:00:00.000Z',
  updated_at: '2026-09-04T00:00:00.000Z',
}

const ask = (now: number) =>
  licenceStatus({ pubkey: CUSTOMER, now, issuerPublicKey: ISSUER, loadRows: async () => [row] })

beforeEach(() => {
  forgetLicenceParses()
  forgetVerification(CUSTOMER)
})

afterEach(() => {
  forgetVerification(CUSTOMER)
})

describe('a licence a real gateway minted', () => {
  it('carries a signature this wallet can verify', () => {
    // The cross-language check that matters: bytes signed by the Java issuer,
    // rebuilt and verified by voucherToken.ts with no shared code.
    expect(verifyVoucher(parsed.voucher)).toEqual({
      signatureValid: true,
      legacyCanonical: false,
    })
  })

  it('carries the licence metadata all the way into the signed secret', () => {
    // b0fdca5 and b282e87, proven on the artefact rather than in a unit test.
    // Before those, this field was absent from the token entirely.
    const licence = licenceFromToken(TOKEN)
    expect(licence).not.toBeNull()
    expect(licence?.subscriptionId).toMatch(/^sub_[0-9a-f]{16}$/)
    expect(licence?.features).toEqual(['terminals'])
    expect(licence?.lockKey).toBe(CUSTOMER)
    expect(licence?.faceValue).toBe(4000)
    expect(licence?.faceUnit).toBe('GBP')
  })

  it('GRANTS to the customer it was locked to', () => {
    const licence = licenceFromToken(TOKEN)
    const verdict = verifyLicence(licence, {
      issuerPublicKey: ISSUER,
      now: EXPIRES_AT - 300 * DAY,
      presenter: CUSTOMER,
      verifySignature: licenceSignatureVerifier({ token: TOKEN }),
    })

    expect(verdict.granted).toBe(true)
    if (verdict.granted) expect(verdict.grant.features).toEqual(['terminals'])
  })

  it('grants nothing to anyone else', () => {
    const verdict = verifyLicence(licenceFromToken(TOKEN), {
      issuerPublicKey: ISSUER,
      now: EXPIRES_AT - 300 * DAY,
      presenter: 'c'.repeat(64),
      verifySignature: licenceSignatureVerifier({ token: TOKEN }),
    })
    expect(verdict.granted).toBe(false)
  })

  it('is never money', () => {
    // A real voucher with a real 4000 GBP face value, and it must still be
    // absent from every balance.
    expect(spendable([row])).toEqual([])
    expect(walletTotals(toMerchants([row]))).toEqual([])
  })
})

describe('the whole subscription lifecycle, on the real licence', () => {
  it('reads as active, in words a person can act on', async () => {
    const status = await ask(EXPIRES_AT - 300 * DAY)
    expect(status.decision.granted).toBe(true)
    expect(explain(status)).toContain('active')
  })

  it('warns before it ends, naming the days left', async () => {
    const now = EXPIRES_AT - 5 * DAY
    const notice = noticeFor(await ask(now), now)
    expect(notice?.daysLeft).toBe(5)
    expect(noticeText(notice!, '14 Mar 2027')).toContain('5 days')
  })

  it('lapses when the term ends, and then says nothing more', async () => {
    const after = EXPIRES_AT + 1
    const status = await ask(after)

    expect(status.decision.granted).toBe(false)
    expect(explain(status)).toContain('ended')
    // Told twice, then silence.
    expect(noticeFor(status, after)).toBeNull()
  })
})
