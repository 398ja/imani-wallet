/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import {
  cancelExpiredWaiting,
  removeUnmintedWaiting,
  resumeMinting,
  setReleasePending,
} from '../terminalRevoke'
import { allTerminals, recordTerminal, waitingTerminals, type TerminalRecord } from '../terminalRoster'
import { TERMINAL_ROLES } from '../terminalRole'
import type { MintTransport } from '../terminalMint'
import { buildLockedCredentialToken } from './voucherFixtures'

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
