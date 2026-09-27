/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The sender's side of #94: two claim receipts for one €6 payment are ONE
 * bell row and one toast, ending at "€6.00 was claimed (2 of 2 vouchers)",
 * rather than two "€3.00 was claimed." lines.
 *
 * The inbox is real so the assertions are about what the bell would show.
 */

const SENDER = '35f7a28b6adc9a923686a4506a02cae0fcf634cb32f42675872a5bd07d67af47'
const REDEEMER = '315042c05c30c54877e48a3fdfa64ece0a44b860e8afba2831163b6dd336ac73'
const BUNDLE = '00112233445566778899aabbccddeeff'

/** Each receipt's plaintext, keyed by the ciphertext the fake gateway hands out. */
const plaintexts = new Map<string, unknown>()
vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: SENDER,
    nip44Decrypt: (_peer: string, cipher: string) => JSON.stringify(plaintexts.get(cipher)),
  }),
}))
vi.mock('../wallet', () => ({ recordCashAttestation: () => Promise.resolve() }))

const signedFetch = vi.fn<(path: string, method: string, body?: unknown) => Promise<Response>>(
  async () => new Response(null, { status: 200 }),
)
vi.mock('../nip98', () => ({
  signedFetch: (...args: Parameters<typeof signedFetch>) => signedFetch(...args),
}))

const toasts: Array<{ message: unknown; options?: Record<string, unknown> }> = []
vi.mock('sonner', () => ({
  toast: {
    success: (message: unknown, options?: Record<string, unknown>) => {
      toasts.push({ message, options })
      return 'id'
    },
  },
}))
vi.mock('../notifications/wants', () => ({ wantsInApp: () => true }))

const { runReceiptDrainTick, startPaymentReceipts, stopPaymentReceipts } = await import('../paymentReceiptDrain')
const { listNotifications, _resetInboxCacheForTests } = await import('../notifications/inbox')

function receipt(id: string, payload: Record<string, unknown>) {
  plaintexts.set('cipher-' + id, { v: 1, redeemedAt: 1789152856, ...payload })
  return {
    receiptId: id,
    ciphertextBase64: 'cipher-' + id,
    recipientPubkeyHex: REDEEMER,
    consumeToken: 'tok-' + id,
  }
}

const part = (index: number, extra: Record<string, unknown> = {}) => ({
  faceValue: 300,
  faceUnit: 'EUR',
  faceDecimals: 2,
  bundleId: BUNDLE,
  bundlePartIndex: index,
  bundlePartCount: 2,
  bundleTotal: 600,
  ...extra,
})

async function drain(...receipts: unknown[]) {
  signedFetch.mockImplementation(async (path: string) =>
    path.endsWith('/drain')
      ? new Response(JSON.stringify({ receipts, nonce: 'n', moreAvailable: false }), { status: 200 })
      : new Response(null, { status: 200 }),
  )
  await runReceiptDrainTick()
}

beforeEach(async () => {
  localStorage.clear()
  _resetInboxCacheForTests()
  toasts.length = 0
  plaintexts.clear()
  signedFetch.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // Starting runs a boot tick; point it at an empty queue first.
  signedFetch.mockResolvedValue(new Response(JSON.stringify({ receipts: [] }), { status: 200 }))
  startPaymentReceipts(SENDER)
  // Let the boot tick finish, or the test's own tick hits the single-flight guard.
  await vi.waitFor(() => expect(signedFetch).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
})
afterEach(() => {
  stopPaymentReceipts()
  vi.restoreAllMocks()
})

describe('claim receipts for one multi-coupon payment', () => {
  it('collapse into one row that ends at the full amount', async () => {
    await drain(receipt('r1', part(0)))
    let rows = listNotifications(SENDER)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toMatch(/3\.00 of €6\.00 claimed so far \(1 of 2 vouchers\)/)

    await drain(receipt('r2', part(1)))
    rows = listNotifications(SENDER)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'claimed:bundle:' + BUNDLE, readAt: null })
    expect(rows[0]!.body).toMatch(/6\.00 was claimed \(2 of 2 vouchers\)/)

    expect(new Set(toasts.map((t) => t.options?.id))).toEqual(new Set(['claimed-bundle-' + BUNDLE]))
  })

  it('say nothing new for a redelivered receipt', async () => {
    await drain(receipt('r1', part(0)))
    toasts.length = 0
    await drain(receipt('r1', part(0)))
    expect(toasts).toHaveLength(0)
    expect(listNotifications(SENDER)).toHaveLength(1)
  })

  it('count parts but do not sum a claim that came without a verified amount', async () => {
    await drain(receipt('r1', part(0)))
    await drain(receipt('r2', part(1, { faceValue: undefined })))
    expect(listNotifications(SENDER)[0]!.body).toBe('Your payment was claimed (2 of 2 vouchers).')
  })

  it('file a second receipt for an already-claimed part on its own rather than dropping it', async () => {
    await drain(receipt('r1', part(0)))
    await drain(receipt('r1b', part(0)))
    const ids = listNotifications(SENDER).map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining(['claimed:bundle:' + BUNDLE, 'r1b']))
    // And the bundle's own row says something did not match.
    const row = listNotifications(SENDER).find((r) => r.id === 'claimed:bundle:' + BUNDLE)!
    expect(row.body).toMatch(/did not match/)
  })

  it('keep the first declaration and flag a later one that disagrees', async () => {
    await drain(receipt('r1', part(0)))
    await drain(receipt('r2', part(1, { bundleTotal: 60_000, bundlePartCount: 9 })))
    const row = listNotifications(SENDER)[0]!
    expect(row.body).toMatch(/6\.00 was claimed \(2 of 2 vouchers\)\. Some parts/)
  })

  it('leave a receipt with no bundle exactly as before', async () => {
    await drain(receipt('solo', { faceValue: 600, faceUnit: 'EUR', faceDecimals: 2 }))
    const rows = listNotifications(SENDER)
    expect(rows).toEqual([expect.objectContaining({ id: 'solo', body: '€6.00 was claimed.' })])
  })
})
