import { createNapSession, createWebCryptoKeyStore } from '@imani/nap-client-web'
import type { NapSession } from '@imani/nap-client-web'
import { nip19 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { createWalletSigner, type WalletSigner } from './signer'

/** The subset of a parsed NUT-18V request the wallet reads. */
export interface NUT18VRequest {
  paymentId: string
  issuerId: string
  /** MINOR units. The wire format carries no decimals — see PayPage. */
  amount: number
  unit: string
  description?: string
  /** Unix SECONDS. `expiresAt` is the name the parser emits — see PayPage. */
  expiresAt?: number
  transports: { type: string; target: string; relays?: string[] }[]
  mints?: string[]
}

declare global {
  interface Window {
    /** Installed by the side-effect import of imani-apps/shared/nut18v.js. */
    NUT18V?: {
      parse(request: string): NUT18VRequest
      isVoucherPaymentRequest(text: string): boolean
      isExpired(request: NUT18VRequest): boolean
    }
  }
}

/**
 * The passphrase-encrypted store holding the customer's key at rest.
 *
 * nap's own WebCrypto implementation — PBKDF2 + AES-GCM, fresh salt and IV per
 * write. RFC §1181 forbids plaintext key material at rest, localStorage
 * included, so "remember my key" has to mean this and not a raw nsec.
 */
export const keyStore = createWebCryptoKeyStore('imani-wallet-key')

let session: NapSession | undefined
let signer: WalletSigner | undefined

/** The live signer, once a session exists. Needed for DM decryption. */
export function getSigner(): WalletSigner {
  if (!signer) throw new Error('No signer — the wallet has not been unlocked.')
  return signer
}

export function hasStoredKey(): Promise<boolean> {
  return keyStore.hasKey()
}

/**
 * Accepts a backup key (nsec) or raw hex, and normalises to hex.
 *
 * The messages say "backup key", never "nsec" (#324): they are shown under the
 * field where someone pasted theirs, and that is the name the app gives it
 * everywhere else. The FORMATS accepted do not change.
 */
export function toPrivkeyHex(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('nsec')) {
    // The decoder's own message ("Invalid checksum in nsec1…") is protocol
    // talk and echoes part of the key back; a typo gets the plain sentence.
    let decoded: ReturnType<typeof nip19.decode>
    try {
      decoded = nip19.decode(trimmed)
    } catch {
      throw new Error('That does not look like a backup key. Paste it exactly as you saved it.')
    }
    if (decoded.type !== 'nsec') throw new Error('That is not a backup key.')
    return bytesToHex(decoded.data)
  }
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new Error('That does not look like a backup key. Paste it exactly as you saved it.')
  }
  return trimmed.toLowerCase()
}

/**
 * Build the app's single NAP session around a key-holding signer.
 *
 * Passing `keyStore` is what makes `requiresPassphrase()` true and gives nap a
 * real reunlock path: lock zeroes the key via the signer's `clearKey()`, and
 * reunlock decrypts it back out of the store. Without it a lock would be
 * unrecoverable for this signer type.
 *
 * baseUrl is same-origin: Vite proxies /api to account-app on :28081, so the
 * opaque session cookie is first-party and needs no CORS handling.
 *
 * It must include the `/v1` segment. nap builds `${baseUrl}/auth/${path}`, and
 * the gateway serves `/api/v1/auth/init` — a bare `/api` yields
 * `/api/auth/init`, which Spring answers 401 (not 404), so the mistake reads as
 * an auth failure rather than a wrong URL.
 *
 * `callbacks` comes from useNapCallbacks() and MUST be passed — they are how
 * session transitions reach React state.
 */
export function createSession(privkeyHex: string, callbacks: object): NapSession {
  if (session) return session

  signer = createWalletSigner(privkeyHex)
  session = createNapSession({
    baseUrl: '/api/v1',
    signer,
    keyStore,
    broadcast: { enabled: true },
    ...callbacks,
  })
  return session
}

export function getSession(): NapSession | undefined {
  return session
}

/**
 * Hold a terminal's unlocked key as the app's signer, with NO NAP session (#160 phase 3).
 *
 * A terminal is not a customer and has no account, so it never calls `/api/v1/auth/*` (spec
 * 2.3): NAP would log its key in as a customer. It still needs a signer for NIP-98 requests and
 * for the NUT-11 witness that hands its credential back, and the code that makes those
 * (`signedFetch`, `witness.ts`) reads `getSigner()`. So the key is held here, in the same slot a
 * customer's session signer uses, and `lockTerminalSigner` zeroes it.
 *
 * Refuses while a NAP session exists: one account per device.
 */
export function installTerminalSigner(privkeyHex: string): WalletSigner {
  if (session) throw new Error('A wallet session is open on this device.')
  signer?.clearKey()
  signer = createWalletSigner(privkeyHex)
  return signer
}

/**
 * Zero and drop a terminal's signer: the idle lock and the Lock button (decision 2).
 *
 * A no-op while a NAP session is open, so it cannot pull the key out from under a customer.
 */
export function lockTerminalSigner(): void {
  if (session) return
  signer?.clearKey()
  signer = undefined
}

/**
 * Drop the session and signer singletons.
 *
 * `createSession` returns the existing session if there is one, which is correct
 * while a session is live — one app, one session — but makes logout a one-way
 * door without this: after `session.logout()` the object is shut down, and the
 * next login would be handed that same dead object and fail in a way that looks
 * like a server problem rather than a client one.
 *
 * Only logout should call this. Clearing the singletons while a session is still
 * in use would leave `getSigner()` throwing for every screen that needs it.
 */
export function resetSession(): void {
  session = undefined
  signer = undefined
}
