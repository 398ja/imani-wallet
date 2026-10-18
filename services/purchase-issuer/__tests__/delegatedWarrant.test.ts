/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { discharge, type Obligation, type Ports } from '../discharge'
import { checkDelegation } from '../delegatedWarrant'
import { CredentialVault, type CredentialStore } from '../vault'
import { parseIssuanceWarrant, verifyIssuanceWarrant } from '../../../src/lib/issuanceWarrant'
import { LOCK, STALL, delegatedCredential, delegationJson, ninetyDayTerm } from './stallFixture'

/**
 * A card purchase's coupon is accepted at the till (#152).
 *
 * #152 made every till refuse an unsigned `processor` warrant, which was the
 * only warrant this service produced: every card coupon would have been
 * refused. This drives the REAL `discharge` to the issuance request it sends,
 * takes the warrant out of that request exactly as the gateway carries it
 * (verbatim, into the voucher's signed bytes), and puts it through the till's
 * REAL verifier. The receipt gate is driven in
 * `src/lib/__tests__/cardPurchaseWarrant.test.ts`.
 */

const OBLIGATION: Obligation = {
  id: 'evt_card_1',
  paymentRequestId: '0123456789abcdef0123456789abcdef',
  stallPubkey: STALL,
  faceValue: 2500,
  faceUnit: 'GBP',
  faceDecimals: 2,
  memo: 'Voucher',
  recipient: { kind: 'pubkey', pubkey: 'c'.repeat(64) },
  attempts: 0,
  processorReference: 'pi_3PzCard',
}

const NOW = 1_800_000_000_000

function ports(over: Partial<Ports> = {}): Ports {
  return {
    validityFor: ninetyDayTerm,
    credentialFor: async () => delegatedCredential(),
    tokenFor: async () => '',
    now: () => NOW,
    sleep: async () => {},
    ...over,
  }
}

/** Runs a discharge against a gateway that records what it was asked to mint. */
async function mintedWarrant(p: Ports = ports()): Promise<{ warrant?: string; calls: number }> {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/api/v1/wallet/vouchers')) {
        bodies.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ voucher_id: 'v1', issuer_id: STALL, token: 'cashuB1' }), {
          status: 201,
        })
      }
      return new Response(JSON.stringify({ event_id: 'dm1', fulfilment_recorded: true }), { status: 200 })
    }),
  )
  await discharge('http://gw', OBLIGATION, p)
  return { warrant: bodies[0]?.issuance_warrant as string | undefined, calls: bodies.length }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a card purchase coupon at the till', () => {
  // End to end at unit level: the real discharge signs a delegated warrant,
  // and the till's real verifier says verified. The receipt gate itself is
  // driven in `src/lib/__tests__/cardPurchaseWarrant.test.ts`, which this
  // project's typecheck cannot import (it pulls browser modules).
  it('carries a delegated warrant the till verifies', async () => {
    const { warrant } = await mintedWarrant()
    expect(warrant).toBeDefined()

    const parsed = parseIssuanceWarrant(warrant)
    expect(parsed).toMatchObject({ state: 'present', form: 'delegated', reference: 'pi_3PzCard' })
    expect(
      verifyIssuanceWarrant(parsed, STALL, { faceValueMinor: 2500, unit: 'GBP', faceDecimals: 2 }),
    ).toEqual({ verdict: 'verified' })
  })

  // No longer the unsigned processor form that #152 refuses.
  it('is not a processor warrant any more', async () => {
    const { warrant } = await mintedWarrant()
    expect(JSON.parse(warrant!).form).toBe('delegated')
  })
})

describe('the issuer refuses to mint what the till would refuse', () => {
  // A stall that enrolled before #152 has a credential and no delegation.
  // Minting would make a coupon every till refuses, so nothing is minted and
  // the debt is blocked for a person (the stall signs a delegation).
  it('blocks without minting when the stall has signed no delegation', async () => {
    const { lockKeyHex, stallPubkey, credentialId } = delegatedCredential()
    const p = ports({ credentialFor: async () => ({ lockKeyHex, stallPubkey, credentialId }) })
    const outcome = await discharge('http://gw', OBLIGATION, p)
    expect(outcome).toMatchObject({ kind: 'blocked' })
    expect((await mintedWarrant(p)).calls).toBe(0)
  })

  // A delegation that lapses before the coupon would leave a coupon that dies
  // at the till part-way through its life. Refused before minting, and parked for a person
  // (#312): the buyer has paid, and the stall's 90-day term is longer than its delegation.
  it('parks for a person when the delegation expires before the coupon would', async () => {
    const short = delegationJson({ expiresAt: Math.floor(NOW / 1000) + 30 * 86_400 })
    const p = ports({ credentialFor: async () => delegatedCredential({ delegation: short }) })
    const outcome = await discharge('http://gw', OBLIGATION, p)
    expect(outcome).toMatchObject({ kind: 'attention' })
    expect((outcome as { reason: string }).reason).toMatch(/^validity_outlives_delegation/)
    expect((await mintedWarrant(p)).calls).toBe(0)
  })

  // A delegation signed by some other stall cannot authorise this one.
  it('refuses a delegation signed by a different stall', () => {
    const foreign = delegationJson({ stallSk: '9'.repeat(63) + '2' })
    expect(checkDelegation(delegatedCredential({ delegation: foreign }), NOW).ok).toBe(false)
  })

  // A delegation for a different key than the one this credential signs with
  // would produce a warrant the till refuses.
  it('refuses a delegation naming a different key than the lock key', () => {
    const other = delegationJson({ delegate: 'a'.repeat(64) })
    expect(checkDelegation(delegatedCredential({ delegation: other }), NOW).ok).toBe(false)
  })

  // Only coupon:issue authorises minting.
  it('refuses a delegation with the wrong scope', () => {
    const wrong = delegationJson({ scope: 'coupon:redeem' })
    expect(checkDelegation(delegatedCredential({ delegation: wrong }), NOW).ok).toBe(false)
  })

  // The happy case for the pre-mint check, so the refusals above are not
  // passing because the check refuses everything.
  it('accepts the stall’s own delegation to this lock key', () => {
    expect(checkDelegation(delegatedCredential(), NOW).ok).toBe(true)
    expect(LOCK).toHaveLength(64)
  })
})

describe('keeping the delegation in the vault', () => {
  function memoryStore(): CredentialStore {
    let rows: unknown[] = []
    return { read: async () => rows as never, write: async (r) => void (rows = [...r]) }
  }
  const KEY = 'a'.repeat(64)

  // The delegation survives a seal and reload beside the credential, so the
  // worker that reads the vault can sign with it.
  it('stores the delegation with the credential and gives it back', async () => {
    const store = memoryStore()
    const { delegation, ...bare } = delegatedCredential()
    await new CredentialVault(KEY, store).put(bare)
    await new CredentialVault(KEY, store).attachDelegation(STALL, delegation, NOW, checkDelegation)
    expect((await new CredentialVault(KEY, store).get(STALL))?.delegation).toBe(delegation)
  })

  // An operator attaching the wrong stall's delegation is told at once, and the
  // vault is left as it was rather than holding a delegation that cannot mint.
  it('refuses to attach a delegation the till would refuse', async () => {
    const store = memoryStore()
    const { delegation: _unused, ...bare } = delegatedCredential()
    void _unused
    await new CredentialVault(KEY, store).put(bare)
    const foreign = delegationJson({ stallSk: '9'.repeat(63) + '2' })
    await expect(
      new CredentialVault(KEY, store).attachDelegation(STALL, foreign, NOW, checkDelegation),
    ).rejects.toThrow(/delegation refused/)
    expect((await new CredentialVault(KEY, store).get(STALL))?.delegation).toBeUndefined()
  })
})

describe('review fixes to what this service signs and accepts (#176 review)', () => {
  // The Stripe reference is inside the delegate's signature: rewriting it on
  // the minted warrant makes the till refuse the coupon.
  it('signs the processor reference, so an edited ref fails at the till', async () => {
    const { warrant } = await mintedWarrant()
    const edited = JSON.stringify({ ...JSON.parse(warrant!), ref: 'pi_3PzSomeoneElse' })
    expect(
      verifyIssuanceWarrant(parseIssuanceWarrant(edited), STALL, {
        faceValueMinor: 2500,
        unit: 'GBP',
        faceDecimals: 2,
      }).verdict,
    ).toBe('failed')
  })

  // A stall-signed kind-30078 from another app (a different d tag) is not a
  // delegation, so the vault will not accept it and nothing is minted under it.
  it('refuses a delegation whose d tag is not the issuer-delegation record', () => {
    const foreign = delegationJson({ d: 'some-other-app:settings' })
    expect(checkDelegation(delegatedCredential({ delegation: foreign }), NOW).ok).toBe(false)
  })

  // Missing or duplicated d tags are refused for the same reason.
  it('refuses a delegation with no d tag or two of them', () => {
    const none = delegationJson({ d: null })
    const two = delegationJson({ extraD: 'other' })
    expect(checkDelegation(delegatedCredential({ delegation: none }), NOW).ok).toBe(false)
    expect(checkDelegation(delegatedCredential({ delegation: two }), NOW).ok).toBe(false)
  })

  // The till checks the delegation against its own clock, which may run ahead,
  // and the gateway stamps the coupon's expiry a little after we ask. So a
  // delegation that ends on the coupon's last day is not enough: it must
  // outlive the coupon by a week.
  it('blocks a delegation that outlives the coupon by less than the skew margin', () => {
    const couponEnds = NOW + 365 * 86_400_000
    const tight = delegationJson({ expiresAt: Math.floor(couponEnds / 1000) + 86_400 })
    const roomy = delegationJson({ expiresAt: Math.floor(couponEnds / 1000) + 8 * 86_400 })
    expect(checkDelegation(delegatedCredential({ delegation: tight }), couponEnds).ok).toBe(false)
    expect(checkDelegation(delegatedCredential({ delegation: roomy }), couponEnds).ok).toBe(true)
  })
})
