/**
 * @vitest-environment jsdom
 *
 * The merchant's voucher screens: the list they reach from the menu, and the
 * record behind one row.
 *
 * Two things matter beyond "it renders", and both are about a merchant being
 * able to trust what is on screen:
 *
 *  - **The default hides expired vouchers and the screen says so.** A count
 *    that included what the list is not showing, or a switch that silently
 *    filtered without a label, is the kind of quiet disagreement that makes a
 *    merchant stop believing the numbers.
 *  - **The record never overstates its evidence.** "Signed by this stall" must
 *    not appear on a sale with no signature, and an unwarranted sale must not
 *    be reported as cash.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

const DAY = 86_400_000

const STALL_SK = '9'.repeat(63) + '1'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))

const NONCE = 'nonce-one'

// The rows as they are STORED, not as `toTransaction` returns them: these go
// through the real converter, which is the point — a fixture in the parsed
// shape would not catch a field this screen reads under the wrong spelling.
function issued({
  id,
  amount = 1000,
  inDays,
  warrant,
}: {
  id: string
  amount?: number
  inDays?: number
  warrant?: string
}) {
  return {
    id: `issued:${id}`,
    type: 'issued',
    direction: 'out',
    amount,
    unit: 'XAF',
    decimals: 0,
    timestamp: Date.now() - DAY,
    memo: `Voucher ${id}`,
    // Camel case: the only spelling `toTransaction` reads for these.
    voucherId: id,
    ...(inDays === undefined ? {} : { expiresAt: Date.now() + inDays * DAY }),
    ...(warrant ? { issuanceWarrant: warrant } : {}),
  }
}

function claim({ id, amount }: { id: string; amount: number }) {
  return {
    id: `received:${id}-${amount}`,
    type: 'received',
    direction: 'in',
    amount,
    unit: 'XAF',
    decimals: 0,
    timestamp: Date.now(),
    voucherId: id,
    merchantId: STALL,
  }
}

/** A genuine merchant warrant, signed by the stall this screen checks against. */
function warrantFor(total: number): string {
  return JSON.stringify({
    form: 'merchant',
    sale_total: total,
    face_decimals: 0,
    unit: 'XAF',
    nonce: NONCE,
    sig: bytesToHex(
      schnorr.sign(warrantSaleDigest(STALL, total, 0, 'XAF', NONCE), hexToBytes(STALL_SK)),
    ),
  })
}

const rows: Record<string, unknown>[] = []

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listTransactions: () => Promise.resolve(rows),
  onWalletChanged: () => () => {},
}))

// Identity resolution reaches the network in the row component; stubbed to the
// key itself so the list renders without a relay.
vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
}))

import { warrantSaleDigest } from '../../lib/issuanceWarrant'
import { IssuedCouponsPage, IssuedCouponPage } from '../MerchantRecordPages'

afterEach(cleanup)

function showList(transactions: Record<string, unknown>[]) {
  rows.length = 0
  rows.push(...transactions)
  return render(
    <MemoryRouter>
      <IssuedCouponsPage />
    </MemoryRouter>,
  )
}

function showVoucher(voucherId: string, transactions: Record<string, unknown>[]) {
  rows.length = 0
  rows.push(...transactions)
  return render(
    <MemoryRouter initialEntries={[`/merchant/coupon/${voucherId}`]}>
      <Routes>
        <Route
          path="/merchant/coupon/:voucherId"
          element={<IssuedCouponPage pubkey={STALL} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('the vouchers list', () => {
  it('shows the ones still valid, and says that is what it is showing', async () => {
    showList([issued({ id: 'live', inDays: 30 }), issued({ id: 'gone', inDays: -3 })])

    await waitFor(() => expect(screen.getByText('1 voucher still valid')).toBeTruthy())
    expect(screen.getByText('Voucher live')).toBeTruthy()
    expect(screen.queryByText('Voucher gone')).toBeNull()
  })

  it('brings the expired ones back when asked, and drops the qualifier', async () => {
    // Not a second screen: the customer most likely to present a coupon at a
    // counter is the one holding a coupon that has run out.
    showList([issued({ id: 'live', inDays: 30 }), issued({ id: 'gone', inDays: -3 })])

    await waitFor(() => expect(screen.getByText('1 voucher still valid')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch', { name: /Include expired/ }))

    await waitFor(() => expect(screen.getByText('2 vouchers')).toBeTruthy())
    expect(screen.getByText('Voucher gone')).toBeTruthy()
  })

  it('says how many are behind the switch, so turning it on has a reason', async () => {
    showList([issued({ id: 'live', inDays: 30 }), issued({ id: 'gone', inDays: -3 })])

    await waitFor(() => expect(screen.getByText('1 voucher has run out')).toBeTruthy())
  })

  it('offers no switch when nothing has expired', async () => {
    // A control that changes nothing teaches a merchant that this control
    // does nothing.
    showList([issued({ id: 'live', inDays: 30 })])

    await waitFor(() => expect(screen.getByText('Voucher live')).toBeTruthy())
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('points at the expired ones rather than looking empty', async () => {
    // An empty list over a full history is the moment a merchant concludes
    // their records are gone.
    showList([issued({ id: 'gone', inDays: -3 })])

    await waitFor(() =>
      expect(
        screen.getByText(/Turn on .Include expired. to see the ones that have run out/),
      ).toBeTruthy(),
    )
  })

  it('takes a row to the voucher, not to the transaction that issued it', async () => {
    showList([issued({ id: 'live', inDays: 30 })])

    await waitFor(() => expect(screen.getByText('Voucher live')).toBeTruthy())
    const row = screen.getByRole('link', { name: /Voucher live/ })
    expect(row.getAttribute('href')).toBe('/merchant/coupon/live')
  })
})

describe('one voucher', () => {
  it('says how much has been claimed and how much is still out there', async () => {
    showVoucher('v1', [
      issued({ id: 'v1', amount: 1000, inDays: 30 }),
      claim({ id: 'v1', amount: 400 }),
      claim({ id: 'v1', amount: 250 }),
    ])

    await waitFor(() => expect(screen.getByText(/claimed/)).toBeTruthy())
    // 650 claimed of 1000, so 350 still out there. Matched loosely because the
    // currency formatter separates FCFA from its figure with a non-breaking
    // space, which a literal written by hand does not contain.
    expect(screen.getByText(/650/)).toBeTruthy()
    expect(screen.getByText(/350/)).toBeTruthy()
    // The figures are WRITTEN, not only drawn: the bar is the fast path and
    // the words are the fact, so neither number may exist as a fill width
    // alone.
    expect(screen.getByText(/outstanding/)).toBeTruthy()
  })

  it('lists the transactions that claimed it, so the total can be checked', async () => {
    showVoucher('v1', [
      issued({ id: 'v1', amount: 1000, inDays: 30 }),
      claim({ id: 'v1', amount: 400 }),
    ])

    await waitFor(() => expect(screen.getByText('Claim')).toBeTruthy())
    // The '+' is the list row's own sign for money coming in.
    expect(screen.getByText(/\+.*400/)).toBeTruthy()
  })

  it('shows nothing claimed on a voucher that has not come back', async () => {
    showVoucher('v1', [issued({ id: 'v1', amount: 1000, inDays: 30 })])

    await waitFor(() => expect(screen.getByText(/claimed/)).toBeTruthy())
    // Anchored to its own word rather than searched for loose: a bare "0" also
    // appears under Details as the currency's decimal count, and that match
    // would pass for the wrong reason.
    expect(screen.getByText(/claimed/).textContent).toMatch(/\b0\b/)
    // Nothing claimed means the whole face value is still out there.
    expect(screen.getByText(/1[\s,]?000\s*outstanding/)).toBeTruthy()
    // No empty "Claims" box under a line that already said zero.
    expect(screen.queryByText('Claims')).toBeNull()
  })

  it('reports a stall-signed sale as a counter sale, authorised', async () => {
    showVoucher('v1', [issued({ id: 'v1', amount: 1000, inDays: 30, warrant: warrantFor(1000) })])

    await waitFor(() => expect(screen.getByText('At the counter')).toBeTruthy())
    expect(screen.getByText('Signed by this stall')).toBeTruthy()
    // Authorisation is not payment, and the screen has to say so.
    expect(screen.getByText(/it does not prove you were paid/)).toBeTruthy()
  })

  it('refuses to call an unsigned sale cash, or to call it authorised', async () => {
    // Every sale made before warrants shipped, and every sale made on a
    // terminal. Ordinary, and not something to invent a payment method over.
    showVoucher('v1', [issued({ id: 'v1', amount: 1000, inDays: 30 })])

    await waitFor(() => expect(screen.getByText('Not recorded')).toBeTruthy())
    expect(screen.getByText('No signature on file')).toBeTruthy()
    expect(screen.queryByText('Signed by this stall')).toBeNull()
    expect(screen.queryByText('At the counter')).toBeNull()
  })

  it('reports a card purchase as a card purchase', async () => {
    showVoucher('v1', [
      issued({
        id: 'v1',
        amount: 1000,
        inDays: 30,
        warrant: JSON.stringify({
          form: 'processor',
          sale_total: 1000,
          face_decimals: 0,
          unit: 'XAF',
          nonce: NONCE,
          ref: 'pi_123',
        }),
      }),
    ])

    await waitFor(() => expect(screen.getByText('Card')).toBeTruthy())
    // Twice over: once in the sentence a merchant reads, and once verbatim in
    // the raw warrant under Details, which is the copy they would quote.
    expect(screen.getAllByText(/pi_123/).length).toBeGreaterThan(0)
    expect(screen.getByText('Recorded by a processor')).toBeTruthy()
  })

  it('calls out a sale that no longer matches its own signature', async () => {
    // The one line that wants a human: the row and the signature filed beside
    // it disagree, which means one of the two changed after the fact.
    showVoucher('v1', [issued({ id: 'v1', amount: 9000, inDays: 30, warrant: warrantFor(1000) })])

    await waitFor(() => expect(screen.getByText('Does not match its signature')).toBeTruthy())
  })

  it('reports a missing customer receipt as ordinary, never as a fault', async () => {
    showVoucher('v1', [issued({ id: 'v1', amount: 1000, inDays: 30, warrant: warrantFor(1000) })])

    await waitFor(() => expect(screen.getByText('Not collected')).toBeTruthy())
    expect(screen.getByText(/its absence is never a fault/)).toBeTruthy()
  })

  it('answers plainly for a voucher these records have never seen', async () => {
    showVoucher('missing', [issued({ id: 'v1', inDays: 30 })])

    await waitFor(() => expect(screen.getByText('No record of this voucher.')).toBeTruthy())
  })

  it('goes back to the list it was opened from', async () => {
    showVoucher('v1', [issued({ id: 'v1', inDays: 30 })])

    await waitFor(() => expect(screen.getByText(/claimed/)).toBeTruthy())
    expect(screen.getByRole('link', { name: /Vouchers/ }).getAttribute('href')).toBe(
      '/merchant/coupons',
    )
  })

  it('still reaches the transaction that issued it', async () => {
    // The voucher and its issuing movement are a pair. The transaction used to
    // be the way IN, so its back arrow carried the pairing; now that the way in
    // is the voucher list, the record itself has to carry it or the movement
    // becomes unreachable from the coupon it produced.
    showVoucher('v1', [issued({ id: 'v1', inDays: 30 })])

    await waitFor(() => expect(screen.getByText(/claimed/)).toBeTruthy())
    expect(
      screen.getByRole('link', { name: /The sale this came from/ }).getAttribute('href'),
    ).toBe('/transaction/issued%3Av1')
  })

  it('calls a lapsed remainder lapsed, not outstanding', async () => {
    // Nobody can walk in with an expired coupon, so its remainder is not a
    // liability the stall still carries. Saying "outstanding" would overstate
    // what they owe; the number is the same and the word is not.
    showVoucher('v1', [issued({ id: 'v1', amount: 1000, inDays: -3 })])

    await waitFor(() => expect(screen.getByText(/claimed/)).toBeTruthy())
    expect(screen.getByText(/lapsed/)).toBeTruthy()
    expect(screen.queryByText(/outstanding/)).toBeNull()
  })

  it('marks an expired voucher with the same red clock the list row used', async () => {
    // A merchant arrives here by tapping that row, so the mark they tapped has
    // to be the mark they land on — a state that is loud on one screen and a
    // plain word on the next reads as two different states.
    const { container } = showVoucher('v1', [issued({ id: 'v1', inDays: -3 })])

    await waitFor(() => expect(screen.getByText('Expired')).toBeTruthy())
    expect(container.querySelector('.text-red-500')).toBeTruthy()
  })
})
