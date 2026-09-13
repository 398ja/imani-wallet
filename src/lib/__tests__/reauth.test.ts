/**
 * Re-authentication, at the seam where it can go quietly wrong.
 *
 * Two of these are about correctness the UI cannot show you. `reauthenticate`
 * verifies the passphrase by DECRYPTING the stored key, so a wrong one must
 * never reach `login()` — and `login()` must never be called on a locked session
 * whose key has been zeroed, because nap throws from inside it and the failure
 * surfaces nowhere useful. The order of the three steps is the contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PUBKEY = 'a'.repeat(64)
const PRIVKEY = 'b'.repeat(64)

/** Records the order calls landed in, which is what these tests are really about. */
let calls: string[] = []

const session = {
  isLocked: vi.fn(() => false),
  reunlock: vi.fn((passphrase: string) => {
    calls.push(`reunlock:${passphrase.length > 0 ? 'given' : 'empty'}`)
    return Promise.resolve()
  }),
  login: vi.fn(async () => {
    calls.push('login')
  }),
  getSession: vi.fn(() => ({ pubkey: PUBKEY })),
}

let currentSession: typeof session | undefined = session
/**
 * The recording implementation, restored in `beforeEach`.
 *
 * A bare `mockResolvedValue` would replace it and silently stop recording, which
 * cost a confusing red on the ordering tests — the very thing this file exists
 * to check.
 */
const loadsKey = (passphrase: string) => {
  calls.push(`loadKey:${passphrase}`)
  return Promise.resolve(PRIVKEY)
}
const loadKey = vi.fn(loadsKey)

vi.mock('../nap', () => ({
  getSession: () => currentSession,
  keyStore: {
    loadKey: (passphrase: string) => loadKey(passphrase),
  },
}))

const remember = vi.fn((pubkey: string, privkeyHex: string) => {
  calls.push(`remember:${pubkey}:${privkeyHex}`)
  return Promise.resolve()
})
vi.mock('../resume', () => ({
  remember: (pubkey: string, privkeyHex: string) => remember(pubkey, privkeyHex),
}))

const { reauthenticate } = await import('../reauth')

describe('reauthenticate', () => {
  beforeEach(() => {
    calls = []
    currentSession = session
    vi.clearAllMocks()
    session.isLocked.mockReturnValue(false)
    session.getSession.mockReturnValue({ pubkey: PUBKEY })
    loadKey.mockImplementation(loadsKey)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('verifies the passphrase against the keystore, then logs in', async () => {
    await reauthenticate('correct horse')

    expect(loadKey).toHaveBeenCalledWith('correct horse')
    // The keystore IS the verifier. There is deliberately no cheaper one — a
    // stored hash would be a second thing that can disagree with the key.
    // The passphrase is captured in the trace, so this also pins that the value
    // reaching the keystore is the one the user typed.
    expect(calls).toEqual([
      'loadKey:correct horse',
      'login',
      `remember:${PUBKEY}:${PRIVKEY}`,
    ])
  })

  it('refuses a wrong passphrase WITHOUT touching the session', async () => {
    loadKey.mockRejectedValue(new DOMException('bad decrypt', 'OperationError'))

    await expect(reauthenticate('wrong')).rejects.toThrow('That passphrase is not right')

    // The load-bearing assertion. A wrong passphrase that still reached login()
    // would spend a challenge and renew the session anyway, which would make the
    // prompt decorative.
    expect(session.login).not.toHaveBeenCalled()
    expect(session.reunlock).not.toHaveBeenCalled()
  })

  it('translates the crypto failure into something a customer can act on', async () => {
    loadKey.mockRejectedValue(new DOMException('bad decrypt', 'OperationError'))

    // "OperationError" on a dialog that appeared unannounced is how someone
    // concludes the app has lost their money.
    await expect(reauthenticate('wrong')).rejects.toThrow(/passphrase is not right/)
  })

  it('restores an evicted key BEFORE logging in', async () => {
    session.isLocked.mockReturnValue(true)

    await reauthenticate('correct horse')

    // A lock zeroes the key (RFC §28.6). login() before reunlock() throws
    // SessionLockedError from inside nap, which surfaces as a failure the user
    // cannot interpret and cannot fix by retrying.
    expect(calls).toEqual([
      'loadKey:correct horse',
      'reunlock:given',
      'login',
      `remember:${PUBKEY}:${PRIVKEY}`,
    ])
  })

  it('does not re-decrypt a key that is already in the signer', async () => {
    session.isLocked.mockReturnValue(false)

    await reauthenticate('correct horse')

    // The common case: the cookie expired but the key never left memory. A
    // second PBKDF2 pass here would be pure latency on the hot path.
    expect(session.reunlock).not.toHaveBeenCalled()
  })

  it('refreshes the tab\u2019s reload cache, so a reload does not re-prompt', async () => {
    await reauthenticate('correct horse')

    expect(remember).toHaveBeenCalledWith(PUBKEY, PRIVKEY)
  })

  it('reports a login failure with its cause attached', async () => {
    session.login.mockRejectedValue(new Error('Failed to fetch'))

    await expect(reauthenticate('correct horse')).rejects.toThrow(
      /Could not restore your session: Failed to fetch/,
    )
  })

  it('refuses when the session singleton has gone', async () => {
    currentSession = undefined

    // A logout in another tab. Nothing here can recover it, so it says so
    // instead of throwing something shaped like a passphrase problem.
    await expect(reauthenticate('correct horse')).rejects.toThrow(/session has ended/)
  })
})
