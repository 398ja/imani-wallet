/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { DetailRow, RawDetails } from '../layout'

/**
 * That the row actually PAINTS.
 *
 * The gap this closes was recorded honestly and then left open: DEV-246's
 * checks reached the gate (`hasPublishedAttestation`) and the data
 * (`toTransaction`), but nothing rendered a `DetailRow`, so "the receipt shows
 * on the transaction detail" rested on the component doing what its callers
 * assumed. A gate that returns true and a row that draws nothing look identical
 * to every test upstream of this file.
 *
 * The repo had no DOM environment, which is why the caveat stood. jsdom +
 * @testing-library/react are dev dependencies now, opted in PER FILE by the
 * docblock above rather than switched on globally: the other 49 suites are
 * logic-only and run faster and stricter in `node`, and a repo-wide `jsdom`
 * would hide a Node-only regression behind a browser polyfill.
 *
 * These assert the CONTRACT the calling screens rely on — a label, its value,
 * and absence when there is nothing to say — not the styling. Pinning class
 * names here would break on every visual pass and prove nothing about whether
 * a merchant can read their receipt.
 */

afterEach(cleanup)

describe('DetailRow paints', () => {
  it('renders the label and its value', () => {
    // The literal claim `TransactionPage` makes for an attested redemption.
    render(
      <DetailRow label="Record" value="Published to the public ledger · 3 Sep 2026, 14:05" />,
    )
    expect(screen.getByText('Record')).toBeDefined()
    expect(
      screen.getByText('Published to the public ledger · 3 Sep 2026, 14:05'),
    ).toBeDefined()
  })

  it('renders a ReactNode value, not only a string', () => {
    // The Checks section passes a <span> carrying the badge and its wording, so
    // a row that stringified its value would print "[object Object]" on the one
    // line a merchant reads to decide whether a coupon is good.
    render(
      <DetailRow
        label="Issuer"
        value={
          <span>
            <b>Signature verified</b>
          </span>
        }
      />,
    )
    expect(screen.getByText('Signature verified')).toBeDefined()
  })

  it('still paints the label when the value is empty', () => {
    // `IssuedCouponPage` keeps the Expires row deliberately even when absent,
    // because "expires 3 Sep" and "never expires" are different facts and a
    // missing row reads as the second.
    render(<DetailRow label="Expires" value="" />)
    expect(screen.getByText('Expires')).toBeDefined()
  })
})

describe('RawDetails paints the drawer', () => {
  it('renders each entry it is given', () => {
    // DEV-246 puts the two ledger ids here. They are what an auditor looks the
    // record up by, so a drawer that swallowed them would leave the receipt
    // unusable for its only purpose.
    render(
      <RawDetails
        entries={[
          ['Ledger record id', 'e'.repeat(64)],
          ['Ledger reference', 'a'.repeat(64)],
        ]}
      />,
    )
    expect(screen.getByText('Ledger record id')).toBeDefined()
    expect(screen.getByText('e'.repeat(64))).toBeDefined()
    expect(screen.getByText('Ledger reference')).toBeDefined()
  })

  it('renders NOTHING when it has no entries', () => {
    // `present()` filters undefined entries out, so an unattested row hands
    // this an empty list. It must not leave an empty disclosure widget behind,
    // which would invite a merchant to open a drawer with nothing in it.
    const { container } = render(<RawDetails entries={[]} />)
    expect(container.innerHTML).toBe('')
  })
})
