/**
 * Surviving a page reload without asking for the passphrase again.
 *
 * The wallet holds the customer's secret key in the page because receiving
 * coupons needs NIP-44 decryption (see lib/signer.ts). A reload destroys the
 * heap, so until now every refresh — and on Android every process restart the
 * WebView decided to do — dropped back to the passphrase screen, even though
 * the NAP session cookie was still perfectly valid. The cookie survived and the
 * key did not, so the app asked for the one thing the user thought they had
 * already given.
 *
 * The obvious fix is to put the key in sessionStorage. That is plaintext key
 * material at rest, which RFC §1181 forbids and which any XSS reads in one
 * line. This does something narrower:
 *
 *   - a random AES-GCM key is generated with `extractable: false` and stored as
 *     a live `CryptoKey` in IndexedDB. Structured clone keeps it a key object,
 *     not bytes: script can USE it and cannot READ it, so an injected script
 *     can never exfiltrate the wrapping key itself.
 *   - the secret key is encrypted under it, and only the ciphertext goes in
 *     sessionStorage.
 *
 * sessionStorage is per-tab and dies with the tab, so closing the app still
 * ends the session; a reload keeps it, which is the whole point. An attacker
 * with script execution in a live tab can ask the wrapping key to decrypt —
 * that is unavoidable for any scheme that survives reload without a prompt —
 * but the material never exists in readable storage, and it is gone the moment
 * the tab closes rather than sitting in localStorage forever.
 *
 * The passphrase-encrypted keystore stays exactly as it was and remains the
 * only durable copy. This is a reload cache, not a second store, which is why
 * `forgetResume()` is called on logout and on any identity change.
 */

const DB_NAME = 'imani-wallet-resume'
const STORE = 'wrap'
const WRAP_KEY_ID = 'v1'
/** Per-tab, and holds only ciphertext. Cleared on logout and on a failed read. */
const SESSION_SLOT = 'imani-wallet:resume:v1'

interface Wrapped {
  /** Owner of the key, so a stale blob can never be handed to another account. */
  pubkey: string
  iv: string
  ciphertext: string
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/**
 * TypeScript models a bare `Uint8Array` as possibly SharedArrayBuffer-backed,
 * which WebCrypto's `BufferSource` does not accept. nap hits the same thing in
 * `webCryptoSecretStore.ts` and solves it the same way: allocate a view that is
 * provably ArrayBuffer-backed.
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return idb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('idb request failed'))
      }),
  )
}

/**
 * The tab's wrapping key, created on first use.
 *
 * `extractable: false` is the load-bearing argument: it is what makes the
 * stored object a capability rather than a secret. `exportKey` on it rejects,
 * so there is no code path — ours or an attacker's — that turns this back into
 * bytes.
 */
async function wrappingKey(create: boolean): Promise<CryptoKey | null> {
  const existing = await tx<CryptoKey | undefined>('readonly', (s) => s.get(WRAP_KEY_ID))
  if (existing) return existing
  if (!create) return null

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  await tx('readwrite', (s) => s.put(key, WRAP_KEY_ID))
  return key
}

/**
 * Cache `privkeyHex` for the life of this tab. Never throws: a browser that
 * refuses IndexedDB (private mode, storage denied) simply keeps the old
 * behaviour of asking for the passphrase, which is a degradation and not a
 * failure.
 */
export async function remember(pubkey: string, privkeyHex: string): Promise<void> {
  try {
    const key = await wrappingKey(true)
    if (!key) return
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(privkeyHex),
    )
    const wrapped: Wrapped = {
      pubkey,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
    }
    sessionStorage.setItem(SESSION_SLOT, JSON.stringify(wrapped))
  } catch (e) {
    console.warn('[resume] could not cache the key for reload:', e)
  }
}

/**
 * The cached key, or null when there is nothing to resume.
 *
 * Any failure clears the slot rather than leaving a blob that will fail again
 * on every reload: the passphrase screen is always a correct fallback.
 */
export async function recover(): Promise<{ pubkey: string; privkeyHex: string } | null> {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(SESSION_SLOT)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const wrapped = JSON.parse(raw) as Wrapped
    if (
      typeof wrapped?.pubkey !== 'string' ||
      typeof wrapped?.iv !== 'string' ||
      typeof wrapped?.ciphertext !== 'string'
    ) {
      throw new Error('malformed resume record')
    }
    // `false`: if the wrapping key is gone the ciphertext is unreadable forever,
    // and generating a fresh one here would silently mint a key that decrypts
    // nothing.
    const key = await wrappingKey(false)
    if (!key) throw new Error('no wrapping key')

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(wrapped.iv) },
      key,
      fromBase64(wrapped.ciphertext),
    )
    const privkeyHex = new TextDecoder().decode(plaintext)
    if (!/^[0-9a-f]{64}$/.test(privkeyHex)) throw new Error('resume record is not a key')
    return { pubkey: wrapped.pubkey, privkeyHex }
  } catch (e) {
    console.warn('[resume] discarding an unusable resume record:', e)
    forgetResume()
    return null
  }
}

/**
 * Drop the resume cache. Called on logout and whenever a resume is rejected.
 *
 * Named for what it forgets, not just "forget": every call site was importing
 * this as `forgetResume`, which is the module telling you the bare name was not
 * honest enough to stand on its own at a call site.
 *
 * The wrapping key goes too, so the ciphertext left in any other tab's
 * sessionStorage becomes undecryptable rather than merely orphaned.
 */
export function forgetResume(): void {
  try {
    sessionStorage.removeItem(SESSION_SLOT)
  } catch {
    /* storage denied — nothing cached in the first place */
  }
  void tx('readwrite', (s) => s.delete(WRAP_KEY_ID)).catch(() => {})
}
