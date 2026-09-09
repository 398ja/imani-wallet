/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The device side of enrolment.
 *
 * Two properties, and both are negatives:
 *
 * 1. **The private key never leaves the device.** Asserted over what the flow
 *    actually displays and stores, not promised in a comment — because the
 *    spec's claim that a market till setup "is not a security event" is exactly
 *    this and nothing else.
 * 2. **Nothing is persisted until enrolment completes.** `registration.test.ts`
 *    is the prior art: a device that stored its key on `begin()` would leave a
 *    half-enrolled terminal indistinguishable, at next launch, from a real one.
 */

const saved: Array<{ privkeyHex: string; passphrase: string }> = []

vi.mock('../nap', () => ({
  keyStore: {
    save: async (privkeyHex: string, passphrase: string) => {
      saved.push({ privkeyHex, passphrase })
    },
  },
}))

const { beginEnrolment, completeEnrolment, enrolledActor, forgetPendingKey, forgetTerminal, storedTerminal } =
  await import('../terminalEnrol')
const { TERMINAL_ROLES, grantFor } = await import('../terminalRole')
type TerminalRole = (typeof TERMINAL_ROLES)[keyof typeof TERMINAL_ROLES]

const STALL = 'a'.repeat(64)
const OTHER_STALL = 'b'.repeat(64)
const PASSPHRASE = 'correct horse battery staple'

/** The credential the owner hands back, locked to whatever this device showed. */
function credentialFor(
  terminalPubkey: string,
  // Annotated rather than inferred: the default would otherwise narrow the
  // parameter to the one role it happens to be, and every redeem-only case
  // below would be a type error rather than a test.
  role: TerminalRole = TERMINAL_ROLES.ISSUE_AND_REDEEM,
) {
  return {
    stallPubkey: STALL,
    role,
    lockedTo: terminalPubkey,
    permissions: grantFor(role, STALL),
  }
}

beforeEach(() => {
  saved.length = 0
  forgetPendingKey()
  forgetTerminal()
  localStorage.clear()
})

describe('the key never leaves the device', () => {
  it('shows a PUBLIC key, and nothing that could reconstruct the private one', () => {
    const code = beginEnrolment()

    // A 32-byte hex pubkey and a URI wrapping it. Nothing else.
    expect(code.terminalPubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(code.uri).toBe(`nostr:${code.terminalPubkey}`)

    // The negative, over everything the flow displays: whatever private key was
    // minted, it is not in here. Compared against what the key store was
    // actually handed after a completed enrolment, below.
    expect(JSON.stringify(code)).not.toMatch(/nsec/)
  })

  it('hands the private key to the key store and to nothing else', async () => {
    const code = beginEnrolment()
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE)

    expect(saved).toHaveLength(1)
    const secret = saved[0].privkeyHex
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    // The real assertion: that exact secret appears in NOTHING the flow emitted
    // or wrote down.
    expect(JSON.stringify(code)).not.toContain(secret)
    expect(JSON.stringify(storedTerminal())).not.toContain(secret)
    expect(localStorage.getItem('imani-wallet:terminal')).not.toContain(secret)
  })

  it('shows a code that is not the key it protects', async () => {
    const code = beginEnrolment()
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE)

    // Public and private halves are different values — a guard against a
    // refactor that "simplified" one into the other.
    expect(code.terminalPubkey).not.toBe(saved[0].privkeyHex)
  })
})

describe('the passphrase', () => {
  it('protects the key at rest', async () => {
    const code = beginEnrolment()
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE)

    expect(saved[0].passphrase).toBe(PASSPHRASE)
  })

  it('is required, not defaulted', async () => {
    // A blank passphrase is a key at rest in clear, and a terminal that trades
    // for whoever switches it on.
    const code = beginEnrolment()
    await expect(completeEnrolment(credentialFor(code.terminalPubkey), '')).rejects.toThrow(
      /passphrase/i,
    )
    expect(saved).toEqual([])
  })
})

describe('nothing is stored until enrolment completes', () => {
  it('persists nothing when the code is merely displayed', () => {
    beginEnrolment()

    expect(saved).toEqual([])
    expect(storedTerminal()).toBeNull()
    expect(enrolledActor()).toBeNull()
  })

  it('persists nothing when the credential does not check out', async () => {
    const code = beginEnrolment()

    // Locked to a DIFFERENT device: the case that makes a photographed
    // credential worthless.
    const notOurs = { ...credentialFor(code.terminalPubkey), lockedTo: 'f'.repeat(64) }
    await expect(completeEnrolment(notOurs, PASSPHRASE)).rejects.toThrow(/not a valid authority/)

    // No key saved, no record written, no session possible.
    expect(saved).toEqual([])
    expect(storedTerminal()).toBeNull()
    expect(enrolledActor()).toBeNull()
  })

  it('persists nothing when the credential is for another stall’s permissions', async () => {
    const code = beginEnrolment()
    const crossed = {
      ...credentialFor(code.terminalPubkey),
      permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, OTHER_STALL),
    }

    await expect(completeEnrolment(crossed, PASSPHRASE)).rejects.toThrow()
    expect(saved).toEqual([])
    expect(storedTerminal()).toBeNull()
  })

  it('refuses to complete an enrolment that was never begun', async () => {
    await expect(completeEnrolment(credentialFor('c'.repeat(64)), PASSPHRASE)).rejects.toThrow(
      /Start enrolment/,
    )
    expect(saved).toEqual([])
  })
})

describe('logging itself in afterwards', () => {
  it('reuses what the owner returned, with no person present', async () => {
    const code = beginEnrolment()
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE, 'Door')

    // A fresh read, as at next launch.
    const actor = enrolledActor()
    expect(actor).not.toBeNull()
    expect(actor!.stallPubkey).toBe(STALL)
    expect(actor!.terminalPubkey).toBe(code.terminalPubkey)
    expect(storedTerminal()!.name).toBe('Door')
  })

  it('acts for the STALL, never for itself', async () => {
    const code = beginEnrolment()
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE)

    expect(enrolledActor()!.stallPubkey).not.toBe(code.terminalPubkey)
  })

  it('keeps the role it was enrolled with', async () => {
    const code = beginEnrolment()
    await completeEnrolment(
      credentialFor(code.terminalPubkey, TERMINAL_ROLES.REDEEM_ONLY),
      PASSPHRASE,
    )

    expect(enrolledActor()!.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
  })

  it('refuses a record whose permissions were tampered with on disk', async () => {
    /**
     * The stored record lives where anything could edit it, so it is re-verified
     * at launch rather than trusted. A device whose storage was edited to add
     * issuance is refused HERE, not at the API.
     */
    const code = beginEnrolment()
    await completeEnrolment(
      credentialFor(code.terminalPubkey, TERMINAL_ROLES.REDEEM_ONLY),
      PASSPHRASE,
    )

    const tampered = {
      ...storedTerminal()!,
      permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
    }
    localStorage.setItem('imani-wallet:terminal', JSON.stringify(tampered))

    expect(enrolledActor()).toBeNull()
  })

  it('reads an unusable record as not enrolled, rather than throwing', () => {
    // A corrupted record must send the device back to enrolment, not into a
    // state where it believes it holds an authority it cannot describe.
    for (const bad of ['not json', '{}', '{"role":"owner"}', 'null']) {
      localStorage.setItem('imani-wallet:terminal', bad)
      expect(storedTerminal()).toBeNull()
      expect(enrolledActor()).toBeNull()
    }
  })
})

describe('retrying', () => {
  it('shows the same code, so an owner who scanned once need not rescan', () => {
    const first = beginEnrolment()
    const second = beginEnrolment()

    expect(second.terminalPubkey).toBe(first.terminalPubkey)
  })

  it('starts fresh once an enrolment has completed', async () => {
    const first = beginEnrolment()
    await completeEnrolment(credentialFor(first.terminalPubkey), PASSPHRASE)

    // A second enrolment is a new terminal identity, not the old one reused.
    const second = beginEnrolment()
    expect(second.terminalPubkey).not.toBe(first.terminalPubkey)
  })
})
