/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #112: a voucher the gateway settled but this device did not save must be
 * shown (held warning + bell row, with the receive id), reported to the
 * operator, and remembered across logout for that account only.
 */

const toasts = vi.hoisted(() => ({
  warnings: [] as Array<{ title: string; opts: Record<string, unknown> }>,
}))
vi.mock('sonner', () => ({
  toast: {
    warning: (title: string, opts: Record<string, unknown>) => toasts.warnings.push({ title, opts }),
  },
}))

import {
  announceUnsaved,
  dropAcknowledgedReceipts,
  isKeptAcrossLogout,
  listUnsavedReceipts,
  resumeUnsavedReceipts,
} from '../unsavedReceipt'
import { _resetInboxCacheForTests, clearNotifications, listNotifications } from '../notifications/inbox'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const event = { eventId: 'evt-1', senderPubkey: 'c'.repeat(64), receiveId: 'rcv-123', reason: 'RECEIVE_ALREADY_SETTLED' }

beforeEach(() => {
  localStorage.clear()
  _resetInboxCacheForTests()
  toasts.warnings.length = 0
  vi.restoreAllMocks()
})

describe('announceUnsaved', () => {
  it('holds a warning toast until dismissed, quoting the receive id, in voucher wording', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    announceUnsaved(ALICE, event)

    expect(toasts.warnings).toHaveLength(1)
    const { title, opts } = toasts.warnings[0]!
    expect(title).toMatch(/voucher/i)
    expect(opts.duration).toBe(Infinity)
    expect(String(opts.description)).toContain('rcv-123')
    expect(String(opts.description)).toMatch(/not saved on this device/)
    expect(String(opts.description)).toMatch(/support/)
  })

  it('files an unread bell row carrying the receive id', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    announceUnsaved(ALICE, event)

    const rows = listNotifications(ALICE)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toContain('rcv-123')
    expect(rows[0]!.readAt).toBeNull()
  })

  it('reports to the operator as a structured console.error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    announceUnsaved(ALICE, event)

    expect(err).toHaveBeenCalledWith(
      '[unsaved-receipt] RECEIVE_SETTLED_NOT_SAVED',
      expect.objectContaining({ receiveId: 'rcv-123', eventId: 'evt-1', reason: 'RECEIVE_ALREADY_SETTLED' }),
    )
  })

  it('still warns without a receive id, and never throws on junk', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    announceUnsaved(ALICE, { eventId: 'evt-2', receiveId: null })
    expect(toasts.warnings).toHaveLength(1)
    expect(() => announceUnsaved(ALICE, undefined)).not.toThrow()
    expect(() => announceUnsaved('', event)).not.toThrow()
    expect(toasts.warnings).toHaveLength(1)
  })
})

describe('the record across logout', () => {
  it('is exempt from the logout sweep, and nothing else is', () => {
    expect(isKeptAcrossLogout(`imani-wallet:unsaved-receipts:${ALICE}`)).toBe(true)
    expect(isKeptAcrossLogout('imani-wallet:unsaved-receipts:')).toBe(false)
    expect(isKeptAcrossLogout(`imani-wallet:receive-ledger:${ALICE}`)).toBe(false)
    expect(isKeptAcrossLogout(`imani-wallet:notifications:${ALICE}`)).toBe(false)
  })

  it('is keyed by account: another account on the device sees nothing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    announceUnsaved(ALICE, event)

    expect(listUnsavedReceipts(ALICE).map((r) => r.receiveId)).toEqual(['rcv-123'])
    expect(listUnsavedReceipts(BOB)).toEqual([])
    resumeUnsavedReceipts(BOB)
    expect(listNotifications(BOB)).toEqual([])
  })

  it('re-files the bell row at the next sign-in after the inbox was swept', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    announceUnsaved(ALICE, event)
    clearNotifications(ALICE)
    expect(listNotifications(ALICE)).toEqual([])

    resumeUnsavedReceipts(ALICE)
    expect(listNotifications(ALICE).map((r) => r.body).join()).toContain('rcv-123')
  })
})

describe('dropAcknowledgedReceipts (#560)', () => {
  const seed = () => {
    announceUnsaved(ALICE, { ...event, eventId: 'evt-acked', receiveId: 'rcv-acked' })
    announceUnsaved(ALICE, { ...event, eventId: 'evt-held', receiveId: 'rcv-held' })
    announceUnsaved(ALICE, { ...event, eventId: 'evt-noid', receiveId: null })
  }
  const rowIds = () => listNotifications(ALICE).map((n) => n.id).sort()

  it('drops the record and bell row of a receive the gateway reports ACKNOWLEDGED', async () => {
    seed()
    const lookup = vi.fn(async () => ({ statuses: { 'rcv-acked': 'ACKNOWLEDGED', 'rcv-held': 'HELD' } }))

    const dropped = await dropAcknowledgedReceipts(ALICE, lookup)

    expect(dropped).toBe(1)
    expect(lookup).toHaveBeenCalledWith(expect.arrayContaining(['rcv-acked', 'rcv-held']))
    expect(listUnsavedReceipts(ALICE).map((r) => r.eventId).sort()).toEqual(['evt-held', 'evt-noid'])
    expect(rowIds()).toEqual(['unsaved:evt-noid', 'unsaved:rcv-held'])
  })

  it('keeps everything when the gateway has no route or fails', async () => {
    seed()
    const before = listUnsavedReceipts(ALICE)
    const dropped = await dropAcknowledgedReceipts(ALICE, async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    })
    expect(dropped).toBe(0)
    expect(listUnsavedReceipts(ALICE)).toEqual(before)
    expect(rowIds()).toHaveLength(3)
  })

  it('does not call the gateway when no record has a receive id, nor touch another account', async () => {
    announceUnsaved(ALICE, { ...event, receiveId: null })
    announceUnsaved(BOB, { ...event, receiveId: 'rcv-acked' })
    const lookup = vi.fn(async () => ({ statuses: { 'rcv-acked': 'ACKNOWLEDGED' } }))
    expect(await dropAcknowledgedReceipts(ALICE, lookup)).toBe(0)
    expect(lookup).not.toHaveBeenCalled()
    expect(listUnsavedReceipts(BOB)).toHaveLength(1)
  })
})
