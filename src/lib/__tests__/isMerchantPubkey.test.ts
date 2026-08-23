import { describe, it, expect, vi, beforeEach } from 'vitest'

import { isMerchantPubkey, merchantStatus } from '../merchant'
import { newestAddressable } from '../relay'

vi.mock('../relay', () => ({ newestAddressable: vi.fn() }))

const query = vi.mocked(newestAddressable)

/** A merchant record as it comes off the relay: the `d` tag is matched upstream. */
const record = (content: object) =>
  ({ content: JSON.stringify(content), created_at: 1000 }) as Awaited<
    ReturnType<typeof newestAddressable>
  >

// Distinct per case: the cache is module-level and deliberately survives calls.
let n = 0
const nextPubkey = () => String(++n).padStart(64, '0')

// Braces matter: an arrow returning the mock hands vitest a function, which it
// runs as this test's teardown — calling the mock after the test that made it
// throw, and failing that test with the error it was asserting is swallowed.
beforeEach(() => {
  query.mockReset()
})

describe('isMerchantPubkey', () => {
  it('is true for a live shop record, and asks the relay only once', async () => {
    const pubkey = nextPubkey()
    query.mockResolvedValue(record({ categories: ['food'] }))

    expect(await isMerchantPubkey(pubkey)).toBe(true)
    expect(await isMerchantPubkey(pubkey)).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('counts an unparseable record — publishing it is what makes you a merchant', async () => {
    query.mockResolvedValue(record('not an object' as unknown as object))
    expect(await isMerchantPubkey(nextPubkey())).toBe(true)
  })

  it('is false once the shop is retired', async () => {
    query.mockResolvedValue(record({ active: false }))
    expect(await isMerchantPubkey(nextPubkey())).toBe(false)
  })

  it('is false with no record, and DOES ask again — a miss is not cached', async () => {
    // The failure this guards: one lookup losing a race with login would
    // otherwise pin "not a merchant" on a real stall for the life of the page.
    const pubkey = nextPubkey()
    query.mockResolvedValue(null)

    expect(await isMerchantPubkey(pubkey)).toBe(false)
    query.mockResolvedValue(record({ categories: ['food'] }))
    expect(await isMerchantPubkey(pubkey)).toBe(true)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('never rejects when the relay is unreachable', async () => {
    query.mockRejectedValue(new Error('relay down'))
    await expect(isMerchantPubkey(nextPubkey())).resolves.toBe(false)
  })
})

describe('merchantStatus', () => {
  it('tells an unreachable relay apart from a key with no record', async () => {
    // The distinction the send guard is built on. Both used to read as
    // `false`, which is how a foreign coupon reached a merchant during an
    // outage — the guard saw "customer, anything goes".
    query.mockResolvedValue(null)
    expect(await merchantStatus(nextPubkey())).toBe('customer')

    query.mockRejectedValue(new Error('relay down'))
    expect(await merchantStatus(nextPubkey())).toBe('unknown')
  })

  it('does not cache an unknown, so the next send asks again', async () => {
    // Caching it would carry one bad moment for the life of the document,
    // refusing every third-party send long after the relay came back.
    const pubkey = nextPubkey()
    query.mockRejectedValue(new Error('relay down'))
    expect(await merchantStatus(pubkey)).toBe('unknown')

    query.mockResolvedValue(record({ categories: ['food'] }))
    expect(await merchantStatus(pubkey)).toBe('merchant')
    expect(query).toHaveBeenCalledTimes(2)
  })
})
