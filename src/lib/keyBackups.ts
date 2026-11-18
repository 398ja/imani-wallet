import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { verifyEvent, type Event } from 'nostr-tools'

import { getSigner } from './nap'
import { allEvents, publish } from './relay'
import { mirrorToGateway } from './transferSignature'
import { buildRecordEvents, isChunkEvent, reassembleRecords, recordIdOf, type Sealer } from './chunkedRecord'
import { KEY_BACKUPS_PREFIX } from './backupRecord'

export { KEY_BACKUPS_PREFIX }

/**
 * Where this account's KEY is backed up, remembered per device (#348).
 *
 * Owner rule (2026-10-20): logout is refused, with no override, until the app knows the key is
 * backed up somewhere: Google Drive, a downloaded file, or both. One location is enough.
 *
 * - Drive counts once it was READ BACK right after the upload and held this key's envelope
 *   (`useDriveBackup`). Logout does not ask Drive again, so it works offline.
 * - A file counts once it was downloaded. A browser cannot see a file on disk later, so the
 *   person may re-check one by picking it (`verifyBackupFile`), which refreshes `lastVerifiedAt`.
 *
 * Each location carries the device it was made on (a random id per install with a friendly name),
 * and the fingerprint of the key envelope it holds. A file made before a passphrase change holds
 * the OLD envelope, so it does not count for the key this browser holds now.
 *
 * The list lives in localStorage (kept across logout, like `backupRecord.ts`) and in one
 * kind-30078 record, `d=imani:key-backups`, NIP-44 sealed to the account's own key, published to
 * the relay and mirrored to the gateway, read from both. So every device of the account sees every
 * known backup. The merge is a union and never forgets a location.
 */

export type KeyBackupLocation = 'drive' | 'file'

export interface KeyBackup {
  location: KeyBackupLocation
  deviceId: string
  deviceName: string
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms of the last read-back (Drive) or re-check (file). */
  lastVerifiedAt?: number
  /** Short sha256 of the key envelope the backup holds. */
  keyFingerprint: string
  /** For a file: the name it was saved under. */
  fileName?: string
}

export const KEY_BACKUPS_KIND = 30078
export const KEY_BACKUPS_D_TAG = 'imani:key-backups'
export const KEY_BACKUPS_CHANGED = 'imani:key-backups-changed'
/** Outside the `imani-wallet:` prefix on purpose: the install keeps its id across logouts. */
export const DEVICE_ID_KEY = 'imani-device-id'
const DEVICE_NAME_KEY = 'imani-device-name'
const KEYSTORE_STORAGE_KEY = 'imani-wallet-key'

// ---------------------------------------------------------------------------
// The device

function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

/** A random id for this browser install, made once. */
export function deviceId(): string {
  try {
    const held = localStorage.getItem(DEVICE_ID_KEY)
    if (held && /^[0-9a-f]{32}$/.test(held)) return held
    const id = randomId()
    localStorage.setItem(DEVICE_ID_KEY, id)
    return id
  } catch {
    return 'unknown'
  }
}

/** "Chrome on Android", "Safari on iPhone", from the user agent. */
export function friendlyDeviceName(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /Firefox\/|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /iPad/.test(ua)
        ? 'iPad'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'this device'
  return `${browser} on ${os}`
}

export function deviceName(): string {
  try {
    const held = localStorage.getItem(DEVICE_NAME_KEY)
    if (held) return held
    const name = friendlyDeviceName()
    localStorage.setItem(DEVICE_NAME_KEY, name)
    return name
  } catch {
    return friendlyDeviceName()
  }
}

// ---------------------------------------------------------------------------
// The key

/** Short sha256 of a key envelope, as an object or its JSON. */
export function envelopeFingerprint(envelope: unknown): string {
  const text = typeof envelope === 'string' ? JSON.stringify(JSON.parse(envelope)) : JSON.stringify(envelope)
  return bytesToHex(sha256(utf8ToBytes(text))).slice(0, 16)
}

/** The fingerprint of the envelope inside a backup file's JSON, or undefined. */
export function backupFingerprint(json: string): string | undefined {
  try {
    const key = (JSON.parse(json) as { key?: unknown }).key
    return key && typeof key === 'object' ? envelopeFingerprint(key) : undefined
  } catch {
    return undefined
  }
}

/** The fingerprint of the key this browser holds, or null when it holds none. */
export function currentKeyFingerprint(): string | null {
  try {
    const raw = localStorage.getItem(KEYSTORE_STORAGE_KEY)
    return raw ? envelopeFingerprint(raw) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The list

function sanitise(value: unknown): KeyBackup | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.location !== 'drive' && v.location !== 'file') return null
  if (typeof v.deviceId !== 'string' || v.deviceId === '' || v.deviceId.length > 64) return null
  if (typeof v.keyFingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(v.keyFingerprint)) return null
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt) || v.createdAt <= 0) return null
  const out: KeyBackup = {
    location: v.location,
    deviceId: v.deviceId,
    deviceName: typeof v.deviceName === 'string' && v.deviceName ? v.deviceName.slice(0, 80) : 'another device',
    createdAt: v.createdAt,
    keyFingerprint: v.keyFingerprint,
  }
  if (typeof v.lastVerifiedAt === 'number' && Number.isFinite(v.lastVerifiedAt) && v.lastVerifiedAt > 0) {
    out.lastVerifiedAt = v.lastVerifiedAt
  }
  if (typeof v.fileName === 'string' && v.fileName) out.fileName = v.fileName.slice(0, 200)
  return out
}

const identity = (b: KeyBackup) => `${b.location}|${b.deviceId}|${b.keyFingerprint}`

/** Union by (location, device, key). Earliest createdAt, latest verification and file name. */
export function mergeKeyBackups(...lists: ReadonlyArray<readonly KeyBackup[]>): KeyBackup[] {
  const byId = new Map<string, KeyBackup>()
  for (const list of lists) {
    for (const raw of list) {
      const b = sanitise(raw)
      if (!b) continue
      const prior = byId.get(identity(b))
      if (!prior) {
        byId.set(identity(b), b)
        continue
      }
      const verified = Math.max(prior.lastVerifiedAt ?? 0, b.lastVerifiedAt ?? 0)
      const newer = (b.lastVerifiedAt ?? b.createdAt) >= (prior.lastVerifiedAt ?? prior.createdAt) ? b : prior
      byId.set(identity(b), {
        ...prior,
        createdAt: Math.min(prior.createdAt, b.createdAt),
        deviceName: newer.deviceName,
        ...(verified > 0 ? { lastVerifiedAt: verified } : {}),
        ...((newer.fileName ?? prior.fileName ?? b.fileName) ? { fileName: newer.fileName ?? prior.fileName ?? b.fileName } : {}),
      })
    }
  }
  return [...byId.values()].sort((a, b) => (b.lastVerifiedAt ?? b.createdAt) - (a.lastVerifiedAt ?? a.createdAt))
}

const storageKey = (pubkey: string) => KEY_BACKUPS_PREFIX + pubkey

export function loadKeyBackups(pubkey: string): KeyBackup[] {
  try {
    if (!pubkey) return []
    const raw = localStorage.getItem(storageKey(pubkey))
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? mergeKeyBackups(parsed as KeyBackup[]) : []
  } catch {
    return []
  }
}

function saveKeyBackups(pubkey: string, list: KeyBackup[]): void {
  try {
    localStorage.setItem(storageKey(pubkey), JSON.stringify(list))
  } catch {
    // Storage full or blocked. The relay copy is still written.
  }
  try {
    window.dispatchEvent(new CustomEvent(KEY_BACKUPS_CHANGED, { detail: pubkey }))
  } catch {
    // No window (a worker or a test without jsdom).
  }
}

/** Merge into the local list. Returns the merged list. */
export function mergeLocalKeyBackups(pubkey: string, incoming: readonly KeyBackup[]): KeyBackup[] {
  const next = mergeKeyBackups(loadKeyBackups(pubkey), incoming)
  saveKeyBackups(pubkey, next)
  return next
}

/** The backups that hold the key this browser holds now. */
export function backupsForCurrentKey(list: readonly KeyBackup[], fingerprint = currentKeyFingerprint()): KeyBackup[] {
  if (!fingerprint) return []
  return list.filter((b) => b.keyFingerprint === fingerprint)
}

/**
 * Remember a backup just made on this device. The fingerprint is of the envelope the backup was
 * made from (pass it when known, else the one stored now). Publishes in the background.
 */
export function recordKeyBackup(
  pubkey: string,
  location: KeyBackupLocation,
  options: { fileName?: string; verified?: boolean; fingerprint?: string; at?: number } = {},
): KeyBackup | null {
  const keyFingerprint = options.fingerprint ?? currentKeyFingerprint()
  if (!pubkey || !keyFingerprint) return null
  const at = options.at ?? Date.now()
  const entry: KeyBackup = {
    location,
    deviceId: deviceId(),
    deviceName: deviceName(),
    createdAt: at,
    keyFingerprint,
    ...(options.verified ? { lastVerifiedAt: at } : {}),
    ...(options.fileName ? { fileName: options.fileName } : {}),
  }
  mergeLocalKeyBackups(pubkey, [entry])
  void syncKeyBackups(pubkey)
  return entry
}

// ---------------------------------------------------------------------------
// The relay record

function selfSealer(): Sealer {
  const signer = getSigner()
  return {
    encrypt: (plain) => signer.nip44Encrypt(signer.pubkey, plain),
    decrypt: (cipher) => signer.nip44Decrypt(signer.pubkey, cipher),
  }
}

function asList(text: string): KeyBackup[] | null {
  try {
    const parsed = JSON.parse(text) as { backups?: unknown }
    return Array.isArray(parsed.backups) ? mergeKeyBackups(parsed.backups as KeyBackup[]) : null
  } catch {
    return null
  }
}

/** Every location in the record(s) on relay ∪ gateway. Null when nothing answered. */
export async function readKeyBackupsRecord(pubkey: string): Promise<KeyBackup[] | null> {
  let events: Event[]
  try {
    events = await allEvents(pubkey, KEY_BACKUPS_KIND)
  } catch {
    return null
  }
  const mine = events.filter((e) => {
    if (e.pubkey !== pubkey || e.kind !== KEY_BACKUPS_KIND || recordIdOf(e) !== KEY_BACKUPS_D_TAG) return false
    const { id, created_at, kind, tags, content, sig } = e
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
  })
  const unique = [...new Map(mine.map((e) => [e.id, e])).values()]
  const sealer = selfSealer()
  // A union over every readable copy, not the newest only: two devices writing at once each keep
  // what they saw, and the next write carries both.
  const lists: KeyBackup[][] = []
  for (const r of await reassembleRecords(unique, pubkey, sealer)) {
    const list = asList(r.plaintext)
    if (list) lists.push(list)
  }
  for (const e of unique) {
    if (isChunkEvent(e)) continue
    try {
      const list = asList(sealer.decrypt(e.content))
      if (list) lists.push(list)
    } catch {
      // Not readable with this key.
    }
  }
  return mergeKeyBackups(...lists)
}

export async function publishKeyBackupsRecord(list: readonly KeyBackup[]): Promise<boolean> {
  const signer = getSigner()
  const plaintext = JSON.stringify({ v: 1, backups: list })
  const templates = await buildRecordEvents(KEY_BACKUPS_KIND, KEY_BACKUPS_D_TAG, plaintext, [], selfSealer())
  let all = true
  for (const template of templates) {
    const event = (await signer.signEvent(template)) as Event
    const [relayed, mirrored] = await Promise.all([
      publish(event).then(
        (r) => r.ok > 0,
        () => false,
      ),
      mirrorToGateway(event).catch(() => false),
    ])
    if (!relayed && !mirrored) all = false
  }
  return all
}

function unlocked(): boolean {
  try {
    const signer = getSigner() as { hasKey?: () => boolean }
    return typeof signer.hasKey !== 'function' || signer.hasKey()
  } catch {
    return false
  }
}

/**
 * Read the record, merge it into the local list, and publish when this device knows a location
 * the record does not. Returns the merged list, or null when the record could not be read.
 * Never throws.
 */
export async function syncKeyBackups(pubkey: string): Promise<KeyBackup[] | null> {
  try {
    if (!pubkey || !unlocked()) return null
    const remote = await readKeyBackupsRecord(pubkey)
    if (!remote) return null
    const merged = mergeLocalKeyBackups(pubkey, remote)
    if (JSON.stringify(merged) !== JSON.stringify(mergeKeyBackups(remote))) {
      await publishKeyBackupsRecord(merged)
    }
    return merged
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The logout gate

export type KeyBackupCheck = { ok: true; backups: KeyBackup[] } | { ok: false; backups: KeyBackup[] }

/** How long logout waits for the relay record before deciding on what this device knows. */
export const KEY_BACKUP_SYNC_TIMEOUT_MS = 5_000

/**
 * Whether a known backup holds the key this browser holds. Reads what this device knows, plus the
 * relay record when it answers in time (a backup made on another device from the same file
 * counts). Works offline: a Drive backup verified at backup time, or a recorded download, is
 * enough. Never answers ok on a failure.
 */
export async function checkKeyBackup(
  pubkey: string,
  sync: (pubkey: string) => Promise<KeyBackup[] | null> = syncKeyBackups,
  timeoutMs = KEY_BACKUP_SYNC_TIMEOUT_MS,
): Promise<KeyBackupCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      sync(pubkey).catch(() => null),
      new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs))),
    ])
  } finally {
    clearTimeout(timer)
  }
  const backups = backupsForCurrentKey(loadKeyBackups(pubkey))
  return backups.length > 0 ? { ok: true, backups } : { ok: false, backups: [] }
}

// ---------------------------------------------------------------------------
// Words

/** Where a backup is, in plain words. `here` is whether it was made on this device. */
export function describeKeyBackup(b: KeyBackup, here: boolean = b.deviceId === deviceId()): string {
  if (b.location === 'drive') {
    return "Your Google Drive (in the app's private storage, so it doesn't appear in your file list)"
  }
  const name = b.fileName ? `The file ${b.fileName}` : 'A backup file'
  return here ? `${name}, in your Downloads on this device` : `${name}, saved on ${b.deviceName}`
}

export const KEY_BACKUP_COPY = {
  title: 'Your key backup',
  keep: 'Do not delete it. You need it to get back into your wallet.',
  none: 'Imani does not know of a backup of your key yet. Back up your key before you log out.',
  stale: 'An older backup was made before your passphrase changed. Back up again so it opens with your current passphrase.',
  savedDrive:
    "Your key is saved in your Google Drive, in the app's private storage, so it doesn't appear in your file list.",
  savedFile: (fileName: string, native: boolean) =>
    native
      ? `Your key is saved as ${fileName}, where you chose to save it on this device.`
      : `Your key is saved as ${fileName}, in your Downloads on this device.`,
  blocked:
    'Imani does not know of a backup of your key, so logging out stays off. Logging out without one would ' +
    'lock you out of your wallet for good. Back up your key to Google Drive or a file first. Nothing has been erased.',
  backUp: 'Back up my key',
  check: 'Check a backup file',
  checkOk: 'That file opens to this account. It is still a good backup.',
  checkStale: 'That file is for this account, but it was made before your passphrase changed. Back up again.',
  checkOther: 'That file is not a backup of this account.',
  checkBad: 'That file is not a wallet backup.',
} as const

/** The lines the logout confirmation shows above its warning. Empty when nothing is known. */
export function logoutBackupLines(backups: readonly KeyBackup[]): string {
  if (backups.length === 0) return ''
  const where = backups.map((b) => `- ${describeKeyBackup(b)}`).join('\n')
  return `Your key is backed up here:\n${where}\n${KEY_BACKUP_COPY.keep}`
}

// ---------------------------------------------------------------------------
// Re-checking a file

export type FileCheck = 'ok' | 'stale' | 'other-account' | 'not-a-backup'

/**
 * Check a picked backup file opens to this account, and record it as a re-checked local backup.
 * Never stores the file.
 */
export function verifyBackupFile(pubkey: string, text: string, fileName?: string): FileCheck {
  let parsed: { format?: unknown; pubkey?: unknown; key?: unknown }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return 'not-a-backup'
  }
  if (parsed.format !== 'imani-wallet-backup' || !parsed.key || typeof parsed.key !== 'object') return 'not-a-backup'
  if (parsed.pubkey !== pubkey) return 'other-account'
  const fp = envelopeFingerprint(parsed.key)
  if (fp !== currentKeyFingerprint()) return 'stale'
  recordKeyBackup(pubkey, 'file', { verified: true, fingerprint: fp, ...(fileName ? { fileName } : {}) })
  return 'ok'
}
