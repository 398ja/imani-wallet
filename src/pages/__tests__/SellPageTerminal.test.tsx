/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Issue #159: a terminal Sell must never say "It is in their wallet now".
 *
 * A terminal's key is not the stall's, so its coupons could only carry a
 * signed `none` warrant, and every wallet receiving a coupon by DM refuses
 * that before the mint swap. The terminal reported success while the
 * customer's wallet showed "Coupon not authorised" and a balance of 0.
 *
 * So the screen stops a terminal on arrival, before a customer is scanned or
 * any money is taken, and the enforcement point refuses the same request made
 * around it (`issueActor.test.ts`). This file covers the screen, and that a
 * refusal from the enforcement point is shown as an error, never as success.
 */

const issued = vi.hoisted(() => ({
  calls: 0,
  args: undefined as unknown,
  impl: null as null | (() => Promise<unknown>),
}))

vi.mock('../../lib/issue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/issue')>()),
  issueAndDeliver: async (params: unknown) => {
    issued.calls += 1
    issued.args = params
    if (!issued.impl) throw new Error('issueAndDeliver not stubbed')
    return issued.impl()
  },
}))

// The camera. Replaced by a button that "scans" a fixed customer.
vi.mock('../../components/ScanRecipient', () => ({
  ScanRecipient: ({ onFound }: { onFound: (pubkey: string) => void }) => (
    <button type="button" onClick={() => onFound('e'.repeat(64))}>
      fake-scan
    </button>
  ),
}))

vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
  useIdentityState: () => ({ identity: undefined, loading: false }),
}))
vi.mock('../../hooks/useIsMerchant', () => ({ useIsMerchant: () => false }))
vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  useCashbackAvailable: () => false,
}))

const { SellPage } = await import('../SellPage')
const { TERMINAL_ROLES, grantFor } = await import('../../lib/terminalRole')
const { SESSION_KIND, openSession } = await import('../../lib/terminalSession')
const { UnwarrantedSaleError } = await import('../../lib/warrantSigner')
import type { TerminalActor } from '../../lib/actor'
import type { MerchantProfile } from '../../lib/merchant'

const STALL = 'a'.repeat(64)
const DEVICE = 'c'.repeat(64)

const merchant = {
  pubkey: STALL,
  active: true,
  categories: [],
  issuanceCurrency: 'GBP',
  voucherValidityDays: 90,
} as unknown as MerchantProfile

const till: TerminalActor = {
  kind: 'terminal',
  stallPubkey: STALL,
  role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
  terminalPubkey: DEVICE,
  permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
  // The stall attested this till at enrolment (#160 decision 5), so it may sell.
  attested: true,
}

function show(props: Partial<Parameters<typeof SellPage>[0]> = {}) {
  return render(
    <MemoryRouter>
      <SellPage pubkey={STALL} merchant={merchant} {...props} />
    </MemoryRouter>,
  )
}

const SUCCESS = /in their wallet now/

beforeEach(() => {
  issued.calls = 0
  issued.impl = null
})

afterEach(cleanup)

describe('a full till reaching Sell (#160 phase 5)', () => {
  it('gets the scanner, because it signs the terminal warrant form', () => {
    show({ actor: till, session: openSession(till, SESSION_KIND.FULL, Date.now()) })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('fake-scan')).toBeTruthy()
  })
})

describe('a REDUCED till reaching Sell', () => {
  it('is stopped on arrival, before a customer is scanned', () => {
    // A REDUCED session never heard from the mint, so it does not sell.
    show({ actor: till, session: openSession(till, SESSION_KIND.REDUCED, Date.now()) })

    expect(screen.getByRole('alert').textContent).toMatch(/cannot sell right now/)
  })

  it('offers no scanner and no amount, so no sale can be started or paid for', () => {
    show({ actor: till, session: openSession(till, SESSION_KIND.REDUCED, Date.now()) })

    expect(screen.queryByText('fake-scan')).toBeNull()
    expect(screen.queryByRole('button', { name: /Send voucher/ })).toBeNull()
    expect(issued.calls).toBe(0)
  })

  it('never shows the success copy', () => {
    show({ actor: till, session: openSession(till, SESSION_KIND.REDUCED, Date.now()) })

    expect(screen.queryByText(SUCCESS)).toBeNull()
  })
})

describe('the owner’s own device', () => {
  it('still gets the scanner', () => {
    show()

    expect(screen.getByText('fake-scan')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a refused sale as an error, never as success', async () => {
    // The enforcement point refusing an unwarranted sale (an owner session
    // whose key is not the stall's, or a locked wallet). Whatever the reason,
    // the screen must not reach the confirmation.
    issued.impl = async () => {
      throw new UnwarrantedSaleError('Could not sign this sale. Nothing has been issued.')
    }
    show()

    fireEvent.click(screen.getByText('fake-scan'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Send voucher/ }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Nothing has been issued/))
    expect(issued.calls).toBe(1)
    expect(screen.queryByText(SUCCESS)).toBeNull()
  })
})

// Review sh6: the Note is capped where it is typed (maxLength) and again in what the sale is
// given, so a pasted or scripted note cannot reach the till's sale DM uncapped.
describe('the Note on a sale', () => {
  it('is capped at NOTE_MAX_CHARS in the field and in what the sale is given', async () => {
    const { NOTE_MAX_CHARS } = await import('../../lib/note')
    issued.impl = async () => {
      throw new UnwarrantedSaleError('stop here')
    }
    show()

    fireEvent.click(screen.getByText('fake-scan'))
    const note = screen.getByLabelText('Note (optional)') as HTMLInputElement
    expect(note.maxLength).toBe(NOTE_MAX_CHARS)
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } })
    // A paste or a script can set more than maxLength allows typing.
    fireEvent.change(note, { target: { value: '漢'.repeat(NOTE_MAX_CHARS + 100) } })
    fireEvent.click(screen.getByRole('button', { name: /Send voucher/ }))

    await waitFor(() => expect(issued.calls).toBe(1))
    expect((issued.args as { memo?: string }).memo).toBe('漢'.repeat(NOTE_MAX_CHARS))
  })
})
