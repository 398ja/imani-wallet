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
 * "No passphrase", spelled the one way the whole app agrees on.
 *
 * An empty passphrase, not a flag beside the record. The keystore still does
 * its PBKDF2 and AES-GCM over it, so nothing on disk changes shape and no code
 * path outside this module learns a second way to store a key — but a device
 * set up this way is readable by anyone holding the device, which is exactly
 * what the customer chose when they turned the switch off.
 *
 * A flag would be the obvious alternative and is the worse one: it can
 * disagree with the ciphertext it claims to describe. Restoring a backup
 * written on another device, or a half-finished passphrase change, would leave
 * a marker saying "open" beside a record that is not — and the failure lands on
 * the login screen of someone who cannot get in.
 */
export const NO_PASSPHRASE = ''

/**
 * The key, if this device holds one that needs no passphrase. Otherwise null.
 *
 * Asked of the ciphertext rather than of a stored flag, for the reason above.
 * It costs one PBKDF2 on the login screen for protected users too — a few
 * hundred milliseconds, spent while the screen is still painting, to buy an
 * answer that cannot be wrong.
 */
export async function loadUnprotectedKey(): Promise<string | null> {
  try {
    return await keyStore.loadKey(NO_PASSPHRASE)
  } catch {
    return null
  }
}

/** Accepts an nsec or raw hex, and normalises to hex. */
export function toPrivkeyHex(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('nsec')) {
    const decoded = nip19.decode(trimmed)
    if (decoded.type !== 'nsec') throw new Error('That is not an nsec.')
    return bytesToHex(decoded.data)
  }
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new Error('Expected an nsec or a 64-character hex key.')
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
