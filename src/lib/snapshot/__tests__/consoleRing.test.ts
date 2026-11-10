/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'

import { clearConsole, installConsoleRing, recentConsole, recordConsole, uninstallConsoleRing } from '../consoleRing'
import { buildSnapshot } from '../build'
import { CANARY, FRIEND_NPUB, PII, SELF, STALL, SUPPORT, seededSources, testSigner } from './fixtures'

/**
 * Console capture for the support snapshot (owner decision 2026-11-10: on by default). Every entry is
 * reduced on the way in, so neither the ring nor data/console.json can hold what the app logged
 * verbatim: a tag the code uses, a message the code wrote (or <message>), and typed placeholders.
 */
const N = 'brackenridge'
const T = Date.now()
const opts = { includeMemos: false, ticket: 'T1', codeRef: 'c'.repeat(64), supportPubkey: SUPPORT, ttlSeconds: 604800, signer: testSigner } as never

async function consoleJson(): Promise<string> {
  const s = seededSources()
  s.console = recentConsole()
  const z = unzipSync((await buildSnapshot(s, opts)).zip)
  return strFromU8(z['data/console.json'])
}

describe('console ring (#589, console capture)', () => {
  beforeEach(() => clearConsole())
  afterEach(() => uninstallConsoleRing())

  it('keeps level, tag and a message the code wrote, with values as typed placeholders', () => {
    recordConsole('warn', ['[dmPoll] attestation failed', new TypeError('boom ' + STALL)], T)
    const [row] = recentConsole()
    expect(row.level).toBe('warn')
    expect(row.tag).toBe('dmPoll')
    expect(row.message).toBe('[dmPoll] attestation failed')
    expect(row.args).toEqual([{ t: 'error', name: 'TypeError' }])
    expect(JSON.stringify(row)).not.toContain(STALL)
  })

  it('a message the code did not write becomes <message>, its tag kept only if the code uses it', () => {
    recordConsole('info', ['[pay] thanks ' + N], T)
    recordConsole('info', ['[' + N + '] hello'], T + 1)
    recordConsole('log', [N + ' says hi'], T + 2)
    const rows = recentConsole()
    expect(rows[0]).toMatchObject({ tag: 'pay', message: '<message>' })
    expect(rows[1]).toMatchObject({ tag: 'other', message: '<message>' })
    expect(rows[2]).toMatchObject({ tag: 'untagged', message: '<message>' })
    expect(JSON.stringify(rows).toLowerCase()).not.toContain(N)
  })

  it('a template literal from the code keeps its shape with the filled-in value replaced', () => {
    recordConsole('warn', ['[pay] pending send as_x1y2z3w4 ended as FAILED.'], T)
    expect(recentConsole()[0].message).toBe('[pay] pending send <value> ended as <value>.<value>')
  })

  it('a template that is only placeholders never matches arbitrary text', () => {
    recordConsole('warn', ['[DmPollService] thanks ' + N], T)
    expect(recentConsole()[0].message).toBe('<message>')
  })

  it('arguments: ids are typed, never persisted raw; numbers and booleans stay; the rest is typed', () => {
    recordConsole('warn', ['[cashback] issuance warrant refused:', PII.voucherId, 42, true, CANARY.token, { email: CANARY.email }, PII.sendId, FRIEND_NPUB, null], T)
    const [row] = recentConsole()
    // The token, the email and the object never get past capture, not even in memory.
    for (const v of [CANARY.token, CANARY.email]) expect(JSON.stringify(row)).not.toContain(v)
    expect(row.args.map((a) => a.t)).toEqual(['id', 'number', 'boolean', 'string', 'object', 'id', 'id', 'null'])
    expect(row.args[1]).toEqual({ t: 'number', v: 42 })
    // Ids are held in memory only so the builder can name them; what reaches disk has none.
    const stored = localStorage.getItem('imani-wallet:console-ring') ?? ''
    for (const v of [PII.voucherId, CANARY.token, CANARY.email, PII.sendId, FRIEND_NPUB]) expect(stored).not.toContain(v)
  })

  it('is bounded, persists only reduced entries, and drops entries older than 24 hours', () => {
    const now = Date.now()
    recordConsole('info', ['[app] old'], now - 25 * 3600_000)
    for (let i = 0; i < 520; i++) recordConsole('info', ['[pay] x ' + PII.phone], now)
    const rows = recentConsole(now)
    expect(rows.length).toBe(500)
    expect(rows.every((r) => r.at >= now - 24 * 3600_000)).toBe(true)
    const stored = localStorage.getItem('imani-wallet:console-ring') ?? ''
    expect(stored).not.toContain(PII.phone)
  })

  it('wraps the console without changing what the developer sees', () => {
    const seen: unknown[][] = []
    const target = { log: (...a: unknown[]) => seen.push(a), info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
    installConsoleRing(target as unknown as Console)
    target.log('[pay] visible', STALL)
    expect(seen).toEqual([['[pay] visible', STALL]])
    expect(recentConsole()).toHaveLength(1)
  })

  it('reaches data/console.json pseudonymised, and survives finalScan with nothing unclassified', async () => {
    recordConsole('warn', ['[cashback] issuance warrant refused:', PII.voucherId], Date.now())
    recordConsole('error', ['[pay] thanks ' + N, SELF], Date.now())
    const text = await consoleJson()
    expect(text).toContain('voucher#')
    expect(text.toLowerCase()).not.toContain(N)
    for (const v of [PII.voucherId, SELF]) expect(text).not.toContain(v)
  })
})
