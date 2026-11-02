/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

/**
 * 2026-11-02, staging: a €6 code was made, used twice at the shop, and the wallet said "No code was
 * made. Your vouchers come back on their own".
 *
 * The page making the code and dm-poll's catch-up (`reconcileCheckoutCodes`) ran the same `locking`
 * record at once: every lock and every refund deposit went to the gateway twice, ~30 ms apart, and
 * both runs deposited at 12:52:01. The store issued the code to one (201) and refused the other
 * `DUPLICATE_PART` (422), and the refused run's `abandoned` save, from its own copy of the record,
 * overwrote the issued one.
 *
 * These tests drive the real flow against `cashlinkWorld` (a mint that really signs, the gateway's
 * lock and relay rules, a store that refuses a locked proof backing a second code, and reads the
 * idempotency key before it verifies, as the real one does).
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const flow = await import('../checkoutCodeFlow')
const records = await import('../checkoutCodeRecords')
const { parseVoucherToken, creditableFaceValue } = await import('../voucherToken')
const W = await import('./cashlinkWorld')
await W.loadTokenReader()

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)
const S = 'd4'.repeat(32)
const SHOP = { url: 'https://shop.example', redeemKey: S, platform: 'woocommerce' as const, since: 1 }

let w: ReturnType<typeof W.world>
let store: InstanceType<typeof W.FakeCodeStore>
let ports: import('../checkoutCodeFlow').CheckoutPorts

function coupon(amounts: number[], nonce: string) {
  const proofs = amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: nonce.padEnd(8, 'n') }, `${nonce}${n}`), a))
  const token = W.tokenOf(proofs)
  const faceValue = creditableFaceValue(parseVoucherToken(token)).faceValue
  return { tokenId: `row-${nonce}`, token, amount: faceValue, faceValue }
}

const plan = (parts: ReturnType<typeof coupon>[]) => ({
  ports,
  pubkey: ME,
  stall: W.STALL,
  shop: SHOP,
  unit: 'GBP',
  decimals: 2,
  amount: parts.reduce((n, p) => n + p.amount, 0),
  x: X,
  parts,
})

const only = () => records.loadCheckoutCodes(ME)[0]
const lockCalls = () => w.gateway.calls.filter((c) => c.path.endsWith('/cashlink/lock')).length
const deposits = () => store.calls.filter((c) => c.path === '/v1/checkout-codes' && c.method === 'POST').length

/** Write a `locking` record the way `startCheckoutCode` does, without running it. */
async function planned(parts: ReturnType<typeof coupon>[]): Promise<string> {
  // Down for the moment of the start, so the start itself stops at once; the record is written first.
  const { identitySecret } = ports
  ports.identitySecret = () => null
  const out = await flow.startCheckoutCode(plan(parts))
  ports.identitySecret = identitySecret
  expect(out.kind).toBe('pending')
  expect(only().status).toBe('locking')
  return out.record.id
}

beforeEach(() => {
  w = W.world(NOW)
  store = new W.FakeCodeStore(w.mint)
  localStorage.clear()
  ports = {
    ...w.ports,
    store,
    identitySecret: () => Uint8Array.from(ID),
    carve: async () => {
      throw new Error('no split in this test')
    },
    consume: async () => {},
    activity: async () => {},
  }
})

describe('one run per code (2026-11-02)', () => {
  it('the page and the catch-up together: one code, each proof locked once, the record says issued', async () => {
    const id = await planned([coupon([64], 'a'), coupon([32, 16], 'b')])
    const page = flow.runCheckoutCode(ports, ME, id)
    const catchUp = flow.reconcileCheckoutCodes(ports, ME)
    const [out] = await Promise.all([page, catchUp])
    expect(out.kind).toBe('issued')
    expect(only()).toMatchObject({ status: 'reserved', code: expect.stringMatching(/^IMANI/) })
    expect(store.codes.size).toBe(1)
    // One deposit, and one real lock (plus its dry run) per proof: nothing ran twice.
    expect(deposits()).toBe(1)
    expect(lockCalls()).toBe(2 * 3)
  })

  it('two runs of one record at once queue: the second finds it issued and changes nothing', async () => {
    const id = await planned([coupon([64], 'a')])
    const [a, b] = await Promise.all([flow.runCheckoutCode(ports, ME, id), flow.runCheckoutCode(ports, ME, id)])
    expect([a.kind, b.kind]).toEqual(['issued', 'issued'])
    expect(a.record.code).toBe(b.record.code)
    expect(deposits()).toBe(1)
    expect(only().status).toBe('reserved')
  })

  it('a stale copy deposited again after the code was issued gets the same code back, never "no code"', async () => {
    // Two copies of the record, as two unsynchronised runs held them on staging.
    const id = await planned([coupon([64], 'a')])
    await flow.runCheckoutCode(ports, ME, id)
    const issued = only()
    expect(issued.status).toBe('reserved')
    // A stale copy from before the deposit answered, as the losing run held it.
    const stale = { ...issued, status: 'depositing' as const, code: undefined, codeHash: undefined }
    delete stale.code
    delete stale.codeHash
    records.saveCheckoutCode(ME, stale)
    // Its deposit replays by the idempotency key: the record gets its code back.
    const out = await flow.runCheckoutCode(ports, ME, id)
    expect(out.kind).toBe('issued')
    expect(only().code).toBe(issued.code)
  })

  it('a DUPLICATE_PART refusal is never "no code": pending, and the record keeps every part locked', async () => {
    const id = await planned([coupon([64], 'a')])
    store.nextDeposit = { status: 422, body: { refusal: 'DUPLICATE_PART', part: 0 } }
    const out = await flow.runCheckoutCode(ports, ME, id)
    expect(out.kind).toBe('pending')
    expect(only().status).toBe('depositing')
    expect(only().parts.every((p) => p.state === 'locked' && p.lockedToken)).toBe(true)
    // The next pass gets the code.
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only()).toMatchObject({ status: 'reserved', code: expect.stringMatching(/^IMANI/) })
  })

  it('a notice and a run of one code do not interleave: the notice waits, then sees the issued record', async () => {
    const id = await planned([coupon([64], 'a')])
    let release!: () => void
    store.onDeposit = () => new Promise<void>((r) => (release = r))
    const run = flow.runCheckoutCode(ports, ME, id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    // A pass starts while the run is mid-deposit: it must wait for it.
    let passDone = false
    const pass = flow.reconcileCheckoutCodes(ports, ME).then(() => (passDone = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(passDone).toBe(false)
    store.onDeposit = undefined
    release()
    await run
    await pass
    expect(deposits()).toBe(1)
    expect(only().status).toBe('reserved')
  })
})

describe('the record already saved as "No code was made" (the user\'s, 2026-11-02)', () => {
  /** The state on the user's phone: locked parts, refused `DUPLICATE_PART`, the code on the store. */
  async function wronglyAbandoned(): Promise<{ id: string; code: string }> {
    const id = await planned([coupon([64], 'a'), coupon([32], 'b')])
    await flow.runCheckoutCode(ports, ME, id)
    const r = only()
    const code = r.code!
    records.saveCheckoutCode(ME, { ...r, status: 'abandoned', refusal: 'DUPLICATE_PART', code: undefined, codeHash: undefined, amount: r.amount, remaining: undefined, redemptions: undefined })
    const saved = only()
    delete saved.code
    delete saved.codeHash
    records.saveCheckoutCode(ME, saved)
    expect(only()).toMatchObject({ status: 'abandoned', refusal: 'DUPLICATE_PART' })
    expect(only().code).toBeUndefined()
    return { id, code }
  }

  it('the next pass gives it its code back (the store replays the same key), and follows it from there', async () => {
    const { code } = await wronglyAbandoned()
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only()).toMatchObject({ status: 'reserved', code })
    expect(only().refusal).toBeUndefined()
    expect(store.codes.size).toBe(1)
    // And once the shop has used it, `/mine` takes it on as for any code.
    store.byCode(code)!.status = 'redeemed'
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only()).toMatchObject({ status: 'redeemed', done: true })
  })

  it('found on /mine by its idempotency key when the replay is refused', async () => {
    const { code } = await wronglyAbandoned()
    // A second run's tokens carry other DLEQs: the same key with another body.
    store.nextDeposit = { status: 409, body: { refusal: 'IDEMPOTENCY_KEY_REUSED' } }
    store.mineNamesKeys = true
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only()).toMatchObject({ status: 'reserved', code })
  })

  it('found on /mine by its exact terms from a store that does not name keys', async () => {
    const { code } = await wronglyAbandoned()
    store.nextDeposit = { status: 409, body: { refusal: 'IDEMPOTENCY_KEY_REUSED' } }
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only()).toMatchObject({ status: 'reserved', code })
  })

  it('never takes a code that is not its own: with other terms it is not adopted, and keeps retrying the deposit', async () => {
    const { code } = await wronglyAbandoned()
    // The store's copy is for another amount now (as if another record's): no match.
    store.byCode(code)!.body = { ...store.byCode(code)!.body, amount: 1 }
    store.nextDeposit = { status: 409, body: { refusal: 'IDEMPOTENCY_KEY_REUSED' } }
    await flow.reconcileCheckoutCodes(ports, ME)
    // Still "being made", never another record's code; at `x` the parts come back as for any code.
    expect(only().status).toBe('depositing')
    expect(only().code).toBeUndefined()
  })

  it('two codes that fit equally: neither is taken', async () => {
    const { code } = await wronglyAbandoned()
    const twin = { ...store.byCode(code)!, code: 'IMANI-TWIN0-00000-0' }
    store.codes.set('another-key', { ...twin, code: (await import('../checkoutCode')).display('IMANI99999999999' + (await import('../checkoutCode')).checkSymbol('99999999999')) })
    store.nextDeposit = { status: 409, body: { refusal: 'IDEMPOTENCY_KEY_REUSED' } }
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only().code).toBeUndefined()
  })

  it('a real refusal (nothing on the store) stays "no code": only DUPLICATE_PART is retried', async () => {
    const id = await planned([coupon([64], 'a')])
    store.nextDeposit = { status: 422, body: { refusal: 'WRONG_ISSUER', part: 0 } }
    const out = await flow.runCheckoutCode(ports, ME, id)
    expect(out.kind).toBe('abandoned')
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only()).toMatchObject({ status: 'abandoned', refusal: 'WRONG_ISSUER' })
    expect(store.codes.size).toBe(0)
  })
})
