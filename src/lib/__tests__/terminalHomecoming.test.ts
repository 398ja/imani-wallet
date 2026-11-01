/**
 * @vitest-environment jsdom
 */
/**
 * The home-coming roster check (#160 phase 6, plan 2.5, decision 5 Q2).
 *
 * A coupon a till sold comes home to the stall carrying a `terminal` warrant, which names the
 * credential the till sold under. That credential must be on the stall's roster, under any status
 * (renewed away and revoked included). If it is not, someone holds a stall-attested credential the
 * owner's list does not know about: the coupon is honoured (the customer paid), and the owner is
 * told. The check stays quiet until this device has synced the roster once, so a fresh restore
 * cannot raise a false alarm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import {
  HOMECOMING_ALERT,
  credentialOfWarrant,
  homecomingCheck,
} from '../terminalHomecoming'
import { recordTerminal } from '../terminalRoster'
import { parseCredentialSecret } from '../terminalWarrant'

const STALL = 'f'.repeat(64)
const KEY = 'a'.repeat(64)
const SERVICE_SK = '11'.repeat(32)
const SERVICE = bytesToHex(schnorr.getPublicKey(hexToBytes(SERVICE_SK)))

function warrantFor(voucherId: string): string {
  const tags = [['voucher_id', voucherId], ['issuer', STALL], ['expires_at', '4000000000'], ['merchant_metadata', '{}']]
  const body = { nonce: 'ab', data: '02' + KEY, tags }
  const signed = parseCredentialSecret(JSON.stringify(['P2PK_VOUCHER', body]))!.signed
  body.tags = [...tags, ['issuer_sig', bytesToHex(schnorr.sign(sha256(signed), hexToBytes(SERVICE_SK)))], ['issuer_pubkey', SERVICE]]
  return JSON.stringify({ form: 'terminal', sale_total: 1, face_decimals: 2, unit: 'EUR', nonce: 'n', signature: '00', credential: JSON.stringify(['P2PK_VOUCHER', body]) })
}

const synced = () => localStorage.setItem(`imani-wallet:terminals-synced:${STALL}`, '1')

// The default refresh reads the published roster from the network; here it has nothing newer.
vi.mock('../terminalRosterSyncNet', () => ({ syncRosterNow: async () => true }))

beforeEach(() => localStorage.clear())

describe('the home-coming roster check', () => {
  it('reads the credential voucher id out of a terminal warrant, and nothing out of any other', () => {
    expect(credentialOfWarrant(warrantFor('cred-9'))).toBe('cred-9')
    expect(credentialOfWarrant(JSON.stringify({ form: 'merchant', sale_total: 1, face_decimals: 2, unit: 'EUR', nonce: 'n', sig: 'ab'.repeat(64) }))).toBeNull()
    expect(credentialOfWarrant(undefined)).toBeNull()
  })

  it('passes a coupon from a till on the list', () => {
    synced()
    recordTerminal(STALL, { terminalPubkey: KEY, name: 'Till', role: 'issue-and-redeem', enrolledAt: 1, voucherId: 'cred-1', token: 't' })
    expect(homecomingCheck(STALL, warrantFor('cred-1'))).toBe('ok')
  })

  it('passes a credential renewed away, and a revoked one (any status)', () => {
    synced()
    recordTerminal(STALL, {
      terminalPubkey: KEY, name: 'Till', role: 'issue-and-redeem', enrolledAt: 1, voucherId: 'cred-2', token: 't',
      credentials: [{ voucherId: 'cred-1', issuedAt: 0, revokedAt: 5 }, { voucherId: 'cred-2', issuedAt: 1, token: 't' }],
    })
    expect(homecomingCheck(STALL, warrantFor('cred-1'))).toBe('ok')
    recordTerminal(STALL, { terminalPubkey: 'b'.repeat(64), name: 'Gone', role: 'issue-and-redeem', enrolledAt: 1, voucherId: 'cred-3', revokedAt: 9 })
    expect(homecomingCheck(STALL, warrantFor('cred-3'))).toBe('ok')
  })

  it('alerts on a credential the list has never seen (mutant: always ok)', () => {
    synced()
    recordTerminal(STALL, { terminalPubkey: KEY, name: 'Till', role: 'issue-and-redeem', enrolledAt: 1, voucherId: 'cred-1', token: 't' })
    expect(homecomingCheck(STALL, warrantFor('cred-unknown'))).toBe('unknown-till')
  })

  it('is silent before the roster has synced once on this device (mutant: no guard)', () => {
    expect(homecomingCheck(STALL, warrantFor('cred-unknown'))).toBe('not-synced')
  })

  it('has nothing to say about a coupon with no terminal warrant', () => {
    synced()
    expect(homecomingCheck(STALL, undefined)).toBe('not-a-till-sale')
  })

  it('tells the owner what to do, not what went wrong in code', () => {
    expect(HOMECOMING_ALERT).toBe(
      'A coupon came back from a till that is not on your list. If you did not set it up, contact support.',
    )
  })
})

describe('raising the alert', () => {
  it('records one notification per unknown credential, and nothing for a known one', async () => {
    const { raiseHomecomingAlert } = await import('../terminalHomecoming')
    const { listNotifications, _resetInboxCacheForTests } = await import('../notifications/inbox')
    _resetInboxCacheForTests()
    synced()
    recordTerminal(STALL, { terminalPubkey: KEY, name: 'Till', role: 'issue-and-redeem', enrolledAt: 1, voucherId: 'cred-1', token: 't' })
    const refresh = async () => true

    expect(await raiseHomecomingAlert(STALL, warrantFor('cred-1'), 'coupon-a', refresh)).toBe('ok')
    expect(listNotifications(STALL)).toEqual([])

    expect(await raiseHomecomingAlert(STALL, warrantFor('cred-x'), 'coupon-b', refresh)).toBe('unknown-till')
    expect(await raiseHomecomingAlert(STALL, warrantFor('cred-x'), 'coupon-b', refresh)).toBe('unknown-till')
    const items = listNotifications(STALL)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ body: HOMECOMING_ALERT, url: '/settings/terminals' })
  })

  // Found by the local gate: the owner's second phone had synced the roster at login, the first
  // phone then renewed a till, and that till's next sale reached the second phone first. A roster
  // older than the till is not a till the owner never set up: read the list again before alerting.
  it('reads the roster again before alerting, and stays quiet when the till is there now', async () => {
    const { raiseHomecomingAlert } = await import('../terminalHomecoming')
    const { listNotifications, _resetInboxCacheForTests } = await import('../notifications/inbox')
    _resetInboxCacheForTests()
    synced()
    let asked = 0
    const refresh = async () => {
      asked += 1
      recordTerminal(STALL, { terminalPubkey: KEY, name: 'Till', role: 'issue-and-redeem', enrolledAt: 1, voucherId: 'cred-new', token: 't' })
      return true
    }

    expect(await raiseHomecomingAlert(STALL, warrantFor('cred-new'), 'coupon-c', refresh)).toBe('ok')
    expect(asked).toBe(1)
    expect(listNotifications(STALL)).toEqual([])
  })
})

describe("trigger (a): dm-poll's redemption of a coupon coming home", () => {
  it('alerts for this stall\'s own coupon from an unknown till, and ignores another stall\'s', async () => {
    const { homecomingAlertFor } = await import('../dmPoll')
    const { buildVoucherToken } = await import('./voucherFixtures')
    const { listNotifications, _resetInboxCacheForTests } = await import('../notifications/inbox')
    _resetInboxCacheForTests()
    synced()
    const stallKey = new Uint8Array(32).fill(5)
    const stall = bytesToHex(schnorr.getPublicKey(stallKey))
    localStorage.setItem(`imani-wallet:terminals-synced:${stall}`, '1')
    const { token } = buildVoucherToken({ issuanceWarrant: warrantFor('cred-x') } as never, undefined, {}, stallKey)
    // Another stall that has synced its own list: a coupon it did not issue is not its till's.
    localStorage.setItem(`imani-wallet:terminals-synced:${'e'.repeat(64)}`, '1')
    homecomingAlertFor({ voucherId: 'v' }, 'e'.repeat(64), token)
    homecomingAlertFor({ voucherId: 'v' }, stall, token)
    await vi.waitFor(() => expect(listNotifications(stall).map((n) => n.body)).toEqual([HOMECOMING_ALERT]))
    expect(listNotifications('e'.repeat(64))).toEqual([])
  })
})
