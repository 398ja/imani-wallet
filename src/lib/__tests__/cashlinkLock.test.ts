/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { hmac } from '@noble/hashes/hmac'

import {
  CASHLINK_LOCK_TAG,
  CASHLINK_RESIGN_TAG,
  CashlinkInvariantError,
  assertNotOpenAfterLocktime,
  cashlinkAuthorization,
  cashlinkDigest,
  deriveRefundSecret,
  derivedOutput,
  derivedOutputs,
  isOpenAfterLocktime,
  isTheLockAskedFor,
  isTheSuccessorAskedFor,
  linkLockProposal,
  lockWindowProblem,
  lockableVoucher,
  readLinkLock,
  secretHash,
  sigAllMessage,
  sigAllWitness,
  unlockedProposal,
  xOnlyPub,
} from '../cashlinkLock'
import { deriveLinkSecret, linkPubOf } from '../giftLink'
import { voucherOfSecret } from '../voucherToken'
import { bearerSecret, signLocked, signUnlocked } from './cashlinkWorld'

/**
 * #295 phase 4: the Cashlink primitives, with no network. The hard rule first: this wallet never
 * makes, and never accepts as a Cashlink, a locked voucher with a locktime and no refund key.
 * cashu-mint#566 pinned that such a voucher is spendable by ANYONE after its locktime.
 */

const ID = hexToBytes('44'.repeat(32))
const LINK = deriveLinkSecret(ID, 3)
const REFUND = deriveRefundSecret(ID, 3)
const X = 1_800_600_000

function proposal(over: Partial<Parameters<typeof linkLockProposal>[0]> = {}) {
  return linkLockProposal({
    giftSecret: bearerSecret(),
    linkPub: linkPubOf(LINK),
    refundPub: xOnlyPub(REFUND),
    x: X,
    maxSats: 64,
    nonce: 'ab'.repeat(32),
    ...over,
  })
}

const withTags = (secret: string, edit: (tags: string[][]) => string[][]) => {
  const [kind, body] = JSON.parse(secret) as [string, { nonce: string; data: string; tags: string[][] }]
  return JSON.stringify([kind, { ...body, tags: edit(body.tags) }])
}

describe('the hard rule: never a locktime without a refund key', () => {
  it('a P2PK_VOUCHER with a locktime and no refund tag is open after its locktime', () => {
    // The exact hazard from cashu-mint#566 (`P2PKLocktimeUnlockTest:81`).
    const open = withTags(proposal(), (t) => t.filter((r) => r[0] !== 'refund'))
    expect(isOpenAfterLocktime(open)).toBe(true)
  })

  it('a refund tag with no key in it is as open as no refund tag', () => {
    const open = withTags(proposal(), (t) => t.map((r) => (r[0] === 'refund' ? ['refund'] : r)))
    expect(isOpenAfterLocktime(open)).toBe(true)
    const blank = withTags(proposal(), (t) => t.map((r) => (r[0] === 'refund' ? ['refund', ''] : r)))
    expect(isOpenAfterLocktime(blank)).toBe(true)
  })

  it('applies to plain P2PK too, and any locktime value counts (one the mint cannot parse is not guessed at)', () => {
    const p2pk = JSON.stringify(['P2PK', { nonce: 'n', data: '02' + 'aa'.repeat(32), tags: [['locktime', 'soon']] }])
    expect(isOpenAfterLocktime(p2pk)).toBe(true)
  })

  it('a locktime WITH one refund key is not open; no locktime at all is not open', () => {
    expect(isOpenAfterLocktime(proposal())).toBe(false)
    const noLocktime = withTags(proposal(), (t) => t.filter((r) => r[0] !== 'locktime' && r[0] !== 'refund'))
    expect(isOpenAfterLocktime(noLocktime)).toBe(false)
  })

  it('assertNotOpenAfterLocktime throws on the hazard and passes a lawful lock', () => {
    const open = withTags(proposal(), (t) => t.filter((r) => r[0] !== 'refund'))
    expect(() => assertNotOpenAfterLocktime(open)).toThrow(CashlinkInvariantError)
    expect(() => assertNotOpenAfterLocktime(proposal())).not.toThrow()
  })

  it('the proposal builder always writes exactly one refund key, and never the link key', () => {
    const tags = (JSON.parse(proposal())[1] as { tags: string[][] }).tags
    const refund = tags.filter((r) => r[0] === 'refund')
    expect(refund).toHaveLength(1)
    expect(refund[0]).toHaveLength(2)
    expect(() => proposal({ refundPub: linkPubOf(LINK) })).toThrow(CashlinkInvariantError)
  })

  it('a refund key that is the link key with its parity byte flipped is still the link key (gc#255 F1)', () => {
    // x-only compare, as the gateway does: 02||x and 03||x are ONE signer.
    const flipped = withTags(proposal(), (t) => t.map((r) => (r[0] === 'refund' ? ['refund', '03' + linkPubOf(LINK)] : r)))
    expect(readLinkLock(flipped)).toBeNull()
  })

  it('readLinkLock never reads the hazard as a Cashlink, whatever else it carries', () => {
    const open = withTags(proposal(), (t) => t.filter((r) => r[0] !== 'refund'))
    expect(readLinkLock(open)).toBeNull()
  })

  it('a signed lock that came back without its refund key is never accepted as the lock asked for', () => {
    const gift = voucherOfSecret(bearerSecret())!
    const signed = signLocked(withTags(proposal(), (t) => t.filter((r) => r[0] !== 'refund')))
    expect(isTheLockAskedFor(signed, gift, { linkPub: linkPubOf(LINK), refundPub: xOnlyPub(REFUND), x: X, maxSats: 64 })).toBe(false)
  })
})

describe('the link-lock shape (gateway LinkLock.shapeProblem)', () => {
  it('reads the link key, the one refund key and the locktime', () => {
    expect(readLinkLock(proposal())).toEqual({ linkPub: linkPubOf(LINK), refundPub: xOnlyPub(REFUND), locktime: X })
  })

  it.each([
    ['SIG_INPUTS instead of SIG_ALL', (t: string[][]) => t.map((r) => (r[0] === 'sigflag' ? ['sigflag', 'SIG_INPUTS'] : r))],
    ['no sigflag', (t: string[][]) => t.filter((r) => r[0] !== 'sigflag')],
    ['two refund keys', (t: string[][]) => t.map((r) => (r[0] === 'refund' ? ['refund', r[1], '02' + 'cd'.repeat(32)] : r))],
    ['extra spending keys', (t: string[][]) => [...t, ['pubkeys', '02' + 'cd'.repeat(32)]]],
    ['n_sigs 2', (t: string[][]) => t.map((r) => (r[0] === 'n_sigs' ? ['n_sigs', '2'] : r))],
    ['n_sigs_refund 2', (t: string[][]) => [...t, ['n_sigs_refund', '2']]],
    ['a tag twice', (t: string[][]) => [...t, ['locktime', String(X + 1)]]],
    ['no locktime', (t: string[][]) => t.filter((r) => r[0] !== 'locktime')],
    ['a locktime that is not an integer', (t: string[][]) => t.map((r) => (r[0] === 'locktime' ? ['locktime', '1.5e9'] : r))],
  ])('refuses %s', (_name, edit) => {
    expect(readLinkLock(withTags(proposal(), edit))).toBeNull()
  })

  it('refuses a plain VOUCHER and plain P2PK', () => {
    expect(readLinkLock(bearerSecret())).toBeNull()
    expect(readLinkLock(JSON.stringify(['P2PK', { nonce: 'n', data: '02' + linkPubOf(LINK), tags: [] }]))).toBeNull()
  })
})

describe('the lock window (gateway LinkLock.timingProblem, Q8)', () => {
  const now = 1_800_000_000
  it('accepts a 7-day link on a coupon that expires in 60 days', () => {
    expect(lockWindowProblem(now + 7 * 86_400, now + 60 * 86_400, now)).toBeNull()
  })
  it('refuses under an hour away (plus clock slack): the take-back must not be postable at once', () => {
    expect(lockWindowProblem(now + 3600, undefined, now)).toBe('too_near')
  })
  it('refuses past 30 days', () => {
    expect(lockWindowProblem(now + 31 * 86_400, undefined, now)).toBe('too_far')
  })
  it('refuses within 24 h (plus slack) of the coupon\u2019s own expiry: a refund after it would lose the value', () => {
    expect(lockWindowProblem(now + 7 * 86_400, now + 8 * 86_400 - 60, now)).toBe('too_close_to_expiry')
    expect(lockWindowProblem(now + 7 * 86_400, now + 8 * 86_400 + 600, now)).toBeNull()
  })
})

describe('what may be locked (before anything is burnt)', () => {
  it('a bearer gift with integer terms and a fractional ratio is lockable', () => {
    expect('voucher' in lockableVoucher(bearerSecret())).toBe(true)
  })
  it('a whole-number ratio other than 1 is not (cashu-voucher#59)', () => {
    expect(lockableVoucher(bearerSecret({ issuanceRatio: 50 }))).toEqual({ problem: 'whole_ratio' })
  })
  it('a locked voucher is not a bearer gift', () => {
    expect(lockableVoucher(proposal())).toEqual({ problem: 'not_a_bearer_voucher' })
  })
  it('a non-voucher is not', () => {
    expect(lockableVoucher('plain-secret')).toEqual({ problem: 'not_a_bearer_voucher' })
  })
})

describe('the proposals carry the gift\u2019s terms unchanged', () => {
  it('the locked proposal names the voucher id and every term, plus the lock and the sat bound', () => {
    const gift = voucherOfSecret(bearerSecret())!
    const locked = voucherOfSecret(signLocked(proposal()))!
    for (const k of ['voucherId', 'issuerId', 'unit', 'faceValue', 'expiresAt', 'faceDecimals', 'backingStrategy', 'issuanceRatio'] as const) {
      expect(locked[k]).toEqual(gift[k])
    }
    const tags = (JSON.parse(proposal())[1] as { tags: string[][] }).tags
    expect(tags.find((r) => r[0] === 'max_sats')).toEqual(['max_sats', '64'])
  })

  it('the signed lock is accepted only when it is exactly what was asked for', () => {
    const gift = voucherOfSecret(bearerSecret())!
    const ask = { linkPub: linkPubOf(LINK), refundPub: xOnlyPub(REFUND), x: X, maxSats: 64 }
    expect(isTheLockAskedFor(signLocked(proposal()), gift, ask)).toBe(true)
    // Another locktime, sat bound, refund key, or a forged issuer signature: refused.
    expect(isTheLockAskedFor(signLocked(proposal({ x: X + 1 })), gift, ask)).toBe(false)
    expect(isTheLockAskedFor(signLocked(proposal({ maxSats: 128 })), gift, ask)).toBe(false)
    expect(isTheLockAskedFor(signLocked(proposal({ refundPub: 'cd'.repeat(32) })), gift, ask)).toBe(false)
    const forged = signLocked(proposal()).replace(/"issuer_sig","[0-9a-f]{128}"/, `"issuer_sig","${'00'.repeat(64)}"`)
    expect(isTheLockAskedFor(forged, gift, ask)).toBe(false)
  })

  it('the unlocked successor drops every spending tag and the sat bound, and keeps the terms (Q4)', () => {
    const locked = signLocked(proposal())
    const unlocked = unlockedProposal(locked, 'cd'.repeat(32))
    const [kind, body] = JSON.parse(unlocked) as [string, { data: string; tags: string[][] }]
    expect(kind).toBe('VOUCHER')
    expect(new TextDecoder().decode(hexToBytes(body.data))).toBe(voucherOfSecret(locked)!.voucherId)
    const keys = body.tags.map((t) => t[0])
    for (const gone of ['locktime', 'refund', 'sigflag', 'n_sigs', 'max_sats', 'issuer_sig', 'issuer_pubkey', 'voucher_id']) expect(keys).not.toContain(gone)
    expect(isTheSuccessorAskedFor(signUnlocked(unlocked), voucherOfSecret(locked)!)).toBe(true)
  })

  it('an unlocked successor with other terms is refused', () => {
    const locked = signLocked(proposal())
    const changed = unlockedProposal(locked, 'cd'.repeat(32)).replace('"face_value","1000"', '"face_value","9000"')
    expect(isTheSuccessorAskedFor(signUnlocked(changed), voucherOfSecret(locked)!)).toBe(false)
  })
})

describe('signatures and derivations', () => {
  it('the refund key is HMAC(identity, "imani-gift-refund/v1/" || i) mod n, and is not the link key', () => {
    const mac = BigInt('0x' + bytesToHex(hmac(sha256, ID, new TextEncoder().encode('imani-gift-refund/v1/3'))))
    const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
    expect(bytesToHex(REFUND)).toBe((mac % n).toString(16).padStart(64, '0'))
    expect(bytesToHex(REFUND)).not.toBe(bytesToHex(LINK))
  })

  it('the refund key is pinned (a change to the rule is a visible break: restores derive it)', () => {
    expect(bytesToHex(deriveRefundSecret(hexToBytes('11'.repeat(32)), 0))).toMatchInlineSnapshot(`"7f8664b13b49427bc93a511b9d108093a3615cde60045340b16afe887020d875"`)
  })

  it('derived outputs are deterministic, differ by purpose and position, and do not depend on the keyset', () => {
    const a = derivedOutputs(REFUND, 'refund', 'secret-1', 64, '00aa000000000001')
    const b = derivedOutputs(REFUND, 'refund', 'secret-1', 64, '00bb000000000002')
    expect(a.map((o) => o.B_)).toEqual(b.map((o) => o.B_))
    expect(derivedOutput(REFUND, 'burn', 'secret-1', 0, 64, 'x').B_).not.toBe(a[0].B_)
    expect(derivedOutput(REFUND, 'refund', 'secret-2', 0, 64, 'x').B_).not.toBe(a[0].B_)
  })

  it('the SIG_ALL message is secret || C || amount || B_ ..., hex lowercased (the mint\u2019s SigAllMessage)', () => {
    expect(sigAllMessage('S', 'AB', [{ amount: 2, B_: 'CD' }, { amount: 1, B_: 'eF' }])).toBe('Sab2cd1ef')
  })

  it('the SIG_ALL witness verifies for the signer over the whole swap, and is byte-identical when repeated', () => {
    const outs = [{ amount: 64, B_: '02' + 'aa'.repeat(32) }]
    const w1 = sigAllWitness(REFUND, 'S', '03' + 'bb'.repeat(32), outs)
    expect(sigAllWitness(REFUND, 'S', '03' + 'bb'.repeat(32), outs)).toBe(w1)
    const [sig] = (JSON.parse(w1) as { signatures: string[] }).signatures
    const digest = sha256(new TextEncoder().encode(sigAllMessage('S', '03' + 'bb'.repeat(32), outs)))
    expect(schnorr.verify(hexToBytes(sig), digest, hexToBytes(xOnlyPub(REFUND)))).toBe(true)
    // Another output, and the signature no longer covers the swap.
    const other = sha256(new TextEncoder().encode(sigAllMessage('S', '03' + 'bb'.repeat(32), [{ amount: 64, B_: '02' + 'cc'.repeat(32) }])))
    expect(schnorr.verify(hexToBytes(sig), other, hexToBytes(xOnlyPub(REFUND)))).toBe(false)
  })

  it('the lock and re-sign authorisations use separate domain tags (a lock cannot stand in for a re-sign)', () => {
    const lockSig = cashlinkAuthorization(REFUND, CASHLINK_LOCK_TAG, 'p', 'q')
    expect(schnorr.verify(hexToBytes(lockSig), cashlinkDigest(CASHLINK_LOCK_TAG, 'p', 'q'), hexToBytes(xOnlyPub(REFUND)))).toBe(true)
    expect(schnorr.verify(hexToBytes(lockSig), cashlinkDigest(CASHLINK_RESIGN_TAG, 'p', 'q'), hexToBytes(xOnlyPub(REFUND)))).toBe(false)
  })

  it('the digest is length-prefixed, so ("ab","c") and ("a","bc") differ', () => {
    expect(bytesToHex(cashlinkDigest(CASHLINK_LOCK_TAG, 'ab', 'c'))).not.toBe(bytesToHex(cashlinkDigest(CASHLINK_LOCK_TAG, 'a', 'bc')))
  })

  it('the relay key is sha256(secret) in hex', () => {
    expect(secretHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
