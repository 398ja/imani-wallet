/**
 * Spec 049 FR-027a-e: the receipt check record. Who may speak for the payee, what a relay can
 * learn, and what each viewer is told.
 */
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'

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
const PHONE = '11'.repeat(16)
const LAPTOP = '22'.repeat(16)
const TILL_ID = '33'.repeat(16)
const borrow = (k: Uint8Array) => <T,>(use: (key: Uint8Array) => T) => use(k)
const stallSigner = { pubkey: STALL, withPrivkey: <T,>(use: (k: Uint8Array) => T) => use(stallKey) }

function proofFor(lockKey: string, opts: { until?: number; role?: string } = {}): TerminalProof {
  const until = opts.until ?? T0 + 86_400
  const role = opts.role ?? 'issue-and-redeem'
  return {
    stall_pubkey: STALL,
    lock_key: lockKey,
    role,
    expires_at: String(until),
    owner_attestation: signOwnerAttestation({ stallPubkey: STALL, lockKey, role, expiresAt: until }, stallSigner),
  }
}

const ownerCheck = (at = T0, deviceId = PHONE) =>
  buildCheckEvent({ payee: STALL, paymentId: PAYMENT, at, device: STALL, deviceId }, borrow(stallKey))
const tillCheck = (at = T0, proof: TerminalProof | null = proofFor(TILL), key = tillKey) =>
  buildCheckEvent({ payee: STALL, paymentId: PAYMENT, at, device: getPublicKey(key), deviceId: TILL_ID, ...(proof ? { terminal: proof } : {}) }, borrow(key))
const devices = (got: { device: string }[]) => got.map((c) => c.device)

describe('the check event (H2: nothing a relay could tie to a stall)', () => {
  it('names neither the payee, the payment, the stall nor the device in the clear', () => {
    const owner = ownerCheck()
    const till = tillCheck()
    for (const e of [owner, till]) {
      expect(e.kind).toBe(CHECK_KIND)
      expect(e.pubkey).not.toBe(STALL)
      expect(e.pubkey).not.toBe(TILL)
      const wire = JSON.stringify(e)
      for (const secret of [STALL, TILL, PAYMENT]) expect(wire).not.toContain(secret)
      expect(e.tags).toEqual([['x', checkLocator(STALL, PAYMENT)]])
    }
    // A fresh outer key every time: two checks by one device are not linkable by signer.
    expect(ownerCheck().pubkey).not.toBe(ownerCheck().pubkey)
  })

  it('the locator is the same however the keys are spelled, and differs per payment and payee', () => {
    expect(checkLocator(STALL.toUpperCase(), PAYMENT.toUpperCase())).toBe(checkLocator(STALL, PAYMENT))
    expect(checkLocator(STALL, 'cd'.repeat(32))).not.toBe(checkLocator(STALL, PAYMENT))
    expect(checkLocator(TILL, PAYMENT)).not.toBe(checkLocator(STALL, PAYMENT))
  })

  it('refuses a malformed payee, a missing device id, or a key that is not the device', () => {
    expect(() => buildCheckEvent({ payee: 'nope', paymentId: PAYMENT, at: T0, device: STALL, deviceId: PHONE }, borrow(stallKey))).toThrow()
    expect(() => buildCheckEvent({ payee: STALL, paymentId: PAYMENT, at: T0, device: STALL, deviceId: 'x' }, borrow(stallKey))).toThrow()
    expect(() => buildCheckEvent({ payee: STALL, paymentId: PAYMENT, at: T0, device: STALL, deviceId: PHONE }, borrow(tillKey))).toThrow()
  })
})

describe('readChecks: who may speak for the payee (FR-027d)', () => {
  it('keeps the owner’s check and an attested till’s, oldest first', () => {
    const got = readChecks([tillCheck(T0 + 60), ownerCheck(T0)], STALL, PAYMENT)
    expect(got.map((c) => [c.at, c.device])).toEqual([
      [T0, STALL],
      [T0 + 60, TILL],
    ])
  })

  it('keeps every check, including two at the same second (append-only)', () => {
    const otherKey = generateSecretKey()
    const other = getPublicKey(otherKey)
    const got = readChecks([tillCheck(T0), tillCheck(T0, proofFor(other), otherKey)], STALL, PAYMENT)
    expect(devices(got).sort()).toEqual([TILL, other].sort())
  })

  it('drops a key the payee never vouched for', () => {
    const stranger = generateSecretKey()
    const e = buildCheckEvent({ payee: STALL, paymentId: PAYMENT, at: T0, device: getPublicKey(stranger), deviceId: PHONE }, borrow(stranger))
    expect(readChecks([e], STALL, PAYMENT)).toEqual([])
  })

  it('drops a till carrying another device’s attestation', () => {
    expect(readChecks([tillCheck(T0, proofFor(TILL), generateSecretKey())], STALL, PAYMENT)).toEqual([])
  })

  it('drops an attestation the stall did not sign', () => {
    const forged = proofFor(TILL)
    forged.owner_attestation = { ...forged.owner_attestation, sig: '00'.repeat(64) }
    expect(readChecks([tillCheck(T0, forged)], STALL, PAYMENT)).toEqual([])
  })

  it('drops a check dated after the attestation ran out, whatever expiry the till claims', () => {
    const proof = { ...proofFor(TILL, { until: T0 + 10 }), expires_at: '1' }
    expect(readChecks([tillCheck(T0 + 11, proof)], STALL, PAYMENT)).toEqual([])
    expect(readChecks([tillCheck(T0 + 10, proof)], STALL, PAYMENT)).toHaveLength(1)
  })

  it('drops an attestation for a role that does not exist (M5)', () => {
    expect(readChecks([tillCheck(T0, proofFor(TILL, { role: 'auditor' }))], STALL, PAYMENT)).toEqual([])
  })

  it('on the owner’s wallet: a roster till counts until revoked, and not after (M5)', () => {
    const legacy = tillCheck(T0, null)
    expect(readChecks([legacy], STALL, PAYMENT)).toEqual([])
    expect(readChecks([legacy], STALL, PAYMENT, { roster: { keys: new Map([[TILL, undefined]]) } })).toHaveLength(1)
    expect(readChecks([legacy], STALL, PAYMENT, { roster: { keys: new Map([[TILL, T0 + 1]]) } })).toHaveLength(1)
    expect(readChecks([legacy], STALL, PAYMENT, { roster: { keys: new Map([[TILL, T0]]) } })).toEqual([])
    // Revoked even though its attestation is still in force.
    expect(readChecks([tillCheck(T0)], STALL, PAYMENT, { roster: { keys: new Map([[TILL, T0 - 5]]) } })).toEqual([])
  })

  it('drops a check dated far ahead of the reader, or before the payment (M6)', () => {
    expect(readChecks([tillCheck(T0 + 601)], STALL, PAYMENT, { now: T0 })).toEqual([])
    expect(readChecks([tillCheck(T0 + 600)], STALL, PAYMENT, { now: T0 })).toHaveLength(1)
    expect(readChecks([tillCheck(T0 - 601)], STALL, PAYMENT, { paidAt: T0 })).toEqual([])
    expect(readChecks([tillCheck(T0 - 600)], STALL, PAYMENT, { paidAt: T0 })).toHaveLength(1)
  })

  it('drops a body re-wrapped under another event, filed under another payment, or with a forged inner time', () => {
    const elsewhere = buildCheckEvent({ payee: STALL, paymentId: 'cd'.repeat(32), at: T0, device: STALL, deviceId: PHONE }, borrow(stallKey))
    // The other payment's encrypted body, re-wrapped under this payment's locator.
    const swapped = finalizeEvent({ kind: CHECK_KIND, created_at: T0, tags: [['x', checkLocator(STALL, PAYMENT)]], content: elsewhere.content }, generateSecretKey())
    expect(readChecks([elsewhere, swapped], STALL, PAYMENT)).toEqual([])
  })

  it('ignores garbage content and other kinds', () => {
    const junk = finalizeEvent({ kind: CHECK_KIND, created_at: T0, tags: [['x', checkLocator(STALL, PAYMENT)]], content: 'x' }, generateSecretKey())
    const other = { ...ownerCheck(), kind: 1 } as Event
    expect(readChecks([junk, other], STALL, PAYMENT)).toEqual([])
  })

  it('counts one event once, however many times the cache returns it', () => {
    const e = ownerCheck()
    expect(readChecks([e, e, { ...e }], STALL, PAYMENT)).toHaveLength(1)
  })
})

describe('labelChecks: what each viewer is told (FR-027e)', () => {
  const check = (device: string, deviceId: string, at = T0) => ({ id: `${device}:${deviceId}:${at}`, at, device, deviceId })

  it('a till: itself, the owner, and "another till", never a colleague’s name', () => {
    const got = labelChecks([check(STALL, PHONE), check(TILL, TILL_ID, T0 + 1), check('ee'.repeat(32), TILL_ID, T0 + 2)], { device: TILL, deviceId: TILL_ID, payee: STALL })
    expect(got.map((c) => c.by)).toEqual([{ kind: 'owner' }, { kind: 'this_device' }, { kind: 'another_till' }])
  })

  it('the owner: this install, its other devices, and each till by its roster name (M4)', () => {
    const got = labelChecks([check(STALL, PHONE), check(STALL, LAPTOP), check(TILL, TILL_ID)], {
      device: STALL,
      deviceId: PHONE,
      payee: STALL,
      nameOf: (k) => (k === TILL ? 'Till 2' : 'A terminal no longer listed'),
    })
    expect(got.map((c) => c.by)).toEqual([{ kind: 'this_device' }, { kind: 'owner_other_device' }, { kind: 'named_till', name: 'Till 2' }])
  })

  it('a till that was reinstalled is still this till', () => {
    expect(labelChecks([check(TILL, '44'.repeat(16))], { device: TILL.toUpperCase(), deviceId: TILL_ID, payee: STALL })[0].by).toEqual({ kind: 'this_device' })
  })
})

describe('repeatOutcome', () => {
  it('first, unknown, repeat on this device, repeat elsewhere', () => {
    expect(repeatOutcome([])).toBe('first')
    expect(repeatOutcome([], false)).toBe('unknown')
    expect(repeatOutcome([{ at: T0, by: { kind: 'this_device' } }], false)).toBe('repeat_this_device')
    expect(repeatOutcome([{ at: T0, by: { kind: 'this_device' } }, { at: T0, by: { kind: 'another_till' } }])).toBe('repeat_other_device')
  })
})
