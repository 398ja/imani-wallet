/**
 * imani-wallet#204: a chunked coupon is never stranded between reassembly and
 * save.
 *
 * The failure, from two gate runs (rev-h1 "run 1", redeploy-4 diagnostic):
 * C reassembled a 2-piece coupon, started `/wallet/receive`, and the e2e's
 * `goto('/')` landed before the save. gateway-customer settled the escrow and
 * held it. After the reload every poll logged `holding chunk` for the same
 * transfer and the coupon never arrived, because `dmChunks` had written the
 * transfer's "completed" tombstone the moment the pieces DECODED. The same
 * tombstone also blocked every retry dm-poll deliberately leaves open without
 * any reload: a failed save, a deferral.
 *
 * Pinned end to end with the real pieces: dm-poll's `DmPollService`, the
 * wallet's dm-crypto adapter (real NIP-17 wraps of the Java sender's chunks),
 * the wallet's dm-poll storage adapter, and the classic `tokenRedemption.js`,
 * against a gateway double with gateway-customer 0.23.1's escrow semantics:
 * one receive per idempotency key, a HELD escrow redelivers its sealed fresh
 * token on a same-key replay, and an ack releases it.
 *
 * A "reload" drops every module and every in-memory object and keeps
 * localStorage and sessionStorage, as a browser does.
 *
 * @vitest-environment jsdom
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import javaChunks from './fixtures/java-encoded-chunks.json'
import { MockNostrdbAdapter } from '../../../packages/dm-poll/tests/mocks'
import type { GiftWrapEvent, RedemptionAdapter } from '@imani/dm-poll'

const signer = vi.hoisted(() => ({ privkey: '' as string, pubkey: '' as string }))
vi.mock('../nap', () => ({
  getSigner: () => ({
    get pubkey() {
      return signer.pubkey
    },
    withPrivkey<T>(borrow: (key: Uint8Array) => T): T {
      return borrow(hexToBytes(signer.privkey))
    },
  }),
}))

/** The wallet store dm-poll's adapter writes to after a redemption. */
const walletRows = vi.hoisted(() => ({ saved: [] as Array<{ token_id: string }> }))
vi.mock('../wallet', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getWallet: () => ({
    saveVoucher: async (row: { token_id: string }) => {
      walletRows.saved.push(row)
    },
  }),
}))

/** The config `startDmPoll` built, so the real service can be driven by hand. */
const captured = vi.hoisted(() => ({ config: undefined as Record<string, unknown> | undefined }))
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: (config: Record<string, unknown>) => {
    captured.config = config
    return { fetchRecentDms: async () => [], start: async () => {}, stop: () => {}, on: () => {} }
  },
}))

class FakeEventSource {
  static readonly CLOSED = 2
  readyState = 1
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

const REDEMPTION_SOURCE = readFileSync('shared/tokenRedemption.js', 'utf8')
const API_SOURCE = readFileSync('shared/api.js', 'utf8')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** The receive-key rule, from the real `shared/api.js`. */
function receiveKeyFn(): (fp: string | null) => string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = {}
  new Function('window', 'localStorage', 'GatewayConfig', 'fetch', 'NostrUtils', API_SOURCE)(
    w,
    localStorage,
    { relayUrl: 'wss://r', apiUrl: 'http://gw', gatewayUrl: 'http://gw' },
    async () => {
      throw new Error('no fetch')
    },
    { createNip98AuthHeader: async () => 'Nostr stub' },
  )
  return w.generateReceiveIdempotencyKey
}

/**
 * gateway-customer 0.23.1's receive escrow, as the wallet sees it.
 *
 * `/wallet/receive` is keyed: the first call swaps and HOLDS the fresh token
 * in a sealed escrow; a replay under the same key while HELD redelivers it
 * (`receive_idempotent_replay status=HELD token_redelivered=true`); once acked
 * a replay carries no token. `onReceive` lets a test kill the page between the
 * gateway settling and the response landing.
 */
class Gateway {
  escrows = new Map<string, { id: string; state: 'HELD' | 'ACKED' }>()
  receiveCalls = 0
  acks: string[] = []
  onReceive: (() => Promise<void>) | undefined

  api(pubkey: string) {
    return {
      _nostrPublicKey: pubkey,
      receive: async (_token: string, o: { idempotencyKey?: string | null }) => {
        this.receiveCalls += 1
        const key = o.idempotencyKey ?? `nokey-${this.receiveCalls}`
        let escrow = this.escrows.get(key)
        const replay = !!escrow
        if (!escrow) {
          escrow = { id: `rcv-${this.escrows.size + 1}`, state: 'HELD' }
          this.escrows.set(key, escrow)
        }
        await this.onReceive?.()
        return {
          receive_id: escrow.id,
          amount: 20000,
          token: escrow.state === 'HELD' ? 'cashuAfreshproofs' : null,
          imported_count: 1,
          unit: 'sat',
          idempotent_replay: replay || undefined,
        }
      },
      acknowledgeReceive: async (id: string) => {
        const escrow = [...this.escrows.values()].find((e) => e.id === id)
        if (!escrow || escrow.state !== 'HELD') {
          throw Object.assign(new Error('no such escrow'), { status: 404 })
        }
        escrow.state = 'ACKED'
        this.acks.push(id)
      },
    }
  }
}

/** What the wallet durably saved through `tokenRedemption` (the atomic write). */
interface Store {
  writes: unknown[]
  /** Set to make the next write fail or never finish. */
  next: 'ok' | 'throw' | 'hang'
}

/** One page load of the wallet. */
interface Session {
  service: import('@imani/dm-poll').DmPollService
  redemption: { flushUnacknowledgedEscrows(): Promise<number> }
  dmChunks: typeof import('../dmChunks')
}

const recipientSk = generateSecretKey()
const RECIPIENT = getPublicKey(recipientSk)

/** The two gift wraps the gateway sent for one coupon, through real NIP-17. */
function wrapsFor(chunks: unknown[]): GiftWrapEvent[] {
  const senderSk = generateSecretKey()
  return chunks.map(
    (chunk) =>
      nip17.wrapEvent(senderSk, { publicKey: RECIPIENT }, JSON.stringify(chunk)) as unknown as GiftWrapEvent,
  )
}

async function loadSession(
  relay: MockNostrdbAdapter,
  gateway: Gateway,
  store: Store,
  backing: () => { outcome: 'accept' } | { outcome: 'defer'; detail: string } = () => ({ outcome: 'accept' }),
): Promise<Session> {
  vi.resetModules()
  const dmPoll = await import('../dmPoll')
  const dmChunks = await import('../dmChunks')
  const { DmPollService } = await vi.importActual<typeof import('@imani/dm-poll')>('@imani/dm-poll')

  dmPoll.startDmPoll(RECIPIENT)
  const config = captured.config!

  const redemption = new Function(
    'api',
    'walletStorageIntegration',
    'localStorage',
    'ImaniDmPoll',
    'generateReceiveIdempotencyKey',
    'resolveDecimals',
    'TokenSecurity',
    `${REDEMPTION_SOURCE}; return TokenRedemption;`,
  )(
    gateway.api(RECIPIENT),
    {
      atomicallyWrite: async (w: { vouchers: unknown[] }) => {
        const mode = store.next
        store.next = 'ok'
        if (mode === 'throw') throw new Error('QuotaExceededError')
        if (mode === 'hang') return new Promise(() => {}) // the page dies here
        store.writes.push(...w.vouchers)
      },
    },
    localStorage,
    undefined,
    receiveKeyFn(),
    () => 2,
    { getFingerprint: async (t: string) => sha(t) },
  )

  const redemptionAdapter: RedemptionAdapter = {
    checkBacking: () => backing(),
    redeem: (token, options) =>
      redemption.redeem(token, {
        metadata: options?.metadata ?? {},
        source: 'dm-poll',
        skipDuplicateCheck: true,
      }),
  } as RedemptionAdapter

  const service = new DmPollService({
    ...(config as object),
    recipientPubkey: RECIPIENT,
    recipientPrivkey: '',
    nostrdbAdapter: relay,
    redemptionAdapter,
    enableUiNotifications: false,
    fetchRecentOnStart: false,
  } as never)
  // Loads the processed set from storage, as a page load does.
  await (service as unknown as { eventTracker: { load(): Promise<void> } }).eventTracker.load()
  return { service, redemption, dmChunks }
}

/** Let deferred (setTimeout 0) writes land, as they would before a reload. */
const settle = () => new Promise((r) => setTimeout(r, 5))

const PROCESSED_KEY = 'imani-wallet:dm-poll:processed'
const processed = (): string[] => JSON.parse(localStorage.getItem(PROCESSED_KEY) ?? '[]')

// Real NIP-17 decryption and a fresh module graph per simulated page load.
describe('a chunked coupon is saved and its escrow acked, whatever interrupts it (#204)', { timeout: 30_000 }, () => {
  let relay: MockNostrdbAdapter
  let gateway: Gateway
  let store: Store
  let wraps: GiftWrapEvent[]

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    walletRows.saved.length = 0
    signer.privkey = bytesToHex(recipientSk)
    signer.pubkey = RECIPIENT
    vi.stubGlobal('EventSource', FakeEventSource)
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      if (!process.env.DEBUG204) vi.spyOn(console, level).mockImplementation(() => {})
    }
    relay = new MockNostrdbAdapter()
    gateway = new Gateway()
    store = { writes: [], next: 'ok' }
    wraps = wrapsFor(javaChunks as unknown[])
    for (const w of wraps) relay.addEvent(w)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a reload between reassembly and save: the next load saves the coupon and acks the escrow once', async () => {
    // Page 1: the coupon reassembles, `/wallet/receive` settles at the gateway,
    // and the page is torn down before the save (the gate's `goto('/')`).
    const page1 = await loadSession(relay, gateway, store)
    store.next = 'hang'
    let settled!: () => void
    const receiveSettled = new Promise<void>((r) => (settled = r))
    gateway.onReceive = async () => settled()
    void page1.service.fetchRecentDms()
    await receiveSettled
    // The gate's own trace: a second catch-up re-offers both pieces while the
    // first is mid-redemption ("Event already in-flight", "holding chunk").
    await page1.service.fetchRecentDms()
    gateway.onReceive = undefined
    await settle()

    expect(gateway.receiveCalls).toBe(1)
    expect(store.writes).toHaveLength(0)
    expect(gateway.acks).toEqual([])

    // Page 2, after the reload. Before #204 every poll here logged "holding
    // chunk" and nothing else, for eight days.
    const page2 = await loadSession(relay, gateway, store)
    await page2.service.fetchRecentDms()
    await settle()

    expect(store.writes).toHaveLength(1)
    expect(walletRows.saved).toHaveLength(1)
    // Replayed under the same key, so the gateway settled ONE receive and
    // redelivered its held token. Acked exactly once.
    expect(gateway.escrows.size).toBe(1)
    expect(gateway.acks).toEqual(['rcv-1'])
    // The completing wrap is consumed; the sibling is released on the next
    // poll, so nothing is re-read forever.
    await page2.service.fetchRecentDms()
    await settle()
    expect(processed().sort()).toEqual(wraps.map((w) => w.id).sort())

    // A later load acks nothing more and saves nothing more.
    const page3 = await loadSession(relay, gateway, store)
    await page3.redemption.flushUnacknowledgedEscrows()
    await page3.service.fetchRecentDms()
    expect(gateway.acks).toEqual(['rcv-1'])
    expect(store.writes).toHaveLength(1)
  })

  it('replaying the same chunks after success creates no duplicate', async () => {
    const page1 = await loadSession(relay, gateway, store)
    await page1.service.fetchRecentDms()
    await settle()
    expect(store.writes).toHaveLength(1)

    // The same pieces, again: in this session, after a reload, and re-wrapped
    // by a sender that sent the transfer twice.
    await page1.service.fetchRecentDms()
    for (const w of wrapsFor(javaChunks as unknown[])) relay.addEvent(w)
    await page1.service.fetchRecentDms()
    await settle()
    const page2 = await loadSession(relay, gateway, store)
    await page2.service.fetchRecentDms()
    await page2.service.fetchRecentDms()
    await settle()

    expect(store.writes).toHaveLength(1)
    expect(walletRows.saved).toHaveLength(1)
    expect(gateway.receiveCalls).toBe(1)
    expect(gateway.acks).toEqual(['rcv-1'])
  })

  it('a failed save leaves the transfer retryable, and the retry saves it and acks once', async () => {
    const page = await loadSession(relay, gateway, store)
    store.next = 'throw'
    await page.service.fetchRecentDms()
    await settle()

    // Not saved, not acked, and NOT consumed: the gateway still holds it.
    expect(store.writes).toHaveLength(0)
    expect(gateway.acks).toEqual([])
    expect(processed()).toEqual([])

    // No reload. The next poll re-offers the completing wrap.
    await page.service.fetchRecentDms()
    await settle()

    expect(store.writes).toHaveLength(1)
    expect(gateway.escrows.size).toBe(1)
    expect(gateway.acks).toEqual(['rcv-1'])
  })

  it('without any reload, a redemption deferred on the first poll is received on the next', async () => {
    // A retryable non-success before the swap (here the backing gate, before
    // its trusted-mint list has loaded). dm-poll leaves the wrap unconsumed for
    // the next poll; the old decode-time tombstone then refused it.
    let deferred = true
    const page = await loadSession(relay, gateway, store, () =>
      deferred ? { outcome: 'defer', detail: 'trusted mints not loaded' } : { outcome: 'accept' },
    )
    await page.service.fetchRecentDms()
    await settle()
    expect(store.writes).toHaveLength(0)
    expect(gateway.receiveCalls).toBe(0)

    deferred = false
    await page.service.fetchRecentDms()
    await settle()

    expect(store.writes).toHaveLength(1)
    expect(gateway.acks).toEqual(['rcv-1'])
  })

  it('recovers a coupon an earlier build already stranded', async () => {
    // The device state the gate left behind: the transfer tombstoned under the
    // old key at decode time, no wrap processed, no coupon saved.
    const transferId = (javaChunks as Array<{ transfer_id: string }>)[0].transfer_id
    localStorage.setItem('imani-wallet:dm-chunks:completed', JSON.stringify([[transferId, Date.now()]]))

    const page = await loadSession(relay, gateway, store)
    await page.service.fetchRecentDms()
    await settle()

    expect(store.writes).toHaveLength(1)
    expect(gateway.acks).toEqual(['rcv-1'])
  })
})
