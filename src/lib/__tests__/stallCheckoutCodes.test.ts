/** #639: the wallet's read of whether a stall's shop takes new checkout codes. Fails open. */
import { describe, expect, it, vi } from 'vitest'
import { stallAcceptsNewCheckoutCodes, stallCheckoutCodesPath } from '../stallCheckoutCodes'

const STALL = 'Ab'.repeat(32)
const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch

describe('stallAcceptsNewCheckoutCodes', () => {
  it('asks the public route, unsigned, lower-case', async () => {
    const f = answer(200, { accepts_new: true })
    expect(await stallAcceptsNewCheckoutCodes(STALL, f)).toBe(true)
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`/api/v1/wallet/stalls/${'ab'.repeat(32)}/checkout-codes`)
    expect(url).toBe(stallCheckoutCodesPath(STALL))
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('passes a clear no through', async () => {
    expect(await stallAcceptsNewCheckoutCodes(STALL, answer(200, { accepts_new: false }))).toBe(false)
  })

  it.each([
    ['503 (licence store down)', answer(503, { code: 'FEATURE_CHECK_UNAVAILABLE' })],
    ['404 (an older gateway)', answer(404, '')],
    ['429', answer(429, '')],
    ['a malformed body', answer(200, { accepts_new: 'no' })],
    ['a body that is not JSON', answer(200, '<html>')],
    ['a network error', vi.fn(async () => { throw new TypeError('offline') }) as unknown as typeof fetch],
  ])('is unknown, never no, on %s', async (_label, f) => {
    expect(await stallAcceptsNewCheckoutCodes(STALL, f)).toBeNull()
  })

  it('does not ask for a key that is not 64 hex', async () => {
    const f = answer(200, { accepts_new: false })
    expect(await stallAcceptsNewCheckoutCodes('abc', f)).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })
})
