import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CREDENTIAL_STATE,
  credentialState,
  revokeCredential,
  unspentForLogin,
} from '../credentialRevocation'
import { parseVoucherToken } from '../voucherToken'

/**
 * Revocation by spending.
 *
 * The properties worth attacking are the ones where being wrong is expensive:
 * a check that spends (a terminal that opens once), an unreachable mint read as
 * revocation (a stall closed by a dropped connection), and spending something
 * that is not a credential (a destroyed customer coupon).
 *
 * Uses the REAL gateway-minted credential, so "is this a terminal credential"
 * is decided on the same bytes a terminal holds.
 */

const TOKEN = readFileSync(
  join(__dirname, 'fixtures', 'live-terminal-credential.token'),
  'utf8',
).trim()
const METADATA = parseVoucherToken(TOKEN).voucher.merchantMetadata

const api = (over = {}) => ({
  validateToken: vi.fn(async () => ({ state: 'UNSPENT' })),
  receive: vi.fn(async () => ({ receive_id: 'r1' })),
  ...over,
})

describe('checking state never spends', () => {
  it('reads without receiving', async () => {
    /**
     * The ticket's last criterion, and the one whose absence is most expensive:
     * if login spent, a terminal could open exactly once and a flat battery
     * would cost a re-enrolment.
     */
    const mint = api()
    await credentialState(TOKEN, mint)

    expect(mint.validateToken).toHaveBeenCalledOnce()
    expect(mint.receive).not.toHaveBeenCalled()
  })

  it('can be called repeatedly with the same result', async () => {
    const mint = api()
    const states = [
      await credentialState(TOKEN, mint),
      await credentialState(TOKEN, mint),
      await credentialState(TOKEN, mint),
    ]
    expect(states).toEqual([CREDENTIAL_STATE.LIVE, CREDENTIAL_STATE.LIVE, CREDENTIAL_STATE.LIVE])
    expect(mint.receive).not.toHaveBeenCalled()
  })

  it('reports a spent proof as revoked', async () => {
    const mint = api({ validateToken: vi.fn(async () => ({ state: 'SPENT' })) })
    expect(await credentialState(TOKEN, mint)).toBe(CREDENTIAL_STATE.REVOKED)
  })

  it('does not retire a terminal over a proof mid-swap', async () => {
    // PENDING is a transient the mint resolves. Reading it as revoked would
    // retire a working till over a race.
    const mint = api({ validateToken: vi.fn(async () => ({ state: 'PENDING' })) })
    expect(await credentialState(TOKEN, mint)).toBe(CREDENTIAL_STATE.UNKNOWN)
  })

  it('says UNKNOWN when the mint is unreachable, never revoked', async () => {
    /**
     * The distinction that decides whether a dropped connection closes a stall.
     * We did not learn the credential is spent, and inventing that answer is
     * the failure this design exists to avoid.
     */
    const mint = api({
      validateToken: vi.fn(async () => {
        throw new Error('network down')
      }),
    })
    expect(await credentialState(TOKEN, mint)).toBe(CREDENTIAL_STATE.UNKNOWN)
  })

  it('says UNKNOWN for an answer it cannot read', async () => {
    for (const answer of [null, {}, { state: 'WHO_KNOWS' }]) {
      const mint = api({ validateToken: vi.fn(async () => answer) })
      expect(await credentialState(TOKEN, mint)).toBe(CREDENTIAL_STATE.UNKNOWN)
    }
  })
})

describe('what login is told', () => {
  it('maps unknown to "not revoked", so a dropped signal admits', () => {
    // Written once, here, rather than re-derived by every caller — and
    // re-derived wrongly once is all it would take.
    expect(unspentForLogin(CREDENTIAL_STATE.LIVE)).toBe(true)
    expect(unspentForLogin(CREDENTIAL_STATE.REVOKED)).toBe(false)
    expect(unspentForLogin(CREDENTIAL_STATE.UNKNOWN)).toBeNull()
  })
})

describe('revoking spends', () => {
  it('spends the credential', async () => {
    const mint = api()
    const out = await revokeCredential(TOKEN, METADATA, mint)

    expect(out.revoked).toBe(true)
    expect(mint.receive).toHaveBeenCalledOnce()
  })

  it('refuses to spend something that is not a terminal credential', async () => {
    /**
     * The mint cannot tell a credential from a coupon, so this is the only
     * place the distinction can be made — and getting it wrong destroys a
     * customer's money while the owner thought they were retiring a till.
     */
    const mint = api()
    const out = await revokeCredential(TOKEN, '{"campaign_id":"summer"}', mint)

    expect(out.revoked).toBe(false)
    if (!out.revoked) expect(out.reason).toBe('not-a-credential')
    expect(mint.receive).not.toHaveBeenCalled()
  })

  it('does not spend twice', async () => {
    // Already revoked is a success in every sense the owner cares about, so it
    // is reported distinctly and never retried.
    const mint = api({ validateToken: vi.fn(async () => ({ state: 'SPENT' })) })
    const out = await revokeCredential(TOKEN, METADATA, mint)

    expect(out.revoked).toBe(false)
    if (!out.revoked) expect(out.reason).toBe('already-revoked')
    expect(mint.receive).not.toHaveBeenCalled()
  })

  it('tells the owner when the revocation did not land', async () => {
    /**
     * An owner who believes a stolen terminal is dead and is wrong is worse off
     * than one who knows it failed, so this can never be swallowed.
     */
    const mint = api({
      receive: vi.fn(async () => {
        throw new Error('network down')
      }),
    })
    const out = await revokeCredential(TOKEN, METADATA, mint)

    expect(out.revoked).toBe(false)
    if (!out.revoked) expect(out.reason).toBe('unreachable')
  })

  it('offers no way to unspend', async () => {
    // There is no unspend, for the same reason there is no pause. Asserted over
    // the module's surface so one cannot quietly appear.
    const mod = await import('../credentialRevocation')
    for (const banned of ['unspend', 'unrevoke', 'restore', 'pause', 'resume']) {
      expect(Object.keys(mod).some((k) => k.toLowerCase().includes(banned))).toBe(false)
    }
  })
})
