import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { LOGIN_REFUSAL, loginTerminal } from '../terminalLogin'
import { SESSION_KIND, SESSION_HOURS, canIssueNow, canRedeemNow } from '../terminalSession'
import { parseVoucherToken } from '../voucherToken'
import { TERMINAL_ROLES, grantFor } from '../terminalRole'

/**
 * Terminal login, against the credential a REAL gateway minted.
 *
 * Ticket 10's login criteria. The fixture is the one
 * `scripts/mint-terminal-credential.mjs` produced on the live stack, so these
 * exercise the bytes a terminal would actually be handed rather than metadata
 * this app wrote for itself — which is the distinction that caught
 * `issuerPublicKey` vs `issuerId`.
 */

const TOKEN = readFileSync(
  join(__dirname, 'fixtures', 'live-terminal-credential.token'),
  'utf8',
).trim()

/**
 * A SECOND real credential, minted issue-and-redeem.
 *
 * The redeem-only fixture cannot prove reduced authority blocks issuance,
 * because a redeem-only role blocks it anyway — a mutation forcing every
 * session to FULL left that test passing. This one has the senior role, so
 * "reduced authority refuses issuance" can only pass for the right reason.
 */
const TILL_TOKEN = readFileSync(
  join(__dirname, 'fixtures', 'live-terminal-till.token'),
  'utf8',
).trim()
const till = parseVoucherToken(TILL_TOKEN)
const TILL_DEVICE = 'defec85d60789c4fab5c5bc1fb7f1ceb3a6ef4a0e9a4cb33ead6dbb11ba7a0b4'

const loginTill = (over = {}) =>
  loginTerminal({
    merchantMetadata: till.voucher.merchantMetadata,
    issuerId: till.voucher.issuerId,
    devicePubkey: TILL_DEVICE,
    unspent: true,
    ...over,
  })

const parsed = parseVoucherToken(TOKEN)
const METADATA = parsed.voucher.merchantMetadata
const ISSUER = parsed.voucher.issuerId
/**
 * The stall and device the fixture was minted for, as RECORDED BY THE MINTING
 * SCRIPT rather than read back out of the token. Hardcoding the hex meant
 * re-minting the fixture broke this file for no reason but a changed key.
 */
const MINTED = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'live-terminal-credential.json'), 'utf8'),
) as { stall: string; device: string }
const STALL = MINTED.stall
const DEVICE = MINTED.device

const login = (over = {}) =>
  loginTerminal({
    merchantMetadata: METADATA,
    issuerId: ISSUER,
    devicePubkey: DEVICE,
    unspent: true,
    ...over,
  })

describe('the credential is the authority', () => {
  it('admits the device it was minted for', () => {
    const out = login()
    expect(out.admitted).toBe(true)
  })

  it('derives permissions from the credential, not from any record', () => {
    /**
     * The ticket's third criterion. Nothing on disk is consulted: the role in
     * the signed metadata is what produces the grant, so a record edited by
     * whoever holds the device cannot widen what it may do.
     */
    const out = login()
    if (!out.admitted) throw new Error('expected admission')
    expect(out.actor.permissions).toEqual(grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL))
    expect(out.actor.stallPubkey).toBe(STALL)
  })

  it('is inert on another device', () => {
    const out = login({ devicePubkey: 'f'.repeat(64) })
    expect(out.admitted).toBe(false)
    if (!out.admitted) expect(out.reason).toBe(LOGIN_REFUSAL.NOT_OURS)
  })

  it('is refused when another stall minted it', () => {
    const out = login({ issuerId: 'a'.repeat(64) })
    expect(out.admitted).toBe(false)
    if (!out.admitted) expect(out.reason).toBe(LOGIN_REFUSAL.NOT_OURS)
  })

  it('distinguishes "never enrolled" from "cannot be read"', () => {
    // Different sentences because they need different actions: one device needs
    // adding, the other needs setting up again.
    expect(login({ merchantMetadata: null }).admitted).toBe(false)
    const fresh = login({ merchantMetadata: null })
    if (!fresh.admitted) expect(fresh.reason).toBe(LOGIN_REFUSAL.NOT_ENROLLED)

    const junk = login({ merchantMetadata: '{"campaign_id":"x"}' })
    if (!junk.admitted) expect(junk.reason).toBe(LOGIN_REFUSAL.UNREADABLE)
  })
})

describe('a revoked terminal cannot log in', () => {
  it('is refused when the mint says the credential is spent', () => {
    // Revocation is the act of spending it, which is why a revoked terminal
    // cannot come back — anywhere.
    const out = login({ unspent: false })
    expect(out.admitted).toBe(false)
    if (!out.admitted) expect(out.reason).toBe(LOGIN_REFUSAL.REVOKED)
  })

  it('does not treat an unreachable mint as revocation', () => {
    /**
     * The distinction that decides whether a dropped connection closes a stall.
     * `null` is "we could not ask", and failing closed on it would take a stall
     * off the market every time its signal went.
     */
    const out = login({ unspent: null })
    expect(out.admitted).toBe(true)
  })
})

describe('degraded login is redeem-only', () => {
  it('opens a REDUCED session when the mint could not be reached', () => {
    const out = login({ unspent: null })
    if (!out.admitted) throw new Error('expected admission')
    expect(out.session.kind).toBe(SESSION_KIND.REDUCED)
  })

  it('opens a FULL session when the mint confirmed it', () => {
    const out = login({ unspent: true })
    if (!out.admitted) throw new Error('expected admission')
    expect(out.session.kind).toBe(SESSION_KIND.FULL)
  })

  it('redeems but never issues on reduced authority', () => {
    /**
     * On the FULL-TILL credential, whose role DOES carry issuance. Using the
     * redeem-only one here proved nothing: a mutation forcing every session to
     * FULL still passed, because the role blocked issuance by itself. Now the
     * only thing standing between this terminal and minting money is the
     * reduced session, which is exactly the claim.
     */
    const out = loginTill({ unspent: null })
    if (!out.admitted) throw new Error('expected admission')
    expect(canRedeemNow(out.actor, out.session)).toBe(true)
    expect(canIssueNow(out.actor, out.session)).toBe(false)
  })

  it('lets the same full till issue once the mint confirms it', () => {
    // The other direction, so the check above cannot pass by the till being
    // unable to issue in any circumstance.
    const out = loginTill({ unspent: true })
    if (!out.admitted) throw new Error('expected admission')
    expect(canIssueNow(out.actor, out.session)).toBe(true)
  })
})

describe('the session it opens', () => {
  it('lives at most one trading day', () => {
    const out = login({ openedAt: 1_000_000 })
    if (!out.admitted) throw new Error('expected admission')
    expect(out.session.expiresAt).toBe(1_000_000 + SESSION_HOURS * 3600 * 1000)
  })
})

describe('verification never spends', () => {
  it('logs in repeatedly from the same credential', () => {
    /**
     * The ticket's last criterion. A login that consumed the credential would
     * mean a terminal could open exactly once, and a flat battery would cost an
     * enrolment. Asserted by doing it — same bytes, three times, all admitted.
     */
    for (let i = 0; i < 3; i += 1) {
      expect(login().admitted).toBe(true)
    }
  })

  it('takes no argument that could spend, and returns nothing that has', () => {
    // Structural: `loginTerminal` is a pure function of bytes already held. It
    // cannot reach the mint, so it cannot spend, whatever a future edit does
    // inside it.
    const out = login()
    if (!out.admitted) throw new Error('expected admission')
    expect(Object.keys(out)).toEqual(['admitted', 'actor', 'session'])
  })
})
