import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event, EventTemplate } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import type { TransactionRow, VoucherRow } from '@imani/wallet-storage'

import { buildVoucherToken } from './voucherFixtures'

/**
 * Logout, then restore the key, then log in: the balance must come back.
 *
 * The staging incident this pins (2026-10-18, wallet 0.30.1): a customer
 * received £11 by DM, logged out (which deletes IndexedDB), restored the key
 * from a Google Drive backup and logged in. The history row came back; the
 * coupon did not, and the balance read 0.
 *
 * Read-only evidence from staging: the coupon's kind-7375 record WAS on the
 * relay, holding the post-swap token, with no tombstone and no chunks. But the
 * browser's direct websocket reads to strfry failed (12 sockets, 0 bytes,
 * closed 1006), and `restoreVouchers` read the relay ONLY (`allEvents`), so a
 * failed read was indistinguishable from "no coupons". `restoreTx` read
 * through `allAddressable`, which ALSO asks the gateway's `/nostr/query`,
 * which is why the history survived the same login.
 *
 * Real modules end to end: `openWallet`/`backUpWrites` on fake-indexeddb, the
 * real `publishVoucher`/`publishTx` with real NIP-44 and real signatures, the
 * real `restoreVouchers`/`restoreTx`. Faked: the relay (an in-memory strfry
 * that can be made unreachable from the "browser") and the gateway's
 * `/nostr/query` (which serves the same events), and the mint.
 */

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const key = nip44.v2.utils.getConversationKey(sk, pk)

const net = vi.hoisted(() => ({
  /** What the relay holds. */
  relay: [] as Event[],
  /** The browser cannot reach strfry (the staging failure). */
  relayDown: false,
  /** The relay serves reads but refuses every publish. */
  refuseWrites: false,
  /** The gateway's `/nostr/query` is reachable. */
  gatewayUp: true,
  /** Mint answer per token. Default UNSPENT. */
  mint: new Map<string, string>(),
  validations: 0,
}))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: pk,
    nip44Encrypt: (_to: string, plain: string) => nip44.v2.encrypt(plain, key),
    nip44Decrypt: (_from: string, cipher: string) => nip44.v2.decrypt(cipher, key),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
  }),
}))

vi.mock('../relay', async () => {
  const { newestByD } = await import('../gatewayNostr')
  const relayRead = async (author: string, kind: number) => {
    // nostr-tools' querySync RESOLVES [] when the socket never opens: it does
    // not throw. That is exactly what made the failure silent.
    if (net.relayDown) return []
    return net.relay.filter((e) => e.pubkey === author && e.kind === kind)
  }
  return {
    allEvents: relayRead,
    // relay.ts's own composition, over the faked relay read and the REAL
    // gateway read and merge.
    allEventsWithGateway: async (author: string, kind: number) => {
      const { gatewayEvents, unionWithGateway } = await import('../gatewayNostr')
      return unionWithGateway(await relayRead(author, kind), await gatewayEvents(author, kind), author, kind)
    },
    allAddressable: async (author: string, kind: number, prefix: string) => {
      const { gatewayEvents } = await import('../gatewayNostr')
      const match = (es: Event[]) =>
        es.filter((e) => e.tags.some(([n, v]) => n === 'd' && v?.startsWith(prefix)))
      return newestByD(match(await relayRead(author, kind)), match(await gatewayEvents(author, kind)))
    },
    publish: async (event: Event) => {
      if (net.relayDown || net.refuseWrites) return { ok: 0, total: 1, errors: ['connection failure'] }
      net.relay.push(event)
      return { ok: 1, total: 1, errors: [] }
    },
  }
})

vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({
    validateToken: async (token: string) => {
      net.validations++
      return { state: net.mint.get(token) ?? 'UNSPENT' }
    },
  }),
}))
vi.mock('../burn', () => ({ burnIfSelfIssued: vi.fn().mockResolvedValue(false) }))

// The gateway's `/nostr/query`, serving what the relay holds, as JSON (so no
// cached verification symbol survives, exactly as over the wire).
const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (!net.gatewayUp) return new Response('', { status: 502 })
    const body = JSON.parse(String(init?.body ?? '{}')) as { kinds: number[]; authors: string[] }
    const events = net.relay
      .filter((e) => body.kinds.includes(e.kind) && body.authors.includes(e.pubkey))
      .map((e) => JSON.parse(JSON.stringify({ ...e, createdAt: e.created_at })))
    return new Response(JSON.stringify({ events }), { status: 200 })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const { openWallet, getWallet, wipeWallet } = await import('../wallet')
const { restoreVouchers, backfillVouchers } = await import('../voucherRecords')
const { restoreTx } = await import('../txRecords')
const { spendable } = await import('../merchants')
const { toTransaction } = await import('../transactions')
const { validationStatus } = await import('../validationStatus')

let seq = 0
/** Let the fire-and-forget publishes in `backUpWrites` land. */
const settle = () => new Promise((r) => setTimeout(r, 50))

async function balance(): Promise<number> {
  return spendable(await getWallet().getAllVouchers()).reduce(
    (sum, row) => sum + Number(row.face_value ?? 0),
    0,
  )
}

/** The login sequence from App.tsx, the coupon and history halves. */
async function login(): Promise<void> {
  await openWallet(pk)
  await restoreVouchers(pk)
  await backfillVouchers(pk)
  await restoreTx(pk)
}

/** logout.ts's wipeWallet: the device copy is gone. */
async function logout(): Promise<void> {
  await settle()
  await wipeWallet(pk)
}

const VERIFIED = {
  signatureValid: true,
  legacyCanonical: false,
  signedFaceValue: 1100,
  cappedAtFaceValue: false,
  warrant: 'verified',
}

/**
 * The three receive paths, each ending as the store write it really makes.
 * The token written is the POST-SWAP token: every path swaps at the mint and
 * writes the fresh proofs, and the pre-swap token is SPENT.
 */
const PATHS: Record<string, (fresh: string) => Promise<void>> = {
  // tokenRedemption._persistRedeemed -> walletStorageIntegration.atomicallyWrite
  // (legacyBridge.installTokenIdFill strips token_id-less rows to this shape).
  'DM auto-receive (customer to customer)': async (fresh) => {
    await getWallet().atomicallyWrite({
      vouchers: [{ token: fresh, face_value: 1100, face_unit: 'GBP', face_decimals: 2, status: 'active' } as VoucherRow],
      transactions: [
        {
          id: `received:${await tokenIdOf(fresh)}`,
          type: 'received',
          direction: 'in',
          amount: 1100,
          unit: 'GBP',
          decimals: 2,
          timestamp: Date.now(),
          voucherId: 'v-dm',
          tokenId: await tokenIdOf(fresh),
          validation: VERIFIED,
        } as unknown as TransactionRow,
      ],
    })
  },
  // Card purchase delivered by purchase-issuer DM: the same dm-poll redeem,
  // then dm-poll's own StorageAdapter.saveVoucher (dmPoll.ts storageAdapter).
  'card-purchase DM from purchase-issuer': async (fresh) => {
    await getWallet().atomicallyWrite({
      vouchers: [{ token: fresh, face_value: 1100, face_unit: 'GBP', face_decimals: 2, status: 'active' } as VoucherRow],
    })
    await getWallet().saveVoucher({
      token_id: await tokenIdOf(fresh),
      token: fresh,
      face_value: 1100,
      face_unit: 'GBP',
      status: 'active',
    } as VoucherRow)
  },
  // giftLinks.claimGiftLink -> TokenRedemption.redeem(source 'gift_link') ->
  // the same atomicallyWrite.
  'gift link': async (fresh) => {
    await getWallet().atomicallyWrite({
      vouchers: [{ token: fresh, face_value: 1100, face_unit: 'GBP', source_transport: 'gift_link' } as unknown as VoucherRow],
    })
  },
}

async function tokenIdOf(token: string): Promise<string> {
  // The store's own rule (packages/wallet-storage/src/tokenId.ts), which the
  // package does not export: sha256(token)[:32].
  const { tokenIdFrom } = await import('../../../packages/wallet-storage/src/tokenId')
  return tokenIdFrom(token)
}

beforeEach(async () => {
  net.relay = []
  net.relayDown = false
  net.refuseWrites = false
  net.gatewayUp = true
  net.mint = new Map()
  net.validations = 0
  seq++
})

afterEach(async () => {
  await wipeWallet(pk).catch(() => undefined)
})

describe('logout then restore keeps the balance, on every receive path', () => {
  for (const [path, receive] of Object.entries(PATHS)) {
    it(`${path}: relay reachable`, async () => {
      await openWallet(pk)
      const fresh = buildVoucherToken({ faceValue: 1100 }, [1000, 100 + seq]).token
      await receive(fresh)
      expect(await balance()).toBe(1100)

      await logout()
      await login()

      expect(await balance()).toBe(1100)
    })

    it(`${path}: browser cannot reach the relay, gateway can (the staging incident)`, async () => {
      await openWallet(pk)
      const fresh = buildVoucherToken({ faceValue: 1100 }, [1000, 200 + seq]).token
      await receive(fresh)
      await logout()

      net.relayDown = true
      await login()

      expect(await balance()).toBe(1100)
    })
  }
})

describe('restore never silently drops a coupon the history says was received', () => {
  it('keeps a coupon the mint calls SPENT when no tombstone says this wallet spent it, flagged', async () => {
    await openWallet(pk)
    const fresh = buildVoucherToken({ faceValue: 1100 }, [1000, 300 + seq]).token
    await PATHS['DM auto-receive (customer to customer)'](fresh)
    await logout()

    // A mint answer the wallet has no record of causing. The old restore
    // dropped the coupon on this alone, without a trace.
    net.mint.set(fresh, 'SPENT')
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await login()

    const rows = await getWallet().getAllVouchers()
    expect(rows).toHaveLength(1)
    // Kept, not dropped; marked as not-money, with the reason on the row.
    expect(rows[0]?.status).toBe('spent')
    expect((rows[0] as { restore_flag?: string }).restore_flag).toBe('mint-spent-without-tombstone')
    // Not money until resolved: it must not inflate the balance either.
    expect(await balance()).toBe(0)
    expect(warn).toHaveBeenCalled()

    // And a second login does not turn it back into money from the relay's
    // `active` copy.
    await restoreVouchers(pk)
    expect(await balance()).toBe(0)
    warn.mockRestore()
  })

  it('still drops a coupon this wallet tombstoned', async () => {
    await openWallet(pk)
    const fresh = buildVoucherToken({ faceValue: 1100 }, [1000, 400 + seq]).token
    await PATHS['gift link'](fresh)
    await settle()
    await getWallet().removeVoucher(await tokenIdOf(fresh))
    await logout()

    net.mint.set(fresh, 'SPENT')
    await login()

    expect(await getWallet().getAllVouchers()).toHaveLength(0)
  })
})

describe('a coupon swapped back to sats restores as it was (review of #326)', () => {
  it('keeps status swapped_to_sats and the sats_token, without asking the mint about the spent original', async () => {
    await openWallet(pk)
    const original = buildVoucherToken({ faceValue: 1100 }, [1000, 900 + seq]).token
    const satsToken = buildVoucherToken({ faceValue: 0 }, [64, 8 + seq]).token
    // swapBack.keepSats: the coupon's own proofs are SPENT by the swap back,
    // and its value now lives in `sats_token`.
    await getWallet().saveVoucher({
      token: original,
      face_value: 1100,
      face_unit: 'GBP',
      status: 'swapped_to_sats',
      sats_token: satsToken,
      sats_amount: 72 + seq,
    } as unknown as VoucherRow)
    await logout()

    net.mint.set(original, 'SPENT')
    await login()

    const rows = await getWallet().getAllVouchers()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('swapped_to_sats')
    expect((rows[0] as { sats_token?: string }).sats_token).toBe(satsToken)
    expect((rows[0] as { restore_flag?: string }).restore_flag).toBeUndefined()
    // The original token is spent by design: asking the mint is what flipped it.
    expect(net.validations).toBe(0)
  })
})

describe('restored history keeps its checks', () => {
  it('a verified receive still reads verified after logout and restore', async () => {
    await openWallet(pk)
    const fresh = buildVoucherToken({ faceValue: 1100 }, [1000, 500 + seq]).token
    await PATHS['DM auto-receive (customer to customer)'](fresh)
    await logout()
    await login()

    const rows = (await getWallet().getAllTransactions()).map(toTransaction)
    expect(rows).toHaveLength(1)
    expect(validationStatus(rows[0]!.validation)).toBe('verified')
  })
})

describe('confirmBackups: logout needs every held voucher READ BACK with the same token (owner rule 2026-10-18)', () => {
  const fast = { settleMs: 0, deadlineMs: 10_000 }

  it('confirms once the post-swap record is readable back', async () => {
    const { confirmBackups } = await import('../voucherRecords')
    await openWallet(pk)
    await PATHS['gift link'](buildVoucherToken({ faceValue: 1100 }, [1000, 600 + seq]).token)
    await settle()
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: true, confirmed: 1 })
  })

  it('relay AND gateway down: not confirmed, with the value, and nothing erased', async () => {
    const { confirmBackups } = await import('../voucherRecords')
    await openWallet(pk)
    const fresh = buildVoucherToken({ faceValue: 1100 }, [1000, 700 + seq]).token
    await PATHS['gift link'](fresh)
    await settle()
    net.relayDown = true
    net.gatewayUp = false
    const check = await confirmBackups(pk, fast)
    expect(check).toMatchObject({ ok: false, reason: 'unconfirmed' })
    expect(!check.ok && check.unconfirmed).toEqual([
      expect.objectContaining({ face_value: 1100, face_unit: 'GBP' }),
    ])
    // The UI gets no token.
    expect(JSON.stringify(check)).not.toContain(fresh)
    expect(await balance()).toBe(1100)
  })

  it('a backup holding an OLDER token (pre-swap) is not confirmation', async () => {
    const { confirmBackups } = await import('../voucherRecords')
    await openWallet(pk)
    const old = buildVoucherToken({ faceValue: 1100 }, [1000, 750 + seq]).token
    const fresh = buildVoucherToken({ faceValue: 1100 }, [1000, 760 + seq]).token
    // A record of the old token under the fresh coupon's `d`, signed by the
    // owner: published, readable, decryptable, and WRONG.
    await getWallet().saveVoucher({ token: fresh, face_value: 1100, face_unit: 'GBP', status: 'active' } as VoucherRow)
    await settle()
    const id = await tokenIdOf(fresh)
    net.relay = net.relay.filter((e) => e.kind !== 7375)
    const content = nip44.v2.encrypt(JSON.stringify({ voucher: { token_id: id, token: old, face_value: 1100 } }), key)
    net.relay.push(finalizeEvent({ kind: 7375, created_at: 10, tags: [['d', id], ['spent', 'false']], content }, sk))
    // Readable, but re-publishing cannot fix it: the relay refuses writes and
    // the gateway is down, so the only record anywhere is the stale one.
    net.refuseWrites = true
    net.gatewayUp = false
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: false, reason: 'unconfirmed' })
    // Once a write lands, the current token is read back and it confirms.
    net.refuseWrites = false
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: true })
  })

  it('re-publishes a missing record and then confirms it by reading it back', async () => {
    const { confirmBackups } = await import('../voucherRecords')
    await openWallet(pk)
    net.relayDown = true
    await PATHS['DM auto-receive (customer to customer)'](
      buildVoucherToken({ faceValue: 1100 }, [1000, 800 + seq]).token,
    )
    await settle()
    expect(net.relay.filter((e) => e.kind === 7375)).toHaveLength(0)

    net.relayDown = false
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: true })
    expect(net.relay.filter((e) => e.kind === 7375)).toHaveLength(1)
  })

  it('a record forged by another key, served by the gateway, is not confirmation', async () => {
    const { confirmBackups } = await import('../voucherRecords')
    await openWallet(pk)
    const fresh = buildVoucherToken({ faceValue: 1100 }, [1000, 850 + seq]).token
    net.relayDown = true
    await getWallet().saveVoucher({ token: fresh, face_value: 1100, face_unit: 'GBP', status: 'active' } as VoucherRow)
    await settle()
    // Same `d`, same sealed content shape, wrong author.
    const other = generateSecretKey()
    const content = nip44.v2.encrypt(JSON.stringify({ voucher: { token_id: await tokenIdOf(fresh), token: fresh } }), key)
    net.relay.push(finalizeEvent({ kind: 7375, created_at: 10, tags: [['d', await tokenIdOf(fresh)]], content }, other))
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: false })
  })

  it('a swapped_to_sats row needs its sats_token backed up, not just the spent original', async () => {
    const { confirmBackups } = await import('../voucherRecords')
    await openWallet(pk)
    const original = buildVoucherToken({ faceValue: 1100 }, [1000, 870 + seq]).token
    await getWallet().saveVoucher({ token: original, face_value: 1100, face_unit: 'GBP', status: 'fully_redeemed' } as VoucherRow)
    await settle()
    // The swap back lands while the relay refuses: only the fully_redeemed
    // record is out there.
    net.relayDown = true
    const sats = buildVoucherToken({ faceValue: 0 }, [64, 870 + seq]).token
    await getWallet().saveVoucher({
      token: original, face_value: 1100, face_unit: 'GBP', status: 'swapped_to_sats', sats_token: sats, sats_amount: 64,
    } as unknown as VoucherRow)
    await settle()
    net.gatewayUp = false
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: false, unconfirmed: [expect.objectContaining({ status: 'swapped_to_sats', sats_amount: 64 })] })
    net.relayDown = false
    expect(await confirmBackups(pk, fast)).toMatchObject({ ok: true })
  })

  it('opens the store to count when it is not open: "nothing open" is not "nothing held"', async () => {
    const { confirmBackups } = await import('../voucherRecords')
    await openWallet(pk)
    net.relayDown = true
    await PATHS['gift link'](buildVoucherToken({ faceValue: 1100 }, [1000, 880 + seq]).token)
    await settle()
    // The handle is someone else's (an account switch, or no wallet opened
    // yet behind the "Session expired" dialog); this user's DB is on disk.
    await openWallet('ee'.repeat(32))
    net.gatewayUp = false
    const check = await confirmBackups(pk, fast)
    expect(check).toMatchObject({ ok: false, reason: 'unconfirmed' })
    expect(!check.ok && check.unconfirmed).toHaveLength(1)
    await wipeWallet('ee'.repeat(32))
  })

  it('never hangs: a gateway that never answers is bounded by the deadline', async () => {
    const { confirmBackups } = await import('../voucherRecords')
    await openWallet(pk)
    net.relayDown = true
    await PATHS['gift link'](buildVoucherToken({ faceValue: 1100 }, [1000, 890 + seq]).token)
    await settle()
    globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch
    const started = Date.now()
    const check = await confirmBackups(pk, { settleMs: 0, deadlineMs: 600 })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(check.ok).toBe(false)
  })
})

describe('a gateway copy is trusted only when it is signed by the owner', () => {
  it('ignores a forged gateway event', async () => {
    const { unionWithGateway } = await import('../gatewayNostr')
    const other = generateSecretKey()
    const genuine = finalizeEvent({ kind: 7375, created_at: 1, tags: [['d', 'x']], content: 'c' }, sk)
    const foreign = finalizeEvent({ kind: 7375, created_at: 1, tags: [['d', 'y']], content: 'c' }, other)
    const tampered = JSON.parse(JSON.stringify({ ...genuine, id: 'ff'.repeat(32), content: 'evil' })) as Event
    const wrongKind = finalizeEvent({ kind: 7376, created_at: 1, tags: [['d', 'z']], content: 'c' }, sk)

    const merged = unionWithGateway([], [JSON.parse(JSON.stringify(genuine)), foreign, tampered, wrongKind], pk, 7375)
    expect(merged.map((e) => e.id)).toEqual([genuine.id])
  })
})
