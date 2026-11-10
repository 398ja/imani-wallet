import { base64 } from '@scure/base'

import { codeRef, normaliseSnapshotCode } from './code'
import type { SealedSnapshot } from './crypto'
import type { SignedNostrEvent, SnapshotSigner } from './types'

/**
 * The online half of a support snapshot (#589 sections 7, 8, 11): validating the code with the
 * support service, uploading the ciphertext to the support Blossom with the grant, the NIP-17
 * handoff DM, and the small local record that lets the user see what happened to it.
 *
 * Network and signing are injected (`SnapshotDeps`), so every step is testable without a relay,
 * a gateway or a key; `snapshotDeps()` in collect.ts wires the real ones.
 */

export const VALIDATE_PATH = '/api/v1/support/snapshot-codes/validate'
export const COMPLETE_PATH = '/api/v1/support/snapshot-codes/complete'
export const GRANT_HEADER = 'X-Imani-Snapshot-Grant'
export const RECORDS_KEY = (pubkey: string) => `imani-wallet:snapshots:${pubkey}`

export type ValidationErrorKind = 'mistyped' | 'invalid_or_expired' | 'rate_limited' | 'offline' | 'unavailable'

export class SnapshotCodeError extends Error {
  constructor(readonly kind: ValidationErrorKind) {
    super(
      kind === 'mistyped' ? 'That code looks mistyped.' :
      kind === 'invalid_or_expired' ? 'This code is not valid or has expired. Ask support for a new one.' :
      kind === 'rate_limited' ? 'Too many attempts. Wait a few minutes and try again.' :
      kind === 'offline' ? 'You need to be online to check the code.' :
      'Support could not be reached. Try again in a moment.',
    )
    this.name = 'SnapshotCodeError'
  }
}

export interface ValidatedCode {
  canonical: string
  codeRef: string
  ticket: string
  maxBytes: number
  /** Epoch seconds the upload grant expires. */
  grantExpiresAt: number
  /** Epoch seconds the code itself expires. */
  codeExpiresAt: number
  grant: string
}

/** Signed POST, as nip98.signedFetch does. Injected so tests stub it. */
export type SignedPost = (path: string, body: unknown) => Promise<Response>

/** NIP-98 signed by the wallet key, so the service learns which pubkey is asking. */
export const defaultPost: SignedPost = async (path, body) => (await import('../nip98')).signedFetch(path, 'POST', body)

export async function validateSnapshotCode(typed: string, post?: SignedPost): Promise<ValidatedCode> {
  const n = normaliseSnapshotCode(typed)
  if (!n.ok) throw new SnapshotCodeError('mistyped')
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SnapshotCodeError('offline')
  const send: SignedPost = post ?? defaultPost
  let res: Response
  try {
    res = await send(VALIDATE_PATH, { code: n.canonical })
  } catch {
    throw new SnapshotCodeError('unavailable')
  }
  if (res.status === 429) throw new SnapshotCodeError('rate_limited')
  if (!res.ok) throw new SnapshotCodeError(res.status >= 500 ? 'unavailable' : 'invalid_or_expired')
  const b = (await res.json()) as Record<string, unknown>
  if (typeof b.ticket !== 'string' || typeof b.upload_grant !== 'string' || typeof b.max_bytes !== 'number') {
    throw new SnapshotCodeError('unavailable')
  }
  return {
    canonical: n.canonical,
    codeRef: codeRef(n.canonical),
    ticket: b.ticket,
    maxBytes: b.max_bytes,
    grantExpiresAt: Number(b.expires_at),
    codeExpiresAt: Number(b.code_expires_at ?? b.expires_at),
    grant: b.upload_grant,
  }
}

/** `imani-snapshot_<ticket>_<pk8>_<YYYYMMDDTHHMMSSZ>_v1.imsnap` (section 7). */
export function snapshotFileName(ticket: string, pubkey: string, createdAtMs: number): string {
  const ts = new Date(Math.floor(createdAtMs / 1000) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const safeTicket = ticket.replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) || 'T'
  return `imani-snapshot_${safeTicket}_${pubkey.slice(0, 8)}_${ts}_v1.imsnap`
}

/** "4.2 MB", "812 KB": the encrypted file's size, as the size screen shows it. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export type ConnectionKind = 'wifi' | 'cellular' | 'unknown'

export interface ConnectionInfo {
  kind: ConnectionKind
  saveData: boolean
}

/** What the size screen says about the connection (section 11). */
export function connectionAdvice(size: number, c: ConnectionInfo): { tone: 'ok' | 'advise' | 'warn'; text: string } {
  if (c.kind === 'wifi' && !c.saveData) return { tone: 'ok', text: "You're on Wi-Fi." }
  const base = `Uploading uses about ${formatBytes(size)} of data.`
  if (c.kind === 'cellular' || c.saveData) {
    return { tone: 'warn', text: `${base} You seem to be on mobile data${c.saveData ? ' with Data Saver on' : ''}. Connect to Wi-Fi first if you can.` }
  }
  return { tone: 'advise', text: `${base} If you're on mobile data, consider connecting to Wi-Fi first.` }
}

/** Browser connection: `navigator.connection` where it exists; Capacitor's Network plugin on Android. */
export async function detectConnection(): Promise<ConnectionInfo> {
  try {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> } }).Capacitor
    const net = cap?.isNativePlatform?.() ? (cap.Plugins?.Network as { getStatus?: () => Promise<{ connectionType: string }> } | undefined) : undefined
    if (net?.getStatus) {
      const s = await net.getStatus()
      return { kind: s.connectionType === 'wifi' ? 'wifi' : s.connectionType === 'cellular' ? 'cellular' : 'unknown', saveData: false }
    }
  } catch {
    /* fall through to the browser API */
  }
  const nc = (typeof navigator !== 'undefined' ? (navigator as unknown as { connection?: { type?: string; saveData?: boolean } }).connection : undefined)
  const t = nc?.type
  return { kind: t === 'wifi' || t === 'ethernet' ? 'wifi' : t === 'cellular' ? 'cellular' : 'unknown', saveData: nc?.saveData === true }
}

/** Kind 24242 auth event for BUD-02, signed by the wallet key. */
export async function blossomAuth(signer: SnapshotSigner, verb: 'upload' | 'delete', sha: string, nowSec: number, ttlSec: number): Promise<SignedNostrEvent> {
  return signer.signEvent({
    kind: 24242,
    created_at: nowSec,
    content: verb === 'upload' ? 'Upload support snapshot' : 'Delete support snapshot',
    tags: [['t', verb], ['x', sha], ['expiration', String(nowSec + ttlSec)]],
  })
}

const authHeader = (e: SignedNostrEvent) => 'Nostr ' + base64.encode(new TextEncoder().encode(JSON.stringify(e)))

export class SnapshotUploadError extends Error {
  constructor(readonly status: number) {
    super(
      status === 403 ? 'Support did not accept this upload. The code may have expired: ask support for a new one.' :
      status === 413 ? 'This snapshot is larger than support accepts.' :
      'The upload did not finish. Try again.',
    )
    this.name = 'SnapshotUploadError'
  }
}

/**
 * BUD-02 `PUT /upload` with the grant. Not through @imani/blossom-upload's `upload()`: that entry
 * point validates image MIME types and avatar/banner size slots and tries `/media` first, all wrong
 * for an opaque octet-stream with a grant header, so this reuses its protocol (same auth event shape,
 * same headers) for the one request it needs. The edge enforces the grant (403) and size (413).
 */
export async function uploadSnapshot(
  blossomUrl: string,
  sealed: SealedSnapshot,
  grant: string,
  signer: SnapshotSigner,
  doFetch: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ url: string }> {
  const auth = await blossomAuth(signer, 'upload', sealed.sha256, Math.floor(now / 1000), 300)
  const res = await doFetch(`${blossomUrl.replace(/\/+$/, '')}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(auth),
      'Content-Type': 'application/octet-stream',
      'X-SHA-256': sealed.sha256,
      [GRANT_HEADER]: grant,
    },
    body: sealed.ciphertext.slice().buffer as ArrayBuffer,
  })
  if (!res.ok) throw new SnapshotUploadError(res.status)
  let url = `${blossomUrl.replace(/\/+$/, '')}/${sealed.sha256}`
  try {
    const d = (await res.json()) as { url?: unknown; sha256?: unknown }
    if (d.sha256 && d.sha256 !== sealed.sha256) throw new SnapshotUploadError(502)
    if (typeof d.url === 'string') url = d.url
  } catch (e) {
    if (e instanceof SnapshotUploadError) throw e
  }
  return { url }
}

export interface HandoffBody {
  type: 'imani-support-snapshot'
  v: 1
  ticket: string
  code_ref: string
  url: string
  sha256: string
  size: number
  file_name: string
  key: string
  iv: string
  k_corr: string
  delete_auth: string
  expires_at: number
}

export async function handoffBody(args: {
  ticket: string
  codeRef: string
  url: string
  sealed: SealedSnapshot
  fileName: string
  kCorr: Uint8Array
  signer: SnapshotSigner
  expiresAt: number
  now?: number
}): Promise<HandoffBody> {
  const nowSec = Math.floor((args.now ?? Date.now()) / 1000)
  const del = await blossomAuth(args.signer, 'delete', args.sealed.sha256, nowSec, 7 * 86400)
  return {
    type: 'imani-support-snapshot',
    v: 1,
    ticket: args.ticket,
    code_ref: args.codeRef,
    url: args.url,
    sha256: args.sealed.sha256,
    size: args.sealed.ciphertext.length,
    file_name: args.fileName,
    key: base64.encode(args.sealed.key),
    iv: base64.encode(args.sealed.iv),
    k_corr: base64.encode(args.kCorr),
    delete_auth: base64.encode(new TextEncoder().encode(JSON.stringify(del))),
    expires_at: args.expiresAt,
  }
}

// ---------------------------------------------------------------------------------- local record

export type SnapshotState = 'kept' | 'uploaded' | 'shared' | 'received' | 'deleted' | 'expired' | 'failed'

export interface SnapshotRecord {
  sha256: string
  ticket: string
  server: string | null
  state: SnapshotState
  size: number
  createdAt: number
  /** Epoch seconds after which a kept snapshot is deleted (the code's expiry). */
  keepUntil: number
  fileName: string
}

export function readRecords(pubkey: string, store: Storage = localStorage): SnapshotRecord[] {
  try {
    const v = JSON.parse(store.getItem(RECORDS_KEY(pubkey)) ?? '[]')
    return Array.isArray(v) ? (v as SnapshotRecord[]) : []
  } catch {
    return []
  }
}

export function writeRecord(pubkey: string, rec: SnapshotRecord, store: Storage = localStorage): void {
  const rows = readRecords(pubkey, store).filter((r) => r.sha256 !== rec.sha256)
  rows.unshift(rec)
  store.setItem(RECORDS_KEY(pubkey), JSON.stringify(rows.slice(0, 20)))
}

/** The ack DM from support (section 8 step 5). Returns the updated record, or null if not ours. */
export function applyAck(pubkey: string, content: string, store: Storage = localStorage): SnapshotRecord | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(content)
  } catch {
    return null
  }
  if (m.type !== 'imani-support-snapshot-ack' || typeof m.sha256 !== 'string') return null
  const rec = readRecords(pubkey, store).find((r) => r.sha256 === m.sha256)
  if (!rec) return null
  const next = { ...rec, state: (m.deleted === true ? 'deleted' : 'received') as SnapshotState }
  writeRecord(pubkey, next, store)
  return next
}

/** Mark kept snapshots past their code's expiry as expired; returns the shas to drop from disk. */
export function expireKept(pubkey: string, nowSec: number, store: Storage = localStorage): string[] {
  const out: string[] = []
  for (const r of readRecords(pubkey, store)) {
    if (r.state === 'kept' && r.keepUntil <= nowSec) {
      writeRecord(pubkey, { ...r, state: 'expired' }, store)
      out.push(r.sha256)
    }
  }
  return out
}
