/**
 * Spec 049 FR-027a-e: the receipt check record. Who may speak for the payee, what a relay can
 * learn, and what each viewer is told.
 */
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import {
  CHECK_KIND,
  buildCheckEvent,
  checkLocator,
  labelChecks,
  readChecks,
  repeatOutcome,
  type TerminalProof,
} from '../checks'
import { signOwnerAttestation } from '../../ownerAttestation'

const stallKey = generateSecretKey()
const STALL = getPublicKey(stallKey)
const tillKey = generateSecretKey()
const TILL = getPublicKey(tillKey)
const PAYMENT = 'ab'.repeat(32)
const T0 = 1_795_000_000
const borrow = (k: Uint8Array) => <T,>(use: (key: Uint8Array) => T) => use(k)
const stallSigner = { pubkey: STALL, withPrivkey: <T,>(use: (k: Uint8Array) => T) => use(stallKey) }

function proofFor(lockKey: string, opts: { until?: number; credentialExpiry?: number } = {}): TerminalProof {
  const until = opts.until ?? T0 + 86_400
  const credentialExpiry = opts.credentialExpiry ?? until
  const role = 'ISSUE_AND_REDEEM'
  return {
    stall_pubkey: STALL,
    lock_key: lockKey,
    role,
    expires_at: String(credentialExpiry),
    owner_attestation: signOwnerAttestation({ stallPubkey: STALL, lockKey, role, expiresAt: until }, stallSigner),
  }
}

const ownerCheck = (at = T0) => buildCheckEvent({ payee: STALL, paymentId: PAYMENT, at }, borrow(stallKey))
const tillCheck = (at = T0, proof = proofFor(TILL), key = tillKey) =>
  buildCheckEvent({ payee: STALL, paymentId: PAYMENT, at, terminal: proof }, borrow(key))

describe('the check event', () => {
  it('names neither the payee, the payment nor the stall in the clear', () => {
    const e = tillCheck()
    expect(e.kind).toBe(CHECK_KIND)
    const wire = JSON.stringify({ tags: e.tags, content: e.content })
    expect(wire).not.toContain(STALL)
    expect(wire).not.toContain(PAYMENT)
    expect(e.tags).toContainEqual(['x', checkLocator(STALL, PAYMENT)])
  })

  it('the locator is the same however the keys are spelled, and differs per payment and payee', () => {
    expect(checkLocator(STALL.toUpperCase(), PAYMENT.toUpperCase())).toBe(checkLocator(STALL, PAYMENT))
    expect(checkLocator(STALL, 'cd'.repeat(32))).not.toBe(checkLocator(STALL, PAYMENT))
    expect(checkLocator(TILL, PAYMENT)).not.toBe(checkLocator(STALL, PAYMENT))
  })

  it('refuses a malformed payee or payment id', () => {
    expect(() => buildCheckEvent({ payee: 'nope', paymentId: PAYMENT, at: T0 }, borrow(stallKey))).toThrow()
  })
})

describe('readChecks: who may speak for the payee (FR-027d)', () => {
  it('keeps the owner’s check and an attested till’s, oldest first', () => {
    const got = readChecks([tillCheck(T0 + 60), ownerCheck(T0)], STALL, PAYMENT)
    expect(got).toEqual([
      { at: T0, device: STALL },
      { at: T0 + 60, device: TILL },
    ])
  })

  it('keeps every check, including two at the same second (append-only)', () => {
    const otherKey = generateSecretKey()
    const other = getPublicKey(otherKey)
    const got = readChecks([tillCheck(T0), tillCheck(T0, proofFor(other), otherKey)], STALL, PAYMENT)
    expect(got.map((c) => c.device).sort()).toEqual([TILL, other].sort())
  })

  it('drops a key the payee never vouched for', () => {
    const stranger = generateSecretKey()
    const e = buildCheckEvent({ payee: STALL, paymentId: PAYMENT, at: T0 }, borrow(stranger))
    expect(readChecks([e], STALL, PAYMENT)).toEqual([])
  })

  it('drops a till carrying another device’s attestation', () => {
    const strangerKey = generateSecretKey()
    expect(readChecks([tillCheck(T0, proofFor(TILL), strangerKey)], STALL, PAYMENT)).toEqual([])
  })

  it('drops an attestation the stall did not sign', () => {
    const forged = proofFor(TILL)
    forged.owner_attestation = { ...forged.owner_attestation, sig: '00'.repeat(64) }
    expect(readChecks([tillCheck(T0, forged)], STALL, PAYMENT)).toEqual([])
  })

  it('drops a check dated after the attestation ran out', () => {
    const proof = proofFor(TILL, { until: T0 + 10 })
    expect(readChecks([tillCheck(T0 + 11, proof)], STALL, PAYMENT)).toEqual([])
    expect(readChecks([tillCheck(T0 + 10, proof)], STALL, PAYMENT)).toHaveLength(1)
  })

  it('drops a credential that outlives what the stall attested', () => {
    const proof = proofFor(TILL, { until: T0 + 100, credentialExpiry: T0 + 200 })
    expect(readChecks([tillCheck(T0, proof)], STALL, PAYMENT)).toEqual([])
  })

  it('on the owner’s wallet, a till in the roster counts without an attestation (legacy till)', () => {
    const legacy = buildCheckEvent({ payee: STALL, paymentId: PAYMENT, at: T0 }, borrow(tillKey))
    expect(readChecks([legacy], STALL, PAYMENT)).toEqual([])
    expect(readChecks([legacy], STALL, PAYMENT, new Set([TILL]))).toEqual([{ at: T0, device: TILL }])
  })

  it('drops a tampered or re-signed event, and one filed under another payment', () => {
    const e = ownerCheck()
    const tampered = { ...e, created_at: e.created_at + 1 }
    const elsewhere = buildCheckEvent({ payee: STALL, paymentId: 'cd'.repeat(32), at: T0 }, borrow(stallKey))
    // A valid signature over the right locator, with a body naming another payment.
    const swapped = finalizeEvent(
      { kind: CHECK_KIND, created_at: T0, tags: [['x', checkLocator(STALL, PAYMENT)]], content: elsewhere.content },
      stallKey,
    )
    expect(readChecks([tampered, elsewhere, swapped], STALL, PAYMENT)).toEqual([])
  })

  it('ignores garbage content and other kinds', () => {
    const junk = finalizeEvent({ kind: CHECK_KIND, created_at: T0, tags: [['x', checkLocator(STALL, PAYMENT)]], content: 'x' }, stallKey)
    const other = { ...ownerCheck(), kind: 1 } as Event
    expect(readChecks([junk, other], STALL, PAYMENT)).toEqual([])
  })

  it('counts one event once, however many times the cache returns it', () => {
    const e = ownerCheck()
    expect(readChecks([e, e, { ...e }], STALL, PAYMENT)).toHaveLength(1)
  })
})

describe('labelChecks: what each viewer is told (FR-027e)', () => {
  const checks = [
    { at: T0, device: STALL },
    { at: T0 + 1, device: TILL },
    { at: T0 + 2, device: 'ee'.repeat(32) },
  ]

  it('a till: itself, the owner, and "another till", never a colleague’s name', () => {
    const got = labelChecks(checks, { device: TILL, payee: STALL })
    expect(got.map((c) => c.by)).toEqual([{ kind: 'owner' }, { kind: 'this_device' }, { kind: 'another_till' }])
  })

  it('the owner: its own checks are its own, each till by its roster name', () => {
    const got = labelChecks(checks, { device: STALL, payee: STALL, nameOf: (k) => (k === TILL ? 'Till 2' : 'A terminal no longer listed') })
    expect(got.map((c) => c.by)).toEqual([
      { kind: 'this_device' },
      { kind: 'named_till', name: 'Till 2' },
      { kind: 'named_till', name: 'A terminal no longer listed' },
    ])
  })

  it('matches keys whatever their case', () => {
    expect(labelChecks([{ at: T0, device: TILL }], { device: TILL.toUpperCase(), payee: STALL })[0].by).toEqual({ kind: 'this_device' })
  })
})

describe('repeatOutcome', () => {
  it('first, repeat on this device, repeat elsewhere', () => {
    expect(repeatOutcome([])).toBe('first')
    expect(repeatOutcome([{ at: T0, by: { kind: 'this_device' } }])).toBe('repeat_this_device')
    expect(repeatOutcome([{ at: T0, by: { kind: 'this_device' } }, { at: T0, by: { kind: 'another_till' } }])).toBe('repeat_other_device')
  })
})

// Keeps the helper honest: a fresh key per run, never a fixed secret in the repo.
it('uses fresh keys', () => expect(bytesToHex(stallKey)).not.toBe(bytesToHex(tillKey)))

describe('readChecks: a till with a fast clock', () => {
  it('drops a check dated more than ten minutes ahead of the reader', () => {
    const e = tillCheck(T0 + 601)
    expect(readChecks([e], STALL, PAYMENT, new Set(), T0)).toEqual([])
    expect(readChecks([tillCheck(T0 + 600)], STALL, PAYMENT, new Set(), T0)).toHaveLength(1)
  })
})
