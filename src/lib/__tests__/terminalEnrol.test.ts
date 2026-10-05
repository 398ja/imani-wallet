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
/** Whether the key store's one slot already holds somebody's key. */
let walletKeyHeld = false

vi.mock('../nap', () => ({
  keyStore: {
    save: async (privkeyHex: string, passphrase: string) => {
      saved.push({ privkeyHex, passphrase })
    },
    hasKey: async () => walletKeyHeld,
    clear: async () => {
      cleared += 1
      if (clearFails) throw new Error('idb refused')
    },
  },
}))
/** How many times the key store was erased. */
let cleared = 0
/** Set to make the key store's clear() fail. */
let clearFails = false
/** Wallet databases deleted, and resume caches dropped (#160 round 2). */
const wiped: string[] = []
let resumeForgotten = 0
vi.mock('../wallet', () => ({
  wipeWallet: async (id: string) => {
    wiped.push(id)
  },
}))
vi.mock('../resume', () => ({
  forgetResume: () => {
    resumeForgotten += 1
  },
}))

const {
  beginEnrolment,
  completeEnrolment,
  enrolledActor,
  forgetPendingKey,
  forgetTerminal,
  offersFor,
  removeTerminalFromDevice,
  storedTerminal,
  MIN_PASSPHRASE_LENGTH,
} = await import('../terminalEnrol')
const { credentialMessageJson, enrolledMessageJson, unwrapSealed, wrapMessage } = await import(
  '../terminalDelivery'
)
const { buildLockedCredentialToken } = await import('./voucherFixtures')
const { generateSecretKey, getPublicKey } = await import('nostr-tools')
const { TERMINAL_ROLES, grantFor } = await import('../terminalRole')
type TerminalRole = (typeof TERMINAL_ROLES)[keyof typeof TERMINAL_ROLES]

const STALL = 'a'.repeat(64)

/**
 * A device key that is NOT the enrolled terminal's (IW-16).
 *
 * enrolledActor now takes the device key as an argument instead of reading it back out of the
 * record it is checking, so "this record belongs to another device" is finally a case that can
 * fail. Used for the not-enrolled assertions, where no record exists either way.
 */
const DEVICE_KEY = 'd'.repeat(64)
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
  walletKeyHeld = false
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
    expect(enrolledActor(DEVICE_KEY)).toBeNull()
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
    expect(enrolledActor(DEVICE_KEY)).toBeNull()
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
    const actor = enrolledActor(code.terminalPubkey)
    expect(actor).not.toBeNull()
    expect(actor!.stallPubkey).toBe(STALL)
    expect(actor!.terminalPubkey).toBe(code.terminalPubkey)
    expect(storedTerminal()!.name).toBe('Door')
  })

  it('acts for the STALL, never for itself', async () => {
    const code = beginEnrolment()
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE)

    expect(enrolledActor(code.terminalPubkey)!.stallPubkey).not.toBe(code.terminalPubkey)
  })

  it('keeps the role it was enrolled with', async () => {
    const code = beginEnrolment()
    await completeEnrolment(
      credentialFor(code.terminalPubkey, TERMINAL_ROLES.REDEEM_ONLY),
      PASSPHRASE,
    )

    expect(enrolledActor(code.terminalPubkey)!.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
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

    // This device's own key, so the refusal is about the tampered permissions and not about the
    // lock. Passing a foreign key here would make the test pass for the wrong reason.
    expect(enrolledActor(code.terminalPubkey)).toBeNull()
  })

  it('reads an unusable record as not enrolled, rather than throwing', () => {
    // A corrupted record must send the device back to enrolment, not into a
    // state where it believes it holds an authority it cannot describe.
    for (const bad of ['not json', '{}', '{"role":"owner"}', 'null']) {
      localStorage.setItem('imani-wallet:terminal', bad)
      expect(storedTerminal()).toBeNull()
      expect(enrolledActor(DEVICE_KEY)).toBeNull()
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

describe('IW-16: the device lock is a real comparison', () => {
  it('refuses a record locked to another device', async () => {
    // enrolledActor used to pass stored.terminalPubkey as BOTH the credential's lockedTo and the
    // device key, so terminalActor evaluated `lockedTo !== device` as `x !== x` and the check
    // could not fail. The record's claim about which device it belonged to was being checked
    // against the record's own claim.
    const code = beginEnrolment()
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE)

    expect(enrolledActor(code.terminalPubkey)).not.toBeNull()
    expect(enrolledActor('f'.repeat(64))).toBeNull()
  })

  it('refuses when no device key is supplied', () => {
    expect(enrolledActor('')).toBeNull()
  })
})

describe('#160 phase 0: setup never destroys a wallet', () => {
  // A phone that already holds a person's wallet key is set up as a terminal.
  // The key store has one slot, so finishing setup would overwrite the key to
  // their money. Setup must refuse, and leave that key exactly where it was.
  it('refuses on a device that already holds a wallet key, and leaves the key loadable', async () => {
    walletKeyHeld = true
    const code = beginEnrolment()

    await expect(completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE)).rejects.toThrow(
      /already holds a wallet/,
    )

    // Nothing was written over the slot, and no terminal record was created.
    expect(saved).toEqual([])
    expect(storedTerminal()).toBeNull()
  })

  // The refusal is about the key slot, not about this attempt: once the person
  // has logged out (the slot is empty), the same pending code still completes,
  // so they need not start the code exchange again.
  it('completes once the device holds no wallet key', async () => {
    walletKeyHeld = true
    const code = beginEnrolment()
    await expect(completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE)).rejects.toThrow()

    walletKeyHeld = false
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE)
    expect(saved).toHaveLength(1)
  })
})

describe('#160 decision 2: the passphrase is at least 8 characters', () => {
  // A shared till's passphrase is the only thing between a picked-up tablet
  // and the stall's till. Seven characters is refused, before anything is stored.
  it('refuses a passphrase shorter than 8 characters, and stores nothing', async () => {
    const code = beginEnrolment()
    await expect(completeEnrolment(credentialFor(code.terminalPubkey), 'seven77')).rejects.toThrow(
      /at least 8 characters/,
    )
    expect(saved).toEqual([])
    expect(storedTerminal()).toBeNull()
    expect(MIN_PASSPHRASE_LENGTH).toBe(8)
  })

  // Exactly 8 is enough.
  it('accepts exactly 8 characters', async () => {
    const code = beginEnrolment()
    await completeEnrolment(credentialFor(code.terminalPubkey), 'eight888')
    expect(saved).toHaveLength(1)
  })
})

describe('#160 phase 2: the credential arrives by DM, opened on the device', () => {
  const stallKey = generateSecretKey()
  const stall = getPublicKey(stallKey)
  const voucherId = '5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9'

  /** The owner's DM, sealed by the stall, carrying a real credential for `device`. */
  const dmFor = (device: string, sealKey = stallKey) =>
    wrapMessage(
      sealKey,
      device,
      credentialMessageJson({
        voucherId,
        token: buildLockedCredentialToken({ stallKey, devicePubkey: device, voucherId }),
        stallPubkey: stall,
        name: 'Front counter',
        idleLockMinutes: 15,
      }),
    )

  // The pending key opens the DM inside the module and reads the offer. The
  // caller never needed the key to do it.
  it('reads an offer addressed to the pending key', () => {
    const code = beginEnrolment()
    const [offer] = offersFor([dmFor(code.terminalPubkey)], undefined, { stallPubkey: stall, voucherId })

    expect(typeof offer).toBe('object')
    if (typeof offer !== 'object') return
    expect(offer.stallPubkey).toBe(stall)
    expect(offer.idleLockMinutes).toBe(15)
  })

  // A credential for another device, or sealed by another stall than it
  // names, is refused, and nothing is stored (spec AC).
  it('refuses a credential for another key, or sealed by another stall, and stores nothing', () => {
    const code = beginEnrolment()
    const elsewhere = getPublicKey(generateSecretKey())
    const forOther = wrapMessage(
      stallKey,
      code.terminalPubkey,
      credentialMessageJson({
        voucherId,
        token: buildLockedCredentialToken({ stallKey, devicePubkey: elsewhere, voucherId }),
        stallPubkey: stall,
        name: 'x',
        idleLockMinutes: 10,
      }),
    )
    const sealedByIntruder = dmFor(code.terminalPubkey, generateSecretKey())

    expect(offersFor([forOther, sealedByIntruder], undefined, { stallPubkey: stall, voucherId })).toEqual([
      'not-locked-to-this-device',
      'sealed-by-another',
    ])
    expect(saved).toEqual([])
    expect(storedTerminal()).toBeNull()
  })

  // The spec's AC: the private key never appears in DOM, storage before
  // completion, network payloads or logs. Here: nothing an offer, a stored
  // record, a published wrap or a console line carries contains it.
  it('never lets the private key reach an offer, a payload, storage or a log', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')))
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => void logs.push(a.join(' ')))
    const code = beginEnrolment()
    const [offer] = offersFor([dmFor(code.terminalPubkey)], undefined, { stallPubkey: stall, voucherId })
    if (typeof offer !== 'object') throw new Error('no offer')
    // Before completion: nothing in storage at all.
    expect(localStorage.length).toBe(0)

    const published: unknown[] = []
    // The role is the verified offer's signed metadata, not a stored record.
    // nosemgrep: imani-role-from-local-storage
    await completeEnrolment(
      {
        stallPubkey: stall,
        role: offer.metadata.role,
        lockedTo: offer.metadata.lock_key,
        permissions: grantFor(offer.metadata.role, stall),
      },
      PASSPHRASE,
      offer.name,
      { token: offer.token, merchantMetadata: offer.merchantMetadata, issuerId: offer.issuerId },
      {
        voucherId: offer.voucherId,
        idleLockMinutes: offer.idleLockMinutes,
        announce: async (tools) => {
          published.push(tools.wrap(stall, enrolledMessageJson(offer.voucherId, code.terminalPubkey)))
          published.push(
            await tools.signer.signEvent({ kind: 27235, created_at: 0, tags: [], content: '' }),
          )
        },
      },
    )
    spy.mockRestore()
    warn.mockRestore()

    const secret = saved[0].privkeyHex
    expect(JSON.stringify(offer)).not.toContain(secret)
    expect(JSON.stringify(published)).not.toContain(secret)
    expect(JSON.stringify({ ...localStorage })).not.toContain(secret)
    expect(logs.join('\n')).not.toContain(secret)
    expect(storedTerminal()?.voucherId).toBe(voucherId)
    expect(storedTerminal()?.idleLockMinutes).toBe(15)
  })

  // The enrolled DM is sealed by the device key and opens for the stall, so the
  // owner can believe it came from this device.
  it('announces enrolment to the stall, sealed by the device', async () => {
    const code = beginEnrolment()
    let wrap: ReturnType<typeof wrapMessage> | undefined
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE, 'Door', undefined, {
      voucherId,
      announce: async (tools) => {
        wrap = tools.wrap(stall, enrolledMessageJson(voucherId, code.terminalPubkey))
      },
    })

    const opened = unwrapSealed(wrap!, stallKey)
    expect(opened?.sealer).toBe(code.terminalPubkey)
  })

  // A failed announce does not undo the enrolment: the device is set up.
  it('stays enrolled when telling the stall fails', async () => {
    const code = beginEnrolment()
    await completeEnrolment(credentialFor(code.terminalPubkey), PASSPHRASE, 'Door', undefined, {
      announce: async () => {
        throw new Error('offline')
      },
    })
    expect(storedTerminal()).not.toBeNull()
  })
})

describe('#160 review: an enrolled device has a way out before phase 3', () => {
  // A device set up in phase 2 cannot open its till yet, and had no unlock
  // and no log out: getting it back meant clearing site data by hand.
  // "Remove this terminal from this device" erases the encrypted key and the
  // record, so the device reads as fresh again. It does not touch the mint:
  // only the owner can revoke.
  it('erases the terminal key and record from this device', async () => {
    cleared = 0
    localStorage.setItem(
      'imani-wallet:terminal',
      JSON.stringify({
        stallPubkey: 'a'.repeat(64),
        role: TERMINAL_ROLES.REDEEM_ONLY,
        terminalPubkey: 'b'.repeat(64),
        permissions: [],
        enrolledAt: 1,
        token: 'cashuB-x',
      }),
    )

    await removeTerminalFromDevice()

    expect(cleared).toBe(1)
    expect(storedTerminal()).toBeNull()
  })
})

describe('#160 round 2: removing a terminal clears what logout clears', () => {
  // Taking a terminal off a device must leave it as clean as logging out does,
  // or phase 3's extra terminal state would survive it. This lists every piece
  // that is cleared: the key at rest, the pending key, the resume cache, every
  // imani-wallet:* localStorage entry, and the wallet database under the
  // terminal's key. Anything outside the app's prefix is left alone.
  it('clears the key, the record, every app entry, the resume cache and the wallet db', async () => {
    cleared = 0
    resumeForgotten = 0
    wiped.length = 0
    clearFails = false
    localStorage.clear()
    const device = 'b'.repeat(64)
    localStorage.setItem(
      'imani-wallet:terminal',
      JSON.stringify({ stallPubkey: 'a'.repeat(64), role: TERMINAL_ROLES.REDEEM_ONLY, terminalPubkey: device }),
    )
    localStorage.setItem('imani-wallet:terminal-session', 'x')
    localStorage.setItem(`imani-wallet:profile:${device}`, 'x')
    localStorage.setItem('someone-else', 'kept')

    const removed = await removeTerminalFromDevice()

    expect(removed.storage.sort()).toEqual(
      ['imani-wallet:terminal', 'imani-wallet:terminal-session', `imani-wallet:profile:${device}`].sort(),
    )
    expect(removed.walletDb).toBe(device)
    expect(cleared).toBe(1)
    expect(resumeForgotten).toBe(1)
    expect(wiped).toEqual([device])
    expect(Object.keys(localStorage)).toEqual(['someone-else'])
    expect(storedTerminal()).toBeNull()
  })

  // A key store that will not clear used to be swallowed, and the record was
  // then skipped. Now every other step still runs, and the failure is thrown
  // so the screen can say the key may still be there.
  it('still clears everything else when the key store fails, then reports it', async () => {
    clearFails = true
    localStorage.clear()
    localStorage.setItem('imani-wallet:terminal', JSON.stringify({ terminalPubkey: 'b'.repeat(64) }))

    await expect(removeTerminalFromDevice()).rejects.toThrow('idb refused')

    expect(localStorage.getItem('imani-wallet:terminal')).toBeNull()
    clearFails = false
  })
})
