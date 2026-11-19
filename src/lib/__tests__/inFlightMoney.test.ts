/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Second check of #326: logout reads the pending-send and swap-intent ledgers
 * through `moneyInFlight`. Pinned against what pay.ts and swapIntent.ts really
 * WRITE, so a renamed key or a changed window cannot quietly make logout read
 * an empty ledger while money sits in it.
 */

const { moneyInFlight, PENDING_SEND_LIFETIME_MS } = await import('../inFlightMoney')
const { rememberSwapIntent, forgetSwapIntent, SWAP_INTENT_LIFETIME_MS } = await import('../swapIntent')

const PK = 'ab'.repeat(32)

function intent(swapId: string, at = Date.now()) {
  return {
    swapId,
    mintUrl: 'https://mint.test',
    keysetId: '00ad',
    inputs: [{ amount: 8, id: '00ad', secret: 's', C: '02' + '1'.repeat(64) }],
    outputs: [{ amount: 8, id: '00ad', B_: '02' + '2'.repeat(64), r: '3'.repeat(64), secret: 'x' }],
    at,
  }
}

beforeEach(() => localStorage.clear())

describe('moneyInFlight', () => {
  it('sees a swap intent the receive path wrote, and stops seeing it once forgotten', () => {
    expect(moneyInFlight(PK)).toEqual({ sends: 0, swaps: 0, cashlinks: 0, codes: 0, unanswered: 0 })
    rememberSwapIntent(PK, intent('one') as never)
    expect(moneyInFlight(PK).swaps).toBe(1)
    forgetSwapIntent(PK, 'one')
    expect(moneyInFlight(PK).swaps).toBe(0)
  })

  it('ignores an intent past the window the recovery itself uses', () => {
    rememberSwapIntent(PK, intent('old', Date.now() - SWAP_INTENT_LIFETIME_MS - 1) as never)
    expect(moneyInFlight(PK).swaps).toBe(0)
  })

  it('sees a pending send under the key pay.ts writes, within its window', async () => {
    const { loadPendingSends } = await import('../pay')
    const send = { sendId: 's1', tokenId: 't1', amount: 100, unit: 'GBP', decimals: 2, merchantPubkey: 'm', sourceFaceValue: 500, at: Date.now() }
    localStorage.setItem(`imani-wallet:pending-sends:${PK}`, JSON.stringify([send]))
    // The same ledger pay.ts reads back.
    expect(loadPendingSends(PK)).toHaveLength(1)
    expect(moneyInFlight(PK).sends).toBe(1)
    localStorage.setItem(
      `imani-wallet:pending-sends:${PK}`,
      JSON.stringify([{ ...send, at: Date.now() - PENDING_SEND_LIFETIME_MS - 1 }]),
    )
    expect(moneyInFlight(PK).sends).toBe(0)
  })

  it('#295 phase 4: counts a Cashlink claim part way and a Cashlink whose value is moving, however old', () => {
    // Neither expires (the value does not), so an entry from a year ago still holds logout.
    localStorage.setItem(`imani-wallet:cashlink-claims:${PK}`, JSON.stringify([{ at: 0 }]))
    localStorage.setItem(`imani-wallet:cashlink-moving:${PK}`, JSON.stringify(['sent:a', 'sent:b']))
    expect(moneyInFlight(PK).cashlinks).toBe(3)
  })

  it('#295 phase 4: an unreadable Cashlink ledger counts as one, never as empty', () => {
    // Unreadable is not "nothing there": the value it describes may be real.
    localStorage.setItem(`imani-wallet:cashlink-moving:${PK}`, '{not json')
    expect(moneyInFlight(PK).cashlinks).toBe(1)
  })

  it('is per account', () => {
    rememberSwapIntent(PK, intent('mine') as never)
    expect(moneyInFlight('cd'.repeat(32))).toEqual({ sends: 0, swaps: 0, cashlinks: 0, codes: 0, unanswered: 0 })
  })
})
