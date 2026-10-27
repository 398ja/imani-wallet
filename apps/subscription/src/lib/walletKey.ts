/**
 * Signing in with the stall's WALLET key, three ways, all ending at the same thing: the wallet's own
 * passphrase-encrypted key envelope, opened here with the wallet passphrase.
 *
 *  1. **This browser.** The usual path: the wallet sends the stall here (`/subscription`, same
 *     origin), so the envelope the wallet wrote to localStorage (`imani-wallet-key`) is right here.
 *  2. **Google Drive.** The wallet's account backup (`imani-wallet-account.json` in the Drive
 *     app-data folder), read with the same OAuth client and scope the wallet uses.
 *  3. **A backup file** the wallet downloaded (`imani-wallet-backup-*.json`), uploaded from this
 *     device.
 *
 * The envelope format is nap's (PBKDF2-SHA256 + AES-GCM, parameters carried inside), so it is
 * opened with nap's own `createWebCryptoSecretStore` over an in-memory storage: nothing is written
 * to this browser, and the decrypted key lives only in this tab's memory until sign-out.
 *
 * There is deliberately no extension, bunker or paste-your-nsec path (owner, 2026-10-27).
 */
import { createWebCryptoSecretStore } from '@imani/nap-client-web'
import { getPublicKey, nip19 } from 'nostr-tools'

/** Must match `createWebCryptoKeyStore('imani-wallet-key')` in src/lib/nap.ts. */
export const WALLET_KEY_STORAGE = 'imani-wallet-key'
/** Must match DRIVE_FILENAME in src/lib/backup.ts. */
export const DRIVE_FILENAME = 'imani-wallet-account.json'
const BACKUP_FORMAT = 'imani-wallet-backup'

export class KeyError extends Error {}

/** A key envelope found somewhere, not yet opened. */
export interface FoundKey {
  source: 'browser' | 'drive' | 'file'
  envelope: string
  /** Whose key it is, when the source says (a backup file names it; the browser's profile may). */
  npub: string | null
  /** The stall's display name, when known. */
  name: string | null
}

function isEnvelope(v: unknown): boolean {
  const e = v as { ciphertext?: unknown; kdf?: unknown; iv?: unknown } | null
  return !!e && typeof e === 'object' && !!e.ciphertext && !!e.kdf && !!e.iv
}

/** The wallet's key in this browser, if the wallet has been used here. */
export function keyInThisBrowser(storage: Pick<Storage, 'getItem' | 'length' | 'key'> = localStorage): FoundKey | null {
  const raw = storage.getItem(WALLET_KEY_STORAGE)
  if (!raw) return null
  try {
    if (!isEnvelope(JSON.parse(raw))) return null
  } catch {
    return null
  }
  // The wallet keeps one profile per account it has held; with exactly one, it names the stall.
  let npub: string | null = null
  let name: string | null = null
  const profiles: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k?.startsWith('imani-wallet:profile:')) profiles.push(k)
  }
  if (profiles.length === 1) {
    try {
      const p = JSON.parse(storage.getItem(profiles[0]) ?? '{}') as { pubkey?: string; name?: string; display_name?: string }
      if (p.pubkey && /^[0-9a-f]{64}$/.test(p.pubkey)) npub = nip19.npubEncode(p.pubkey)
      name = p.display_name || p.name || null
    } catch {
      /* unnamed, not unusable */
    }
  }
  return { source: 'browser', envelope: raw, npub, name }
}

/** A wallet backup file's text (from Drive or an upload), validated. */
export function keyFromBackup(text: string, source: 'drive' | 'file'): FoundKey {
  let parsed: { format?: unknown; key?: unknown; npub?: unknown; profile?: { name?: string; display_name?: string } | null }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new KeyError('That file is not an Imani wallet backup.')
  }
  if (parsed.format !== BACKUP_FORMAT) throw new KeyError('That file is not an Imani wallet backup.')
  if (!isEnvelope(parsed.key)) throw new KeyError('That backup is missing its key, or is damaged.')
  const npub = typeof parsed.npub === 'string' && parsed.npub.startsWith('npub1') ? parsed.npub : null
  return {
    source,
    envelope: JSON.stringify(parsed.key),
    npub,
    name: parsed.profile?.display_name || parsed.profile?.name || null,
  }
}

/**
 * Open a found key with the wallet passphrase. Returns the private key bytes.
 *
 * Decrypted through an in-memory storage holding only this envelope, so opening never writes to
 * the browser and a wrong passphrase changes nothing anywhere.
 */
export async function openKey(found: FoundKey, passphrase: string): Promise<{ sk: Uint8Array; pubkey: string }> {
  const memory = new Map<string, string>([[WALLET_KEY_STORAGE, found.envelope]])
  const store = createWebCryptoSecretStore(WALLET_KEY_STORAGE, {
    storage: {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
      removeItem: (k) => void memory.delete(k),
    },
  })
  const hex = await store.load(passphrase)
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new KeyError('That passphrase does not open this key.')
  const sk = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  const pubkey = getPublicKey(sk)
  if (found.npub && nip19.npubEncode(pubkey) !== found.npub) {
    throw new KeyError('This backup is damaged: its key does not match the account it names.')
  }
  return { sk, pubkey }
}

// ---------------------------------------------------------------- Google Drive

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const FILES = 'https://www.googleapis.com/drive/v3/files'

interface TokenClient {
  requestAccessToken(): void
}
interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(c: {
        client_id: string
        scope: string
        callback: (r: { access_token?: string; error_description?: string }) => void
        error_callback?: () => void
      }): TokenClient
    }
  }
}

/** The same public OAuth client the wallet's Drive backup uses (VITE_GOOGLE_CLIENT_ID). */
export function driveClientId(): string {
  return ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '').trim()
}

function loadGis(): Promise<Gis> {
  const w = window as unknown as { google?: Gis }
  if (w.google?.accounts?.oauth2) return Promise.resolve(w.google)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.onload = () => (w.google ? resolve(w.google) : reject(new KeyError('Could not reach Google.')))
    s.onerror = () => reject(new KeyError('Could not reach Google. Check your connection and try again.'))
    document.head.appendChild(s)
  })
}

/** Read the wallet's account backup from the stall's Google Drive. */
export async function keyFromDrive(): Promise<FoundKey> {
  const clientId = driveClientId()
  if (!clientId) throw new KeyError('Google Drive is not set up on this site. Use a backup file instead.')
  const gis = await loadGis()
  const token = await new Promise<string>((resolve, reject) => {
    gis.accounts.oauth2
      .initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (r) => (r.access_token ? resolve(r.access_token) : reject(new KeyError(r.error_description ?? 'Google did not grant access.'))),
        error_callback: () => reject(new KeyError('Google sign-in was cancelled.')),
      })
      .requestAccessToken()
  })
  const auth = { Authorization: `Bearer ${token}` }
  const q = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${DRIVE_FILENAME}' and trashed = false`,
    fields: 'files(id)',
    orderBy: 'modifiedTime desc',
    pageSize: '1',
  })
  const list = (await (await fetch(`${FILES}?${q}`, { headers: auth })).json()) as { files?: { id: string }[] }
  const id = list.files?.[0]?.id
  if (!id) throw new KeyError('There is no Imani wallet backup in this Google account.')
  const r = await fetch(`${FILES}/${id}?alt=media`, { headers: auth })
  if (!r.ok) throw new KeyError(`Google Drive refused the request (${r.status}).`)
  return keyFromBackup(await r.text(), 'drive')
}
