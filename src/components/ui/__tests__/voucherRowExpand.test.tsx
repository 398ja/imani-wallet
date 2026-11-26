/**
 * @vitest-environment jsdom
 */
/**
 * The customer's voucher row, which opens in place (no detail screen): a real disclosure button,
 * keyboard-operable, showing only what a holder acts on, and none of the support facts the old
 * detail screen listed (those are in the support snapshot, see snapshot.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

import { CouponListItem } from '../records'
import { formatDate } from '../../../lib/format'

afterEach(cleanup)

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 26, 12)

function row(over: Partial<VoucherRow> & Record<string, unknown> = {}): VoucherRow {
  return {
    token_id: 'tok-' + 'f'.repeat(60),
    voucher_id: 'issuance-id-should-stay-hidden',
    token: 'cashuBsecret',
    amount: 250,
    face_value: 1250,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 500,
    issuance_ratio: 2.5,
    backing_strategy: 'ledger',
    issuer_id: 'a'.repeat(64),
    status: 'active',
    created_at: new Date(NOW - 5 * DAY).toISOString(),
    updated_at: new Date(NOW - 4 * DAY).toISOString(),
    expires_at: Math.floor((NOW + 40 * DAY) / 1000),
    source_transport: 'gift_link',
    received_via_event_id: 'e'.repeat(64),
    memo: 'a note only support should see',
    ...over,
  } as VoucherRow
}

const draw = (r: VoucherRow) =>
  render(
    <MemoryRouter>
      <CouponListItem row={r} now={NOW} />
    </MemoryRouter>,
  )

describe('a voucher row', () => {
  it('is a button that opens in place, with aria-expanded and aria-controls', () => {
    draw(row())
    const button = screen.getByRole('button', { name: /€12\.50/ })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!
    expect(panel).toBeTruthy()
    expect(panel.hasAttribute('inert')).toBe(true)
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(panel.hasAttribute('inert')).toBe(false)
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('is no link: there is no screen behind it any more', () => {
    draw(row())
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('opened, shows received, expiry, status, source and the id, each labelled', () => {
    const r = row()
    draw(r)
    fireEvent.click(screen.getByRole('button', { name: /€12\.50/ }))
    const panel = screen.getByRole('region')
    const text = panel.textContent ?? ''
    expect(text).toContain('Received')
    expect(text).toContain(formatDate(r.created_at))
    expect(text).toContain('Expires')
    expect(text).toContain(`${formatDate(r.expires_at)} · in 40 days`)
    expect(within(panel).getByText('Ready to use')).toBeTruthy()
    expect(text).toContain('Cashlink')
    expect(within(panel).getByTitle(r.token_id).textContent).toBe(r.token_id)
  })

  it('shows none of the old detail screen\'s support facts', () => {
    const r = row()
    draw(r)
    fireEvent.click(screen.getByRole('button', { name: /€12\.50/ }))
    const all = document.body.textContent ?? ''
    for (const hidden of [
      'Backing',
      'sats',
      'ledger',
      'Issuance',
      'per sat',
      r.voucher_id,
      'Merchant',
      'Face decimals',
      'Updated',
      'Received via',
      'e'.repeat(64),
      'Terms',
      'Redeemable only',
      'gift_link',
      'a note only support should see',
      'Memo',
    ]) {
      expect(all.includes(hidden!), `shows ${hidden}`).toBe(false)
    }
  })

  it('copies the whole id, however long, and says so', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const r = row()
    draw(r)
    fireEvent.click(screen.getByRole('button', { name: /€12\.50/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy voucher id' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(r.token_id))
    await screen.findByText('Copied')
    // Truncated on screen, never cut in what is copied.
    expect(screen.getByTitle(r.token_id).className).toContain('truncate')
  })

  it('keeps expired, spent and pending visually distinct, in words and not colour alone', () => {
    const cases: Array<[Partial<VoucherRow>, string, string]> = [
      [{ expires_at: Math.floor((NOW - DAY) / 1000) }, 'expired', 'Expired'],
      [{ status: 'redeemed' }, 'redeemed', 'Redeemed'],
      [{ status: 'spent' }, 'spent', 'Spent'],
      [{ status: 'pending' }, 'pending', 'Pending'],
      [{}, 'active', 'Ready to use'],
    ]
    for (const [over, kind, words] of cases) {
      cleanup()
      draw(row(over))
      const button = screen.getByRole('button', { expanded: false })
      fireEvent.click(button)
      const badge = document.querySelector('[data-voucher-status]')!
      expect(badge.getAttribute('data-voucher-status')).toBe(kind)
      expect(badge.textContent).toBe(words)
      const dimmed = button.querySelector('.opacity-60') !== null
      expect(dimmed, kind).toBe(kind === 'expired' || kind === 'redeemed' || kind === 'spent')
    }
  })

  it('a spent voucher is struck through; an expired one says when it ran out', () => {
    draw(row({ status: 'redeemed' }))
    expect(screen.getByText('€12.50').className).toContain('line-through')
    cleanup()
    const r = row({ expires_at: Math.floor((NOW - DAY) / 1000) })
    draw(r)
    expect(screen.getByRole('button', { expanded: false }).textContent).toContain(`Expired ${formatDate(r.expires_at)}`)
  })

  it('opens from the keyboard: it is a native button, so Enter and Space click it', () => {
    draw(row())
    const button = screen.getByRole('button', { name: /€12\.50/ })
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    button.focus()
    expect(document.activeElement).toBe(button)
  })

  it('animates only where motion is welcome: every transition is dropped under reduced motion', () => {
    draw(row())
    const button = screen.getByRole('button', { name: /€12\.50/ })
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!
    expect(panel.className).toContain('motion-reduce:transition-none')
    expect(button.querySelector('svg.lucide-chevron-down')?.getAttribute('class')).toContain('motion-reduce:transition-none')
    // A tap target of at least 44px: min-h-16 is 64px.
    expect(button.className).toContain('min-h-16')
  })
})
