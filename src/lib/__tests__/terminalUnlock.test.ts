/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { buildLockedCredentialToken } from './voucherFixtures'

/**
 * Opening the till (#160 phase 3, spec 2.3).
 *
 * The key store is replaced with one that holds a real key under a real passphrase, and the mint
 * is a stub, so each case is the decision a real device makes: who it is comes from the key the
 * passphrase opened, what it may do comes from the token's signed bytes, and whether it is live
 * comes from the mint.
 */

const DEVICE_KEY = generateSecretKey()
const DEVICE_HEX = bytesToHex(DEVICE_KEY)
const DEVICE = getPublicKey(DEVICE_KEY)
const STALL_KEY = generateSecretKey()
const STALL = getPublicKey(STALL_KEY)
const PASSPHRASE = 'counter-pass'

vi.mock('../nap', () => ({
  keyStore: {
    loadKey: async (p: string) => {
      if (p !== PASSPHRASE) throw new Error('Invalid passphrase')
      return DEVICE_HEX
    },
    hasKey: async () => true,
  },
  installTerminalSigner: vi.fn(),
  lockTerminalSigner: vi.fn(),
}))

const nap = await import('../nap')
const { unlockTerminal, forgetTerminalSession, heldTerminalSession, lockTerminal, WRONG_PASSPHRASE } =
  await import('../terminalUnlock')
const { SESSION_KIND, SESSION_HOURS } = await import('../terminalSession')
const { TERMINAL_ROLES } = await import('../terminalRole')
const { isTerminalDevice } = await import('../terminalEnrol')

function enrol(role: string = TERMINAL_ROLES.ISSUE_AND_REDEEM, over: Record<string, unknown> = {}) {
  localStorage.setItem(
    'imani-wallet:terminal',
    JSON.stringify({
      stallPubkey: STALL,
      role,
      terminalPubkey: DEVICE,
      enrolledAt: 1,
      token: buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, role }),
      ...over,
    }),
  )
}

const mint = (state: string | Error) => ({
  validateToken: vi.fn(async () => {
    if (state instanceof Error) throw state
    return { state }
  }),
})

// The build names the key that signs terminal credentials, as every deploy must now: a terminal
// credential whose signer is not on VITE_VOUCHER_ISSUER_PUBKEYS is refused (#160 review, IW-15).
beforeEach(() => {
  vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', STALL)
  localStorage.clear()
  forgetTerminalSession()
  vi.mocked(nap.installTerminalSigner).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('unlocking without NAP', () => {
  // The spec's AC: a terminal makes no call to /api/v1/auth/*. Every fetch the unlock makes is
  // recorded, through the real terminal mint client, and none of them is an auth call.
  it('makes no call to /api/v1/auth, and asks only the public mint check', async () => {
    enrol()
    const calls: string[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ state: 'UNSPENT' }), { status: 200 })
    })

    const out = await unlockTerminal(PASSPHRASE)

    expect(out.unlocked).toBe(true)
    expect(calls.some((u) => u.includes('/api/v1/auth'))).toBe(false)
    expect(calls).toEqual(['/api/v1/wallet/token/validate'])
    fetchSpy.mockRestore()
  })

  // The unlocked key becomes the app's signer, and only once the device is admitted.
  it('installs the unlocked key as the signer', async () => {
    enrol()
    await unlockTerminal(PASSPHRASE, { mint: mint('UNSPENT') })
    expect(nap.installTerminalSigner).toHaveBeenCalledWith(DEVICE_HEX)
  })

  // A wrong passphrase opens nothing and asks the mint nothing.
  it('refuses a wrong passphrase, and installs nothing', async () => {
    enrol()
    const api = mint('UNSPENT')
    const out = await unlockTerminal('not it', { mint: api })
    expect(out).toEqual({ unlocked: false, reason: 'wrong-passphrase', message: WRONG_PASSPHRASE })
    expect(api.validateToken).not.toHaveBeenCalled()
    expect(nap.installTerminalSigner).not.toHaveBeenCalled()
  })
})

describe('what the mint says decides the session', () => {
  // A live credential, confirmed by the mint, opens the full session the role allows.
  it('opens FULL when the mint says UNSPENT', async () => {
    enrol()
    const out = await unlockTerminal(PASSPHRASE, { mint: mint('UNSPENT') })
    if (!out.unlocked) throw new Error(out.message)
    expect(out.session.kind).toBe(SESSION_KIND.FULL)
    expect(out.actor.stallPubkey).toBe(STALL)
  })

  // The mint cannot be reached: redemption still works, issuance does not (G8 closed: before
  // phase 3 every terminal was REDUCED because nothing asked the mint at all).
  it('opens REDUCED when the mint cannot be reached', async () => {
    enrol()
    const out = await unlockTerminal(PASSPHRASE, { mint: mint(new Error('offline')) })
    if (!out.unlocked) throw new Error(out.message)
    expect(out.session.kind).toBe(SESSION_KIND.REDUCED)
  })

  // Revoked: the owner spent the credential. Refused with the words the spec names, and no
  // signer is installed, so nothing on the device can sign for the stall.
  it('refuses a revoked credential as no longer in service, and installs nothing', async () => {
    enrol()
    const out = await unlockTerminal(PASSPHRASE, { mint: mint('SPENT') })
    expect(out.unlocked).toBe(false)
    if (!out.unlocked) {
      expect(out.reason).toBe('revoked')
      expect(out.message).toMatch(/no longer in service/)
    }
    expect(nap.installTerminalSigner).not.toHaveBeenCalled()
  })
})

describe('the stored record cannot raise the role (IW-15)', () => {
  // The record says issue-and-redeem, but the token it holds was minted redeem-only. The session
  // is redeem-only, because the role comes from the token.
  it('logs in with the token’s role, not the record’s', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY, { role: TERMINAL_ROLES.ISSUE_AND_REDEEM })
    const out = await unlockTerminal(PASSPHRASE, { mint: mint('UNSPENT') })
    if (!out.unlocked) throw new Error(out.message)
    expect(out.actor.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
  })

  // The record names this device, but its token is locked to another key. Not ours.
  it('refuses a token locked to another device', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY, {
      token: buildLockedCredentialToken({
        stallKey: STALL_KEY,
        devicePubkey: getPublicKey(generateSecretKey()),
      }),
    })
    const out = await unlockTerminal(PASSPHRASE, { mint: mint('UNSPENT') })
    expect(out.unlocked).toBe(false)
    if (!out.unlocked) expect(out.reason).toBe('not-ours')
  })
})

describe('a wallet key beside a terminal record is not a terminal', () => {
  // The record names another device, and the passphrase opened this device's own key: a person's
  // wallet beside a stale or planted record. Not admitted, nothing installed, the mint not asked,
  // and the reason is one the screen answers with "Open the wallet", never with a wipe.
  it('refuses without asking the mint or installing a signer', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY, { terminalPubkey: getPublicKey(generateSecretKey()) })
    const api = mint('UNSPENT')
    const out = await unlockTerminal(PASSPHRASE, { mint: api })
    expect(out.unlocked).toBe(false)
    if (!out.unlocked) expect(out.reason).toBe('not-a-terminal-key')
    expect(api.validateToken).not.toHaveBeenCalled()
    expect(nap.installTerminalSigner).not.toHaveBeenCalled()
  })
})

describe('the idle lock keeps the twelve-hour session', () => {
  // Locking drops the signer. Unlocking again within the session needs only the passphrase: the
  // mint is not asked a second time.
  it('re-unlocks within the session without asking the mint', async () => {
    enrol()
    const api = mint('UNSPENT')
    const t0 = 1_800_000_000_000
    await unlockTerminal(PASSPHRASE, { mint: api, now: t0 })
    lockTerminal()
    expect(nap.lockTerminalSigner).toHaveBeenCalled()
    expect(heldTerminalSession()).not.toBeNull()

    const again = await unlockTerminal(PASSPHRASE, { mint: api, now: t0 + 60_000 })
    expect(again.unlocked).toBe(true)
    expect(api.validateToken).toHaveBeenCalledTimes(1)
  })

  // After the twelve hours the session is over, so the next unlock asks the mint again, which is
  // where a revocation made in the meantime bites.
  it('asks the mint again once the session has ended', async () => {
    enrol()
    const t0 = 1_800_000_000_000
    await unlockTerminal(PASSPHRASE, { mint: mint('UNSPENT'), now: t0 })
    lockTerminal()
    const later = await unlockTerminal(PASSPHRASE, {
      mint: mint('SPENT'),
      now: t0 + SESSION_HOURS * 3600 * 1000 + 1,
    })
    expect(later.unlocked).toBe(false)
  })
})

describe('a terminal record without a token (#160 review, LOW)', () => {
  // Spec 2.3: a terminal is never a customer. A record whose token is gone (an old enrolment, a
  // partial wipe) used to read as "not enrolled", so Entry sent the device to /login and its
  // terminal key opened a NAP customer session. The record still names the device, so the device
  // is still treated as a terminal, and unlocking it is refused with nothing installed.
  it('is still a terminal device, so Entry never sends it to /login', () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY, { token: undefined })
    expect(isTerminalDevice()).toBe(true)
  })

  it('refuses to unlock it, and installs nothing', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY, { token: undefined })
    const api = mint('UNSPENT')

    const out = await unlockTerminal('pass', { loadKey: async () => DEVICE_HEX, mint: api })

    expect(out.unlocked).toBe(false)
    if (!out.unlocked) expect(out.reason).toBe('unreadable')
    expect(nap.installTerminalSigner).not.toHaveBeenCalled()
    expect(api.validateToken).not.toHaveBeenCalled()
  })

  // Someone's own wallet key beside such a record is a person, not that terminal: the screen
  // offers the wallet, as for any stale record.
  it('tells a wallet key apart from the terminal it names', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY, { token: undefined })
    const out = await unlockTerminal('pass', { loadKey: async () => bytesToHex(generateSecretKey()), mint: mint('UNSPENT') })
    expect(out.unlocked).toBe(false)
    if (!out.unlocked) expect(out.reason).toBe('not-a-terminal-key')
  })
})
