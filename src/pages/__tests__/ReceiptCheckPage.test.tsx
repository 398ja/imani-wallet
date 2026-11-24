/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { VerifyResult } from '../../lib/receipts/verify'

/**
 * The receipt check card (spec 049 US2-US4). The one headline is what the person at the till
 * acts on, so the order matters: a failed check or a mint that saw no collection must never be
 * dressed as "Paid to you", whatever else passed.
 */

let next: VerifyResult
const seen: string[] = []
const stalls: (string | undefined)[] = []
vi.mock('../../lib/receipts', () => ({
  verifyScanned: async (qr: string, forStall?: string) => (seen.push(qr), stalls.push(forStall), next),
}))

const { ReceiptCheckPage } = await import('../ReceiptCheckPage')

const SUMMARY = { amount: 1200, unit: 'sat', payee: 'aa'.repeat(32), payer: 'bb'.repeat(32), paidAt: 1_795_000_000, mints: ['https://mint.example'] }

function result(over: Partial<VerifyResult>): VerifyResult {
  return {
    verdict: 'verified',
    checks: [
      { check: 'PAYER_SIGNATURE', ok: true },
      { check: 'MINT_SIGNATURE_DLEQ', ok: true },
    ],
    summary: SUMMARY,
    presenter: 'PRESENTER_IS_PAYER',
    mint: 'confirmed',
    mine: 'neither',
    warnings: [],
    ...over,
  } as VerifyResult
}

function open(state: unknown) {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/receipt/check', state }]}>
      <Routes>
        <Route path="/receipt/check" element={<ReceiptCheckPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  seen.length = 0
  stalls.length = 0
})

describe('the receipt check card', () => {
  it('on a terminal: checks for the stall it acts for, and says "Paid to this stall"', async () => {
    next = result({ mine: 'payee', mint: 'confirmed' })
    render(
      <MemoryRouter initialEntries={[{ pathname: '/receipt/check', state: { qr: 'imrc1:x' } }]}>
        <Routes>
          <Route path="/receipt/check" element={<ReceiptCheckPage forStall={'aa'.repeat(32)} scanPath="/receipts/scan" />} />
        </Routes>
      </MemoryRouter>,
    )
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Paid to this stall')
    expect(screen.getByText('The mint confirms the stall collected this payment.')).toBeTruthy()
    expect(stalls).toEqual(['aa'.repeat(32)])
    expect(screen.getByRole('link', { name: /Scan/ }).getAttribute('href')).toBe('/receipts/scan')
  })

  it('in the owner app: checks as itself', async () => {
    next = result({ mine: 'payee', mint: 'confirmed' })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Paid to you')
    expect(stalls).toEqual([undefined])
  })

  it('shows the face value and never the signed sat amount', async () => {
    next = result({ mine: 'payee', records: 'found_in_records', face: { value: 500, unit: 'GBP', decimals: 2 } })
    open({ qr: 'imrc1:x' })
    expect(await screen.findByText('£5.00')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/sats?\b|1,?200/)
  })

  it('without a known face value it shows no amount, not sats', async () => {
    next = result({ mine: 'neither' })
    open({ qr: 'imrc1:x' })
    await screen.findByText('Valid, but not paid to you')
    expect(document.body.textContent).not.toMatch(/sats?\b|1,?200/)
  })

  it('a payee with the payment in its records reads "Paid to you"', async () => {
    next = result({ mine: 'payee', records: 'found_in_records' })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Paid to you')
    expect(seen).toEqual(['imrc1:x'])
  })

  it('invalid wins over everything, even the payee\'s own records', async () => {
    next = result({ verdict: 'invalid', mine: 'payee', records: 'found_in_records' })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Not a valid receipt')
    expect(document.querySelector('[data-tone="bad"]')).toBeTruthy()
  })

  it('a mint that saw no collection is "Payment not confirmed", not a valid receipt', async () => {
    next = result({ mint: 'not_valid', mine: 'payee' })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Payment not confirmed')
  })

  it('a valid receipt for someone else says so', async () => {
    next = result({ mine: 'neither' })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Valid, but not paid to you')
  })

  it('without the payee\'s countersignature it is not yet confirmed', async () => {
    next = result({ verdict: 'unacknowledged', mint: 'not_checked' })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Not yet confirmed by the payee')
  })

  it('a failed check shows as failed in the list', async () => {
    next = result({ verdict: 'invalid', checks: [{ check: 'EVIDENCE_DIGEST', ok: false }] })
    open({ qr: 'imrc1:x' })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByText('Proof matches receipt')).toBeTruthy()
    expect(screen.getByLabelText('Failed')).toBeTruthy()
  })

  it('opened without a scan, it asks for one and verifies nothing', async () => {
    open(null)
    expect(await screen.findByText('Scan a receipt code to check it.')).toBeTruthy()
    expect(seen).toEqual([])
  })
})
