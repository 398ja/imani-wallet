/**
 * @vitest-environment jsdom
 */
/**
 * Renewal, from the owner's side (#160 phase 6, plan 2.3, S3, S4, Q2, Q3, Q6).
 *
 * Renew mints a fresh, attested credential to the SAME device key, persisting everything on the
 * row's `renewal` BEFORE the request so `resumeRenewal` can replay it byte for byte, and DMs it
 * with `renews`. The old credential is retired only on the enrolled DM for the NEW voucher id.
 * A renewal not adopted in 24 hours has lapsed at the gateway and is cancelled. Renewals count
 * against the two-waiting limit, and the rest wait their turn (Q6).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { allTerminals, recordTerminal, type TerminalRecord } from '../terminalRoster'
import { TERMINAL_ROLES } from '../terminalRole'
import type { MintTransport } from '../terminalMint'
import { buildLockedCredentialToken } from './voucherFixtures'
import { setReleasePending } from '../terminalRevoke'
import {
  RENEWAL_TTL_MS,
  adoptRenewRequest,
  cancelLapsedRenewals,
  canStartRenewal,
  completeRenewals,
  renewalsQueued,
  resumeRenewal,
  startRenewal,
} from '../terminalRenewOwner'

const STALL_KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(STALL_KEY))
const DEVICE = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))
const OLD = '11111111-1111-4111-8111-111111111111'
const NEW = '22222222-2222-4222-8222-222222222222'

const stallSigner = { pubkey: STALL, withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(STALL_KEY) }
const oldToken = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, voucherId: OLD, role: 'issue-and-redeem' })

function inService(over: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    terminalPubkey: DEVICE, name: 'Front counter', role: TERMINAL_ROLES.ISSUE_AND_REDEEM, enrolledAt: 1_000,
    status: 'in-service', gatewayState: 'confirmed', voucherId: OLD, token: oldToken, idleLockMinutes: 15, ...over,
  }
}

/**
 * A gateway that signs back exactly the metadata it was asked for, with T as the expiry, as
 * gateway-customer 5b-2 does. Resumed from a voucher id alone, it returns the last one it minted.
 */
const minted = new Map<string, string>()
function transport() {
  const posted: Array<{ body: unknown; headers?: Record<string, string> }> = []
  const t: MintTransport & { posted: typeof posted } = {
    posted,
    post: vi.fn(async (_path: string, body: unknown, headers?: Record<string, string>) => {
      posted.push({ body, headers })
      mint(body)
      return new Response(JSON.stringify({ voucher_id: NEW }), { status: 201 })
    }),
    get: vi.fn(async () => new Response(JSON.stringify({ status: 'ISSUED', token: minted.get(NEW) }), { status: 200 })),
    sleep: async () => {},
  }
  return t
}
function mint(body: unknown) {
  const md = (body as { merchant_metadata: Record<string, unknown> & { owner_attestation: { expires_at: string } } }).merchant_metadata
  minted.set(NEW, buildLockedCredentialToken({
    stallKey: STALL_KEY, devicePubkey: String(md.lock_key), voucherId: NEW, role: String(md.role),
    metadata: JSON.stringify(md), expiresAt: Number(md.owner_attestation.expires_at),
  }))
}

const spendApi = () => ({
  validateToken: vi.fn(async () => ({ state: 'UNSPENT' })),
  receive: vi.fn(async () => ({})),
})


beforeEach(() => {
  localStorage.clear()
  setReleasePending(async () => {})
  vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', STALL)
})

describe('Renew mints to the same key and DMs it with renews', () => {
  it('persists the renewal before the request, mints the same K, role and idle lock, and sends renews', async () => {
    recordTerminal(STALL, inService())
    const t = transport()
    const sent: string[] = []
    let atRequest: TerminalRecord | undefined
    t.post = vi.fn(async (_p: string, body: unknown, headers?: Record<string, string>) => {
      atRequest = allTerminals(STALL)[0]
      t.posted.push({ body, headers })
      mint(body)
      return new Response(JSON.stringify({ voucher_id: NEW }), { status: 201 })
    })

    const out = await startRenewal(STALL, DEVICE, {
      transport: t, api: spendApi(), stallSigner, send: async (json) => (sent.push(json), true), now: 5_000,
    })

    expect(out).toEqual({ started: true, delivered: true })
    expect(atRequest!.renewal).toMatchObject({ startedAt: 5_000 })
    expect(atRequest!.renewal!.mintKey).toBe(t.posted[0].headers!['Idempotency-Key'])
    const md = (t.posted[0].body as { merchant_metadata: Record<string, unknown> }).merchant_metadata
    expect(md).toMatchObject({ lock_key: DEVICE, role: 'issue-and-redeem', stall_pubkey: STALL, name: 'Front counter' })
    expect(md.owner_attestation).toBeTruthy()
    expect(JSON.parse(sent[0])).toMatchObject({ type: 'imani-terminal-credential/1', voucher_id: NEW, renews: OLD })
    const [row] = allTerminals(STALL)
    expect(row.voucherId).toBe(OLD)
    expect(row.renewal).toMatchObject({ voucherId: NEW, delivered: true })
    expect(row.credentials!.map((c) => c.voucherId)).toEqual([OLD, NEW])
  })

  it('resumes a renewal whose answer was lost, re-sending the identical body under the same key', async () => {
    recordTerminal(STALL, inService())
    const failing = transport()
    failing.post = vi.fn(async (_p: string, body: unknown, headers?: Record<string, string>) => {
      failing.posted.push({ body, headers })
      mint(body)
      throw new Error('network')
    })
    await startRenewal(STALL, DEVICE, { transport: failing, api: spendApi(), stallSigner, send: async () => true, now: 5_000 })
    expect(allTerminals(STALL)[0].renewal?.voucherId).toBeUndefined()

    const again = transport()
    const out = await resumeRenewal(STALL, { transport: again, api: spendApi(), send: async () => true })
    expect(out.completed).toBe(1)
    expect(JSON.stringify(again.posted[0].body)).toBe(JSON.stringify(failing.posted[0].body))
    expect(again.posted[0].headers!['Idempotency-Key']).toBe(failing.posted[0].headers!['Idempotency-Key'])
    expect(allTerminals(STALL)[0].renewal?.voucherId).toBe(NEW)
  })
})

describe('the owner retires the old credential only on the enrolled DM for the NEW voucher', () => {
  async function started() {
    recordTerminal(STALL, inService())
    await startRenewal(STALL, DEVICE, { transport: transport(), api: spendApi(), stallSigner, send: async () => true, now: 5_000 })
  }

  it('an enrolled DM for the OLD voucher changes nothing', async () => {
    await started()
    const api = spendApi()
    expect(await completeRenewals(STALL, [{ voucherId: OLD, terminalPubkey: DEVICE }], api, 6_000)).toBe(0)
    expect(allTerminals(STALL)[0].voucherId).toBe(OLD)
    expect(api.receive).not.toHaveBeenCalled()
  })

  it('the enrolled DM for the new voucher makes it current, revokes the old one, keeps it in history', async () => {
    await started()
    const api = spendApi()
    expect(await completeRenewals(STALL, [{ voucherId: NEW, terminalPubkey: DEVICE }], api, 6_000)).toBe(1)
    const [row] = allTerminals(STALL)
    expect(row.voucherId).toBe(NEW)
    expect(row.revokedAt).toBeUndefined()
    expect(row.renewal).toBeUndefined()
    expect(row.enrolledAt).toBe(1_000)
    expect(row.credentials!.find((c) => c.voucherId === OLD)).toMatchObject({ revokedAt: 6_000 })
    expect(row.credentials!.find((c) => c.voucherId === OLD)!.token).toBeUndefined()
    expect(row.gatewayState).toBe('unconfirmed')
    expect(api.receive).toHaveBeenCalledTimes(1)
  })

  it("counts the old credential as retired when the device spent it first (already-revoked, Q2)", async () => {
    await started()
    const api = { ...spendApi(), validateToken: vi.fn(async () => ({ state: 'SPENT' })) }
    expect(await completeRenewals(STALL, [{ voucherId: NEW, terminalPubkey: DEVICE }], api, 6_000)).toBe(1)
    expect(api.receive).not.toHaveBeenCalled()
    expect(allTerminals(STALL)[0].credentials!.find((c) => c.voucherId === OLD)!.revokedAt).toBe(6_000)
  })

  it('a spend that lost the race to the device still retires the old credential when the mint says SPENT', async () => {
    await started()
    let spentNow = false
    const api = {
      validateToken: vi.fn(async () => ({ state: spentNow ? 'SPENT' : 'UNSPENT' })),
      receive: vi.fn(async () => { spentNow = true; throw new Error('Proof already used') }),
    }
    expect(await completeRenewals(STALL, [{ voucherId: NEW, terminalPubkey: DEVICE }], api, 6_000)).toBe(1)
    expect(allTerminals(STALL)[0].credentials!.find((c) => c.voucherId === OLD)).toMatchObject({ revokedAt: 6_000 })
  })

  // Found by the local gate (E8): the owner's spend raced the device's own (Q2) and lost, so the
  // old entry stayed open in the history with its token. The mint later says SPENT: the next
  // check marks the history entry revoked, and leaves the till itself in service.
  it('marks a lost race in the history once the mint says the old credential is spent', async () => {
    await started()
    const lost = { ...spendApi(), receive: vi.fn(async () => { throw new Error('already being spent') }) }
    expect(await completeRenewals(STALL, [{ voucherId: NEW, terminalPubkey: DEVICE }], lost, 6_000)).toBe(1)
    expect(allTerminals(STALL)[0].credentials!.find((c) => c.voucherId === OLD)!.revokedAt).toBeUndefined()

    const { markSpentElsewhere } = await import('../terminalRevoke')
    const newToken = allTerminals(STALL)[0].token!
    const mint = { validateToken: vi.fn(async (t: string) => ({ state: t === newToken ? 'UNSPENT' : 'SPENT' })) }
    await markSpentElsewhere(STALL, mint, 7_000)

    const [row] = allTerminals(STALL)
    expect(row.revokedAt).toBeUndefined()
    expect(row.voucherId).toBe(NEW)
    expect(row.credentials!.find((c) => c.voucherId === OLD)).toMatchObject({ revokedAt: 7_000 })
    expect(row.credentials!.find((c) => c.voucherId === OLD)!.token).toBeUndefined()
  })
})

describe('a renewal not adopted in 24 hours has lapsed', () => {
  it('is cancelled at the mint and dropped, and the old credential stays current', async () => {
    recordTerminal(STALL, inService())
    await startRenewal(STALL, DEVICE, { transport: transport(), api: spendApi(), stallSigner, send: async () => true, now: 5_000 })
    const api = spendApi()
    expect(await cancelLapsedRenewals(STALL, api, 5_000 + RENEWAL_TTL_MS - 1)).toEqual([])
    expect(await cancelLapsedRenewals(STALL, api, 5_000 + RENEWAL_TTL_MS)).toEqual(['Front counter'])
    const [row] = allTerminals(STALL)
    expect(row.renewal).toBeUndefined()
    expect(row.voucherId).toBe(OLD)
    expect(row.credentials!.find((c) => c.voucherId === NEW)!.revokedAt).toBe(5_000 + RENEWAL_TTL_MS)
    expect(api.receive).toHaveBeenCalledTimes(1)
  })
})

describe('renewals count against two waiting (Q6)', () => {
  it('refuses a third concurrent renewal and queues it', async () => {
    const keys = [1, 2, 3].map(() => bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())))
    for (const [i, k] of keys.entries()) recordTerminal(STALL, inService({ terminalPubkey: k, name: `Till ${i}`, voucherId: `v${i}` }))
    for (const k of keys.slice(0, 2)) {
      await startRenewal(STALL, k, { transport: transport(), api: spendApi(), stallSigner, send: async () => true, now: 5_000 })
    }
    expect(canStartRenewal(STALL)).toBe(false)
    expect(renewalsQueued(STALL, 5_000)).toBe(1)
    const out = await startRenewal(STALL, keys[2], { transport: transport(), api: spendApi(), stallSigner, send: async () => true, now: 5_000 })
    expect(out).toMatchObject({ started: false, reason: 'too-many-waiting' })
  })
})

describe('a renew request from a till the owner lost (Q3)', () => {
  it('adopts an unspent credential of this stall as a row, with nothing but a revocation handle', async () => {
    const api = spendApi()
    const out = await adoptRenewRequest(STALL, {
      terminalPubkey: DEVICE, voucherId: OLD, token: oldToken, role: 'issue-and-redeem', name: 'Legacy till', attested: false,
    }, api, 7_000)
    expect(out).toBe('adopted')
    const [row] = allTerminals(STALL)
    expect(row).toMatchObject({ terminalPubkey: DEVICE, voucherId: OLD, token: oldToken, status: 'in-service', name: 'Legacy till', renewRequest: { at: 7_000 } })
    expect(api.receive).not.toHaveBeenCalled()
  })

  it('refuses one the mint reports spent', async () => {
    const api = { ...spendApi(), validateToken: vi.fn(async () => ({ state: 'SPENT' })) }
    expect(await adoptRenewRequest(STALL, {
      terminalPubkey: DEVICE, voucherId: OLD, token: oldToken, role: 'issue-and-redeem', name: 'x', attested: false,
    }, api, 7_000)).toBe('spent')
    expect(allTerminals(STALL)).toEqual([])
  })

  it('marks an existing row as asking, without replacing its token', async () => {
    recordTerminal(STALL, inService())
    expect(await adoptRenewRequest(STALL, {
      terminalPubkey: DEVICE, voucherId: OLD, token: oldToken, role: 'issue-and-redeem', name: 'x', attested: false,
    }, spendApi(), 8_000)).toBe('already-listed')
    expect(allTerminals(STALL)[0]).toMatchObject({ name: 'Front counter', renewRequest: { at: 8_000 } })
  })
})

void hexToBytes

// Review rv6 (H1): revoking a till while its renewal is out must spend the renewal too. The
// renewal is a live, attested credential locked to the same K and already DM'd to the device, so
// a stolen device (the reason to revoke) could unwrap it, confirm it at gc as the device, and sell.
describe('revoking a till with a renewal out (review rv6 H1)', () => {
  it('spends the renewal credential as well as the current one, and frees its pending slot', async () => {
    const released: string[] = []
    setReleasePending(async (id) => void released.push(id))
    recordTerminal(STALL, inService())
    await startRenewal(STALL, DEVICE, { transport: transport(), api: spendApi(), stallSigner, send: async () => true, now: 5_000 })
    const renewalToken = allTerminals(STALL)[0].renewal!.token!
    const { revokeTerminalAtMint } = await import('../terminalRevoke')
    const api = spendApi()
    const out = await revokeTerminalAtMint(STALL, DEVICE, api, 6_000)
    expect(out.revoked).toBe(true)
    const spent = (api.receive.mock.calls as unknown as string[][]).map((c) => c[0])
    expect(spent).toContain(oldToken)
    expect(spent).toContain(renewalToken)
    const [row] = allTerminals(STALL)
    expect(row.renewal).toBeUndefined()
    expect(row.credentials!.find((c) => c.voucherId === NEW)).toMatchObject({ revokedAt: 6_000 })
    expect(released).toContain(NEW)
  })

  it('does not mark the till revoked when the renewal could not be spent', async () => {
    recordTerminal(STALL, inService())
    await startRenewal(STALL, DEVICE, { transport: transport(), api: spendApi(), stallSigner, send: async () => true, now: 5_000 })
    const renewalToken = allTerminals(STALL)[0].renewal!.token!
    const { revokeTerminalAtMint } = await import('../terminalRevoke')
    const api = { ...spendApi(), receive: vi.fn(async (t: string) => { if (t === renewalToken) throw new Error('offline') }) }
    const out = await revokeTerminalAtMint(STALL, DEVICE, api, 6_000)
    expect(out.revoked).toBe(false)
    expect(allTerminals(STALL)[0].revokedAt).toBeUndefined()
  })
})

// Review rv6 (H2): the device adopted the renewal and spent its old credential, but its enrolled
// DM never arrived (offline at adoption, or a crash after the store). 24 h later the owner's app
// must not "cancel" the renewal: that spends the till's CURRENT credential and kills it.
describe('a renewal the device adopted whose enrolled DM was lost (review rv6 H2)', () => {
  it('is completed, not cancelled, once the old credential is spent', async () => {
    recordTerminal(STALL, inService())
    await startRenewal(STALL, DEVICE, { transport: transport(), api: spendApi(), stallSigner, send: async () => true, now: 5_000 })
    const renewalToken = allTerminals(STALL)[0].renewal!.token!
    const api = {
      validateToken: vi.fn(async (t: string) => ({ state: t === oldToken ? 'SPENT' : 'UNSPENT' })),
      receive: vi.fn(async () => ({})),
    }
    expect(await cancelLapsedRenewals(STALL, api, 5_000 + RENEWAL_TTL_MS)).toEqual([])
    expect(api.receive).not.toHaveBeenCalled()
    const [row] = allTerminals(STALL)
    expect(row.voucherId).toBe(NEW)
    expect(row.token).toBe(renewalToken)
    expect(row.renewal).toBeUndefined()
    expect(row.revokedAt).toBeUndefined()
  })
})

// Review rv6 (M12 survived): a mint that cannot be asked is not UNSPENT. Nothing is adopted.
describe('a renew request when the mint cannot answer (review rv6, mutant M12)', () => {
  it('is not adopted', async () => {
    const api = { validateToken: vi.fn(async () => { throw new Error('offline') }) }
    const out = await adoptRenewRequest(STALL, {
      terminalPubkey: DEVICE, voucherId: OLD, token: oldToken, role: 'issue-and-redeem', name: 'F', attested: false,
    }, api, 1_000)
    expect(out).toBe('unknown-state')
    expect(allTerminals(STALL)).toEqual([])
  })
})
