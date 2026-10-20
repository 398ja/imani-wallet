/**
 * Review of #353: letting go of the store for another tab stops SENDS as well
 * as receives, in logout's order, and waits for both before the handle goes.
 * A send settling its change writes the change coupon; written to a closed
 * store, that coupon is gone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../dmPoll', () => ({ stopDmPoll: vi.fn(), drainDmPoll: async () => true }))
vi.mock('../terminalRosterSyncNet', () => ({ stopRosterSync: vi.fn() }))
vi.mock('../incomingNotifications', () => ({ stopIncomingNotifications: vi.fn() }))
vi.mock('../logout', () => ({ DRAIN_TIMEOUT_MS: 50 }))

const gate = await import('../receiveGate')
const { releaseWalletForOtherTab } = await import('../walletHandover')

afterEach(() => {
  gate.openReceives()
  gate.openSpends()
})

describe('handing the store to another tab (review of #353)', () => {
  it('closes the send gate and waits for a send already running', async () => {
    const endSpend = gate.beginSpend()
    let released = false
    const release = releaseWalletForOtherTab(undefined, 20, 5).then(() => (released = true))

    // No new send may start once the hand-over has begun.
    expect(() => gate.beginSpend()).toThrow()
    await new Promise((r) => setTimeout(r, 60))
    // The send is still settling its change: the store is kept.
    expect(released).toBe(false)

    endSpend()
    await release
    expect(released).toBe(true)
  })

  it('closes the receive gate and waits for a receive already running', async () => {
    const endReceive = gate.beginReceive()
    let released = false
    const release = releaseWalletForOtherTab(undefined, 20, 5).then(() => (released = true))
    expect(() => gate.beginReceive()).toThrow()
    await new Promise((r) => setTimeout(r, 60))
    expect(released).toBe(false)
    endReceive()
    await release
    expect(released).toBe(true)
  })
})
