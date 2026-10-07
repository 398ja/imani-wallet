/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fulfilmentOf,
  idleLockMinutesFor,
  idleLockMs,
  paidForStall,
  registerRequestTerms,
  startIdleLock,
  terminalMintApi,
} from '../terminalTill'
import { terminalMetadataJson } from '../terminalCredential'
import { buildLockedCredentialToken } from './voucherFixtures'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

/** The terminal's own clients and its idle lock (#160 phase 3). */

const STALL = 'a'.repeat(64)

afterEach(() => {
  vi.useRealTimers()
})

describe('the fulfilment check (spec 2.5)', () => {
  /** What the till asked for: 500 cents of the stall's money. */
  const REQUEST = { amount: 500, unit: 'EUR' }
  /** gateway-core's answer for a request paid exactly. */
  const PAID = {
    fulfilled: true,
    sendId: 's1',
    issuerId: STALL,
    recipientPubkey: STALL,
    amount: 500,
    unit: 'EUR',
  }

  // The terminal asks gateway-core whether its request was paid, signed by the terminal key, at
  // the path the core controller serves, and keeps every fact the answer was measured on.
  it('asks gateway-core about the request id, with a NIP-98 GET', async () => {
    const calls: Array<[string, string]> = []
    const check = fulfilmentOf(undefined, (async (path: string, method: string) => {
      calls.push([path, method])
      return new Response(JSON.stringify(PAID))
    }) as never)

    const answer = await check('0123456789abcdef0123')

    expect(calls).toEqual([['/api/v1/atomic/fulfilment/0123456789abcdef0123', 'GET']])
    expect(answer).toEqual(PAID)
    expect(paidForStall(answer, STALL, REQUEST)).toBe(true)
  })

  // Never paid on an error path: a failed call is "still waiting".
  it('reads a failure as still waiting', async () => {
    const check = fulfilmentOf(undefined, (async () => new Response('', { status: 503 })) as never)
    expect(await check('0123456789abcdef0123')).toBeNull()
    expect(paidForStall(null, STALL, REQUEST)).toBe(false)
  })

  // A voucher from another stall did not pay this stall.
  it('does not count a payment in another stall’s voucher', () => {
    expect(paidForStall({ ...PAID, issuerId: 'b'.repeat(64) }, STALL, REQUEST)).toBe(false)
    expect(paidForStall({ ...PAID, fulfilled: false }, STALL, REQUEST)).toBe(false)
  })

  // #160 review (BLOCKER). The customer reads the request id off the QR code and sends 1 sat to
  // themself tagged with it. Whatever gateway-core says, the till checks the facts it reports:
  // the money went to the customer, not the stall, so the till is still waiting.
  it('does not count a payment that went to someone other than the stall', () => {
    expect(paidForStall({ ...PAID, recipientPubkey: 'c'.repeat(64) }, STALL, REQUEST)).toBe(false)
  })

  // #160 review (BLOCKER). The same customer, aiming better: the money reached the stall, but
  // 1 cent of it. Paid means at least what the till asked for.
  it('does not count a payment smaller than the request', () => {
    expect(paidForStall({ ...PAID, amount: 1 }, STALL, REQUEST)).toBe(false)
    expect(paidForStall({ ...PAID, amount: 499 }, STALL, REQUEST)).toBe(false)
    expect(paidForStall({ ...PAID, amount: 600 }, STALL, REQUEST)).toBe(true)
  })

  // 500 of some other currency is not 500 euro cents.
  it('does not count a payment in another unit', () => {
    expect(paidForStall({ ...PAID, unit: 'XAF' }, STALL, REQUEST)).toBe(false)
  })

  // #160 review: a "paid" answer that does not say whose coupons paid it, who received them or
  // how much arrived cannot be checked, so it is not trusted. It used to be enough to omit the
  // issuer for any issuer to pass.
  it('does not count an answer that leaves out the facts', () => {
    const without = (key: keyof typeof PAID) => Object.fromEntries(Object.entries(PAID).filter(([k]) => k !== key))
    expect(paidForStall(without('issuerId') as never, STALL, REQUEST)).toBe(false)
    expect(paidForStall(without('recipientPubkey') as never, STALL, REQUEST)).toBe(false)
    expect(paidForStall(without('amount') as never, STALL, REQUEST)).toBe(false)
  })

  // The till registers its request's terms with gateway-core before it shows the QR code, so
  // the gateway measures payments against the till's terms and a customer who reads the id off
  // the screen cannot register different ones first.
  it('registers the request’s terms with a NIP-98 PUT', async () => {
    const calls: Array<[string, string, unknown]> = []
    const register = registerRequestTerms(undefined, (async (path: string, method: string, body: unknown) => {
      calls.push([path, method, body])
      return new Response(null, { status: 201 })
    }) as never)

    await expect(
      register({ paymentId: '0123456789abcdef0123', issuerId: STALL, amount: 500, unit: 'EUR' }),
    ).resolves.toBe(true)

    expect(calls).toEqual([
      [
        '/api/v1/atomic/fulfilment/0123456789abcdef0123',
        'PUT',
        { recipientPubkey: STALL, issuerId: STALL, amount: 500, unit: 'EUR' },
      ],
    ])
  })

  // A conflict means somebody else registered this id first: the request cannot be confirmed,
  // so the till must not show it. Any other failure is the same answer.
  it('reports a request it could not register', async () => {
    const conflict = registerRequestTerms(undefined, (async () => new Response(null, { status: 409 })) as never)
    const down = registerRequestTerms(undefined, (async () => {
      throw new Error('offline')
    }) as never)
    const terms = { paymentId: '0123456789abcdef0123', issuerId: STALL, amount: 500, unit: 'EUR' }
    await expect(conflict(terms)).resolves.toBe(false)
    await expect(down(terms)).resolves.toBe(false)
  })
})

describe('the mint client', () => {
  // The unlock check is the public NUT-07 endpoint and carries no signature.
  it('checks state at the public validate endpoint, unsigned', async () => {
    const seen: RequestInit[] = []
    const api = terminalMintApi(async (url, init) => {
      expect(url).toBe('/api/v1/wallet/token/validate')
      seen.push(init!)
      return new Response(JSON.stringify({ state: 'SPENT' }))
    })
    expect(await api.validateToken('cashuBx')).toEqual({ state: 'SPENT' })
    expect(JSON.stringify(seen[0].headers)).not.toMatch(/Authorization/)
  })
})

describe('the idle lock (decision 2)', () => {
  /** A real-shaped credential whose signed metadata carries `idle` (or nothing). */
  const credential = (idle?: number) => {
    const stallKey = generateSecretKey()
    const device = getPublicKey(generateSecretKey())
    return buildLockedCredentialToken({
      stallKey,
      devicePubkey: device,
      metadata: terminalMetadataJson({
        stallPubkey: getPublicKey(stallKey),
        role: 'redeem-only',
        lockKey: device,
        name: 'Front counter',
        ...(idle !== undefined ? { idleLockMinutes: idle } : {}),
      }),
    })
  }

  // #160 review (LOW). The owner's 5 minutes is signed into the credential. The person holding
  // the till edits the record on disk to "off": the signed value still wins.
  it('takes the signed idle lock over the device record', () => {
    expect(idleLockMinutesFor({ token: credential(5), idleLockMinutes: 0 })).toBe(5)
  })

  // A credential minted before the review carries no idle lock, so the record's (delivered in the
  // stall-sealed DM) is the only one there is.
  it('falls back to the record for a credential that carries none', () => {
    expect(idleLockMinutesFor({ token: credential(), idleLockMinutes: 15 })).toBe(15)
  })
  // 0 is off, missing is the 10-minute default, and an unreadable value is the default too, so a
  // bad setting cannot leave a till open all day.
  it('reads the owner’s setting', () => {
    expect(idleLockMs(0)).toBeNull()
    expect(idleLockMs(undefined)).toBe(10 * 60_000)
    expect(idleLockMs(3)).toBe(3 * 60_000)
    expect(idleLockMs(-1)).toBe(10 * 60_000)
    expect(idleLockMs(2.5)).toBe(10 * 60_000)
  })

  // Fires at N minutes with no touch, and a touch restarts the clock.
  it('locks at N minutes without a touch, and a touch restarts the clock', () => {
    vi.useFakeTimers()
    const onLock = vi.fn()
    const stop = startIdleLock(idleLockMs(10), onLock)

    vi.advanceTimersByTime(9 * 60_000)
    window.dispatchEvent(new Event('pointerdown'))
    vi.advanceTimersByTime(9 * 60_000)
    expect(onLock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(onLock).toHaveBeenCalledTimes(1)
    stop()
  })

  // Never means never: with the lock switched off nothing fires, however long the till sits.
  it('never fires when switched off', () => {
    vi.useFakeTimers()
    const onLock = vi.fn()
    const stop = startIdleLock(idleLockMs(0), onLock)
    vi.advanceTimersByTime(48 * 3600_000)
    expect(onLock).not.toHaveBeenCalled()
    stop()
  })
})
