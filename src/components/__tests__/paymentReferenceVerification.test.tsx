/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PaymentReferenceBlock } from '../PaymentReference'
import { __resetReferenceVerificationCache } from '../../lib/referenceVerification'

const PI = 'pi_3PqRsTuVwXyZ'

function serverSays(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })))
}

async function renderBlock() {
  render(<PaymentReferenceBlock reference={PI} amount="$15.00" date="1 Nov" />)
  // The reference is on screen before Stripe answers: never blocked.
  expect(screen.getByText(PI)).toBeTruthy()
  await act(async () => {})
  return screen.getByTestId('reference-verification').getAttribute('data-state')
}

describe('PaymentReferenceBlock verification', () => {
  beforeEach(() => __resetReferenceVerificationCache())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows a checkmark for a verified reference', async () => {
    serverSays(200, { result: 'verified' })
    expect(await renderBlock()).toBe('verified')
    expect(screen.getByText(/^Genuine:/)).toBeTruthy()
  })

  it('warns for a reference not on the account', async () => {
    serverSays(200, { result: 'not_found' })
    expect(await renderBlock()).toBe('failed')
    expect(screen.getByText(/^Not found on your Stripe account\./)).toBeTruthy()
  })

  it('stays neutral when the check cannot be made', async () => {
    serverSays(502, {})
    expect(await renderBlock()).toBe('unknown')
    expect(screen.getByText(/^Could not check with Stripe right now/)).toBeTruthy()
  })

  it.each([
    ['refunded', /^Refunded on Stripe\./],
    ['disputed', /^Disputed on Stripe\./],
  ])('shows an amber, non-genuine state for %s', async (result, sentence) => {
    serverSays(200, { result, refunded_minor: 500 })
    expect(await renderBlock()).toBe(result)
    const mark = screen.getByTestId('reference-verification')
    expect(mark.getAttribute('class')).toContain('text-amber-600')
    expect(mark.getAttribute('aria-label')).toBe(result === 'refunded' ? 'Refunded on Stripe' : 'Disputed on Stripe')
    const line = screen.getByText(sentence)
    expect(line.textContent).toMatch(/voucher was still issued/)
    expect(line.textContent).toMatch(/not handled automatically/)
    expect(line.getAttribute('class')).toContain('text-amber-600')
  })

  it('keeps unknown grey, never red', async () => {
    serverSays(429, {})
    expect(await renderBlock()).toBe('unknown')
    const mark = screen.getByTestId('reference-verification')
    expect(mark.getAttribute('class')).toContain('text-mono-500')
    expect(mark.getAttribute('class')).not.toContain('red')
  })
})
