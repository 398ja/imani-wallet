/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

/**
 * #389: a send whose initiate answer was lost is resolved with the gateway on the next start (and
 * before logout, which runs the same reconcile), instead of holding logout off for 24 hours.
 */
const stubs = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  rows: [] as unknown[],
  saved: [] as VoucherRow[],
  removed: [] as string[],
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    getVoucher: async (id: string) => (stubs.rows as VoucherRow[]).find((r) => r.token_id === id) ?? null,
    removeVoucher: async (id: string) => {
      stubs.removed.push(id)
      return true
    },
    saveVoucher: async (row: VoucherRow) => void stubs.saved.push(row),
    addTransaction: async () => undefined,
  }),
  listVouchers: async () => stubs.rows,
  notifyWalletChanged: () => {},
}))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => stubs.api }))
vi.mock('../transferSignature', () => ({ sendTransferSignature: async () => true }))
vi.mock('../txRecords', () => ({ publishTx: async () => undefined }))

const { reconcilePendingSends, resolveSendIntents, loadPendingSends, INTENT_HISTORY_PAGE } = await import('../pay')
const { keyForSend, loadSendIntents, INTENT_ARRIVAL_GRACE_MS } = await import('../sendIntent')
const { moneyInFlight } = await import('../inFlightMoney')

const PAYER = 'a1'.repeat(32)
const FRIEND = 'b2'.repeat(32)
const ISSUER = 'f'.repeat(64)
const TOKEN_ID = 'c'.repeat(32)
const send = { recipientPubkey: FRIEND, amount: 300, voucherId: 'v-1', memo: 'lunch' }
const pending = { tokenId: TOKEN_ID, unit: 'EUR', decimals: 2, merchantPubkey: ISSUER, sourceFaceValue: 500 }
const row = {
  token_id: TOKEN_ID,
  token: `cashuB${'o'.repeat(30)}`,
  voucher_id: 'v-1',
  face_value: 500,
  face_unit: 'EUR',
  face_decimals: 2,
  issuer_id: ISSUER,
  status: 'active',
} as unknown as VoucherRow

/** Store an intent as if its POST went out `ageMs` ago and the answer never came. */
function lostAnswer(ageMs: number, withPending = true): string {
  const key = keyForSend(PAYER, send, withPending ? pending : undefined)
  const stored = JSON.parse(localStorage.getItem(`imani-wallet:send-intents:${PAYER}`)!)
  stored[0].at = Date.now() - ageMs
  localStorage.setItem(`imani-wallet:send-intents:${PAYER}`, JSON.stringify(stored))
  return key
}

const historyRow = (over: Record<string, unknown> = {}) => ({
  send_id: 'as_found',
  recipient_pubkey: FRIEND,
  amount: 300,
  voucher_id: 'v-1',
  status: 'COMPLETED',
  created_at: new Date(Date.now() - 30_000).toISOString(),
  ...over,
})

beforeEach(() => {
  localStorage.clear()
  for (const k of Object.keys(stubs.api)) delete stubs.api[k]
  stubs.rows = [row]
  stubs.saved.length = 0
  stubs.removed.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('a lost-answer send is resolved on the next start (#389)', () => {
  it('found in the history: settled as a send, the intent cleared, nothing in flight', async () => {
    lostAnswer(60_000)
    const acked: string[] = []
    const keep = `cashuB${'k'.repeat(30)}`
    Object.assign(stubs.api, {
      getAtomicSendHistory: async () => [historyRow()],
      getAtomicSendStatus: async (id: string) => ({ status: 'COMPLETED', keep_token: keep, keep_face_value: 200, is_full_send: false, send_id: id }),
      ackKeepToken: async (id: string) => void acked.push(id),
      initiateAtomicSend: vi.fn(),
    })
    expect(moneyInFlight(PAYER)).toMatchObject({ sends: 1, unanswered: 1 })

    expect(await reconcilePendingSends(PAYER)).toBe(1)

    expect(loadSendIntents(PAYER)).toEqual([])
    expect(loadPendingSends(PAYER)).toEqual([])
    expect(stubs.saved[0]).toMatchObject({ token: keep, face_value: 200 })
    expect(acked).toEqual(['as_found'])
    // Looked up, never re-sent: a POST would START a send that never arrived.
    expect(stubs.api.initiateAtomicSend).not.toHaveBeenCalled()
    expect(moneyInFlight(PAYER)).toMatchObject({ sends: 0, unanswered: 0 })
  })

  it('found but still running: moves to the pending ledger with its send id, the intent cleared', async () => {
    lostAnswer(60_000)
    Object.assign(stubs.api, {
      getAtomicSendHistory: async () => [historyRow({ status: 'TOKEN_HELD' })],
      getAtomicSendStatus: async () => ({ status: 'TOKEN_HELD' }),
      ackKeepToken: async () => undefined,
    })
    await reconcilePendingSends(PAYER)
    expect(loadSendIntents(PAYER)).toEqual([])
    expect(loadPendingSends(PAYER)).toMatchObject([{ sendId: 'as_found', tokenId: TOKEN_ID, recipientPubkey: FRIEND, amount: 300 }])
    // Still money in flight, but now a send the gateway accepted, not an unanswered one.
    expect(moneyInFlight(PAYER)).toMatchObject({ sends: 1, unanswered: 0 })
  })

  it('an intent from an older build (no source row stored) finds its coupon by voucher id', async () => {
    lostAnswer(60_000, false)
    Object.assign(stubs.api, { getAtomicSendHistory: async () => [historyRow({ status: 'TOKEN_HELD' })], getAtomicSendStatus: async () => ({ status: 'TOKEN_HELD' }) })
    await reconcilePendingSends(PAYER)
    expect(loadPendingSends(PAYER)).toMatchObject([{ sendId: 'as_found', tokenId: TOKEN_ID, merchantPubkey: ISSUER }])
  })

  it('not in a complete history once past the grace: it never arrived, the intent is cleared', async () => {
    lostAnswer(INTENT_ARRIVAL_GRACE_MS + 1000)
    Object.assign(stubs.api, { getAtomicSendHistory: async () => [historyRow({ voucher_id: 'other' })] })
    expect(await resolveSendIntents(PAYER)).toEqual({ arrived: 0, neverArrived: 1, unknown: 0 })
    expect(loadSendIntents(PAYER)).toEqual([])
    expect(loadPendingSends(PAYER)).toEqual([])
  })

  it('a send made BEFORE the intent is not taken for it', async () => {
    lostAnswer(INTENT_ARRIVAL_GRACE_MS + 1000)
    Object.assign(stubs.api, { getAtomicSendHistory: async () => [historyRow({ created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() })] })
    expect(await resolveSendIntents(PAYER)).toMatchObject({ arrived: 0, neverArrived: 1 })
    expect(loadPendingSends(PAYER)).toEqual([])
  })

  it('two intents of one identity and one send in the history: only one is taken as arrived', async () => {
    lostAnswer(10_000)
    keyForSend(PAYER, { ...send, memo: 'dinner' }, pending)
    Object.assign(stubs.api, { getAtomicSendHistory: async () => [historyRow({ status: 'TOKEN_HELD' })], getAtomicSendStatus: async () => ({ status: 'TOKEN_HELD' }) })
    expect(await resolveSendIntents(PAYER)).toMatchObject({ arrived: 1, unknown: 1 })
    expect(loadSendIntents(PAYER)).toHaveLength(1)
  })

  it('still unknown: within the grace the request may be on its way, so it is kept', async () => {
    lostAnswer(10_000)
    Object.assign(stubs.api, { getAtomicSendHistory: async () => [] })
    expect(await resolveSendIntents(PAYER)).toEqual({ arrived: 0, neverArrived: 0, unknown: 1 })
    expect(loadSendIntents(PAYER)).toHaveLength(1)
  })

  it('still unknown: the gateway cannot be reached', async () => {
    lostAnswer(INTENT_ARRIVAL_GRACE_MS + 1000)
    Object.assign(stubs.api, {
      getAtomicSendHistory: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(await resolveSendIntents(PAYER)).toMatchObject({ unknown: 1 })
    expect(loadSendIntents(PAYER)).toHaveLength(1)
    expect(moneyInFlight(PAYER)).toMatchObject({ sends: 1, unanswered: 1 })
  })

  it('still unknown: a full history page that does not reach back to the intent', async () => {
    lostAnswer(INTENT_ARRIVAL_GRACE_MS + 1000)
    const recent = Array.from({ length: INTENT_HISTORY_PAGE }, (_, i) => historyRow({ send_id: `as_${i}`, voucher_id: `x-${i}`, created_at: new Date().toISOString() }))
    Object.assign(stubs.api, { getAtomicSendHistory: async () => recent })
    expect(await resolveSendIntents(PAYER)).toMatchObject({ unknown: 1 })
    expect(loadSendIntents(PAYER)).toHaveLength(1)
  })
})
