/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { useTerminalIdentity } from '../useTerminalIdentity'
import { parseVoucherToken } from '../voucherToken'
import { SESSION_KIND } from '../terminalSession'
import { TERMINAL_ROLES } from '../terminalRole'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { buildLockedCredentialToken } from './voucherFixtures'

/**
 * The hook that finally makes ticket 07's gating reachable.
 *
 * Until this existed `App` rendered the till with no actor and no session, so
 * the role gating and the lapse notice were correct code no user could reach.
 * These assert the two shapes that matter: the owner's own device must be
 * completely unaffected, and a terminal must get the authority its REAL
 * credential confers.
 */

const TOKEN = readFileSync(
  join(__dirname, 'fixtures', 'live-terminal-credential.token'),
  'utf8',
).trim()
const parsed = parseVoucherToken(TOKEN)
/**
 * What the minting script SENT, recorded beside the token. Hardcoded hex here
 * meant re-minting the fixture — which the live spend probe requires, since a
 * swap consumes the proof — failed four tests over a credential that was valid.
 */
const MINTED = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'live-terminal-credential.json'), 'utf8'),
) as { stall: string; device: string }
const DEVICE = MINTED.device
const STALL = MINTED.stall
/** The key that signed the live credential: the issuing gateway's, not the stall's. */
const GATEWAY_SIGNER = parsed.voucher.issuerPublicKey

const ENROLMENT_KEY = 'imani-wallet:terminal'

function enrol(over: Record<string, unknown> = {}) {
  localStorage.setItem(
    ENROLMENT_KEY,
    JSON.stringify({
      stallPubkey: STALL,
      role: TERMINAL_ROLES.REDEEM_ONLY,
      terminalPubkey: DEVICE,
      permissions: [`voucher:redeem:${STALL}`],
      enrolledAt: 1_000_000,
      token: TOKEN,
      merchantMetadata: parsed.voucher.merchantMetadata,
      issuerId: parsed.voucher.issuerId,
      ...over,
    }),
  )
}

const mint = (state: string) => ({ validateToken: vi.fn(async () => ({ state })) })

// The build names the key that signs terminal credentials, as every deploy must now: a terminal
// credential whose signer is not on VITE_VOUCHER_ISSUER_PUBKEYS is refused (#160 review, IW-15).
// The real fixture was signed by the gateway's issuing key, which is what a deploy names.
beforeEach(() => {
  vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', GATEWAY_SIGNER)
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('the stall’s own device', () => {
  it('is not a terminal, and settles immediately', () => {
    /**
     * The overwhelmingly common case. `ready` is true on the FIRST render with
     * no async work at all, because the owner's till must not wait on a
     * question that cannot change its answer.
     */
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE }))

    expect(result.current.actor).toBeNull()
    expect(result.current.session).toBeNull()
    expect(result.current.ready).toBe(true)
  })

  it('never asks the mint anything', () => {
    const api = mint('UNSPENT')
    renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...api }))
    expect(api.validateToken).not.toHaveBeenCalled()
  })
})

describe('a device enrolled before the credential was stored', () => {
  it('behaves as the owner’s device rather than as a broken terminal', async () => {
    // A ticket-04 record has no token. It must not become a terminal that
    // cannot log in; it stays exactly as the app always behaved.
    enrol({ token: undefined, merchantMetadata: undefined, issuerId: undefined })
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.refusal).toBeNull()
  })
})

describe('a real terminal', () => {
  it('logs in with the authority its credential confers', async () => {
    enrol()
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...mint('UNSPENT') }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).not.toBeNull()
    expect(result.current.actor!.stallPubkey).toBe(STALL)
    expect(result.current.actor!.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(result.current.session!.kind).toBe(SESSION_KIND.FULL)
  })

  it('is refused once the owner has revoked it', async () => {
    // Revocation is the act of spending the credential, so the mint reporting
    // SPENT is the terminal being finished — everywhere, not just here.
    enrol()
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...mint('SPENT') }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.refusal).toMatch(/no longer in service/)
  })

  it('trades on reduced authority when the mint cannot be reached', async () => {
    /**
     * The queue cannot wait for the network to agree. Failing closed here would
     * take a stall off the market every time its connection dropped.
     */
    enrol()
    const api = {
      validateToken: vi.fn(async () => {
        throw new Error('offline')
      }),
    }
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...api }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).not.toBeNull()
    expect(result.current.session!.kind).toBe(SESSION_KIND.REDUCED)
  })

  it('is refused when its record was edited to claim this session’s key', async () => {
    // The credential is locked to a key; editing the record around it changes
    // nothing, because login re-derives everything from the signed metadata.
    // Here the record was rewritten to name the key this session holds, but the
    // credential inside it is still locked to DEVICE, so login refuses it.
    const other = 'e'.repeat(64)
    enrol({ terminalPubkey: other })
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: other, ...mint('UNSPENT') }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.refusal).toMatch(/not for this device/)
  })

  it('ignores permissions widened in the stored record', async () => {
    /**
     * Ticket 10's third criterion, at the point it actually matters. The record
     * on disk is editable by whoever holds the device; the credential is not.
     * A record claiming issuance must still produce a redemption-only terminal.
     */
    enrol({
      role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
      permissions: [`voucher:issue:${STALL}`, `voucher:redeem:${STALL}`],
    })
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...mint('UNSPENT') }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor!.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(result.current.actor!.permissions).not.toContain(`voucher:issue:${STALL}`)
  })
})

describe('#160 phase 3: login reads the token, never the fields stored beside it', () => {
  // IW-15. The record's `merchantMetadata` used to be what login verified, and anyone holding the
  // device can edit it. Here it is replaced with metadata claiming the issuing role, keeping the
  // real token. The terminal must still log in as the redeem-only till its signed token says.
  it('ignores metadata and issuer edited into the record', async () => {
    const forged = JSON.stringify({
      ...JSON.parse(String(parsed.voucher.merchantMetadata)),
      role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
    })
    enrol({ role: TERMINAL_ROLES.ISSUE_AND_REDEEM, merchantMetadata: forged })
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...mint('UNSPENT') }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor!.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(result.current.actor!.permissions).not.toContain(`voucher:issue:${STALL}`)
  })

  // #160 review (IW-15 test gap). The credential is signed by a key this build TRUSTS, so the only
  // thing that can refuse it is the signature check. Its metadata is then edited after signing, to
  // claim the issuing role. The signature no longer covers the bytes, so login refuses it. Before
  // the review this test signed with a random key, so the allowlist refused it first and deleting
  // the signature check left the test passing.
  it('refuses a token whose signed metadata was edited', async () => {
    const trustedKey = generateSecretKey()
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', getPublicKey(trustedKey))
    const metadata = (role: string) =>
      JSON.stringify({ terminal: true, stall_pubkey: getPublicKey(trustedKey), role, lock_key: DEVICE, name: 'Front counter' })
    const signed = buildLockedCredentialToken({
      stallKey: trustedKey,
      devicePubkey: DEVICE,
      metadata: metadata(TERMINAL_ROLES.REDEEM_ONLY),
    })
    const tampered = buildLockedCredentialToken({
      stallKey: trustedKey,
      devicePubkey: DEVICE,
      metadata: metadata(TERMINAL_ROLES.REDEEM_ONLY),
      tamperMetadata: metadata(TERMINAL_ROLES.ISSUE_AND_REDEEM),
    })

    // The control: the same credential, untouched, logs in. So the refusal below is the edit's.
    enrol({ stallPubkey: getPublicKey(trustedKey), token: signed })
    const control = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...mint('UNSPENT') }))
    await waitFor(() => expect(control.result.current.ready).toBe(true))
    expect(control.result.current.actor?.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    control.unmount()

    enrol({ stallPubkey: getPublicKey(trustedKey), token: tampered })
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...mint('UNSPENT') }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.refusal).not.toBeNull()
  })

  // #160 review (IW-15). A credential re-signed with the attacker's own key verifies against the
  // key it carries. Only the allowlist can tell it from a real one, so it must refuse it.
  it('refuses a credential signed by a key the build does not trust', async () => {
    const forged = buildLockedCredentialToken({
      stallKey: generateSecretKey(),
      devicePubkey: DEVICE,
      role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
    })
    enrol({ token: forged })
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...mint('UNSPENT') }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
  })

  // #160 review (IW-15). No deploy set VITE_VOUCHER_ISSUER_PUBKEYS, and an unset list used to
  // mean "unchecked": any self-signed credential opened an issuing till for any stall. For a
  // terminal credential an empty list now refuses, even the real one.
  it('refuses every credential when the build names no trusted signer', async () => {
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', '')
    enrol()
    const { result } = renderHook(() => useTerminalIdentity({ devicePubkey: DEVICE, ...mint('UNSPENT') }))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.refusal).toMatch(/cannot confirm who issued/)
  })
})

describe('#160 phase 0 (G9): the device key comes from the unlocked signer', () => {
  // The record and the credential both name DEVICE, but the key that unlocked
  // this session is someone else's. The record cannot vouch for itself: this
  // session does not hold the key the credential is locked to, so it is not
  // that terminal. It gets no terminal authority, and the mint is not asked.
  it('grants no terminal authority to a session that does not hold the record’s key', async () => {
    enrol()
    const api = mint('UNSPENT')
    const { result } = renderHook(() =>
      useTerminalIdentity({ devicePubkey: 'e'.repeat(64), ...api }),
    )

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.session).toBeNull()
    // Decided locally, before the mint was asked anything.
    expect(api.validateToken).not.toHaveBeenCalled()
  })

  // No unlocked key at all is the same answer: nothing shows this device
  // holds the credential's key, so it is not a terminal.
  it('grants no terminal authority when no unlocked key is supplied', async () => {
    enrol()
    const { result } = renderHook(() =>
      useTerminalIdentity({ devicePubkey: null, ...mint('UNSPENT') }),
    )

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.session).toBeNull()
  })
})

describe('#160 review (LOW): a record for another device does not lock the owner out', () => {
  // The owner is logged in with the stall key, and storage holds a terminal
  // record written for some other device (left over from a test, a shared
  // browser, or a set-up that was abandoned). That record is not about this
  // session, so it must be ignored exactly as a missing record is. Before the
  // fix the hook returned a "not for this device" refusal, and the owner's home
  // screen rendered NotTrading for their own stall.
  it('treats the owner as the owner, with no refusal', async () => {
    enrol()
    const { result } = renderHook(() =>
      useTerminalIdentity({ devicePubkey: STALL, ...mint('UNSPENT') }),
    )

    // Wait on the deferred update itself, not the clock (#286).
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.actor).toBeNull()
    expect(result.current.refusal).toBeNull()
  })

  // Same for a session with no unlocked key yet: a foreign record must not
  // put a refusal on screen.
  it('shows no refusal when no key is unlocked', async () => {
    enrol()
    const { result } = renderHook(() =>
      useTerminalIdentity({ devicePubkey: null, ...mint('UNSPENT') }),
    )

    // Settle first (#286), so a refusal set by the deferred update would be seen.
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.refusal).toBeNull()
  })
})
