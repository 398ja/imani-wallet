import { describe, expect, it, vi } from 'vitest'

import { SALES_ALLOWANCE_PATH, UPGRADE_PATH, salesAllowance } from '../salesAllowance'

function answering(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('salesAllowance (review of gc#317)', () => {
  it('asks the gateway for the caller’s own stall, in the sale’s unit', async () => {
    const fetchImpl = answering(200, { limited: false })
    await salesAllowance('gbp', fetchImpl as never)
    expect(fetchImpl).toHaveBeenCalledWith(`${SALES_ALLOWANCE_PATH}?unit=gbp`, 'GET')
  })

  it('reads a used-up Free plan as reached', async () => {
    const a = await salesAllowance('GBP', answering(200, {
      limited: true, unit: 'GBP', used_minor: 13300, allowance_minor: 10000, remaining_minor: 0, reached: true,
    }) as never)
    expect(a).toEqual({ kind: 'limited', unit: 'GBP', usedMinor: 13300, allowanceMinor: 10000, remainingMinor: 0, reached: true })
  })

  it('reads room left as not reached', async () => {
    const a = await salesAllowance('GBP', answering(200, {
      limited: true, unit: 'GBP', used_minor: 3000, allowance_minor: 10000, remaining_minor: 7000, reached: false,
    }) as never)
    expect(a.kind === 'limited' && a.reached).toBe(false)
  })

  it('reads a paid plan as unlimited', async () => {
    expect(await salesAllowance('GBP', answering(200, { limited: false }) as never)).toEqual({ kind: 'unlimited' })
  })

  it.each([
    ['a 503', answering(503, {})],
    ['a 401', answering(401, {})],
    ['a malformed answer', answering(200, { limited: true, used_minor: 'lots' })],
    ['a network failure', vi.fn(async () => { throw new TypeError('offline') })],
  ])('reads %s as unknown, never as reached', async (_label, fetchImpl) => {
    expect(await salesAllowance('GBP', fetchImpl as never)).toEqual({ kind: 'unknown' })
  })

  it('sends the owner to the subscription screen with the reason', () => {
    expect(UPGRADE_PATH).toBe('/settings/subscription?reason=sales-limit')
  })
})
