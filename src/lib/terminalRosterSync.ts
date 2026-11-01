import type { OwnerAttestation } from './ownerAttestation'
import { localRoster, replaceRoster, sanitizeRow, type GatewayState, type TerminalCredentialEntry, type TerminalRecord, type TerminalStatus } from './terminalRoster'

/**
 * The owner's terminal list, synced across the owner's devices (#160 phase 6, plan 2.2).
 *
 * ## Why
 *
 * The roster is the only place the stall's revocation handles live (ADR 0005 keeps no
 * per-terminal record on the gateway). Logout wiped it (F4), so an owner who logged out, or
 * lost the phone, could no longer revoke a till. Now it is also an encrypted kind-30078 event,
 * `d=imani:terminals`, sealed to the stall's own key, and every device merges what it finds.
 *
 * ## The merge is a join
 *
 * Two phones can write at once, and a replaceable event keeps only the last write. So nothing
 * here is last-writer-wins: `mergeRosters` is commutative, associative and idempotent (property
 * tested), and the next write from either phone re-merges what the other lost. Concretely:
 *
 * - credentials are united by `voucherId`; a `revokedAt` is sticky and the earliest one is kept;
 *   a revoked credential keeps no token, an unrevoked one never loses its token;
 * - a terminal's CURRENT enrolment is the one with the newest `(credentialAt ?? enrolledAt,
 *   voucherId)`; rows for the same enrolment are joined field by field, status only moving
 *   forward and `lapsed` sticking;
 * - a row deliberately removed (a refused mint) leaves a tombstone, so the other phone cannot
 *   bring it back.
 *
 * Revocation truth is the mint (`markSpentElsewhere`), never this event: the merge only makes
 * sure no phone forgets a handle it once had.
 */

export interface ForgottenRow {
  terminalPubkey: string
  /** The forgotten enrolment's `credentialAt ?? enrolledAt`. Rows at or before it are gone. */
  enrolledAt: number
}

export interface Roster {
  rows: TerminalRecord[]
  forgotten: ForgottenRow[]
}

export const ROSTER_PAYLOAD_VERSION = 1

const STATUS_RANK: Record<TerminalStatus, number> = { minting: 1, waiting: 2, 'in-service': 3 }
const GATEWAY_RANK: Record<GatewayState, number> = { unconfirmed: 1, confirmed: 2, lapsed: 3 }

/** "Prefer the one that is set, then the smaller": a semilattice join for optional values. */
function pickNum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

function pickStr(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a <= b ? a : b
}

function pickObj<T>(a: T | undefined, b: T | undefined): T | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b
}

function maxNum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

function maxStr(a: string, b: string): string {
  return a >= b ? a : b
}

/** Drops undefined fields, so equal rosters serialise equally. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function mergeCredential(a: TerminalCredentialEntry, b: TerminalCredentialEntry): TerminalCredentialEntry {
  const revokedAt = pickNum(a.revokedAt, b.revokedAt)
  return clean({
    voucherId: a.voucherId,
    issuedAt: Math.min(a.issuedAt, b.issuedAt),
    nonce: pickStr(a.nonce, b.nonce),
    expiresAt: pickNum(a.expiresAt, b.expiresAt),
    renews: pickStr(a.renews, b.renews),
    revokedAt,
    // A revoked credential is spent: its token revokes nothing and only costs bytes (F9).
    token: revokedAt === undefined ? pickStr(a.token, b.token) : undefined,
  })
}

/** The instant that orders a terminal's enrolments, newest current. */
export function enrolmentAt(row: TerminalRecord): number {
  return row.credentialAt ?? row.enrolledAt
}

/**
 * A row with its own facts folded into its credential history, and back. Idempotent.
 *
 * The CURRENT credential (`row.voucherId`) is where revocation and the token live: the row's
 * `revokedAt` and `token` are read from it, so the two cannot disagree after a merge.
 */
export function normalizeRow(row: TerminalRecord): TerminalRecord {
  const byId = new Map<string, TerminalCredentialEntry>()
  for (const c of row.credentials ?? []) {
    const prior = byId.get(c.voucherId)
    byId.set(c.voucherId, prior ? mergeCredential(prior, clean({ ...c })) : mergeCredential(c, c))
  }
  let revokedAt = row.revokedAt
  let token = row.token
  if (row.voucherId) {
    const own: TerminalCredentialEntry = clean({
      voucherId: row.voucherId,
      issuedAt: enrolmentAt(row),
      revokedAt: row.revokedAt,
      token: row.revokedAt === undefined ? row.token : undefined,
      nonce: row.attestation?.nonce,
      expiresAt: row.attestation ? Number(row.attestation.expires_at) : undefined,
    })
    const prior = byId.get(row.voucherId)
    const current = prior ? mergeCredential(prior, own) : own
    byId.set(row.voucherId, current)
    revokedAt = current.revokedAt
    // A revoked row keeps no token, unless it is a defective mint whose spend must be retried.
    token = current.revokedAt === undefined ? current.token : undefined
  }
  const credentials = [...byId.values()].sort(
    (x, y) => x.issuedAt - y.issuedAt || x.voucherId.localeCompare(y.voucherId),
  )
  return clean({ ...row, credentials, revokedAt, token })
}

function identity(row: TerminalRecord): [number, string] {
  return [enrolmentAt(row), row.voucherId ?? '']
}

function newer(a: TerminalRecord, b: TerminalRecord): number {
  const [ta, va] = identity(a)
  const [tb, vb] = identity(b)
  return ta - tb || (va < vb ? -1 : va > vb ? 1 : 0)
}

/** Two rows for the same enrolment (same identity), joined field by field. */
function joinSame(a: TerminalRecord, b: TerminalRecord): TerminalRecord {
  const status =
    a.status === undefined ? b.status : b.status === undefined ? a.status
      : STATUS_RANK[a.status] >= STATUS_RANK[b.status] ? a.status : b.status
  const gatewayState =
    a.gatewayState === undefined ? b.gatewayState : b.gatewayState === undefined ? a.gatewayState
      : GATEWAY_RANK[a.gatewayState] >= GATEWAY_RANK[b.gatewayState] ? a.gatewayState : b.gatewayState
  return clean({
    terminalPubkey: a.terminalPubkey,
    name: maxStr(a.name, b.name),
    role: maxStr(a.role, b.role) as TerminalRecord['role'],
    // Same identity, but one side may spell it as `credentialAt` and the other not yet.
    enrolledAt: Math.min(a.enrolledAt, b.enrolledAt),
    credentialAt: pickNum(a.credentialAt, b.credentialAt),
    voucherId: a.voucherId,
    status,
    gatewayState,
    revokedAt: pickNum(a.revokedAt, b.revokedAt),
    token: pickStr(a.token, b.token),
    waitingUntil: pickNum(a.waitingUntil, b.waitingUntil),
    idleLockMinutes: pickNum(a.idleLockMinutes, b.idleLockMinutes),
    mintKey: pickStr(a.mintKey, b.mintKey),
    attestation: pickObj<OwnerAttestation>(a.attestation, b.attestation),
    defect: pickStr(a.defect, b.defect),
    delivered: a.delivered === undefined && b.delivered === undefined ? undefined : Boolean(a.delivered || b.delivered),
    confirmAttempts: maxNum(a.confirmAttempts, b.confirmAttempts),
    nextConfirmAt: maxNum(a.nextConfirmAt, b.nextConfirmAt),
    lastUsedAt: maxNum(a.lastUsedAt, b.lastUsedAt),
    renewal: pickObj(a.renewal, b.renewal),
    renewRequest: pickObj(a.renewRequest, b.renewRequest),
    shop: pickObj(a.shop, b.shop),
    credentials: a.credentials,
  })
}

function forgottenUnion(a: ForgottenRow[], b: ForgottenRow[]): ForgottenRow[] {
  const latest = new Map<string, number>()
  for (const f of [...a, ...b]) {
    const key = f.terminalPubkey.toLowerCase()
    latest.set(key, Math.max(latest.get(key) ?? -Infinity, f.enrolledAt))
  }
  return [...latest.entries()]
    .map(([terminalPubkey, enrolledAt]) => ({ terminalPubkey, enrolledAt }))
    .sort((x, y) => x.terminalPubkey.localeCompare(y.terminalPubkey))
}

export function isForgotten(row: TerminalRecord, forgotten: ForgottenRow[]): boolean {
  const key = row.terminalPubkey.toLowerCase()
  return forgotten.some((f) => f.terminalPubkey === key && enrolmentAt(row) <= f.enrolledAt)
}

/**
 * The rows an owner sees: those not removed on purpose. A forgotten row's NEWEST enrolment is at
 * or before its tombstone; one enrolled again after it is visible again.
 */
export function visibleRows(roster: Roster): TerminalRecord[] {
  return roster.rows.filter((row) => !isForgotten(row, roster.forgotten))
}

/** Join two rosters. Commutative, associative, idempotent (`terminalRosterSync.test.ts`). */
export function mergeRosters(a: Roster, b: Roster): Roster {
  const forgotten = forgottenUnion(a.forgotten, b.forgotten)
  const groups = new Map<string, TerminalRecord[]>()
  for (const raw of [...a.rows, ...b.rows]) {
    // Never dropped here, even when forgotten: dropping before or after another merge would keep
    // or lose its credential history depending on the order (found by the associativity
    // property). A tombstone hides a row from the VIEW (`visibleRows`), never from the join.
    const row = normalizeRow({ ...raw, terminalPubkey: raw.terminalPubkey.toLowerCase() })
    const list = groups.get(row.terminalPubkey) ?? []
    list.push(row)
    groups.set(row.terminalPubkey, list)
  }
  const rows: TerminalRecord[] = []
  for (const list of groups.values()) {
    // Every credential either side ever recorded for this device, whichever enrolment is current.
    const credentials = list.flatMap((r) => r.credentials ?? [])
    const lastUsedAt = list.reduce<number | undefined>((m, r) => maxNum(m, r.lastUsedAt), undefined)
    const current = list.reduce((best, r) => (newer(r, best) > 0 ? r : best))
    const same = list.filter((r) => newer(r, current) === 0)
    const joined = same.reduce((x, y) => joinSame(x, y))
    rows.push(normalizeRow({ ...joined, credentials, lastUsedAt }))
  }
  rows.sort((x, y) => x.terminalPubkey.localeCompare(y.terminalPubkey))
  return { rows, forgotten }
}

/**
 * The event's plaintext: `{"v":1,"rows":[…],"forgotten":[…]}`.
 *
 * Tokens only for credentials that can still be revoked (F9): a revoked credential's token
 * revokes nothing and a roster of about 20 live tokens already fills one event. Chunked above
 * the relay's budget by the caller (`chunkedRecord`).
 */
export function rosterPayload(roster: Roster): string {
  const rows = roster.rows.map((raw) => {
    const row = normalizeRow(raw)
    return clean({
      ...row,
      // Local-only bookkeeping that means nothing on another phone.
      confirmAttempts: undefined,
      nextConfirmAt: undefined,
      credentials: (row.credentials ?? []).map((c) => clean({ ...c, token: c.revokedAt === undefined ? c.token : undefined })),
      token: row.revokedAt === undefined ? row.token : undefined,
    })
  })
  return JSON.stringify({ v: ROSTER_PAYLOAD_VERSION, rows, forgotten: roster.forgotten })
}

/** The roster an event carried, validated row by row; null when it is not one. */
export function rosterFromPayload(json: string): Roster | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const body = parsed as { v?: unknown; rows?: unknown; forgotten?: unknown }
  if (!body || body.v !== ROSTER_PAYLOAD_VERSION || !Array.isArray(body.rows)) return null
  const rows = body.rows.flatMap((r) => {
    const row = sanitizeRow(r)
    return row ? [row] : []
  })
  const forgotten = Array.isArray(body.forgotten)
    ? body.forgotten.flatMap((f) => {
        const x = f as Partial<ForgottenRow>
        return typeof x?.terminalPubkey === 'string' && typeof x.enrolledAt === 'number'
          ? [{ terminalPubkey: x.terminalPubkey.toLowerCase(), enrolledAt: x.enrolledAt }]
          : []
      })
    : []
  return { rows, forgotten }
}

// ---- the sync itself ------------------------------------------------------------------------

export interface SyncDeps {
  /**
   * The newest roster plaintext the stall published, `null` when there is none, and a throw when
   * the relay and the gateway could not be read at all (which is NOT an empty roster).
   */
  fetch(stallPubkey: string): Promise<string | null>
  /** Publish the merged plaintext, sealed to the stall. True when it landed somewhere. */
  publish(plaintext: string): Promise<boolean>
  /** Run once the merged roster is stored: the owner's app asks the mint (`markSpentElsewhere`). */
  afterMerge?(stallPubkey: string): Promise<void>
}

const SYNCED_KEY = (stall: string) => `imani-wallet:terminals-synced:${stall.toLowerCase()}`

/** Whether this device has merged the published roster at least once (the W4 guard). */
export function rosterSyncedOnce(stallPubkey: string): boolean {
  try {
    return localStorage.getItem(SYNCED_KEY(stallPubkey)) !== null
  } catch {
    return false
  }
}

/**
 * Fetch the published roster, merge it INTO local storage, publish the merge, then let the mint
 * correct anything revoked elsewhere. Local storage is an input to the merge, never overwritten
 * blind (R1). A roster that could not be read is not merged and not overwritten.
 */
export async function syncRoster(
  stallPubkey: string,
  deps: SyncDeps,
): Promise<{ fetched: boolean; published: boolean }> {
  let remote: Roster | null
  try {
    const plaintext = await deps.fetch(stallPubkey)
    remote = plaintext === null ? { rows: [], forgotten: [] } : rosterFromPayload(plaintext)
  } catch {
    return { fetched: false, published: false }
  }
  // An event this build cannot read (a newer version) is left for the build that can.
  if (remote === null) return { fetched: false, published: false }

  const merged = mergeRosters(localRoster(stallPubkey), remote)
  replaceRoster(stallPubkey, merged.rows, merged.forgotten)
  try {
    localStorage.setItem(SYNCED_KEY(stallPubkey), String(Date.now()))
  } catch {
    // The home-coming check then stays quiet a little longer.
  }

  let published = false
  // Only when the merge says something the published copy does not, to spare the relay.
  if (canonicalPayload(merged) !== canonicalPayload(remote)) {
    published = await deps.publish(rosterPayload(merged)).catch(() => false)
  }
  if (deps.afterMerge) await deps.afterMerge(stallPubkey).catch(() => undefined)
  return { fetched: true, published }
}

function canonicalPayload(roster: Roster): string {
  return rosterPayload(mergeRosters(roster, { rows: [], forgotten: [] }))
}
