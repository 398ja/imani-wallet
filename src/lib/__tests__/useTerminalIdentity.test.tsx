/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { useTerminalIdentity } from '../useTerminalIdentity'
import { parseVoucherToken } from '../voucherToken'
import { SESSION_KIND } from '../terminalSession'
import { TERMINAL_ROLES } from '../terminalRole'

/**
 * The hook that finally makes ticket 07's gating reachable.
 *
 * Until this existed `App` rendered the till with no actor and no session, so
 * the role gating and the lapse notice were correct code no user could reach.
 * These assert the two shapes that matter: the owner's own device must be
 * completely unaffected, and a terminal must get the authority its REAL
 * credential confers.
 */

const TOKEN = readFileSync(
  join(__dirname, 'fixtures', 'live-terminal-credential.token'),
  'utf8',
).trim()
const parsed = parseVoucherToken(TOKEN)
/**
 * What the minting script SENT, recorded beside the token. Hardcoded hex here
 * meant re-minting the fixture — which the live spend probe requires, since a
 * swap consumes the proof — failed four tests over a credential that was valid.
 */
const MINTED = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'live-terminal-credential.json'), 'utf8'),
) as { stall: string; device: string }
const DEVICE = MINTED.device
const STALL = MINTED.stall

const ENROLMENT_KEY = 'imani-wallet:terminal'

function enrol(over: Record<string, unknown> = {}) {
  localStorage.setItem(
    ENROLMENT_KEY,
    JSON.stringify({
      stallPubkey: STALL,
      role: TERMINAL_ROLES.REDEEM_ONLY,
      terminalPubkey: DEVICE,
      permissions: [`voucher:redeem:${STALL}`],
      enrolledAt: 1_000_000,
      token: TOKEN,
      merchantMetadata: parsed.voucher.merchantMetadata,
      issuerId: parsed.voucher.issuerId,
      ...over,
    }),
  )
}

const mint = (state: string) => ({ validateToken: vi.fn(async () => ({ state })) })

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('the stall’s own device', () => {
  it('is not a terminal, and settles immediately', () => {
    /**
     * The overwhelmingly common case. `ready` is true on the FIRST render with
     * no async work at all, because the owner's till must not wait on a
     * question that cannot change its answer.
     */
    const { result } = renderHook(() => useTerminalIdentity())

    expect(result.current.actor).toBeNull()
    expect(result.current.session).toBeNull()
    expect(result.current.ready).toBe(true)
  })

  it('never asks the mint anything', () => {
    const api = mint('UNSPENT')
    renderHook(() => useTerminalIdentity(api))
    expect(api.validateToken).not.toHaveBeenCalled()
  })
})

describe('a device enrolled before the credential was stored', () => {
  it('behaves as the owner’s device rather than as a broken terminal', async () => {
    // A ticket-04 record has no token. It must not become a terminal that
    // cannot log in; it stays exactly as the app always behaved.
    enrol({ token: undefined, merchantMetadata: undefined, issuerId: undefined })
    const { result } = renderHook(() => useTerminalIdentity())

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.refusal).toBeNull()
  })
})

describe('a real terminal', () => {
  it('logs in with the authority its credential confers', async () => {
    enrol()
    const { result } = renderHook(() => useTerminalIdentity(mint('UNSPENT')))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).not.toBeNull()
    expect(result.current.actor!.stallPubkey).toBe(STALL)
    expect(result.current.actor!.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(result.current.session!.kind).toBe(SESSION_KIND.FULL)
  })

  it('is refused once the owner has revoked it', async () => {
    // Revocation is the act of spending the credential, so the mint reporting
    // SPENT is the terminal being finished — everywhere, not just here.
    enrol()
    const { result } = renderHook(() => useTerminalIdentity(mint('SPENT')))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.refusal).toMatch(/no longer in service/)
  })

  it('trades on reduced authority when the mint cannot be reached', async () => {
    /**
     * The queue cannot wait for the network to agree. Failing closed here would
     * take a stall off the market every time its connection dropped.
     */
    enrol()
    const api = {
      validateToken: vi.fn(async () => {
        throw new Error('offline')
      }),
    }
    const { result } = renderHook(() => useTerminalIdentity(api))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).not.toBeNull()
    expect(result.current.session!.kind).toBe(SESSION_KIND.REDUCED)
  })

  it('is refused when its record was edited to name another device', async () => {
    // The credential is locked to a key; editing the record around it changes
    // nothing, because login re-derives everything from the signed metadata.
    enrol({ terminalPubkey: 'f'.repeat(64) })
    const { result } = renderHook(() => useTerminalIdentity(mint('UNSPENT')))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.refusal).toMatch(/not for this device/)
  })

  it('ignores permissions widened in the stored record', async () => {
    /**
     * Ticket 10's third criterion, at the point it actually matters. The record
     * on disk is editable by whoever holds the device; the credential is not.
     * A record claiming issuance must still produce a redemption-only terminal.
     */
    enrol({
      role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
      permissions: [`voucher:issue:${STALL}`, `voucher:redeem:${STALL}`],
    })
    const { result } = renderHook(() => useTerminalIdentity(mint('UNSPENT')))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor!.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(result.current.actor!.permissions).not.toContain(`voucher:issue:${STALL}`)
  })
})
