/**
 * @vitest-environment jsdom
 */
/**
 * Renewal, from the device's side (#160 phase 6, plan 2.3, spec 2.7, Q2).
 *
 * The owner mints a new credential to the same K and DMs it with `"renews":"<old voucher>"`. The
 * device accepts it only when it is sealed by its own stall, locked to K, for the same stall, the
 * same or a smaller role, ATTESTED, from a trusted issuer, and renews exactly the credential the
 * device holds. Then, in order: store it (keeping the old), confirm at gc, send the enrolled DM,
 * and spend the old credential itself with K (F7), so the free slot passes to the new one at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

import { buildAttestedCredentialToken, buildLockedCredentialToken } from './voucherFixtures'
import { wrapMessage, unwrapSealed } from '../terminalDelivery'
import {
  RENEWAL_REFUSAL,
  adoptRenewal,
  renewalFromRumor,
  renewalMessageJson,
  renewRequestJson,
  renewRequestFromRumor,
  findRenewal,
} from '../terminalRenewal'

const STALL_KEY = generateSecretKey()
const STALL = getPublicKey(STALL_KEY)
const OTHER_STALL_KEY = generateSecretKey()
const DEVICE_KEY = generateSecretKey()
const DEVICE = getPublicKey(DEVICE_KEY)
const OTHER_DEVICE = getPublicKey(generateSecretKey())
const OLD = '11111111-1111-4111-8111-111111111111'
const NEW = '22222222-2222-4222-8222-222222222222'
const NOW_S = 1_800_000_000

beforeEach(() => {
  vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', STALL)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const newToken = (o: Partial<Parameters<typeof buildAttestedCredentialToken>[0]> = {}) =>
  buildAttestedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, voucherId: NEW, role: 'issue-and-redeem', expiresAt: NOW_S + 365 * 86_400, ...o })

const held = { stallPubkey: STALL, voucherId: OLD, role: 'issue-and-redeem' as const, terminalPubkey: DEVICE }

function offer(token: string, o: { renews?: string; sealer?: Uint8Array; voucherId?: string } = {}) {
  const content = renewalMessageJson({
    voucherId: o.voucherId ?? NEW, token, stallPubkey: STALL, name: 'Front counter', idleLockMinutes: 10, renews: o.renews ?? OLD,
  })
  const opened = unwrapSealed(wrapMessage(o.sealer ?? STALL_KEY, DEVICE, content), DEVICE_KEY)!
  return renewalFromRumor(opened.rumor, opened.sealer, held)
}

describe('the device accepts only a renewal of the credential it holds', () => {
  it('accepts a genuine, attested renewal from its own stall', () => {
    const out = offer(newToken())
    expect(typeof out).toBe('object')
    expect(out).toMatchObject({ voucherId: NEW, renews: OLD, stallPubkey: STALL })
  })

  it('accepts a smaller role (issue-and-redeem renewed as redeem-only)', () => {
    expect(typeof offer(newToken({ role: 'redeem-only' }))).toBe('object')
  })

  it.each([
    ['sealed by another stall', () => offer(newToken(), { sealer: OTHER_STALL_KEY }), RENEWAL_REFUSAL.SEALED_BY_ANOTHER],
    ['locked to another key', () => offer(buildAttestedCredentialToken({ stallKey: STALL_KEY, devicePubkey: OTHER_DEVICE, voucherId: NEW })), RENEWAL_REFUSAL.NOT_LOCKED_TO_THIS_DEVICE],
    ['unattested', () => offer(buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, voucherId: NEW, role: 'issue-and-redeem' })), RENEWAL_REFUSAL.UNATTESTED],
    ['for a renews that does not match', () => offer(newToken(), { renews: 'someone-else' }), RENEWAL_REFUSAL.NOT_A_RENEWAL_OF_THIS],
    ['the same credential again', () => offer(newToken({ voucherId: OLD }), { voucherId: OLD }), RENEWAL_REFUSAL.NOT_A_RENEWAL_OF_THIS],
  ])('refuses a renewal %s', (_n, run, reason) => {
    expect(run()).toBe(reason)
  })

  it('refuses a larger role (redeem-only renewed as issue-and-redeem): role-not-renewal', () => {
    const redeemOnly = { ...held, role: 'redeem-only' as const }
    const content = renewalMessageJson({ voucherId: NEW, token: newToken(), stallPubkey: STALL, name: 'F', idleLockMinutes: 10, renews: OLD })
    const opened = unwrapSealed(wrapMessage(STALL_KEY, DEVICE, content), DEVICE_KEY)!
    expect(renewalFromRumor(opened.rumor, opened.sealer, redeemOnly)).toBe(RENEWAL_REFUSAL.ROLE_NOT_RENEWAL)
  })

  it('refuses one from an untrusted issuer', () => {
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', 'e'.repeat(64))
    expect(offer(newToken())).toBe(RENEWAL_REFUSAL.UNTRUSTED_ISSUER)
  })

  it('ignores any DM that is not a renewal', () => {
    const opened = unwrapSealed(wrapMessage(STALL_KEY, DEVICE, JSON.stringify({ type: 'imani-terminal-credential/1' })), DEVICE_KEY)!
    expect(renewalFromRumor(opened.rumor, opened.sealer, held)).toBe(RENEWAL_REFUSAL.NOT_A_RENEWAL_DM)
  })

  it('finds the renewal among wraps, newest first, skipping refusals', () => {
    const bad = wrapMessage(OTHER_STALL_KEY, DEVICE, renewalMessageJson({ voucherId: NEW, token: newToken(), stallPubkey: STALL, name: 'F', idleLockMinutes: 1, renews: OLD }))
    const good = wrapMessage(STALL_KEY, DEVICE, renewalMessageJson({ voucherId: NEW, token: newToken(), stallPubkey: STALL, name: 'F', idleLockMinutes: 1, renews: OLD }))
    const found = findRenewal([bad, good], (w) => unwrapSealed(w, DEVICE_KEY), held)
    expect(found?.voucherId).toBe(NEW)
  })
})

describe('adopting a renewal: store, confirm, enrolled DM, spend the old (Q2)', () => {
  function steps(o: { spendFails?: boolean } = {}) {
    const order: string[] = []
    return {
      order,
      deps: {
        store: (_token: string, voucherId: string, previous: string) => void order.push(`store ${voucherId} keep ${previous}`),
        confirm: async (voucherId: string) => void order.push(`confirm ${voucherId}`),
        announce: async (voucherId: string) => (order.push(`enrolled ${voucherId}`), true),
        spendOld: async () => {
          order.push('spend old')
          if (o.spendFails) throw new Error('offline')
          return true
        },
        clearPrevious: () => void order.push('clear previous'),
      },
    }
  }
  const accepted = () => offer(newToken()) as Exclude<ReturnType<typeof offer>, string>

  it('runs the four steps in order, and drops the old token only after the spend landed', async () => {
    const { order, deps } = steps()
    expect(await adoptRenewal(accepted(), 'old-token', deps)).toEqual({ adopted: true, oldSpent: true })
    expect(order).toEqual([`store ${NEW} keep old-token`, `confirm ${NEW}`, `enrolled ${NEW}`, 'spend old', 'clear previous'])
  })

  it('keeps the old token for the next unlock when its spend fails; the owner revoke is the fallback', async () => {
    const { order, deps } = steps({ spendFails: true })
    expect(await adoptRenewal(accepted(), 'old-token', deps)).toEqual({ adopted: true, oldSpent: false })
    expect(order).not.toContain('clear previous')
  })
})

describe('the renew request from a till without an owner row (Q3)', () => {
  const oldToken = () =>
    buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, voucherId: OLD, role: 'issue-and-redeem' })

  function request(token: string, sealer = DEVICE_KEY) {
    const opened = unwrapSealed(wrapMessage(sealer, STALL, renewRequestJson(OLD, token)), STALL_KEY)!
    return renewRequestFromRumor(opened.rumor, opened.sealer, STALL)
  }

  it("adopts this stall's own credential, locked to the sealer, from a trusted issuer", () => {
    expect(request(oldToken())).toMatchObject({ voucherId: OLD, terminalPubkey: DEVICE, role: 'issue-and-redeem' })
  })

  it('refuses a foreign credential (another stall issued it), even from a trusted issuer', () => {
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', `${STALL},${getPublicKey(OTHER_STALL_KEY)}`)
    const foreign = buildLockedCredentialToken({ stallKey: OTHER_STALL_KEY, devicePubkey: DEVICE, voucherId: OLD })
    expect(request(foreign)).toBe('wrong-issuer')
  })

  it('refuses one the sealer does not hold (lock is not the sealer)', () => {
    expect(request(oldToken(), generateSecretKey())).toBe('not-locked-to-sealer')
  })

  it('refuses a self-signed credential (issuer not trusted)', () => {
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', 'e'.repeat(64))
    expect(request(oldToken())).toBe('untrusted-issuer')
  })

  it('refuses one without the stall as co-key, which the stall could not revoke', () => {
    const noCoKey = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, voucherId: OLD, pubkeys: [] })
    expect(request(noCoKey)).toBe('no-stall-co-key')
  })
})
