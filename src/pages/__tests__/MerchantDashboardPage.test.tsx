/**
 * @vitest-environment jsdom
 *
 * The merchant dashboard, on the three things that changed about it.
 *
 * Each is a judgement about what a merchant should be reading, not a rendering
 * detail, so each is asserted against the real page over real rows:
 *
 *   - **"Taken in" is gone.** It totalled the vouchers this wallet HOLDS, which
 *     on a stall's dashboard reads as takings and is not takings.
 *   - **"Expiring soon" is capped at three**, soonest first, with a way to the
 *     rest. It is a prompt to act; a list of forty is a report.
 *   - **The issued summary counts them**, because a count is the thing you scan
 *     a summary for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const ME = 'a'.repeat(64)
const DAY = 86_400_000

/**
 * One issued-voucher row as the wallet stores it.
 *
 * `toTransaction` reads these, so they are shaped like the store's rows rather
 * than like `WalletTransaction` — a fixture built from the output type would
 * prove nothing about the page's own read path.
 */
function issued({ id, inDays, amount = 1000 }: { id: string; inDays: number; amount?: number }) {
  return {
    id: `issued:${id}`,
    type: 'issued',
    direction: 'out',
    counterparty: 'b'.repeat(64),
    amount,
    unit: 'EUR',
    decimals: 2,
    at: Date.now() - DAY,
    memo: `Voucher ${id}`,
    voucher_id: id,
    // `expiresAt`, not `expires_at`: `toTransaction` reads only the camelCase
    // spelling here, unlike most of the other fields, which accept both.
    expiresAt: Date.now() + inDays * DAY,
  }
}

const rows: ReturnType<typeof issued>[] = []

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listTransactions: () => Promise.resolve(rows),
  listVouchers: () => Promise.resolve([]),
  onWalletChanged: () => () => {},
}))

vi.mock('../../components/SubscriptionNotice', () => ({
  // Reads a licence over the network and renders nothing most days; it is not
  // what these tests are about.
  SubscriptionNotice: () => null,
}))

import { MerchantDashboardPage } from '../MerchantDashboardPage'

afterEach(cleanup)

function show(transactions: ReturnType<typeof issued>[]) {
  rows.length = 0
  rows.push(...transactions)
  return render(
    <MemoryRouter>
      <MerchantDashboardPage
        pubkey={ME}
        merchant={{ issuanceCurrency: 'EUR' } as never}
      />
    </MemoryRouter>,
  )
}

/**
 * The "Expiring soon" list section, by its HEADING.
 *
 * Addressed by role, because the summary row below carries the same words as a
 * label — which is the point of the pairing, and which makes a bare text query
 * ambiguous. `heading` picks the section out unambiguously.
 */
const expiringHeading = () =>
  screen.queryByRole('heading', { name: 'Expiring soon' })
const expiringSection = () => expiringHeading()?.closest('section') as HTMLElement

describe('the dashboard balance', () => {
  it('no longer shows "Taken in"', async () => {
    show([issued({ id: 'v1', inDays: 2 })])

    await waitFor(() => expect(screen.getByText('Outstanding vouchers')).toBeTruthy())
    // It totalled what this wallet HOLDS, sat under a liability figure, and
    // read as income. "Value taken" below is the real answer to that question.
    expect(screen.queryByText(/Taken in/)).toBeNull()
  })
})

describe('the expiring soon section', () => {
  it('is absent entirely when nothing is expiring', async () => {
    // An "Expiring soon (0)" box every day of the year trains a merchant to
    // stop reading it. Its presence IS the signal.
    show([issued({ id: 'far', inDays: 90 })])

    await waitFor(() => expect(screen.getByText('Outstanding vouchers')).toBeTruthy())
    // The SECTION is gone. The summary row below still says "Expiring soon: 0",
    // which is why this asks for the heading rather than the words.
    expect(expiringHeading()).toBeNull()
  })

  it('shows all of them, with no link out, when there are three or fewer', async () => {
    show([
      issued({ id: 'v1', inDays: 1 }),
      issued({ id: 'v2', inDays: 2 }),
      issued({ id: 'v3', inDays: 3 }),
    ])

    await waitFor(() => expect(expiringHeading()).toBeTruthy())
    const section = expiringSection()
    expect(within(section).getAllByRole('link')).toHaveLength(3)
    // Nothing is hidden, so a "See all" would lead to the same three rows.
    expect(within(section).queryByText(/See all/)).toBeNull()
  })

  it('shows only the three most urgent, and links to the rest', async () => {
    show([
      issued({ id: 'v5', inDays: 5 }),
      issued({ id: 'v1', inDays: 1 }),
      issued({ id: 'v4', inDays: 4 }),
      issued({ id: 'v2', inDays: 2 }),
      issued({ id: 'v3', inDays: 3 }),
    ])

    await waitFor(() => expect(expiringHeading()).toBeTruthy())
    const section = expiringSection()
    const links = within(section).getAllByRole('link')

    // Three rows plus the "See all" link.
    expect(links).toHaveLength(4)
    expect(within(section).getByText('See all (5)')).toBeTruthy()
    expect(within(section).getByText('See all (5)').getAttribute('href')).toBe('/merchant/expiring')
  })

  it('orders them soonest first, which is what makes capping at three defensible', async () => {
    show([
      issued({ id: 'v5', inDays: 5 }),
      issued({ id: 'v1', inDays: 1 }),
      issued({ id: 'v4', inDays: 4 }),
      issued({ id: 'v2', inDays: 2 }),
      issued({ id: 'v3', inDays: 3 }),
    ])

    await waitFor(() => expect(expiringHeading()).toBeTruthy())
    const section = expiringSection()

    // The three shown are the three that run out first — capping an unsorted
    // list would hide the urgent ones behind whatever happened to load first.
    expect(within(section).getByText('Voucher v1')).toBeTruthy()
    expect(within(section).getByText('Voucher v2')).toBeTruthy()
    expect(within(section).getByText('Voucher v3')).toBeTruthy()
    expect(within(section).queryByText('Voucher v4')).toBeNull()
    expect(within(section).queryByText('Voucher v5')).toBeNull()
  })
})

describe('the issued-vouchers summary', () => {
  it('counts the ones expiring soon', async () => {
    show([
      issued({ id: 'v1', inDays: 1 }),
      issued({ id: 'v2', inDays: 2 }),
      issued({ id: 'v3', inDays: 3 }),
      issued({ id: 'v4', inDays: 4 }),
      issued({ id: 'far', inDays: 90 }),
    ])

    await waitFor(() => expect(screen.getByText('Vouchers you have issued')).toBeTruthy())
    const summary = screen.getByText('Vouchers you have issued').closest('section') as HTMLElement
    const row = within(summary).getByText('Expiring soon').closest('div') as HTMLElement

    // Four, not the three on screen above: the row counts the whole set the
    // section is a preview OF.
    expect(within(row).getByText('4')).toBeTruthy()
  })

  it('still shows the row, saying zero, when nothing is expiring', async () => {
    // Unlike the section above, this is a summary of counts — a zero here means
    // "nothing needs chasing", which is information.
    show([issued({ id: 'far', inDays: 90 })])

    await waitFor(() => expect(screen.getByText('Vouchers you have issued')).toBeTruthy())
    const summary = screen.getByText('Vouchers you have issued').closest('section') as HTMLElement
    const row = within(summary).getByText('Expiring soon').closest('div') as HTMLElement

    expect(within(row).getByText('0')).toBeTruthy()
  })
})

describe('the range filters', () => {
  const rangeButtons = () =>
    screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-pressed'))
      .map((b) => b.textContent)
  const chart = () => screen.queryByRole('img', { name: 'Daily voucher activity' })

  it('are Today, 7 days and 30 days, with 30 days chosen', async () => {
    show([issued({ id: 'v1', inDays: 2 })])

    await waitFor(() => expect(screen.getByText('Vouchers issued')).toBeTruthy())
    expect(rangeButtons()).toEqual(['Today', '7 days', '30 days'])
    expect(screen.queryByText('90 days')).toBeNull()
    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('shows the daily chart for 7 and 30 days', async () => {
    show([issued({ id: 'v1', inDays: 2 })])

    await waitFor(() => expect(chart()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '7 days' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe('true'),
    )
    expect(chart()).toBeTruthy()
  })

  it('hides the chart for Today, keeping the totals', async () => {
    show([issued({ id: 'v1', inDays: 2 })])

    await waitFor(() => expect(chart()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('true'),
    )
    // One bar is not a chart. The tiles already say everything it would.
    expect(chart()).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Activity' })).toBeNull()
    expect(screen.getByText('Vouchers issued')).toBeTruthy()
    expect(screen.getByText('Came back')).toBeTruthy()
  })
})
