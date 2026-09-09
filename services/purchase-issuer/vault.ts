/**
 * Holding one stall's issuing authority, per stall.
 *
 * ## What is actually secret here
 *
 * A credential is two things: an id, and the private key it is locked to. The
 * id travels in a header on every issuance and proves nothing on its own — the
 * gateway checks a NIP-98 signature from the key the credential names. So the
 * key is the secret, and it is an ISSUING key: whoever holds it can mint
 * coupons that one stall must honour, until that stall burns the credential.
 *
 * ## One key per stall, and why deriving them would be a disguise
 *
 * Deriving every credential from one master key plus a stall pubkey is elegant,
 * stores nothing, and destroys the property this design rests on. ADR 0009
 * rejected a single platform credential because one breach would mint for every
 * stall and no stall could revoke independently. A master-derived key is that
 * same shape wearing a nicer hat: compromise the master, derive them all.
 *
 * So keys are stored, separately, and encrypted with a service key that is not
 * derived from anything.
 *
 * ## What this protects against, and what it does not
 *
 * Encryption at rest protects a stolen database dump, a backup, a disk. It does
 * NOT protect against an attacker who has the process, because the process must
 * decrypt to sign. That is worth being plain about rather than implying more:
 * this raises the cost of a stolen file, and a compromised host is a compromised
 * issuer regardless.
 *
 * AES-256-GCM, so ciphertext is authenticated. Without that, an attacker able
 * to write the store could flip bits in a key and watch how signing failed.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { StallCredential } from './issuer'

/** GCM's standard nonce length. */
const IV_BYTES = 12

/** What a stored record looks like, before decryption. */
interface SealedCredential {
  stallPubkey: string
  credentialId: string
  /** base64. */
  iv: string
  /** base64, ciphertext with the GCM tag appended. */
  sealed: string
}

/**
 * Somewhere to keep sealed credentials.
 *
 * An interface because the store is not the interesting part: a file today, a
 * secrets manager later, and neither changes what is sealed or when.
 */
export interface CredentialStore {
  read(): Promise<SealedCredential[]>
  write(records: SealedCredential[]): Promise<void>
}

/**
 * Seals and unseals credentials with one service key.
 *
 * The service key comes from the environment and is never stored beside the
 * data it protects. A deployment that keeps both in the same place has
 * encryption in name only.
 */
export class CredentialVault {
  private readonly key: Buffer
  private readonly store: CredentialStore
  /** Decrypted keys, held only for the life of the process. */
  private cache: Map<string, StallCredential> | null = null

  constructor(serviceKeyHex: string, store: CredentialStore) {
    const key = Buffer.from(serviceKeyHex, 'hex')
    if (key.length !== 32) {
      // Refused at construction rather than at first use. A service that starts
      // with a bad key and fails on the first sale has already taken money.
      throw new Error('credential vault service key must be 32 bytes of hex')
    }
    this.key = key
    this.store = store
  }

  /** Put one stall's credential away. */
  async put(credential: StallCredential): Promise<void> {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(credential.lockKeyHex, 'utf8'),
      cipher.final(),
    ])
    const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()])

    const records = await this.store.read()
    // Replace rather than append. A stall that re-enrols has one current
    // credential, and keeping the old one would leave a burnt key on disk
    // looking exactly like a live one.
    const without = records.filter((r) => r.stallPubkey !== credential.stallPubkey)
    without.push({
      stallPubkey: credential.stallPubkey,
      credentialId: credential.credentialId,
      iv: iv.toString('base64'),
      sealed: sealed.toString('base64'),
    })
    await this.store.write(without)
    this.cache = null
  }

  /**
   * One stall's credential, or null when it holds none.
   *
   * Null is the ordinary answer for a stall that never enrolled an issuer, and
   * the caller treats it as "issue by hand" rather than as a failure.
   */
  async get(stallPubkey: string): Promise<StallCredential | null> {
    if (this.cache === null) {
      this.cache = await this.load()
    }
    return this.cache.get(stallPubkey.toLowerCase()) ?? null
  }

  /** Forget a stall's credential, e.g. after the stall burnt it. */
  async forget(stallPubkey: string): Promise<void> {
    const records = await this.store.read()
    await this.store.write(records.filter((r) => r.stallPubkey !== stallPubkey))
    this.cache = null
  }

  private async load(): Promise<Map<string, StallCredential>> {
    const loaded = new Map<string, StallCredential>()
    for (const record of await this.store.read()) {
      try {
        const raw = Buffer.from(record.sealed, 'base64')
        // The tag is the last 16 bytes, appended at seal time.
        const tag = raw.subarray(raw.length - 16)
        const ciphertext = raw.subarray(0, raw.length - 16)
        const decipher = createDecipheriv(
          'aes-256-gcm',
          this.key,
          Buffer.from(record.iv, 'base64'),
        )
        decipher.setAuthTag(tag)
        const lockKeyHex = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString('utf8')

        loaded.set(record.stallPubkey.toLowerCase(), {
          stallPubkey: record.stallPubkey,
          credentialId: record.credentialId,
          lockKeyHex,
        })
      } catch {
        // One unreadable record must not deny every other stall its issuer.
        // Skipped rather than thrown: the stall falls back to issuing by hand,
        // which is the same path a stall with no credential takes.
        continue
      }
    }
    return loaded
  }
}
