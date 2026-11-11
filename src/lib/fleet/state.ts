/**
 * Local fleet state (#591 contract C6), one record per wallet under `imani-wallet:fleet:<pubkey>`.
 *
 * - `optIn`: the opt-in record `{consent_version, install_nonce, opted_in_at}`. The nonce is what
 *   the fleet key is derived from (key.ts); deleting it makes the old fleet identity unreachable.
 * - `held`: a snapshot request from the server, clamped, kept until it expires or is handled.
 * - `uploads`: the Snapshot history lines for fleet uploads, and the 30-day client cap's input.
 * - `deregisterNonce`: after an opt-out whose DELETE failed, the old nonce, kept ONLY to retry the
 *   DELETE on the next unlock. Nothing else may use it.
 *
 * Under the `imani-wallet:` prefix, so logout sweeps it. The snapshot inventory reports this key by
 * family and size only (inventory.ts), so neither the nonce nor a held code reaches `data/`.
 */
export const FLEET_KEY_PREFIX = 'imani-wallet:fleet:'
export const fleetKeyName = (walletPubkey: string) => `${FLEET_KEY_PREFIX}${walletPubkey}`

/** Client-side ceiling on fleet uploads, whatever the server asks (#591 section 11). */
export const FLEET_CLIENT_MAX_PER_30D = 2
export const THIRTY_DAYS_MS = 30 * 86400 * 1000
/** History lines kept. */
const MAX_UPLOADS = 20

export interface OptInRecord {
  consent_version: number
  /** 32 bytes, hex. */
  install_nonce: string
  /** Epoch ms. */
  opted_in_at: number
}

export interface HeldRequest {
  code: string
  round: string
  /** Epoch seconds, already clamped. */
  expiresAt: number
  maxBytes: number
  historyDays: number
}

export type FleetUploadState = 'sent' | 'received' | 'deleted' | 'not_sent'

export interface FleetUpload {
  round: string
  /** Epoch ms. */
  at: number
  state: FleetUploadState
  /** Whether it counts against the 30-day cap: anything that reached the upload server. */
  counted: boolean
}

export interface FleetState {
  optIn: OptInRecord | null
  held: HeldRequest | null
  uploads: FleetUpload[]
  deregisterNonce: string | null
  /** Epoch ms of the opt-out that left `deregisterNonce`; dropped 30 days later (server forgets anyway). */
  optedOutAt?: number
  /** The server accepted a register for the current opt-in. A 410 clears it (re-register once). */
  registered?: boolean
}

const EMPTY: FleetState = { optIn: null, held: null, uploads: [], deregisterNonce: null }
const HEX32 = /^[0-9a-f]{64}$/

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseOptIn(v: unknown): OptInRecord | null {
  if (!isRec(v) || typeof v.consent_version !== 'number' || typeof v.install_nonce !== 'string' || !HEX32.test(v.install_nonce) || typeof v.opted_in_at !== 'number') return null
  return { consent_version: v.consent_version, install_nonce: v.install_nonce, opted_in_at: v.opted_in_at }
}

function parseHeld(v: unknown): HeldRequest | null {
  if (!isRec(v)) return null
  const { code, round, expiresAt, maxBytes, historyDays } = v
  if (typeof code !== 'string' || typeof round !== 'string' || typeof expiresAt !== 'number' || typeof maxBytes !== 'number' || typeof historyDays !== 'number') return null
  return { code, round, expiresAt, maxBytes, historyDays }
}

function parseUpload(v: unknown): FleetUpload | null {
  if (!isRec(v) || typeof v.round !== 'string' || typeof v.at !== 'number') return null
  const state = (['sent', 'received', 'deleted', 'not_sent'] as const).find((s) => s === v.state)
  if (!state) return null
  return { round: v.round, at: v.at, state, counted: v.counted === true }
}

export function readFleet(walletPubkey: string, store: Storage = localStorage): FleetState {
  let raw: unknown
  try {
    raw = JSON.parse(store.getItem(fleetKeyName(walletPubkey)) ?? 'null')
  } catch {
    return { ...EMPTY, uploads: [] }
  }
  if (!isRec(raw)) return { ...EMPTY, uploads: [] }
  return {
    optIn: parseOptIn(raw.optIn),
    held: parseHeld(raw.held),
    uploads: Array.isArray(raw.uploads) ? raw.uploads.map(parseUpload).filter((u): u is FleetUpload => !!u) : [],
    deregisterNonce: typeof raw.deregisterNonce === 'string' && HEX32.test(raw.deregisterNonce) ? raw.deregisterNonce : null,
    optedOutAt: typeof raw.optedOutAt === 'number' ? raw.optedOutAt : undefined,
    registered: raw.registered === true && parseOptIn(raw.optIn) !== null,
  }
}

/** Writes the record; an all-empty record removes the key, so opt-out leaves nothing behind. */
export function writeFleet(walletPubkey: string, s: FleetState, store: Storage = localStorage): void {
  const next: FleetState = { ...s, uploads: s.uploads.slice(0, MAX_UPLOADS) }
  if (!next.optIn && !next.held && next.uploads.length === 0 && !next.deregisterNonce) {
    store.removeItem(fleetKeyName(walletPubkey))
    return
  }
  store.setItem(fleetKeyName(walletPubkey), JSON.stringify(next))
}

export function updateFleet(walletPubkey: string, f: (s: FleetState) => FleetState, store: Storage = localStorage): FleetState {
  const next = f(readFleet(walletPubkey, store))
  writeFleet(walletPubkey, next, store)
  return next
}

/** Fleet uploads that reached the server in the last 30 days, on this device. */
export function uploadsIn30d(s: FleetState, nowMs: number): number {
  return s.uploads.filter((u) => u.counted && nowMs - u.at < THIRTY_DAYS_MS && u.at <= nowMs).length
}

/** Record a fleet upload outcome, newest first, replacing an earlier line for the same round. */
export function recordUpload(s: FleetState, u: FleetUpload): FleetState {
  return { ...s, uploads: [u, ...s.uploads.filter((x) => x.round !== u.round)] }
}
