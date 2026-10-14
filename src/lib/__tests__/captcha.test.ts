// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CAPTCHA_HEADER,
  CASHBACK_LOOKUP_ACTION,
  captchaHeaders,
  captchaToken,
  resetCaptchaForTests,
} from '../captcha'

/**
 * lib/captcha.ts never decides anything: it returns a token or nothing, fast, and never throws.
 * Whether a missing token is refused is the edge's call. These tests hold it to that.
 */

type Exec = (action?: string) => Promise<{ success?: boolean; token?: string | null }>

/** Make the next appended <script> "load" and define a stub FCaptcha with the given execute. */
function serveWidget(execute: Exec | null, onLoad: 'load' | 'error' | 'never' = 'load') {
  const configure = vi.fn()
  const invisible = vi.fn(() => ({ execute: vi.fn(execute ?? (async () => ({}))), destroy: vi.fn() }))
  const append = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
    const script = node as HTMLScriptElement
    queueMicrotask(() => {
      if (onLoad === 'load') {
        if (execute) (globalThis as { FCaptcha?: unknown }).FCaptcha = { configure, invisible }
        script.onload?.(new Event('load'))
      } else if (onLoad === 'error') {
        script.onerror?.(new Event('error'))
      }
    })
    return node
  })
  return { configure, invisible, append }
}

afterEach(() => {
  resetCaptchaForTests()
  delete (globalThis as { FCaptcha?: unknown }).FCaptcha
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('captcha token for the cashback lookup', () => {
  it('loads the same-origin widget once, configured for the same-origin API', async () => {
    const { configure, invisible, append } = serveWidget(async () => ({ success: true, token: 't1' }))

    expect(await captchaToken()).toBe('t1')
    expect(await captchaToken()).toBe('t1')

    expect(append).toHaveBeenCalledTimes(1)
    expect((append.mock.calls[0][0] as HTMLScriptElement).src).toMatch(/\/fcaptcha\/fcaptcha\.js$/)
    expect(configure).toHaveBeenCalledWith({ serverUrl: '/fcaptcha' })
    expect(invisible).toHaveBeenCalledTimes(1)
    expect(invisible).toHaveBeenCalledWith(expect.objectContaining({ siteKey: 'imani-wallet', autoScore: false }))
  })

  it('asks for the action the edge gate accepts, and puts the token in its header', async () => {
    const execute = vi.fn<Exec>(async () => ({ success: true, token: 'tok' }))
    serveWidget(execute)

    expect(await captchaHeaders()).toEqual({ [CAPTCHA_HEADER]: 'tok' })
    expect(execute).toHaveBeenCalledWith(CASHBACK_LOOKUP_ACTION)
    expect(CASHBACK_LOOKUP_ACTION).toBe('cashback_lookup')
    expect(CAPTCHA_HEADER).toBe('X-Imani-Captcha')
  })

  it('sends no header when the server scores the visitor as a bot (no token)', async () => {
    serveWidget(async () => ({ success: false, token: null }))
    expect(await captchaHeaders()).toEqual({})
  })

  it('sends no header, and does not throw, when the solver throws', async () => {
    serveWidget(async () => {
      throw new Error('worker died')
    })
    expect(await captchaHeaders()).toEqual({})
  })

  it('switches itself off on a deployment with no gate (the script defines no FCaptcha)', async () => {
    const { append } = serveWidget(null)
    expect(await captchaToken()).toBeNull()
    expect(await captchaToken()).toBeNull()
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('switches itself off when the script fails to load', async () => {
    serveWidget(null, 'error')
    expect(await captchaToken()).toBeNull()
  })

  it('never makes a lookup wait longer than its budget', async () => {
    vi.useFakeTimers()
    serveWidget(() => new Promise(() => {}))
    const pending = captchaToken(CASHBACK_LOOKUP_ACTION, 1_000)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(await pending).toBeNull()
  })
})
