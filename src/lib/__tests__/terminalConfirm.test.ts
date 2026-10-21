/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import { confirmBackoff, confirmEnrolled, deliverWaiting } from '../terminalConfirm'
import { allTerminals, markInService, recordTerminal, type TerminalRecord } from '../terminalRoster'
import { resumeMinting, setReleasePending } from '../terminalRevoke'
import { unwrapSealed } from '../terminalDelivery'
import { TERMINAL_ROLES } from '../terminalRole'
import { buildLockedCredentialToken } from './voucherFixtures'

/**
 * The owner's app confirms a terminal at the gateway (#160 round 2).
 *
 * gateway-customer V27 refuses Sell for a credential nobody confirmed. The
 * device confirms on setup, but best effort, so these cover the owner's app
 * doing it too, and the list reading the gateway's answer.
 */

const STALL_KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(STALL_KEY))
const DEVICE_KEY = schnorr.utils.randomSecretKey()
const DEVICE = bytesToHex(schnorr.getPublicKey(DEVICE_KEY))
const VOUCHER = '5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9'

function waiting(over: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    terminalPubkey: DEVICE,
    name: 'Front counter',
    role: TERMINAL_ROLES.REDEEM_ONLY,
    enrolledAt: 1_000,
    status: 'waiting',
    token: 'cashuB-x',
    voucherId: VOUCHER,
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
  setReleasePending(async () => {})
})

describe('a lost device confirm is made good by the owner', () => {
  // The scenario from the review: the device's /confirm never reached the
  // gateway (its result is ignored), but its enrolled DM did. The owner's app
  // sees the DM, confirms as the stall, and the row reads confirmed. Before
  // this the row said In service while the gateway refused every sale.
  it('confirms as the stall once the enrolled DM is seen', async () => {
    recordTerminal(STALL, waiting())
    // The device's own confirm was lost: nothing reached the gateway.
    const gateway = { confirmed: new Set<string>() }
    // The enrolled DM arrives; collectEnrolled promotes the row.
    expect(markInService(STALL, DEVICE, VOUCHER)).toBe(true)
    expect(allTerminals(STALL)[0].gatewayState).toBe('unconfirmed')

    const confirm = vi.fn(async (id: string) => {
      gateway.confirmed.add(id)
      return 204
    })
    expect(await confirmEnrolled(STALL, confirm, 0)).toBe(1)

    expect(confirm).toHaveBeenCalledWith(VOUCHER)
    expect(gateway.confirmed.has(VOUCHER)).toBe(true)
    expect(allTerminals(STALL)[0].gatewayState).toBe('confirmed')
  })

  // A confirmed row is not confirmed again on every tick.
  it('stops once the gateway has confirmed', async () => {
    recordTerminal(STALL, waiting())
    markInService(STALL, DEVICE, VOUCHER)
    const confirm = vi.fn(async () => 204)

    await confirmEnrolled(STALL, confirm, 0)
    await confirmEnrolled(STALL, confirm, 0)

    expect(confirm).toHaveBeenCalledTimes(1)
  })

  // Offline or a 5xx: try again, but not on every 5-second tick. The wait
  // doubles from 30 s, capped at an hour.
  it('retries with backoff while the gateway does not answer', async () => {
    recordTerminal(STALL, waiting())
    markInService(STALL, DEVICE, VOUCHER)
    const answers: Array<number | null> = [null, 503, 204]
    const confirm = vi.fn(async () => (answers.length ? answers.shift()! : 204))

    await confirmEnrolled(STALL, confirm, 0)
    expect(allTerminals(STALL)[0].nextConfirmAt).toBe(30_000)
    await confirmEnrolled(STALL, confirm, 10_000) // not due yet
    expect(confirm).toHaveBeenCalledTimes(1)
    await confirmEnrolled(STALL, confirm, 30_000)
    expect(allTerminals(STALL)[0].nextConfirmAt).toBe(30_000 + 60_000)
    await confirmEnrolled(STALL, confirm, 90_000)

    expect(confirm).toHaveBeenCalledTimes(3)
    expect(allTerminals(STALL)[0].gatewayState).toBe('confirmed')
    expect(confirmBackoff(20)).toBe(60 * 60_000)
  })

  // 410: past its 24 hours, or cancelled. It will never sell, and the list
  // says so instead of In service.
  it('marks a credential the gateway will not confirm as lapsed', async () => {
    recordTerminal(STALL, waiting())
    markInService(STALL, DEVICE, VOUCHER)

    await confirmEnrolled(STALL, async () => 410, 0)

    expect(allTerminals(STALL)[0].gatewayState).toBe('lapsed')
  })
})

describe('a credential resumeMinting finished still reaches its device', () => {
  // The enrol screen sends the credential DM. A row finished later by
  // resumeMinting never had one, so the device could never be set up. Now the
  // list sends it, the same DM, sealed by the stall.
  it('sends the DM for a resumed row, once', async () => {
    const token = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, voucherId: VOUCHER })
    recordTerminal(STALL, waiting({ status: 'minting', token: undefined, voucherId: VOUCHER, mintKey: 'k' }))
    const transport = {
      post: vi.fn(),
      get: vi.fn(async () => new Response(JSON.stringify({ status: 'ISSUED', token }), { status: 200 })),
      sleep: async () => {},
    }
    const api = { validateToken: vi.fn(async () => ({ state: 'UNSPENT' })), receive: vi.fn(async () => ({})) }
    expect((await resumeMinting(STALL, api, transport)).completed).toBe(1)

    const wraps: Parameters<typeof unwrapSealed>[0][] = []
    const publisher = {
      publish: vi.fn(async (wrap: (typeof wraps)[number]) => {
        wraps.push(wrap)
        return true
      }),
    }
    const seal = <T,>(borrow: (key: Uint8Array) => T): T => borrow(STALL_KEY)

    expect(await deliverWaiting(STALL, seal, publisher)).toBe(1)
    expect(await deliverWaiting(STALL, seal, publisher)).toBe(0)

    const opened = unwrapSealed(wraps[0], DEVICE_KEY)
    expect(opened?.sealer).toBe(STALL)
    expect(JSON.parse(opened!.rumor.content).voucher_id ?? JSON.parse(opened!.rumor.content).voucherId).toBe(VOUCHER)
    expect(allTerminals(STALL)[0].delivered).toBe(true)
  })

  // A send that does not land is tried again next time.
  it('leaves an undelivered row to try again', async () => {
    recordTerminal(STALL, waiting())
    const seal = <T,>(borrow: (key: Uint8Array) => T): T => borrow(STALL_KEY)

    expect(await deliverWaiting(STALL, seal, { publish: async () => false })).toBe(0)
    expect(allTerminals(STALL)[0].delivered).toBeUndefined()
  })
})
