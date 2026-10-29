/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

/**
 * The diagnostics screen, driven as a screen.
 *
 * `licenceStatus` has its own tests and they pass against a screen that renders
 * none of it. What this file asserts is the part only a rendered screen can be
 * wrong about: that the GATE is the real check rather than a hidden route, that
 * a refusal states a reason a person can act on, and that a licence arriving
 * unlocks it with nothing for the customer to do.
 *
 * The real `licenceStatus`, `licences.ts` and `@imani/licence` all run. Only the
 * wallet STORE is stubbed — it is IndexedDB, and stubbing the check itself
 * would leave the gate untested, which is the entire ticket.
 */

const CUSTOMER = 'b'.repeat(64)
const SOLD_AT = 1_800_000_000
const YEAR = 365 * 86400

let rows: VoucherRow[] = []
let txRows: Array<Record<string, unknown>> = []
let storeThrows = false
let walletListeners: Array<() => void> = []

vi.mock('../../lib/wallet', () => ({
  listVouchers: async () => {
    if (storeThrows) throw new Error('storage unavailable')
    return rows
  },
  listTransactions: async () => txRows,
  onWalletChanged: (listener: () => void) => {
    walletListeners.push(listener)
    return () => {
      walletListeners = walletListeners.filter((l) => l !== listener)
    }
  },
}))

import type { LicenceTerms } from '../../lib/licenceIssue'

const { SubscriptionPage } = await import('../SubscriptionPage')
const { licenceIssueParams } = await import('../../lib/licenceIssue')
const { buildLicenceVoucherToken: buildVoucherToken } = await import('../../lib/__tests__/voucherFixtures')
const { forgetLicenceParses } = await import('../../lib/licences')
const { forgetVerification } = await import('../../lib/licenceStatus')

function terms(over: Partial<LicenceTerms> = {}): LicenceTerms {
  return {
    lockKey: CUSTOMER,
    subscriptionId: 'sub_9f2c11',
    paidAmountMinor: 4000,
    paidCurrency: 'GBP',
    ...over,
  }
}

function idFor(token: string): string {
  let hash = 0
  for (let i = 0; i < token.length; i += 1) {
    hash = (Math.imul(hash, 31) + token.charCodeAt(i)) | 0
  }
  return `id-${hash}`
}

/**
 * A real signed licence.
 *
 * The issuer key is the fixture's own, so the screen must be told to expect it.
 * `VITE_LICENCE_ISSUER_PUBKEY` is a build-time constant, so the test sets it on
 * `import.meta.env` before the module reads it — which is why `licenceStatus`
 * takes an override at all.
 */
function mintRow(t: LicenceTerms, expiresAt: number) {
  const params = licenceIssueParams(t)
  const built = buildVoucherToken({
    merchantMetadata: params.merchantMetadata,
    faceValue: params.faceValueMinor,
    unit: params.currency,
    expiresAt,
  })
  const row: VoucherRow = {
    token_id: idFor(built.token),
    token: built.token,
    amount: 1782,
    face_value: params.faceValueMinor,
    face_unit: params.currency,
    face_decimals: 2,
    token_amount: 1782,
    issuer_id: built.voucher.issuerPublicKey,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
  return { row, issuerPublicKey: built.voucher.issuerPublicKey }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SubscriptionPage pubkey={CUSTOMER} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  rows = []
  txRows = []
  // The screen first asks the subscription site for a newer catalog. No site here: answer at once.
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
  storeThrows = false
  walletListeners = []
  forgetLicenceParses()
  forgetVerification(CUSTOMER)
  // The screen reads the real clock, so the fixtures are dated around a fixed
  // "now" rather than the clock being faked globally.
  vi.setSystemTime(SOLD_AT * 1000)
})

afterEach(() => {
  cleanup()
  forgetVerification(CUSTOMER)
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('reaching the screen without a subscription', () => {
  it('refuses with the REAL check, not a hidden route', async () => {
    // No licence in the store, and the screen is reachable. The refusal has to
    // be the licence check's own answer — if this screen were merely unlisted,
    // the gate would never be exercised at all.
    renderPage()

    expect(await screen.findByText('Not active')).toBeTruthy()
    expect(screen.getByText(/No subscription has arrived on this device yet\./)).toBeTruthy()
  })

  it('says how to get one, rather than offering a button that does nothing', async () => {
    // Where the site is comes from this environment's build config, never from code.
    vi.stubEnv('VITE_SUBSCRIPTION_SITE_URL', 'https://plans.example.test/')
    renderPage()

    await screen.findByText('Not active')
    // Bought on the subscription site, its own origin, in a named tab the wallet signs in (#411).
    const link = screen.getByRole('link', { name: 'Upgrade my plan' })
    expect(link.getAttribute('href')).toBe('https://plans.example.test')
    expect(link.getAttribute('target')).toBe('imani-subscription')
    // The opener is kept on purpose: it is the channel the wallet signs the site's login over.
    expect(link.getAttribute('rel')).toBe('opener')
    vi.unstubAllEnvs()
  })

  it('a build with no subscription site says so, and links nowhere', async () => {
    vi.stubEnv('VITE_SUBSCRIPTION_SITE_URL', '')
    renderPage()

    await screen.findByText('Not active')
    expect(screen.queryByRole('link', { name: 'Upgrade my plan' })).toBeNull()
    expect(screen.getByText(/no subscription site is set up/)).toBeTruthy()
    vi.unstubAllEnvs()
  })

  it('refuses a licence that is not ours, however well-formed', async () => {
    const { row } = mintRow(terms(), SOLD_AT + YEAR)
    rows = [row]
    // The deployment expects a DIFFERENT issuer: the default empty key.
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', 'f'.repeat(64))

    renderPage()

    expect(await screen.findByText('Not active')).toBeTruthy()
    expect(screen.getByText(/was not issued by us/)).toBeTruthy()
  })
})

describe('a licence that arrived', () => {
  it('says Cancelled, when it ends and that it will not renew, once the seller says so (#407)', async () => {
    const { rememberSubscriptionStatus } = await import('../../lib/subscriptionStatusStore')
    const { subscriptionStatusJson } = await import('../../lib/subscriptionStatus')
    const { row, issuerPublicKey } = mintRow(terms(), SOLD_AT + YEAR)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    localStorage.clear()
    rememberSubscriptionStatus(CUSTOMER, subscriptionStatusJson({ subscriptionId: 'sub_9f2c11', status: 'cancelled', endsAt: SOLD_AT + YEAR, at: SOLD_AT }))

    renderPage()

    expect(await screen.findByText('Cancelled')).toBeTruthy()
    expect(screen.queryByText('Active')).toBeNull()
    expect(screen.getByText(/works until .* and will not renew/)).toBeTruthy()
    expect(screen.getByText('No, cancelled')).toBeTruthy()
    expect(screen.getByText('Ends')).toBeTruthy()
    // Still paid for: the licence keeps granting, so the plan still works.
    expect(screen.getByText('terminals')).toBeTruthy()
  })

  it('goes back to Active when the cancellation is undone, without a reload', async () => {
    const { rememberSubscriptionStatus } = await import('../../lib/subscriptionStatusStore')
    const { subscriptionStatusJson } = await import('../../lib/subscriptionStatus')
    const { row, issuerPublicKey } = mintRow(terms(), SOLD_AT + YEAR)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    localStorage.clear()
    rememberSubscriptionStatus(CUSTOMER, subscriptionStatusJson({ subscriptionId: 'sub_9f2c11', status: 'cancelled', at: SOLD_AT }))

    renderPage()
    await screen.findByText('Cancelled')
    act(() => {
      rememberSubscriptionStatus(CUSTOMER, subscriptionStatusJson({ subscriptionId: 'sub_9f2c11', status: 'active', at: SOLD_AT + 60 }))
    })
    expect(await screen.findByText('Active')).toBeTruthy()
    expect(screen.getByText('Yes')).toBeTruthy()
  })

  it('ignores a status for another subscription', async () => {
    const { rememberSubscriptionStatus } = await import('../../lib/subscriptionStatusStore')
    const { subscriptionStatusJson } = await import('../../lib/subscriptionStatus')
    const { row, issuerPublicKey } = mintRow(terms(), SOLD_AT + YEAR)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    localStorage.clear()
    rememberSubscriptionStatus(CUSTOMER, subscriptionStatusJson({ subscriptionId: 'sub_other', status: 'cancelled', at: SOLD_AT }))

    renderPage()

    expect(await screen.findByText('Active')).toBeTruthy()
  })

  it('unlocks the screen with no step the customer takes', async () => {
    const { row, issuerPublicKey } = mintRow(terms(), SOLD_AT + YEAR)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)

    renderPage()

    expect(await screen.findByText('Active')).toBeTruthy()
    expect(screen.getByText(/active and was confirmed just now/)).toBeTruthy()
  })

  it('names what it unlocks, until when, and which subscription', async () => {
    const { row, issuerPublicKey } = mintRow(terms(), SOLD_AT + YEAR)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)

    renderPage()

    await screen.findByText('Active')
    expect(screen.getByText('terminals')).toBeTruthy()
    // The thread support follows, which survives renewal and re-issue.
    expect(screen.getByText('sub_9f2c11')).toBeTruthy()
    expect(screen.getByText('Until')).toBeTruthy()
  })

  it('appears when the licence is DELIVERED, without a reload', async () => {
    // A licence arrives by DM like everything else. "Nothing to activate and no
    // code to type" is only true if the screen notices.
    const { row, issuerPublicKey } = mintRow(terms(), SOLD_AT + YEAR)
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)

    renderPage()
    expect(await screen.findByText('Not active')).toBeTruthy()

    rows = [row]
    walletListeners.forEach((l) => l())

    expect(await screen.findByText('Active')).toBeTruthy()
  })
})

describe('letting it lapse', () => {
  it('locks the screen once the term ends, and says so plainly', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mintRow(terms(), expiresAt)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    vi.setSystemTime((expiresAt + 1) * 1000)

    renderPage()

    expect(await screen.findByText('Not active')).toBeTruthy()
    expect(screen.getByText(/This subscription has ended\./)).toBeTruthy()
    // Still shows the date it ended: that is the support question.
    expect(screen.getByText('Until')).toBeTruthy()
  })

  it('renewing unlocks it again, with nothing reinstalled', async () => {
    const expiresAt = SOLD_AT + YEAR
    const original = mintRow(terms(), expiresAt)
    rows = [original.row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', original.issuerPublicKey)
    vi.setSystemTime((expiresAt + 86400) * 1000)

    renderPage()
    expect(await screen.findByText('Not active')).toBeTruthy()

    // The renewal lands in the same store, same subscription id.
    forgetLicenceParses()
    const renewal = mintRow(terms(), expiresAt + YEAR)
    rows = [original.row, renewal.row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', renewal.issuerPublicKey)

    fireEvent.click(screen.getByText('Check again'))

    await waitFor(() => expect(screen.getByText('Active')).toBeTruthy())
  })
})

describe('when nothing can be checked', () => {
  it('keeps working, and says it could not confirm', async () => {
    const { row, issuerPublicKey } = mintRow(terms(), SOLD_AT + YEAR)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)

    // Verify once, so the window has something to run from.
    renderPage()
    await screen.findByText('Active')

    // Now the store fails, an hour later.
    storeThrows = true
    vi.setSystemTime((SOLD_AT + 3600) * 1000)
    fireEvent.click(screen.getByText('Check again'))

    // A different verdict from "Active", deliberately: a screen that showed the
    // same tick for both could never warn before the window drained.
    await waitFor(() => expect(screen.getByText('Working, unconfirmed')).toBeTruthy())
    expect(screen.getByText(/have not been able to confirm/)).toBeTruthy()
    expect(screen.getByText(/hours left/)).toBeTruthy()
  })

  it('shows no grace deadline while the subscription is healthy', async () => {
    // A device that can check has no window running out, and inventing a
    // countdown would invent an anxiety.
    const { row, issuerPublicKey } = mintRow(terms(), SOLD_AT + YEAR)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)

    renderPage()

    await screen.findByText('Active')
    expect(screen.queryByText('Offline until')).toBeNull()
  })
})

describe('what a person reads', () => {
  it('never shows a reason code', async () => {
    const cases: Array<() => void> = [
      () => {
        rows = []
      },
      () => {
        const { row } = mintRow(terms(), SOLD_AT + YEAR)
        rows = [row]
        vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', 'f'.repeat(64))
      },
      () => {
        const { row, issuerPublicKey } = mintRow(terms({ lockKey: 'c'.repeat(64) }), SOLD_AT + YEAR)
        rows = [row]
        vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
      },
    ]

    for (const setup of cases) {
      cleanup()
      forgetLicenceParses()
      setup()
      renderPage()
      await screen.findByText('Not active')

      // The internal vocabulary — wrong-issuer, grace-elapsed, no-features —
      // must never reach a merchant's screen.
      for (const code of ['wrong-issuer', 'wrong-key', 'grace-elapsed', 'never-verified', 'absent']) {
        expect(screen.queryByText(new RegExp(code))).toBeNull()
      }
    }
  })
})

describe('a subscription the seller revoked (review of imani-wallet#226, W-1)', () => {
  it('says "Not active" and "revoked by the seller", and keeps the subscription id for support', async () => {
    const { rememberRevocation, forgetRevocations } = await import('../../lib/licenceRevocations')
    const { row, issuerPublicKey } = mintRow(terms(), SOLD_AT + YEAR)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    // The fixture's licence names its gateway key as the seller (issuer_id).
    rememberRevocation(CUSTOMER, 'sub_9f2c11', issuerPublicKey, SOLD_AT)

    try {
      renderPage()

      expect(await screen.findByText('Not active')).toBeTruthy()
      expect(screen.getByText(/revoked by the seller/)).toBeTruthy()
      expect(screen.getByText('sub_9f2c11')).toBeTruthy()
    } finally {
      forgetRevocations(CUSTOMER)
    }
  })
})

describe('the plan (#407)', () => {
  it('shows a free stall its one-off allowance and what it has used of it', async () => {
    txRows = [{ id: 'issued:a', type: 'issued', direction: 'out', timestamp: SOLD_AT * 1000, amount: 8200, unit: 'GBP' }]
    render(
      <MemoryRouter>
        <SubscriptionPage pubkey={CUSTOMER} currency="GBP" />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Starter')).toBeTruthy()
    expect(screen.getByText(/82\.00 of .*100\.00/)).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('82')
    expect(screen.getByText('1 besides this device')).toBeTruthy()
  })
})
