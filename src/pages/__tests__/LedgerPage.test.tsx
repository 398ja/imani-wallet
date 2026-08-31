/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { finalizeEvent, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * The merchant's view of their own published ledger.
 *
 * The property under test is not layout, it is HONESTY: this screen must show
 * the merchant what an external auditor sees, computed by the same reader, and
 * it must never print an amount. A panel that quietly ran a friendlier check —
 * or read local rows instead of the relay — would be reassurance about nothing.
 */

const LEDGER_SK = hexToBytes('a'.repeat(64))
const OTHER_SK = hexToBytes('b'.repeat(64))
const commitment = (seed: string) => `02${seed.repeat(64).slice(0, 64)}`

let relayEvents: Event[] = []
let relayThrows = false

vi.mock('../../lib/relay', () => ({
  allEvents: async () => {
    if (relayThrows) throw new Error('relay unreachable')
    return relayEvents
  },
}))

// The real reader runs. Only the KEY derivation is stubbed, because it needs a
// signer — stubbing the reader would defeat the point of the screen.
vi.mock('../../lib/attestation', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1.js')
  const { bytesToHex } = await import('@noble/hashes/utils')
  return {
    ledgerPubkey: () => bytesToHex(schnorr.getPublicKey(LEDGER_SK)),
    reconcileAttestations: async () => ({ checked: 0, missing: 0, republished: 0 }),
  }
})

vi.mock('../../lib/wallet', () => ({
  listTransactions: async () => [],
  recordAttestationReceipt: async () => {},
}))

const { LedgerPage } = await import('../LedgerPage')

const attest = (sk: Uint8Array, nullifier: string, c = commitment('1'), unit = 'XAF'): Event =>
  finalizeEvent(
    {
      kind: 7377,
      created_at: 1_700_000_000,
      tags: [
        ['n', nullifier],
        ['unit', unit],
        ['v', '1'],
      ],
      content: JSON.stringify({ v: '1', nullifier, commitment: c, unit }),
    },
    sk,
  )

/**
 * The value rendered against a labelled row.
 *
 * `getByText('1')` is ambiguous the moment two rows show the same number —
 * redemptions and refused both read "1" in the forgery test — and an ambiguous
 * query fails loudly rather than silently asserting the wrong row, which is why
 * this reads the value as the label's SIBLING instead.
 */
const valueFor = (label: string) => {
  const row = screen.getByText(label).closest('div')
  return within(row as HTMLElement).getAllByText(/.+/).pop()?.textContent
}

const paint = () =>
  render(
    <MemoryRouter>
      <LedgerPage />
    </MemoryRouter>,
  )

afterEach(cleanup)
beforeEach(() => {
  relayEvents = []
  relayThrows = false
})

describe('what the merchant is shown about their own stream', () => {
  it('reports what is actually published, read back from the relay', async () => {
    relayEvents = [attest(LEDGER_SK, 'n1'), attest(LEDGER_SK, 'n2')]
    paint()
    await waitFor(() => expect(screen.getByText('Redemptions published')).toBeTruthy())
    expect(valueFor('Redemptions published')).toBe('2')
  })

  it('never counts another stall\'s records as its own', async () => {
    // The pseudonym only works if one query means one stall. Pooling two ledger
    // keys would inflate this merchant's count with someone else's trade.
    relayEvents = [attest(LEDGER_SK, 'n1'), attest(OTHER_SK, 'n2'), attest(OTHER_SK, 'n3')]
    paint()
    await waitFor(() => expect(screen.getByText('Redemptions published')).toBeTruthy())
    expect(valueFor('Redemptions published')).toBe('1')
  })

  it('does not count a forged record, even under this merchant\'s own key', async () => {
    // The reader verifies signatures, and this screen must inherit that rather
    // than trusting anything tagged with the right pubkey.
    const genuine = attest(LEDGER_SK, 'n1')
    relayEvents = [genuine, { ...attest(LEDGER_SK, 'n2'), sig: 'f'.repeat(128) } as Event]
    paint()
    await waitFor(() => expect(screen.getByText('Redemptions published')).toBeTruthy())
    expect(valueFor('Redemptions published')).toBe('1')
    expect(valueFor('Unreadable records')).toBe('1')
  })

  it('NEVER prints an amount', async () => {
    // The commitments are what keep a stall's takings private. This screen has
    // no field for a value and must never grow one — a merchant reads their own
    // figures in their transaction list, where they are not public.
    relayEvents = [attest(LEDGER_SK, 'n1')]
    const { container } = paint()
    await waitFor(() => expect(screen.getByText('Redemptions published')).toBeTruthy())
    // The commitment is a public value, but printing it beside a known amount
    // invites treating it as if it were private. It is deliberately not shown.
    expect(container.textContent).not.toContain(commitment('1'))
  })
})

describe('conflicts', () => {
  it('stays quiet when the sweep has republished a record byte-identically', async () => {
    // Derived blinds make republication identical BY DESIGN. Flagging it would
    // make the merchant think the button they just pressed broke something.
    relayEvents = [attest(LEDGER_SK, 'n1'), attest(LEDGER_SK, 'n1')]
    paint()
    await waitFor(() => expect(screen.getByText('Redemptions published')).toBeTruthy())
    expect(screen.queryByText('Conflicting records')).toBeNull()
  })

  it('raises the alarm when one coupon carries two different claims', async () => {
    relayEvents = [
      attest(LEDGER_SK, 'n1', commitment('1')),
      attest(LEDGER_SK, 'n1', commitment('7')),
    ]
    paint()
    await waitFor(() => expect(screen.getByText('Conflicting records')).toBeTruthy())
    expect(screen.getByText(/should not happen/)).toBeTruthy()
  })
})

describe('when the relay cannot be reached', () => {
  it('says so without implying the merchant has lost anything', async () => {
    // A read failure is not a fault in the books. The wording has to keep those
    // apart, or a network blip reads as missing money.
    relayThrows = true
    paint()
    await waitFor(() => expect(screen.getByText(/Could not reach the relay/)).toBeTruthy())
    expect(screen.getByText(/records are unaffected/)).toBeTruthy()
  })
})
