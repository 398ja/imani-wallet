import { describe, it, expect, vi, beforeEach } from 'vitest'

import { isMerchantPubkey } from '../merchant'
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
  it('is true for a live stall record, and asks the relay only once', async () => {
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

  it('is false once the stall is retired', async () => {
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
