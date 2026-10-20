import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { keyStore } from './nap'

/**
 * One wallet per device, until it has logged out (#330).
 *
 * The key store has ONE slot. Importing a key, opening a backup or registering
 * writes it. When the slot already holds ANOTHER account's key, that write
 * replaces the only key to that account's vouchers on this device: they stay
 * in its store, unreadable and never backed up by a logout that can no longer
 * run. So every writer of the slot asks this first, and is refused unless the
 * slot is empty or holds this same account.
 *
 * The way past the refusal is logout, which runs the full backed-up check
 * (`attemptLogout`): it refuses until every voucher is confirmed, and only then
 * clears the slot. There is no override.
 *
 * WHOSE KEY IS IN THE SLOT. It is encrypted, so it cannot be read without the
 * passphrase. What the device knows is which accounts it holds data for: the
 * per-account records beside it (`imani-wallet:<what>:<hex key>`) and the
 * per-account wallet store (`imani-wallet-<hex key>`). Same account means every
 * account found is this one. None found, with the slot taken, cannot be told
 * apart from another account, so it is refused: the safe direction.
 *
 * A slot that is EMPTY is never refused, even with another account's leftover
 * data: nothing is overwritten, that data stays in its own store, and refusing
 * would strand the device with no key to log out with.
 */

/** Shown when a key cannot be stored because another wallet is on this device. */
export const OTHER_WALLET_COPY =
  'This device already holds another wallet. Open it and log out first: logging out checks that ' +
  'every voucher in it is backed up. Then come back to this account. Nothing has been changed.'

export class OtherWalletOnDeviceError extends Error {
  constructor() {
    super(OTHER_WALLET_COPY)
    this.name = 'OtherWalletOnDeviceError'
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/

/**
 * Records kept under the account's OWN key. Not every `imani-wallet:*:<key>`
 * is: the merchant branding cache (`imani-wallet:identity:`) is keyed on other
 * people's keys, and counting it would refuse a same-account re-import.
 */
const ACCOUNT_PREFIXES = [
  'imani-wallet:profile:',
  'imani-wallet:merchant:',
  'imani-wallet:pending-sends:',
  'imani-wallet:swap-intents:',
  'imani-wallet:payment-requests:',
  'imani-wallet:notifications:',
  'imani-wallet:notification-prefs:',
  'imani-wallet:incoming-seen:',
  'imani-wallet:gift-link-next:',
]

/** The accounts this device holds data for (lower-case hex). Never throws. */
export async function accountsOnDevice(): Promise<Set<string>> {
  const found = new Set<string>()
  try {
    for (const key of Object.keys(localStorage)) {
      const prefix = ACCOUNT_PREFIXES.find((p) => key.startsWith(p))
      if (!prefix) continue
      const rest = key.slice(prefix.length).toLowerCase()
      if (HEX_KEY.test(rest)) found.add(rest)
    }
  } catch {
    // Storage that cannot be listed: the IndexedDB names below still count.
  }
  try {
    const dbs = (await (indexedDB as { databases?: () => Promise<Array<{ name?: string }>> }).databases?.()) ?? []
    for (const db of dbs) {
      const m = /^imani-wallet-([0-9a-f]{64})$/i.exec(db.name ?? '')
      if (m) found.add(m[1].toLowerCase())
    }
  } catch {
    // Not supported here: the records above are what is known.
  }
  return found
}

export interface GuardDeps {
  /** Whether the key slot holds a key. Default: the real key store. */
  slotTaken?: () => Promise<boolean>
  accounts?: () => Promise<Set<string>>
}

/**
 * Throw `OtherWalletOnDeviceError` when storing `privkeyHex` would replace
 * another account's key. Same account, or an empty slot, passes. Any failure
 * to tell refuses.
 */
export async function refuseIfAnotherWallet(privkeyHex: string, deps: GuardDeps = {}): Promise<void> {
  let taken: boolean
  try {
    taken = await (deps.slotTaken ?? (() => keyStore.hasKey()))()
  } catch {
    taken = true
  }
  if (!taken) return
  let incoming: string
  try {
    incoming = getPublicKey(hexToBytes(privkeyHex)).toLowerCase()
  } catch {
    throw new OtherWalletOnDeviceError()
  }
  const accounts = await (deps.accounts ?? accountsOnDevice)().catch(() => new Set<string>())
  if (accounts.size > 0 && [...accounts].every((a) => a === incoming)) return
  throw new OtherWalletOnDeviceError()
}
