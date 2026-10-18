import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event, EventTemplate } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import type { VoucherRow } from '@imani/wallet-storage'

import { buildVoucherToken } from './voucherFixtures'

/**
 * Second check of #326: `confirmBackups` adversarially.
 *
 * Each test here is one way to make the check say "confirmed" while a held
 * voucher is NOT readable back, and each was a surviving mutant on 57908a2
 * (the check was right, nothing pinned it):
 *
 * - a RELAY event forged by another key, of another kind, or with a broken
 *   signature (the relay library's own verification is not relied on);
 * - a backup of the right token with the wrong status or the wrong sats_token;
 * - a fully_redeemed row (still the holder's proofs) left out of scope;
 * - a locked key read as "check your connection" rather than "locked";
 * - an unreadable store read as "nothing held";
 * - the gateway mirror (the only write that lands when the relay is down);
 * - a short gateway page taken as the end of the walk;
 * - restored writes invisible to logout's race counter.
 */

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const key = nip44.v2.utils.getConversationKey(sk, pk)

const net = vi.hoisted(() => ({
  relay: [] as Event[],
  /** Served by the relay read only, on top of `relay` (what a lying relay adds). */
  relayExtra: [] as Event[],
  relayDown: false,
  gateway: [] as Event[],
  gatewayUp: true,
  /** The gateway answers at most this many per page (a cap below the ask). */
  gatewayCap: 500,
  posted: [] as Event[],
  locked: false,
}))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: pk,
    hasKey: () => !net.locked,
    nip44Encrypt: (_to: string, plain: string) => {
      if (net.locked) throw new Error('locked')
      return nip44.v2.encrypt(plain, key)
    },
    nip44Decrypt: (_from: string, cipher: string) => {
      if (net.locked) throw new Error('locked')
      return nip44.v2.decrypt(cipher, key)
    },
    signEvent: async (t: EventTemplate) => {
      if (net.locked) throw new Error('locked')
      return finalizeEvent(t, sk)
    },
  }),
}))

vi.mock('../relay', async () => {
  const relayRead = async (author: string, kind: number) => {
    if (net.relayDown) return []
    // A lying relay: it serves whatever it holds for this filter, author or not.
    return [...net.relay.filter((e) => e.pubkey === author && e.kind === kind), ...net.relayExtra]
  }
  return {
    allEvents: relayRead,
    allEventsWithGateway: async (author: string, kind: number) => {
      const { gatewayAllEvents, unionWithGateway } = await import('../gatewayNostr')
      const [relayed, cached] = await Promise.all([relayRead(author, kind), gatewayAllEvents(author, kind)])
      return unionWithGateway(relayed, cached ?? [], author, kind)
    },
    publish: async (event: Event) => {
      if (net.relayDown) return { ok: 0, total: 1, errors: ['connection failure'] }
      net.relay.push(event)
      return { ok: 1, total: 1, errors: [] }
    },
  }
})
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({ validateToken: async () => ({ state: 'UNSPENT' }) }) }))
vi.mock('../burn', () => ({ burnIfSelfIssued: vi.fn().mockResolvedValue(false) }))
vi.mock('../nip98', () => ({
  // The gateway re-checks the signature server-side; the fake stores what it is given.
  signedFetch: async (_path: string, _method: string, body: Record<string, unknown>) => {
    if (!net.gatewayUp) return new Response('', { status: 502 })
    net.posted.push({ ...(body as unknown as Event), created_at: body.createdAt as number })
    net.gateway.push({ ...(body as unknown as Event), created_at: body.createdAt as number })
    return new Response('', { status: 200 })
  },
}))

const realFetch = globalThis.fetch
beforeEach(() => {
  // `/nostr/query`: newest first, inclusive `until`, capped at `gatewayCap`.
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (!net.gatewayUp) return new Response('', { status: 502 })
    const body = JSON.parse(String(init?.body ?? '{}')) as { kinds: number[]; authors: string[]; until?: number; limit?: number }
    const events = [...net.gateway, ...net.relay]
      .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
      .filter((e) => body.kinds.includes(e.kind) && body.authors.includes(e.pubkey))
      .filter((e) => body.until === undefined || e.created_at <= body.until)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, Math.min(body.limit ?? 100, net.gatewayCap))
      .map((e) => JSON.parse(JSON.stringify({ ...e, createdAt: e.created_at })))
    return new Response(JSON.stringify({ events }), { status: 200 })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const { openWallet, getWallet, wipeWallet, voucherWriteCount, addRestoredVoucher } = await import('../wallet')
const { confirmBackups } = await import('../voucherRecords')

const fast = { settleMs: 0, deadlineMs: 10_000 }
const settle = () => new Promise((r) => setTimeout(r, 50))
let seq = 0

async function tokenIdOf(token: string): Promise<string> {
  const { tokenIdFrom } = await import('../../../packages/wallet-storage/src/tokenId')
  return tokenIdFrom(token)
}

/** An owner-sealed record of `voucher` under `d`, signed by `signer`. */
function record(d: string, voucher: Record<string, unknown>, signer = sk, kind = 7375, at = 10): Event {
  const content = nip44.v2.encrypt(JSON.stringify({ voucher }), key)
  return finalizeEvent({ kind, created_at: at, tags: [['d', d], ['spent', 'false']], content }, signer)
}

/** Hold one coupon whose ONLY copy anywhere is what the test then puts there. */
async function holdOnly(row: Partial<VoucherRow>): Promise<{ id: string; token: string }> {
  net.relayDown = true
  net.gatewayUp = false
  const token = row.token ?? buildVoucherToken({ faceValue: 1100 }, [1000, 300 + seq]).token
  await getWallet().saveVoucher({ face_value: 1100, face_unit: 'GBP', status: 'active', ...row, token } as VoucherRow)
  await settle()
  net.relay = []
  net.gateway = []
  net.posted = []
  return { id: await tokenIdOf(token), token }
}

beforeEach(async () => {
  net.relay = []
  net.relayExtra = []
  net.relayDown = false
  net.gateway = []
  net.gatewayUp = true
  net.gatewayCap = 500
  net.posted = []
  net.locked = false
  seq++
  await openWallet(pk)
})
afterEach(async () => {
  await wipeWallet(pk).catch(() => undefined)
})

describe('a relay event is checked like a gateway one: author, kind, signature', () => {
  // The relay serves a record that WOULD match; re-publishing cannot help
  // (the relay accepts nothing, the gateway is down), so only the forged
  // record stands between "confirmed" and "not".
  async function onlyThis(forged: (id: string, token: string) => Event) {
    const { id, token } = await holdOnly({})
    net.relayDown = false
    net.relayExtra = [forged(id, token)]
    net.relay = []
    // Reads served, writes refused.
    const relay = await import('../relay')
    vi.spyOn(relay, 'publish').mockResolvedValue({ ok: 0, total: 1, errors: ['blocked'] })
    net.gatewayUp = false
    return confirmBackups(pk, fast)
  }

  it('the control: an honest record confirms', async () => {
    expect(await onlyThis((id, token) => record(id, { token_id: id, token, status: 'active' }))).toMatchObject({ ok: true })
  })

  it('another author, same sealed content: not confirmed', async () => {
    const other = generateSecretKey()
    expect(await onlyThis((id, token) => record(id, { token_id: id, token }, other))).toMatchObject({ ok: false })
  })

  it('another kind: not confirmed', async () => {
    expect(await onlyThis((id, token) => record(id, { token_id: id, token }, sk, 7376))).toMatchObject({ ok: false })
  })

  it('a signature that does not verify: not confirmed', async () => {
    expect(
      await onlyThis((id, token) => ({ ...record(id, { token_id: id, token }), sig: 'ab'.repeat(64) })),
    ).toMatchObject({ ok: false })
  })
})

describe('the backup must hold the same VALUE, not just the same token', () => {
  async function withOnly(held: Partial<VoucherRow>, backed: Record<string, unknown>) {
    const { id, token } = await holdOnly(held)
    net.relayDown = false
    net.relay = [record(id, { token_id: id, token, ...backed })]
    const relay = await import('../relay')
    vi.spyOn(relay, 'publish').mockResolvedValue({ ok: 0, total: 1, errors: ['blocked'] })
    return confirmBackups(pk, fast)
  }

  it('a fully_redeemed row is in scope, and a record of it as active is not its backup', async () => {
    const check = await withOnly({ status: 'fully_redeemed' }, { status: 'active' })
    expect(check).toMatchObject({ ok: false, unconfirmed: [expect.objectContaining({ status: 'fully_redeemed' })] })
  })

  it('a fully_redeemed row with no record at all is not confirmed', async () => {
    await holdOnly({ status: 'fully_redeemed' })
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: false })
  })

  it('swapped_to_sats with a DIFFERENT sats_token is not confirmation', async () => {
    const sats = buildVoucherToken({ faceValue: 0 }, [64, 900 + seq]).token
    const otherSats = buildVoucherToken({ faceValue: 0 }, [64, 950 + seq]).token
    const check = await withOnly(
      { status: 'swapped_to_sats', sats_token: sats, sats_amount: 64 } as Partial<VoucherRow>,
      { status: 'swapped_to_sats', sats_token: otherSats },
    )
    expect(check).toMatchObject({ ok: false })
  })

  it('swapped_to_sats with the same sats_token confirms (the control)', async () => {
    const sats = buildVoucherToken({ faceValue: 0 }, [64, 980 + seq]).token
    const check = await withOnly(
      { status: 'swapped_to_sats', sats_token: sats, sats_amount: 64 } as Partial<VoucherRow>,
      { status: 'swapped_to_sats', sats_token: sats },
    )
    expect(check).toMatchObject({ ok: true })
  })
})

describe('failures to check never read as confirmed', () => {
  it('an idle-locked key (signer kept, key zeroed) is LOCKED, not "check your connection"', async () => {
    await holdOnly({})
    net.relayDown = false
    net.gatewayUp = true
    net.locked = true
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: false, reason: 'locked', unconfirmed: [expect.anything()] })
  })

  it('a store that cannot be read is "unreadable", never "nothing held"', async () => {
    const wallet = await import('../wallet')
    vi.spyOn(wallet, 'openWallet').mockRejectedValueOnce(new Error('QuotaExceededError'))
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: false, reason: 'store-unreadable' })
  })
})

describe('the gateway mirror and paging', () => {
  it('relay unreachable: the re-publish lands in the gateway and is read back from there', async () => {
    await holdOnly({})
    net.relayDown = true
    net.gatewayUp = true
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: true })
    expect(net.posted.length).toBeGreaterThan(0)
  })

  it('a gateway that pages below the ask: a record past the first short page still confirms', async () => {
    const { id, token } = await holdOnly({})
    net.relayDown = true
    net.gatewayUp = true
    net.gatewayCap = 50
    // 120 newer records of other coupons, then ours, the oldest.
    for (let i = 0; i < 120; i++) net.gateway.push(record(`other-${i}`, { token_id: `other-${i}`, token: `cashuAx${i}` }, sk, 7375, 1000 + i))
    net.gateway.push(record(id, { token_id: id, token, status: 'active' }, sk, 7375, 5))
    // The relay is down and re-publish would also land in the gateway; refuse
    // that so the PAGED READ is the only way to find the record.
    const nip98 = await import('../nip98')
    vi.spyOn(nip98, 'signedFetch').mockResolvedValue(new Response('', { status: 503 }))
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: true })
  })
})

describe('restored writes move logout’s race counter', () => {
  it('addRestoredVoucher counts', async () => {
    const before = voucherWriteCount()
    await addRestoredVoucher({
      token: buildVoucherToken({ faceValue: 100 }, [64, 990 + seq]).token,
      face_value: 100,
      status: 'active',
    } as VoucherRow)
    expect(voucherWriteCount()).toBe(before + 1)
  })
})
