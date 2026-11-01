/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

import { CredentialVault, type CredentialStore } from '../vault'
import { runPass, type WorkerDeps } from '../worker'
import type { PurchasesApi, OwedPurchase } from '../purchasesApi'
import type { Ports } from '../discharge'
import { delegatedCredential, ninetyDayTerm } from './stallFixture'

const KEY = 'a'.repeat(64)
const LOCK = '11'.repeat(32)

function memoryStore(): CredentialStore & { rows: unknown[] } {
  const state: { rows: unknown[] } = { rows: [] }
  return {
    rows: state.rows,
    read: async () => state.rows as never,
    write: async (records) => {
      state.rows.length = 0
      state.rows.push(...records)
    },
  } as CredentialStore & { rows: unknown[] }
}

/**
 * Keeping issuing keys, one stall at a time.
 *
 * The property under test is the one ADR 0009 rests on: a stall's credential is
 * its own, so one compromise is one stall rather than all of them.
 */
describe('credential vault', () => {
  it('seals a credential and gives it back', async () => {
    const vault = new CredentialVault(KEY, memoryStore())
    await vault.put({ stallPubkey: 'b'.repeat(64), credentialId: 'c1', lockKeyHex: LOCK })

    const got = await vault.get('b'.repeat(64))
    expect(got?.lockKeyHex).toBe(LOCK)
    expect(got?.credentialId).toBe('c1')
  })

  it('never writes the key in the clear', async () => {
    const store = memoryStore()
    const vault = new CredentialVault(KEY, store)
    await vault.put({ stallPubkey: 'b'.repeat(64), credentialId: 'c1', lockKeyHex: LOCK })

    expect(JSON.stringify(store.rows)).not.toContain(LOCK)
  })

  it('refuses a service key of the wrong size at construction', () => {
    // Not at first use. A service that starts with a bad key and fails on the
    // first sale has already taken somebody's money.
    expect(() => new CredentialVault('abcd', memoryStore())).toThrow()
  })

  it('refuses to decrypt a tampered record', async () => {
    // AES-GCM authenticates. Without that, an attacker able to write the store
    // could flip bits and learn from how signing failed.
    const store = memoryStore()
    const vault = new CredentialVault(KEY, store)
    await vault.put({ stallPubkey: 'b'.repeat(64), credentialId: 'c1', lockKeyHex: LOCK })

    const row = store.rows[0] as { sealed: string }
    const bytes = Buffer.from(row.sealed, 'base64')
    bytes[0] ^= 0xff
    row.sealed = bytes.toString('base64')

    expect(await new CredentialVault(KEY, store).get('b'.repeat(64))).toBeNull()
  })

  it('keeps one stall readable when another record is corrupt', async () => {
    // One unreadable row must not deny every other stall its issuer.
    const store = memoryStore()
    const vault = new CredentialVault(KEY, store)
    await vault.put({ stallPubkey: 'b'.repeat(64), credentialId: 'c1', lockKeyHex: LOCK })
    await vault.put({ stallPubkey: 'c'.repeat(64), credentialId: 'c2', lockKeyHex: LOCK })
    ;(store.rows[0] as { sealed: string }).sealed = 'not base64 ciphertext'

    const fresh = new CredentialVault(KEY, store)
    expect(await fresh.get('b'.repeat(64))).toBeNull()
    expect(await fresh.get('c'.repeat(64))).not.toBeNull()
  })

  it('replaces rather than appends when a stall re-enrols', async () => {
    // A burnt key left on disk looks exactly like a live one.
    const store = memoryStore()
    const vault = new CredentialVault(KEY, store)
    await vault.put({ stallPubkey: 'b'.repeat(64), credentialId: 'old', lockKeyHex: LOCK })
    await vault.put({ stallPubkey: 'b'.repeat(64), credentialId: 'new', lockKeyHex: LOCK })

    expect(store.rows).toHaveLength(1)
    expect((await vault.get('b'.repeat(64)))?.credentialId).toBe('new')
  })

  it('does not decrypt one stall with another stall key', async () => {
    const store = memoryStore()
    await new CredentialVault(KEY, store).put({
      stallPubkey: 'b'.repeat(64),
      credentialId: 'c1',
      lockKeyHex: LOCK,
    })

    // The point of per-stall keys: a different service key reads nothing.
    expect(await new CredentialVault('b'.repeat(64), store).get('b'.repeat(64))).toBeNull()
  })
})

function owed(over: Partial<OwedPurchase> = {}): OwedPurchase {
  return {
    eventId: 'evt_1',
    paymentRequestId: '0123456789abcdef0123456789abcdef',
    stallPubkey: 'b'.repeat(64),
    recipientPubkey: 'c'.repeat(64),
    amountMinor: 2500,
    currency: 'gbp',
    livemode: true,
    attempts: 0,
    processorReference: 'pi_1',
    ...over,
  }
}

function deps(over: Partial<WorkerDeps> = {}): WorkerDeps & { api: PurchasesApi } {
  const api = {
    owed: vi.fn().mockResolvedValue([owed()]),
    claim: vi.fn().mockResolvedValue('claimed'),
    discharge: vi.fn().mockResolvedValue('accepted'),
    reportFailure: vi.fn().mockResolvedValue(undefined),
  } as unknown as PurchasesApi
  const ports: Ports = {
    // A real stall's delegation: since #152 nothing mints without one.
    validityFor: ninetyDayTerm,
    credentialFor: async () => delegatedCredential({ credentialId: 'c1' }),
    tokenFor: async () => '',
    now: () => Date.now(),
    sleep: async () => {},
  }
  return { api, ports, gatewayUrl: 'http://gw', livemode: true, ...over } as never
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

/**
 * One pass over the queue.
 *
 * The customer has already paid, so the only failure modes are "late" and
 * "twice". These tests are about never reaching the second one.
 */
describe('worker pass', () => {
  it('discharges what it issued', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 't', issuer_id: 'i1' }))
      .mockResolvedValueOnce(reply(200, { event_id: 'ev1', fulfilment_recorded: true })))
    const d = deps()

    const result = await runPass(d)

    expect(result.discharged).toBe(1)
    expect(d.api.discharge).toHaveBeenCalledWith('evt_1', 'v1', 'i1')
  })

  it('skips a test-mode debt on a live worker rather than failing it', async () => {
    // Left owed for the other worker. Marking it would hide a misconfigured
    // pair behind a stream of failures.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const d = deps()
    ;(d.api.owed as ReturnType<typeof vi.fn>).mockResolvedValue([owed({ livemode: false })])

    const result = await runPass(d)

    expect(result.skipped).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(d.api.reportFailure).not.toHaveBeenCalled()
  })

  it('never re-issues when the discharge is refused', async () => {
    // We issued and the debt did not close. A second pass minting again would
    // give two coupons for one payment, so this reports and moves on.
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 't', issuer_id: 'i1' }))
      .mockResolvedValueOnce(reply(200, { fulfilment_recorded: true })))
    const d = deps()
    ;(d.api.discharge as ReturnType<typeof vi.fn>).mockResolvedValue('refused')

    const result = await runPass(d)

    expect(result.discharged).toBe(0)
    expect(result.deferred).toBe(1)
    expect((d.api.reportFailure as ReturnType<typeof vi.fn>).mock.calls[0][1])
      .toContain('v1')
  })

  it('reports a burnt credential as permanent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 403 })))
    const d = deps()

    const result = await runPass(d)

    expect(result.blocked).toBe(1)
    expect((d.api.reportFailure as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(true)
  })

  it('skips a debt whose stall could not be identified', async () => {
    // A row with no stall pubkey has no credential to look up. Minting for a
    // guessed stall is worse than not minting, so this waits for a person.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const d = deps()
    ;(d.api.owed as ReturnType<typeof vi.fn>).mockResolvedValue([owed({ stallPubkey: null })])

    const result = await runPass(d)

    expect(result.skipped).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('mints a zero-decimal currency at its own scale', async () => {
    // XAF is zero-decimal and a primary market. Stripe sends 5000 for 5000 XAF,
    // and minting that with 2 decimals would issue 50.00 - a customer paying
    // 5000 and receiving a hundredth of it.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 't', issuer_id: 'i1' }))
      .mockResolvedValueOnce(reply(200, { fulfilment_recorded: true }))
    vi.stubGlobal('fetch', fetchMock)
    const d = deps()
    ;(d.api.owed as ReturnType<typeof vi.fn>).mockResolvedValue([
      owed({ currency: 'xaf', amountMinor: 5000 }),
    ])

    await runPass(d)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.face_decimals).toBe(0)
    expect(body.face_value).toBe(5000)
  })

  it('mints a two-decimal currency at its own scale', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 't', issuer_id: 'i1' }))
      .mockResolvedValueOnce(reply(200, { fulfilment_recorded: true }))
    vi.stubGlobal('fetch', fetchMock)

    await runPass(deps())

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).face_decimals).toBe(2)
  })

  it('says nothing about a stall that holds no credential', async () => {
    // Ordinary, not a failure. A note on every pass would fill the row with a
    // fact that will not change by itself.
    const d = deps({
      ports: { ...deps().ports, credentialFor: async () => null },
    })

    const result = await runPass(d)

    expect(result.skipped).toBe(1)
    expect(d.api.reportFailure).not.toHaveBeenCalled()
  })
})

describe('#312: a sale the stall\u2019s term cannot back', () => {
  // The backstop: the term changed to never-expires between checkout and mint. Nothing is minted
  // and the row is parked NEEDS_ATTENTION (`issue_blocked`) for an operator to refund, not BLOCKED.
  it('parks the row for a person, with the reason, and mints nothing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const d = deps()
    const attention = vi.fn().mockResolvedValue('parked')
    ;(d.api as unknown as { attention: typeof attention }).attention = attention
    d.ports.validityFor = async () => ({ kind: 'days', days: 0, source: 'record' })
    const result = await runPass(d)
    expect(result.blocked).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(attention).toHaveBeenCalledWith(
      'evt_1',
      'issue_blocked',
      expect.objectContaining({ detail: expect.stringMatching(/^validity_never_expires/) }),
    )
    expect(d.api.reportFailure).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  // A payment-adapter that cannot park it: the permanent failure, so a person still sees it.
  it('falls back to a permanent failure when it cannot park', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const d = deps()
    ;(d.api as unknown as { attention: () => Promise<string> }).attention = async () => 'unsupported'
    d.ports.validityFor = async () => ({ kind: 'days', days: 0, source: 'record' })
    await runPass(d)
    expect(d.api.reportFailure).toHaveBeenCalledWith('evt_1', expect.stringMatching(/^validity_never_expires/), true, undefined, expect.anything())
    vi.unstubAllGlobals()
  })
})
