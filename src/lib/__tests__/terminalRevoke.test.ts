/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import {
  cancelExpiredWaiting,
  markSpentElsewhere,
  removeUnmintedWaiting,
  resumeMinting,
  setReleasePending,
} from '../terminalRevoke'
import { allTerminals, recordTerminal, waitingTerminals, type TerminalRecord } from '../terminalRoster'
import { TERMINAL_ROLES } from '../terminalRole'
import type { MintTransport } from '../terminalMint'
import { buildAttestedCredentialToken, buildLockedCredentialToken } from './voucherFixtures'
import { attestEnrolment, credentialRequestBody } from '../terminalMint'
import { grantFor } from '../terminalRole'

/**
 * The owner's roster settles what a lost answer left behind (#160 review).
 *
 * Tokens are signed for real, the way gateway-customer mints them. Only the
 * network is faked.
 */

const STALL_KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(STALL_KEY))
const DEVICE = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))
const OTHER = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))
const VOUCHER = '5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9'

function row(over: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    terminalPubkey: DEVICE,
    name: 'Front counter',
    role: TERMINAL_ROLES.REDEEM_ONLY,
    enrolledAt: 1_000,
    status: 'minting',
    mintKey: 'key-1',
    ...over,
  }
}

function transport(token: string | null, over: Partial<MintTransport> = {}) {
  const t = {
    post: vi.fn(async () => new Response(JSON.stringify({ voucher_id: VOUCHER }), { status: 201 })),
    get: vi.fn(async () =>
      token
        ? new Response(JSON.stringify({ status: 'ISSUED', token }), { status: 200 })
        : new Response('{}', { status: 503 }),
    ),
    sleep: async () => {},
  }
  return { ...t, ...over } as typeof t
}

function spendApi(lands = true) {
  return {
    validateToken: vi.fn(async () => ({ state: 'UNSPENT' })),
    receive: vi.fn(async () => {
      if (!lands) throw new Error('offline')
      return {}
    }),
  }
}

const good = () =>
  buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, voucherId: VOUCHER })

beforeEach(() => {
  localStorage.clear()
  setReleasePending(async () => {})
})

describe('a credential request whose answer was lost', () => {
  // The gateway named the voucher but the token never arrived. On the next
  // open the token is fetched, checked, and the row waits for its device like
  // any other: the credential is no longer unknown to the roster.
  it('is finished from its voucher id', async () => {
    recordTerminal(STALL, row({ voucherId: VOUCHER }))
    const token = good()
    const t = transport(token)

    const out = await resumeMinting(STALL, spendApi(), t)

    expect(out).toEqual({ completed: 1, cleared: 0, pending: 0 })
    const [r] = allTerminals(STALL)
    expect(r.status).toBe('waiting')
    expect(r.token).toBe(token)
    expect(t.post).not.toHaveBeenCalled()
  })

  // Not even the voucher id came back. The request is sent again with the
  // same Idempotency-Key, so the gateway replays what it minted rather than
  // minting a second credential.
  it('is re-sent with the same Idempotency-Key when only that is known', async () => {
    recordTerminal(STALL, row())
    const t = transport(good())

    await resumeMinting(STALL, spendApi(), t)

    expect(t.post).toHaveBeenCalledTimes(1)
    expect((t.post.mock.calls[0] as unknown[])[2]).toEqual({ 'Idempotency-Key': 'key-1' })
    expect(allTerminals(STALL)[0].status).toBe('waiting')
  })

  // Still no answer: the row stays as it is and is tried again next time,
  // rather than being dropped while a credential might be live.
  it('stays minting while the gateway cannot be reached', async () => {
    recordTerminal(STALL, row({ voucherId: VOUCHER }))
    const t = transport(null)
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 60_000))

    const out = await resumeMinting(STALL, spendApi(), t)
    vi.restoreAllMocks()

    expect(out.pending).toBe(1)
    expect(allTerminals(STALL)[0].status).toBe('minting')
  })

  // The re-sent request is refused outright: nothing was minted, so the row
  // goes and Add is free again.
  it('is cleared when the gateway refuses it', async () => {
    recordTerminal(STALL, row())
    const t = transport(good(), {
      post: vi.fn(async () => new Response('{}', { status: 409 })),
    })

    const out = await resumeMinting(STALL, spendApi(), t)

    expect(out.cleared).toBe(1)
    expect(allTerminals(STALL)).toEqual([])
  })
})

describe('a credential that came back wrong and could not be cancelled', () => {
  // The defect self-spend failed, so the row keeps the token. The next open
  // retries the spend, and only once it lands is the row removed.
  it('is spent on the next open, then removed', async () => {
    const bad = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: OTHER })
    recordTerminal(STALL, row({ token: bad, defect: 'wrong-lock', voucherId: VOUCHER }))
    const api = spendApi()

    const out = await resumeMinting(STALL, api, transport(null))

    expect(out.cleared).toBe(1)
    expect(api.receive).toHaveBeenCalledTimes(1)
    expect(allTerminals(STALL)).toEqual([])
  })

  // While the spend keeps failing the row stays, so the owner is never told
  // nothing is out there when something is.
  it('stays while the spend does not land', async () => {
    const bad = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: OTHER })
    recordTerminal(STALL, row({ token: bad, defect: 'wrong-lock' }))

    const out = await resumeMinting(STALL, spendApi(false), transport(null))

    expect(out.pending).toBe(1)
    expect(allTerminals(STALL)[0].token).toBe(bad)
  })

  // A token checked on resume that is itself wrong, with a failed spend, is
  // kept with its defect rather than dropped.
  it('keeps a wrong token found on resume when its spend fails', async () => {
    const bad = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: OTHER })
    recordTerminal(STALL, row({ voucherId: VOUCHER }))

    const out = await resumeMinting(STALL, spendApi(false), transport(bad))

    expect(out.pending).toBe(1)
    const [r] = allTerminals(STALL)
    expect(r.token).toBe(bad)
    expect(r.defect).toBe('wrong-lock')
  })
})

describe('#160 review: phase 0 waiting rows', () => {
  // A phase 0 row holds no token: nothing was minted for it. The owner can
  // remove it, and it no longer counts toward the two-waiting limit.
  it('can be removed, and only that kind of row', () => {
    recordTerminal(STALL, row({ status: 'waiting', mintKey: undefined }))
    recordTerminal(
      STALL,
      row({ terminalPubkey: OTHER, status: 'waiting', mintKey: undefined, token: 'cashuB-real' }),
    )

    expect(removeUnmintedWaiting(STALL, OTHER)).toBe(false)
    expect(removeUnmintedWaiting(STALL, DEVICE)).toBe(true)
    expect(allTerminals(STALL).map((t) => t.terminalPubkey)).toEqual([OTHER])
  })

  // The 24-hour expiry skips them without error, and does not touch a row
  // that is still minting.
  it('are left alone by the 24-hour expiry, as are minting rows', async () => {
    recordTerminal(STALL, row({ status: 'waiting', mintKey: undefined, enrolledAt: 0 }))
    recordTerminal(STALL, row({ terminalPubkey: OTHER, enrolledAt: 0, waitingUntil: 1 }))
    const api = spendApi()

    expect(await cancelExpiredWaiting(STALL, api, 10 ** 12)).toBe(0)
    expect(api.receive).not.toHaveBeenCalled()
    expect(waitingTerminals(STALL)).toHaveLength(1)
  })
})

describe('cancelling a waiting credential frees the gateway slot', () => {
  // The gateway counts a stall's pending credentials (gateway-customer#187).
  // Cancelling a waiting row tells it so, and the slot is free at once
  // rather than after its 24 hours.
  it('tells the gateway once the spend lands', async () => {
    const release = vi.fn(async () => {})
    setReleasePending(release)
    recordTerminal(
      STALL,
      row({ status: 'waiting', token: good(), voucherId: VOUCHER, enrolledAt: 0, waitingUntil: 1 }),
    )

    expect(await cancelExpiredWaiting(STALL, spendApi(), 10)).toBe(1)
    expect(release).toHaveBeenCalledWith(VOUCHER)
  })
})

describe('#160 round 2: an ambiguous answer keeps the minting row', () => {
  // A 502, 504 or 500 can come back after the gateway already minted the
  // credential. Forgetting the row and its Idempotency-Key would leave a live
  // credential nobody knows about, so the row stays and is resumed later.
  it.each([500, 502, 504, 408, 429])('keeps the row on HTTP %i', async (status) => {
    recordTerminal(STALL, row())
    const t = transport(good(), {
      post: vi.fn(async () => new Response('{}', { status })),
    })

    const out = await resumeMinting(STALL, spendApi(), t)

    expect(out.pending).toBe(1)
    const [r] = allTerminals(STALL)
    expect(r.status).toBe('minting')
    expect(r.mintKey).toBe('key-1')
  })

  // A network failure (fetch throws) is just as ambiguous.
  it('keeps the row when the network fails', async () => {
    recordTerminal(STALL, row())
    const t = transport(good(), {
      post: vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    })

    const out = await resumeMinting(STALL, spendApi(), t)

    expect(out.pending).toBe(1)
    expect(allTerminals(STALL)[0].mintKey).toBe('key-1')
  })

  // Only a definitive 4xx means nothing was minted, so only that forgets the row.
  it.each([400, 403, 409])('forgets the row on a definitive HTTP %i', async (status) => {
    recordTerminal(STALL, row())
    const t = transport(good(), {
      post: vi.fn(async () => new Response('{}', { status })),
    })

    expect((await resumeMinting(STALL, spendApi(), t)).cleared).toBe(1)
    expect(allTerminals(STALL)).toEqual([])
  })

  // Found by the local gate (#160 phase 6, E8): the same Idempotency-Key sent twice at once (the
  // Renew tap and the screen's resume) gets 409 IDEMPOTENCY_IN_PROGRESS for the second. The first
  // is minting: forgetting the row then strands a live credential nobody holds.
  it('keeps the row on 409 IDEMPOTENCY_IN_PROGRESS: the same request is still minting', async () => {
    recordTerminal(STALL, row())
    const body = JSON.stringify({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'in progress' } })
    const t = transport(good(), { post: vi.fn(async () => new Response(body, { status: 409 })) })

    expect((await resumeMinting(STALL, spendApi(), t)).pending).toBe(1)
    expect(allTerminals(STALL)[0].mintKey).toBe('key-1')
  })
})

describe('#160 round 2: a wrong credential that was spent gives its slot back', () => {
  // The gateway counts the wrong credential as waiting until it is cancelled.
  // Once the owner's wallet has spent it, it tells the gateway, so the slot is
  // free now rather than after 24 hours.
  it('releases the slot when the retried spend lands', async () => {
    const release = vi.fn(async () => {})
    setReleasePending(release)
    const bad = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: OTHER })
    recordTerminal(STALL, row({ token: bad, defect: 'wrong-lock', voucherId: VOUCHER }))

    await resumeMinting(STALL, spendApi(), transport(null))

    expect(release).toHaveBeenCalledWith(VOUCHER)
  })

  // The same when the wrong credential is found on resume and spent at once.
  it('releases the slot when a wrong token found on resume is spent', async () => {
    const release = vi.fn(async () => {})
    setReleasePending(release)
    const bad = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: OTHER })
    recordTerminal(STALL, row({ voucherId: VOUCHER }))

    const out = await resumeMinting(STALL, spendApi(), transport(bad))

    expect(out.cleared).toBe(1)
    expect(release).toHaveBeenCalledWith(VOUCHER)
  })
})

describe('#160 phase 4: a credential spent elsewhere reads as revoked here', () => {
  const inService = (over: Partial<TerminalRecord> = {}) =>
    row({ status: 'in-service', token: good(), voucherId: VOUCHER, mintKey: undefined, ...over })
  const mintSays = (state: string | Error) => ({
    validateToken: vi.fn(async () => {
      if (state instanceof Error) throw state
      return { state }
    }),
  })

  // The device took itself out of service, or another of the owner's phones revoked it: the mint
  // says SPENT, so this phone's row reads revoked rather than In service.
  it('marks a row revoked when the mint says its credential is spent', async () => {
    recordTerminal(STALL, inService())
    expect(await markSpentElsewhere(STALL, mintSays('SPENT'), 5_000)).toBe(1)
    expect(allTerminals(STALL)[0].revokedAt).toBe(5_000)
  })

  // Unspent, or a mint that cannot be reached, leaves the row alone: marking a live till revoked
  // would hide the one handle that can still revoke it.
  it('leaves the row alone when the credential is live or the mint is unreachable', async () => {
    recordTerminal(STALL, inService())
    expect(await markSpentElsewhere(STALL, mintSays('UNSPENT'))).toBe(0)
    expect(await markSpentElsewhere(STALL, mintSays(new Error('offline')))).toBe(0)
    expect(allTerminals(STALL)[0].revokedAt).toBeUndefined()
  })

  // Read-only: asking about a row never spends it, and a row being minted is not asked about.
  it('never spends, and skips rows still being minted', async () => {
    recordTerminal(STALL, row())
    const api = { ...mintSays('SPENT'), receive: vi.fn() }
    expect(await markSpentElsewhere(STALL, api)).toBe(0)
    expect(api.validateToken).not.toHaveBeenCalled()
    expect(api.receive).not.toHaveBeenCalled()
  })

  // #160 review (LOW). A WAITING row whose credential was spent elsewhere (cancelled from another
  // phone) still holds one of the stall's two pending slots at the gateway. Marking it revoked
  // here must also give that slot back, exactly as revoking it from this phone does, or the owner
  // cannot add a terminal for up to 24 hours. An in-service row has no slot to give back.
  it('gives the gateway its pending slot back for a waiting row, and only for one', async () => {
    const released: string[] = []
    setReleasePending(async (id) => {
      released.push(id)
    })
    recordTerminal(STALL, inService({ status: 'waiting', voucherId: 'waiting-1' }))
    recordTerminal(STALL, inService({ terminalPubkey: OTHER, voucherId: 'live-1' }))

    expect(await markSpentElsewhere(STALL, mintSays('SPENT'))).toBe(2)
    expect(released).toEqual(['waiting-1'])
  })

  // #160 phase 6, Q2 (found by the local gate, E8). A renewed till spends its OLD credential
  // itself, at unlock, after it has adopted the new one. Until the owner's phone collects the
  // enrolled DM, the row still names the old credential, and the mint says SPENT. That is a
  // renewal landing, not a revocation: revoking here retired a till that was trading on its new
  // credential, and left the renewal stranded.
  const renewing = () =>
    inService({
      renewal: {
        startedAt: 1, mintKey: 'renew-key', voucherId: 'renewed-1', token: 'cashuBnew', delivered: true,
        attestation: { v: '1', expires_at: '1900000000', nonce: 'ab'.repeat(32), sig: 'cd'.repeat(64) },
      },
    })
  const mintAnswers = (byToken: Record<string, string>) => ({
    validateToken: vi.fn(async (token: string) => ({ state: byToken[token] ?? 'SPENT' })),
  })

  it('leaves a row alone while its renewal is out: the device spent the old credential (Q2)', async () => {
    recordTerminal(STALL, renewing())
    expect(await markSpentElsewhere(STALL, mintAnswers({ cashuBnew: 'UNSPENT' }), 5_000)).toBe(0)
    expect(allTerminals(STALL)[0].revokedAt).toBeUndefined()
  })

  // The renewal's credential is then the one that answers: revoked from another phone, it is.
  it('still marks a renewing row revoked when the renewal credential is spent too', async () => {
    recordTerminal(STALL, renewing())
    expect(await markSpentElsewhere(STALL, mintAnswers({}), 5_000)).toBe(1)
    expect(allTerminals(STALL)[0].revokedAt).toBe(5_000)
  })
})

describe('a resumed mint carries the attestation signed at enrolment (#160 decision 5)', () => {
  /**
   * The enrol screen signs the attestation once and persists it on the `minting` row, beside the
   * Idempotency-Key. A resumed request must send that very body: signing again would pick a fresh
   * nonce, and the gateway would refuse the replay as a different request (spec 4.6.2).
   */
  it('re-sends the persisted attestation and idle lock byte for byte, with T in the header', async () => {
    const prepared = {
      name: 'Front counter',
      stallPubkey: STALL,
      role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
      lockedTo: DEVICE,
      permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
      idleLockMinutes: 5,
    }
    const signer = { pubkey: STALL, withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(STALL_KEY) }
    const attestation = attestEnrolment(prepared, signer, 1_800_000_000_000)
    // What the enrol screen sent the first time.
    const firstBody = {
      ...credentialRequestBody(prepared),
      merchant_metadata: { ...(credentialRequestBody(prepared).merchant_metadata as object), owner_attestation: attestation },
    }
    recordTerminal(STALL, row({ role: TERMINAL_ROLES.ISSUE_AND_REDEEM, attestation, idleLockMinutes: 5 }))
    const t = transport(
      buildAttestedCredentialToken({
        stallKey: STALL_KEY,
        devicePubkey: DEVICE,
        voucherId: VOUCHER,
        expiresAt: Number(attestation.expires_at),
      }),
    )

    await resumeMinting(STALL, spendApi(), t)

    const [, body, headers] = t.post.mock.calls[0] as unknown as [string, unknown, Record<string, string>]
    expect(JSON.stringify(body)).toBe(JSON.stringify(firstBody))
    expect(headers['Idempotency-Key']).toBe('key-1')
    expect(headers['X-Idempotency-Expires-At']).toBe(new Date(Number(attestation.expires_at) * 1000).toISOString().replace('.000Z', 'Z'))
  })

  // The attestation survives the row's reload from storage: it is read back field by field.
  it('keeps the attestation on the roster row across a reload', () => {
    const signer = { pubkey: STALL, withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(STALL_KEY) }
    const attestation = attestEnrolment(
      { name: 'x', stallPubkey: STALL, role: TERMINAL_ROLES.ISSUE_AND_REDEEM, lockedTo: DEVICE, permissions: [] },
      signer,
    )
    recordTerminal(STALL, row({ attestation }))
    expect(allTerminals(STALL)[0].attestation).toEqual(attestation)
  })
})
