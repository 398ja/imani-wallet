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
vi.mock('../../lib/receipts', async () => ({
  // The real predicate, so the card's "paid" and the remembered check use one rule.
  isPaidToMe: (await import('../../lib/receipts/verify')).isPaidToMe,
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

  /**
   * Regression (review of 72de4e6c): spent at the mint only proves SOMEONE spent the proofs. With
   * no countersignature and no lock to the payee, the payer may have spent them elsewhere, so
   * neither the owner nor a till may be told it was paid to them.
   */
  it.each([
    ['the owner', undefined, 'Paid to you'],
    ['a till', 'aa'.repeat(32), 'Paid to this stall'],
  ])('for %s, spent but unacknowledged is never "Paid to"', async (_who, forStall, paid) => {
    next = result({ verdict: 'unacknowledged', mine: 'payee', mint: 'confirmed' })
    render(
      <MemoryRouter initialEntries={[{ pathname: '/receipt/check', state: { qr: 'imrc1:x' } }]}>
        <Routes>
          <Route path="/receipt/check" element={<ReceiptCheckPage forStall={forStall} />} />
        </Routes>
      </MemoryRouter>,
    )
    const h = (await screen.findByRole('heading', { level: 1 })).textContent
    expect(h).not.toBe(paid)
    expect(h).toBe('Not yet confirmed by the payee')
  })

  it('summary only, even for the payee, is never "Paid to"', async () => {
    next = result({ verdict: 'verified_summary_only', mine: 'payee', mint: 'not_checked' })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Partly checked')
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

/**
 * Spec 049 FR-027b/e/f: a receipt already checked. The verdict stays, the top area and its tick
 * turn grey so staff notice, and the line says when and by whom, in the viewer's words.
 */
describe('already checked (FR-027b)', () => {
  const AT = 1_795_003_600
  const when = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(AT * 1000))
  const paid = (over: Partial<VerifyResult>) => result({ mine: 'payee', records: 'found_in_records', ...over })

  it('first check: green, no "Already checked"', async () => {
    next = paid({ priorChecks: [] })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Paid to you')
    expect(document.querySelector('[data-tone="good"]')).toBeTruthy()
    expect(screen.queryByText(/Already checked/)).toBeNull()
  })

  it('a repeat: grey top area and grey tick, the verdict kept, when and by which till', async () => {
    next = paid({ priorChecks: [{ at: AT, by: { kind: 'named_till', name: 'Till 2' } }] })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Paid to you')
    const card = document.querySelector('[data-tone="checked"]') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.className).toMatch(/bg-mono-/)
    expect(card.className).not.toMatch(/green/)
    const tick = card.querySelector('svg') as SVGElement
    expect(tick.getAttribute('class')).toMatch(/text-mono-/)
    expect(tick.getAttribute('class')).not.toMatch(/green/)
    expect(screen.getByText(`Already checked ${when} by Till 2`)).toBeTruthy()
  })

  it('on a till: "another till", "the owner" or "this till", never a colleague’s name', async () => {
    next = paid({
      records: undefined,
      mint: 'confirmed',
      priorChecks: [
        { at: AT, by: { kind: 'another_till' } },
        { at: AT + 60, by: { kind: 'owner' } },
        { at: AT + 120, by: { kind: 'this_device' } },
      ],
    })
    render(
      <MemoryRouter initialEntries={[{ pathname: '/receipt/check', state: { qr: 'imrc1:x' } }]}>
        <Routes>
          <Route path="/receipt/check" element={<ReceiptCheckPage forStall={'aa'.repeat(32)} />} />
        </Routes>
      </MemoryRouter>,
    )
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Paid to this stall')
    // The first check leads; the rest are counted, then listed below.
    expect(screen.getByText(`Already checked ${when} on another till`)).toBeTruthy()
    expect(screen.getByText('Checked 3 times before')).toBeTruthy()
    expect(screen.getByText(/by the owner/)).toBeTruthy()
    expect(screen.getByText(/on this till/)).toBeTruthy()
  })

  it('the owner’s own earlier check reads "on this device"', async () => {
    next = paid({ priorChecks: [{ at: AT, by: { kind: 'this_device' } }] })
    open({ qr: 'imrc1:x' })
    expect(await screen.findByText(`Already checked ${when} on this device`)).toBeTruthy()
  })

  it('an invalid receipt stays red even with earlier checks', async () => {
    next = result({ verdict: 'invalid', priorChecks: [{ at: AT, by: { kind: 'owner' } }] })
    open({ qr: 'imrc1:x' })
    await screen.findByRole('heading', { level: 1 })
    expect(document.querySelector('[data-tone="bad"]')).toBeTruthy()
  })

  it('history known and empty: green, no claim of an earlier check', async () => {
    next = paid({ history: 'known' })
    open({ qr: 'imrc1:x' })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByText(/Already checked|First check/)).toBeNull()
    expect(screen.queryByTestId('history-unknown')).toBeNull()
    expect(document.querySelector('[data-tone="good"]')).toBeTruthy()
  })

  it('history unknown (offline, flooded): the verdict stands, and it says it could not look (M3)', async () => {
    next = paid({ history: 'unknown' })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Paid to you')
    expect(screen.getByTestId('history-unknown').textContent).toBe('Couldn’t look up earlier checks.')
  })

  it('history unknown but this device checked before: still "Already checked"', async () => {
    next = paid({ priorChecks: [{ at: AT, by: { kind: 'this_device' } }], history: 'unknown' })
    open({ qr: 'imrc1:x' })
    expect(await screen.findByText(`Already checked ${when} on this device`)).toBeTruthy()
    expect(screen.queryByTestId('history-unknown')).toBeNull()
    expect(document.querySelector('[data-tone="checked"]')).toBeTruthy()
  })

  it('the owner’s other device is named as such (M4)', async () => {
    next = paid({ priorChecks: [{ at: AT, by: { kind: 'owner_other_device' } }] })
    open({ qr: 'imrc1:x' })
    expect(await screen.findByText(`Already checked ${when} on another of your devices`)).toBeTruthy()
  })

  it('a payment not tied to me never shows earlier checks', async () => {
    next = result({ mine: 'payee', mint: 'confirmed', verdict: 'unacknowledged', priorChecks: [{ at: AT, by: { kind: 'owner' } }] })
    open({ qr: 'imrc1:x' })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByText(/Already checked|Checked \d+ times? before/)).toBeNull()
    expect(document.querySelector('[data-tone="checked"]')).toBeNull()
  })

  it('the grey stands out against the page: a filled grey with a border', async () => {
    next = paid({ priorChecks: [{ at: AT, by: { kind: 'owner' } }] })
    open({ qr: 'imrc1:x' })
    await screen.findByRole('heading', { level: 1 })
    const card = document.querySelector('[data-tone="checked"]') as HTMLElement
    expect(card.className).toMatch(/\bbg-mono-200\b/)
    expect(card.className).toMatch(/\bborder-mono-300\b/)
  })
})

describe('the payment memo (FR-027f)', () => {
  it('shows my record’s memo on the card', async () => {
    next = result({ mine: 'payee', records: 'found_in_records', memo: 'Two coffees, table 4' })
    open({ qr: 'imrc1:x' })
    expect(await screen.findByText('Two coffees, table 4')).toBeTruthy()
  })

  it('and on a repeat too, read after "Already checked"', async () => {
    next = result({ mine: 'payee', records: 'found_in_records', memo: 'Two coffees', priorChecks: [{ at: 1, by: { kind: 'owner' } }] })
    open({ qr: 'imrc1:x' })
    const memo = await screen.findByText('Two coffees')
    const already = screen.getByText(/Already checked/)
    expect(already.compareDocumentPosition(memo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('no memo, no line', async () => {
    next = result({ mine: 'payee', records: 'found_in_records' })
    open({ qr: 'imrc1:x' })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByTestId('receipt-memo')).toBeNull()
  })
})

describe('Back returns to the scanner that opened the check', () => {
  it('the receipt scanner, when it opened the check', async () => {
    next = result({})
    open({ qr: 'imrc1:x', from: '/receipts/scan' })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByRole('link', { name: /Scan/ }).getAttribute('href')).toBe('/receipts/scan')
  })

  it('the general Scan otherwise, and never an outside address', async () => {
    next = result({})
    open({ qr: 'imrc1:x', from: '//evil.example' })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByRole('link', { name: /Scan/ }).getAttribute('href')).toBe('/scan')
  })
})

describe('the memo on the card (FR-002a)', () => {
  it('a till shows the memo the payer signed, under the verdict', async () => {
    next = result({ mine: 'payee', mint: 'confirmed', memo: 'Table 4, two flat whites' })
    render(
      <MemoryRouter initialEntries={[{ pathname: '/receipt/check', state: { qr: 'imrc1:x' } }]}>
        <Routes>
          <Route path="/receipt/check" element={<ReceiptCheckPage forStall={'aa'.repeat(32)} />} />
        </Routes>
      </MemoryRouter>,
    )
    expect((await screen.findByTestId('receipt-memo')).textContent).toBe('Table 4, two flat whites')
  })

  it('a receipt for someone else still shows what it was for', async () => {
    next = result({ mine: 'neither', memo: 'Rent, November' })
    open({ qr: 'imrc1:x' })
    expect((await screen.findByTestId('receipt-memo')).textContent).toBe('Rent, November')
  })
})

describe('a receipt sent as text', () => {
  it('never says the payer’s own phone, even with a fresh presenter proof', async () => {
    // Arrange
    next = result({ mine: 'payee', mint: 'confirmed', presenter: 'PRESENTER_IS_PAYER' })

    // Act
    open({ qr: 'imrc1:x', via: 'text' })

    // Assert
    expect(await screen.findByText('Sent as text, not shown in person')).toBeTruthy()
    expect(screen.queryByText('The payer’s own phone')).toBeNull()
  })

  it('is still checked in full: the verdict is the same as for a scan', async () => {
    // Arrange
    next = result({ mine: 'payee', mint: 'confirmed' })

    // Act
    open({ qr: 'imrc1:x', via: 'text' })

    // Assert
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Paid to you')
    expect(seen).toEqual(['imrc1:x'])
  })

  it('a scanned receipt keeps its presenter line', async () => {
    // Arrange
    next = result({ mine: 'payee', mint: 'confirmed', presenter: 'PRESENTER_IS_PAYER' })

    // Act
    open({ qr: 'imrc1:x' })

    // Assert
    expect(await screen.findByText('The payer’s own phone')).toBeTruthy()
  })
})
