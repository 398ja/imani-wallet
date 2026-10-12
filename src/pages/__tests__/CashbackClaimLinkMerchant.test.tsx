/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * Claim links phase 2 (spec 4.1) on the two merchant screens:
 *  - Cashback ready: the code stays, Show QR reveals the link's QR, Share or Copy hands out the
 *    wallet-origin link, live status turns the QR into "Claimed just now", Cancel asks first;
 *  - the record detail page: Show QR again rebuilds the link from the stored code, and Cancel.
 * The key is never written to storage or logged.
 */

const REF = 'abcd1234efgh5678'
const KEY = 'K'.repeat(43)
const h = vi.hoisted(() => ({
  status: 'Unclaimed' as string,
  statusReads: 0,
  revokes: [] as string[],
  revokeAnswer: { kind: 'revoked' } as { kind: string },
  byCode: [] as string[],
  qrTexts: [] as string[],
  row: null as Record<string, unknown> | null,
  recorded: [] as unknown[],
}))

vi.mock('qrcode', () => ({
  default: {
    toDataURL: async (text: string) => {
      h.qrTexts.push(text)
      return 'data:image/png;base64,QR'
    },
  },
}))
vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  fetchCashbackStatus: async () => {
    h.statusReads += 1
    return { status: h.status }
  },
  revokeCashback: async (id: string) => {
    h.revokes.push(id)
    return h.revokeAnswer
  },
  resolveClaimLinkByCode: async (code: string) => {
    h.byCode.push(code)
    return { kind: 'ok', ref: REF, key: KEY }
  },
}))
// `useCashbackStatus` (the detail page) calls the module's own `fetchCashbackStatus`, which the
// export mock above cannot reach, so its signed read is answered here.
vi.mock('../../lib/nip98', () => ({
  signedFetch: async () => new Response(JSON.stringify({ status: h.status }), { status: 200 }),
}))
vi.mock('../../lib/cashbackIssue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashbackIssue')>()),
  createCashbackIssuer: () => ({
    submit: async () => ({
      cashbackId: 'cb-1',
      claimCode: 'CB-ABCDE-FGHJK',
      amountMinor: 125,
      unit: 'EUR',
      expiresAt: '2026-11-11T00:00:00Z',
      claim: { ref: REF, key: KEY },
    }),
  }),
}))
vi.mock('../../lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/config')>()),
  gatewayConfig: () => new Promise(() => {}),
}))
vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  getTransactionRow: async () => h.row,
  onWalletChanged: () => () => {},
  recheckCashbackRowOnOpen: async () => {},
  recordCashbackStatus: async (...a: unknown[]) => void h.recorded.push(a),
}))

const { CashbackIssuePage } = await import('../CashbackIssuePage')
const { TransactionPage } = await import('../RecordDetailPages')
import type { MerchantProfile } from '../../lib/merchant'

const merchant = {
  pubkey: 'a'.repeat(64),
  active: true,
  categories: [],
  issuanceCurrency: 'EUR',
  voucherValidityDays: 90,
} as unknown as MerchantProfile

const LINK = `${window.location.origin}/c/${REF}#k=${KEY}`

let logged: string[] = []
beforeEach(() => {
  Object.assign(h, { status: 'Unclaimed', statusReads: 0, revokes: [], revokeAnswer: { kind: 'revoked' }, byCode: [], qrTexts: [], recorded: [] })
  logged = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
  }
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'share')
})

function noKeyLeaked() {
  expect(logged.filter((l) => l.includes(KEY))).toEqual([])
  const stored = [...Object.keys(localStorage).map((k) => localStorage.getItem(k)), ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k))]
  expect(stored.filter((v) => v?.includes(KEY))).toEqual([])
  expect(window.location.href).not.toContain(KEY)
}

async function issue() {
  render(
    <MemoryRouter>
      <CashbackIssuePage merchant={merchant} />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1.25' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create cashback code' }))
  await screen.findByText('CB-ABCDE-FGHJK')
}

describe('Cashback ready: the link next to the code', () => {
  it('keeps the code and hides the QR until Show QR is tapped', async () => {
    await issue()
    expect(screen.getByRole('button', { name: /Copy code/ })).toBeTruthy()
    expect(screen.queryByAltText(/QR code to claim/)).toBeNull()
    expect(h.qrTexts).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: /Show QR/ }))
    await screen.findByAltText(/QR code to claim/)
    expect(h.qrTexts).toEqual([LINK])
    expect(screen.getByText(/Anyone with this link or QR can claim it once\. It works until /)).toBeTruthy()
    noKeyLeaked()
  })

  it('shares the wallet-origin link where the system can, copies it otherwise', async () => {
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } })
    await issue()
    fireEvent.click(screen.getByRole('button', { name: /Copy link/ }))
    await screen.findByText(/Link copied/)
    expect(writes).toEqual([LINK])

    cleanup()
    const shared: unknown[] = []
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: unknown) => void shared.push(d) })
    await issue()
    fireEvent.click(screen.getByRole('button', { name: /Share link/ }))
    await waitFor(() => expect(shared).toEqual([{ url: LINK }]))
    noKeyLeaked()
  })

  it('polls the status every 5 s and swaps the QR for "Claimed just now"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await issue()
    fireEvent.click(screen.getByRole('button', { name: /Show QR/ }))
    await screen.findByAltText(/QR code to claim/)
    expect(h.statusReads).toBe(0)
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)))
    expect(h.statusReads).toBe(1)
    h.status = 'Claimed'
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)))
    expect(screen.getByText('Claimed just now')).toBeTruthy()
    expect(screen.queryByAltText(/QR code to claim/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Cancel cashback/ })).toBeNull()
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)))
    expect(h.statusReads).toBe(2)
  })

  it('cancels only after the confirm, with the no-refund words, then stops offering the link', async () => {
    await issue()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel cashback' }))
    expect(h.revokes).toEqual([])
    expect(screen.getByText(/The value is not returned to you\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(h.revokes).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel cashback' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    await screen.findByText(/Cancelled\. The link and the code no longer work\./)
    expect(h.revokes).toEqual(['cb-1'])
    expect(screen.queryByRole('button', { name: /Show QR/ })).toBeNull()
  })

  it('says so when the customer claimed before the cancel landed', async () => {
    h.revokeAnswer = { kind: 'not_revocable' }
    await issue()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel cashback' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    await screen.findByText(/may already have claimed it/)
  })
})

describe('Cashback ready on a till (#160 phase 5)', () => {
  // The portal's /status and /revoke are owner-only (MERCHANT_ONLY), and the edge sends them through
  // the NAP session gate, which a till never has: a till would read 401 forever and its Cancel could
  // only ever fail. The till keeps the code, the QR and the link; the owner cancels from the record.
  it('shows the link but neither polls the status nor offers Cancel', async () => {
    const { TERMINAL_ROLES, grantFor } = await import('../../lib/terminalRole')
    const { SESSION_KIND, openSession } = await import('../../lib/terminalSession')
    const stall = 'a'.repeat(64)
    const till = {
      kind: 'terminal' as const,
      stallPubkey: stall,
      role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
      terminalPubkey: 'c'.repeat(64),
      permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, stall),
      attested: true,
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(
      <MemoryRouter>
        <CashbackIssuePage merchant={merchant} actor={till} session={openSession(till, SESSION_KIND.FULL, Date.now())} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1.25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create cashback code' }))
    await screen.findByText('CB-ABCDE-FGHJK')
    expect(screen.getByRole('button', { name: /Show QR/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Cancel cashback/ })).toBeNull()
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
    expect(h.statusReads).toBe(0)
  })
})

function cashbackRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cashback:cb-1',
    txId: 'cashback:cb-1',
    type: 'cashback',
    direction: 'out',
    timestamp: Date.now(),
    amount: 125,
    unit: 'EUR',
    decimals: 2,
    cashbackId: 'cb-1',
    claimCode: 'CB-ABCDE-FGHJK',
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    merchantId: 'a'.repeat(64),
    ...over,
  }
}

function openRecord() {
  return render(
    <MemoryRouter initialEntries={['/transaction/cashback%3Acb-1']}>
      <Routes>
        <Route path="/transaction/:id" element={<TransactionPage pubkey={'a'.repeat(64)} trading />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('the record detail page', () => {
  it('Show QR again rebuilds the link from the stored code, after a reload, with nothing stored', async () => {
    h.row = cashbackRow()
    openRecord()
    const again = await screen.findByRole('button', { name: 'Show QR again' })
    expect(h.byCode).toEqual([])
    fireEvent.click(again)
    await screen.findByAltText(/QR code to claim/)
    expect(h.byCode).toEqual(['CB-ABCDE-FGHJK'])
    expect(h.qrTexts).toEqual([LINK])
    noKeyLeaked()
  })

  it('offers neither Show QR again nor Cancel once the code is claimed, or before the status is known', async () => {
    h.row = cashbackRow({ cashbackStatus: 'Claimed' })
    openRecord()
    await screen.findByText(/Yes, redeemed by the customer/)
    expect(screen.queryByRole('button', { name: 'Show QR again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel cashback' })).toBeNull()
  })

  it('Cancel cashback revokes and records the row as cancelled', async () => {
    h.row = cashbackRow()
    openRecord()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel cashback' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    await screen.findByText(/No, the code was cancelled/)
    expect(h.revokes).toEqual(['cb-1'])
    expect(h.recorded).toEqual([['cashback:cb-1', { status: 'Revoked' }]])
    expect(screen.queryByRole('button', { name: 'Show QR again' })).toBeNull()
  })
})
