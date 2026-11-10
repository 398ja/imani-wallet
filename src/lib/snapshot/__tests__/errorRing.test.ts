/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { clearErrors, recentErrors, recordError, templateOf } from '../errorRing'
import { CANARY, PII, STALL } from './fixtures'

describe('error ring buffer (#589 phase 1b)', () => {
  beforeEach(() => clearErrors())

  it('keeps only class, code, a templated message and file:line frames', () => {
    const e = new TypeError(`Failed to fetch active keysets: mintUrl=http://mint.example/v1?x=1, status=502, pk=${STALL}, token=${CANARY.token}, mail ${CANARY.email}`)
    ;(e as Error & { code?: string }).code = 'mint_fetch'
    e.stack = `TypeError: x\n    at fetchKeys (http://localhost:5176/src/lib/mintTransport.ts?t=123:88:12)\n    at http://localhost:5176/src/lib/pay.ts:40:3`
    recordError(e, Date.parse('2026-11-09T22:00:00Z'))
    const [row] = recentErrors()
    expect(row.name).toBe('TypeError')
    expect(row.code).toBe('mint_fetch')
    expect(row.frames).toEqual(['src/lib/mintTransport.ts:88:12', 'src/lib/pay.ts:40:3'])
    const text = JSON.stringify(row)
    for (const v of [STALL, CANARY.token, CANARY.email, 'x=1']) expect(text).not.toContain(v)
    expect(row.template).toContain('<url>')
    expect(row.template).toContain('<hex>')
    expect(row.template).toContain('<token>')
    expect(row.template).toContain('<email>')
  })

  it('is bounded and survives a reload through localStorage without raw text', () => {
    for (let i = 0; i < 80; i++) recordError(new Error(`boom ${i} ${PII.phone}`))
    expect(recentErrors().length).toBe(50)
    expect(localStorage.getItem('imani-wallet:error-ring')).not.toContain(PII.phone)
  })

  it('replaces numbers so a template is a template', () => {
    expect(templateOf('status 502 after 3 tries for amount 12000')).toBe('status <n> after <n> tries for amount <n>')
  })
})
