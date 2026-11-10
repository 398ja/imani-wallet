import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * AES-256-GCM over the snapshot zip, with WebCrypto (#589 section 5, owner decision 1). A fresh
 * random key and IV per snapshot; the key travels only in the NIP-17 handoff DM. The output is the
 * WebCrypto layout, ciphertext followed by the 16-byte tag, with no header: the IV is in the DM.
 */
export interface SealedSnapshot {
  ciphertext: Uint8Array
  key: Uint8Array
  iv: Uint8Array
  /** sha256 hex of `ciphertext`, which is the Blossom blob hash. */
  sha256: string
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is not available here.')
  return s
}

/** A fresh, exactly-sized copy, typed as WebCrypto's BufferSource. */
const buf = (b: Uint8Array) => new Uint8Array(b) as Uint8Array<ArrayBuffer>

export async function encryptSnapshot(zip: Uint8Array): Promise<SealedSnapshot> {
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const k = await subtle().importKey('raw', buf(key), 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, k, buf(zip)))
  return { ciphertext, key, iv, sha256: bytesToHex(sha256(ciphertext)) }
}

export async function decryptSnapshot(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(iv) }, k, buf(ciphertext)))
}
