/**
 * The real stalls' keys (corda = slot 0, bart = slot 1), read at runtime from an env file and held
 * in memory only (#550). Never argv, never the pool file, never a result.
 *
 * The file is parsed here, not `source`d: `KEY=value` lines, `#` comments, optional quotes.
 * Default path ~/.jcode/scratch/merchant-keys.env, override MERCHANT_KEYS_FILE.
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { registerSecret } from './redact.mts'

export type RealStall = { slot: number; name: string; secret: Uint8Array; pubHex: string }

/** The pubkey prefix each real stall must decode to, so a wrong line in the file cannot sell as someone else. */
export const REAL_STALLS = [
  { slot: 0, name: 'corda', envKey: 'CORDA_NSEC', prefix: '1c4be7be' },
  { slot: 1, name: 'bart', envKey: 'BART_NSEC', prefix: 'b233db85' },
] as const

export function defaultKeysFile(): string {
  return process.env.MERCHANT_KEYS_FILE || join(homedir(), '.jcode', 'scratch', 'merchant-keys.env')
}

/** Pure: KEY=value lines to a map. Values are never echoed by anything here. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]!] = v
  }
  return out
}

export class KeyFileError extends Error {}

/**
 * Decodes and checks the keys. Errors name the variable and what was wrong, never the value.
 * Every decoded secret is registered with the redactor in both encodings before it is returned.
 */
export function decodeRealStalls(env: Record<string, string>): RealStall[] {
  return REAL_STALLS.map(({ slot, name, envKey, prefix }) => {
    const value = env[envKey]
    if (!value) throw new KeyFileError(`${envKey} is missing from the merchant keys file`)
    let secret: Uint8Array
    try {
      const decoded = nip19.decode(value)
      if (decoded.type !== 'nsec') throw new Error('not an nsec')
      secret = decoded.data
    } catch {
      throw new KeyFileError(`${envKey} is not a valid nsec`)
    }
    registerSecret(value, bytesToHex(secret))
    const pubHex = getPublicKey(secret)
    if (!pubHex.startsWith(prefix)) {
      throw new KeyFileError(`${envKey} decodes to a pubkey starting ${pubHex.slice(0, 8)}, expected ${prefix} (${name})`)
    }
    return { slot, name, secret, pubHex }
  })
}

export function loadRealStalls(path = defaultKeysFile()): RealStall[] {
  let text: string
  try {
    const mode = statSync(path).mode & 0o777
    if (mode & 0o077) throw new KeyFileError(`${path} is readable by others (mode ${mode.toString(8)}); chmod 600 it`)
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if (e instanceof KeyFileError) throw e
    throw new KeyFileError(`cannot read the merchant keys file ${path} (set MERCHANT_KEYS_FILE)`)
  }
  return decodeRealStalls(parseEnvFile(text))
}
