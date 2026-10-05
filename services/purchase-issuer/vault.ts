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
  /**
   * The stall's signed delegation event JSON (imani-wallet#152). PUBLIC, so
   * stored in the clear and outside the GCM tag on purpose: it authenticates
   * itself (the stall's signature), and `checkDelegation` refuses one that is
   * not signed by this record's stall or does not name this record's lock key.
   * Editing it on disk can only make minting stop, never mint as someone else.
   */
  delegation?: string
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

/**
 * The fields bound into the GCM tag alongside the key material (IW-08).
 *
 * Separator is a NUL byte so the two fields cannot be run together ambiguously — without it,
 * ("ab", "c") and ("a", "bc") would produce identical associated data and a record could be
 * re-pointed between them.
 */
function associatedData(stallPubkey: string, credentialId: string): Buffer {
  return Buffer.from(`${stallPubkey.toLowerCase()}\u0000${credentialId}`, 'utf8')
}

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
    // IW-08: bind the identity fields into the authentication tag.
    //
    // Only lockKeyHex was encrypted; stallPubkey and credentialId sat beside it in plaintext and
    // outside the GCM tag, and decryption reassembled the credential from those plaintext
    // fields. So the key material was authenticated and the identity it belongs to was not:
    // anyone who could write the vault file could move a live key onto a different stall's
    // record, and every signature it then produced would be attributed to that stall. The tag
    // would still verify, because it never covered the fields that were changed.
    cipher.setAAD(associatedData(credential.stallPubkey, credential.credentialId))
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
      ...(credential.delegation ? { delegation: credential.delegation } : {}),
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

  /**
   * Store the stall's signed delegation beside its credential (imani-wallet#152).
   *
   * Refused, and nothing written, unless the delegation is one the till will
   * accept for a coupon minted now: signed by this stall, scope `coupon:issue`,
   * naming this credential's lock key, outliving `minimumUntilMs`. Storing one
   * that fails would only move the refusal to the next card sale.
   */
  async attachDelegation(
    stallPubkey: string,
    delegation: string,
    minimumUntilMs: number,
    check: (credential: StallCredential, untilMs: number) => { ok: true } | { ok: false; reason: string },
  ): Promise<void> {
    const current = await this.get(stallPubkey)
    if (current === null) throw new Error('no credential is held for this stall; enrol it first')
    const candidate = { ...current, delegation }
    const verdict = check(candidate, minimumUntilMs)
    if (!verdict.ok) throw new Error(`delegation refused: ${verdict.reason}`)
    await this.put(candidate)
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
        // The same binding, checked. If either field was edited on disk, final() throws and the
        // record is skipped below — which is the correct outcome: a credential whose owner we
        // cannot confirm must not be used to sign as that owner.
        decipher.setAAD(associatedData(record.stallPubkey, record.credentialId))
        const lockKeyHex = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString('utf8')

        loaded.set(record.stallPubkey.toLowerCase(), {
          stallPubkey: record.stallPubkey,
          credentialId: record.credentialId,
          lockKeyHex,
          ...(typeof record.delegation === 'string' ? { delegation: record.delegation } : {}),
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
