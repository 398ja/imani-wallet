/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest'

/**
 * A payment request names the STALL.
 *
 * Terminals ticket 03. Takings are gift-wrapped to the recipient's key —
 * `lib/pay.ts` sets `recipientPubkey` from the request's `issuerId`, and the
 * atomic-send saga DMs the token there — so a device that named itself would
 * collect coupons its owner cannot decrypt. That is money stranded on a till,
 * and it would make revoking a device a way to destroy funds rather than only
 * access.
 *
 * The property is about the REQUEST rather than about who built it, which is
 * why the ticket is unblocked and testable before any terminal exists.
 */

/** What the encoder was asked to put on the wire. */
const generated: Array<Record<string, unknown>> = []

beforeEach(() => {
  generated.length = 0
  // The real encoder is imani-apps' classic script, installed on `window` by
  // main.tsx. Standing in for it here keeps the assertion on WHAT WE ASK IT TO
  // ENCODE, which is the thing this ticket is about.
  ;(window as unknown as { NUT18V: unknown }).NUT18V = {
    generate: (options: Record<string, unknown>) => {
      generated.push(options)
      return {
        paymentId: 'pay-1',
        requestString: 'vreqAtest',
        clickableUri: 'cashu:vreqAtest',
      }
    },
  }
})

const { createRequest } = await import('../vreq')
const { ownerActor, terminalActor } = await import('../actor')
const { TERMINAL_ROLES, grantFor } = await import('../terminalRole')

const STALL = 'a'.repeat(64)
const DEVICE = 'c'.repeat(64)

const till = () =>
  terminalActor(
    {
      stallPubkey: STALL,
      role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
      lockedTo: DEVICE,
      permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
    },
    DEVICE,
  )!

describe('who gets paid', () => {
  it('names the stall when the owner’s own device asks', async () => {
    // The fourth criterion: unchanged behaviour on the owner's device.
    createRequest({ amount: 500, unit: 'GBP', actor: ownerActor(STALL)! })

    expect(generated[0].issuerId).toBe(STALL)
  })

  it('still names the stall when a TERMINAL asks', async () => {
    // The whole ticket. The device displaying the QR holds a different key, and
    // the request must not mention it.
    createRequest({ amount: 500, unit: 'GBP', actor: till() })

    expect(generated[0].issuerId).toBe(STALL)
  })

  it('never names the terminal’s own key, anywhere in the request', async () => {
    createRequest({ amount: 500, unit: 'GBP', actor: till(), description: 'Two coffees' })

    // Not just `issuerId`: the disposable key must appear nowhere at all, so a
    // future field cannot quietly reintroduce it.
    expect(JSON.stringify(generated[0])).not.toContain(DEVICE)
  })

  it('gives the same recipient for both kinds of device', async () => {
    createRequest({ amount: 500, unit: 'GBP', actor: ownerActor(STALL)! })
    createRequest({ amount: 500, unit: 'GBP', actor: till() })

    expect(generated[0].issuerId).toBe(generated[1].issuerId)
  })
})

describe('what cannot be asked for', () => {
  it('refuses when the actor names no usable stall', () => {
    // `ownerActor` returns null for a malformed key, so the only way to reach
    // `createRequest` with a bad one is to hand-build the object — which is
    // what a future caller might do.
    expect(() =>
      createRequest({
        amount: 500,
        unit: 'GBP',
        actor: { kind: 'owner', stallPubkey: 'not-a-key' },
      }),
    ).toThrow(/must name its issuer/)
  })

  it('refuses a non-positive amount before encoding anything', () => {
    for (const amount of [0, -1, Number.NaN]) {
      expect(() =>
        createRequest({ amount, unit: 'GBP', actor: ownerActor(STALL)! }),
      ).toThrow(/more than zero/)
    }
    expect(generated).toEqual([])
  })

  it('has no field in which a caller could supply a recipient', () => {
    /**
     * The structural half of the ticket. `createRequest` used to take
     * `issuerPubkey: string`, and every caller passed its own session key —
     * correct on the owner's device and silently wrong on a terminal.
     *
     * Passing one now does nothing: the recipient comes from the actor.
     */
    createRequest({
      amount: 500,
      unit: 'GBP',
      actor: till(),
      // @ts-expect-error — the field is gone, and this asserts it stays gone.
      issuerPubkey: DEVICE,
    })

    expect(generated[0].issuerId).toBe(STALL)
  })
})
