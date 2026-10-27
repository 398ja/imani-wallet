/**
 * A stall's wallet key, exactly as the wallet stores it, for the subscription e2e specs.
 *
 * The envelope is written by nap's own `createWebCryptoKeyStore` (the store the wallet uses in
 * src/lib/nap.ts), so the site under test opens the same bytes a real wallet would have left in
 * localStorage or in a backup file. Nothing here re-implements the format.
 */
import { createWebCryptoKeyStore } from '@imani/nap-client-web'
import { nip19 } from 'nostr-tools'

export const WALLET_KEY_STORAGE = 'imani-wallet-key'

export async function walletKeyEnvelope(sk: Uint8Array, passphrase: string): Promise<string> {
  const memory = new Map<string, string>()
  const store = createWebCryptoKeyStore(WALLET_KEY_STORAGE, {
    storage: {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
      removeItem: (k) => void memory.delete(k),
    },
  })
  await store.save(Buffer.from(sk).toString('hex'), passphrase)
  return memory.get(WALLET_KEY_STORAGE)!
}

/** The file the wallet's "Download backup" writes (src/lib/backup.ts `createBackup`). */
export function walletBackupFile(pubkey: string, envelope: string, name: string): string {
  return JSON.stringify({
    format: 'imani-wallet-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    npub: nip19.npubEncode(pubkey),
    pubkey,
    profile: { pubkey, name },
    key: JSON.parse(envelope) as unknown,
  })
}

/** localStorage as the wallet leaves it: the key, and the stall's one cached profile. */
export function walletLocalStorage(pubkey: string, envelope: string, name: string): Record<string, string> {
  return {
    [WALLET_KEY_STORAGE]: envelope,
    [`imani-wallet:profile:${pubkey}`]: JSON.stringify({ pubkey, name }),
  }
}
