import { readOwnerAttestation, type OwnerAttestation } from './ownerAttestation'
import { roleOf, type TerminalRole } from './terminalRole'
import { parseVoucherToken } from './voucherToken'
import { ONLINE_SHOP_PLATFORMS, type OnlineShopPlatform } from './onlineShop'
import { isForgotten, normalizeRow, type ForgottenRow } from './terminalRosterSync'

/**
 * The stall's record of the terminals it has out, and withdrawing one.
 *
 * Terminals ticket 06, kept on the OWNER's device. There is deliberately no
 * server-side list: ADR 0005 removes the per-terminal record on the gateway,
 * which is what makes terminals cheap, so the owner's own copy is the only
 * roster there is.
 *
 * ## Revocation must work with the device gone
 *
 * The lost, stolen and dead-battery cases are the only ones that really matter,
 * so nothing here asks the terminal for anything. The owner keeps each
 * terminal's credential `token`, which carries the stall as a co-spender
 * (#160, spec 4.3), so revoking a device at the bottom of a river is the same
 * operation as revoking one on the counter: the stall spends the credential.
 *
 * ## Revoking withdraws authority; it never erases
 *
 * A revoked terminal stays in the roster, marked. Its past movements stay in
 * the stall's records attributed to it — "revoking is not the same as erasing"
 * is a user story, and a stall that lost its own history every time it retired
 * a till could not reconcile anything.
 *
 * ## There is no pause
 *
 * The mint models spent, not suspended, so this module offers `revoke` and
 * nothing else. A `suspend` here would need exactly the server-side record the
 * design removes, and an owner who wants a terminal back enrols it again —
 * seconds of work. The absence is the feature.
 */

/** How long a session may outlive its credential. ADR 0005 sets 12 hours. */
export const REVOCATION_DELAY_HOURS = 12

/**
 * What the screen says about the delay, rather than leaving it to be found out.
 *
 * The fourth acceptance criterion is that this is STATED. An owner who has just
 * lost a device is deciding whether to also close the stall, and they cannot
 * make that decision against a number nobody told them.
 */
export const REVOCATION_DELAY_NOTE =
  `A revoked terminal stops trading within ${REVOCATION_DELAY_HOURS} hours, when its ` +
  'session next expires. If the device is in the wrong hands and that is too long, ' +
  'close your stall as well.'

export interface TerminalRecord {
  /** This terminal's own public key. The roster's identity for it. */
  terminalPubkey: string
  /** What the owner called it. */
  name: string
  role: TerminalRole
  enrolledAt: number
  /** Epoch ms of the last movement this terminal handled, if any. */
  lastUsedAt?: number
  /**
   * The credential itself (#160). The stall is its co-spender, so this is what
   * revoking spends. Kept at enrolment so revocation never needs the device.
   *
   * Absent on rows set up before revocation existed: those were minted by hand,
   * locked to the device alone, and cannot be revoked from here.
   */
  token?: string
  /** The credential's voucher id, which the device's enrolled DM names. */
  voucherId?: string
  /** Epoch ms after which a still-waiting row is cancelled (decision 4: 24 hours). */
  waitingUntil?: number
  /** Minutes of no touch before the till locks (decision 2). `0` is off. Sent to the device. */
  idleLockMinutes?: number
  /** Set when revoked. Present means retired; the record itself stays. */
  revokedAt?: number
  /**
   * Where setup stands, #160.
   *
   * `waiting`: added on this phone, not yet confirmed by the device, so it
   * cannot trade and the list must not say it can. Absent on rows written
   * before this field existed, which read as they always did.
   */
  status?: TerminalStatus
  /**
   * The Idempotency-Key the mint request was sent with (#160 review). Set on a
   * `minting` row before the request leaves this phone, so a request whose
   * answer was lost can be sent again and the gateway replays the credential it
   * already minted instead of minting a second one.
   */
  mintKey?: string
  /**
   * The owner's attestation the mint request carries (#160 decision 5, spec 4.6.2). Written on
   * the `minting` row with `mintKey`, so `resumeMinting` re-sends the identical body: signing
   * again would pick a fresh nonce, and the gateway's idempotent replay would refuse it as a
   * different request. Kept afterwards, as the roster's record of what the owner signed.
   */
  attestation?: OwnerAttestation
  /**
   * The device's enrolment proof the first mint carried (inv-terminal-not-merchant), kept on the
   * `minting` row with `mintKey` so a resumed mint sends it again. Public; grants nothing.
   */
  enrolmentProof?: string
  /**
   * Why a minted credential was refused, on a `minting` row whose cancelling
   * spend has not landed yet. Kept so the next open retries the spend.
   */
  defect?: string
  /**
   * Whether the credential DM reached the relay or the gateway mirror (#160 round 2). False or
   * absent on a waiting row means it still has to be sent: the enrol screen's send failed, or
   * `resumeMinting` finished the row and nothing was sent at all.
   */
  delivered?: boolean
  /**
   * What gateway-customer says about the credential (#160 round 2, V27). Only a `confirmed`
   * credential may sell; `lapsed` was never confirmed within 24 hours and never will be.
   * Absent until the owner's app has asked.
   */
  gatewayState?: GatewayState
  /** Failed confirm attempts so far, for the backoff. */
  confirmAttempts?: number
  /** Epoch ms before which the next confirm attempt is not made. */
  nextConfirmAt?: number
  /**
   * When the CURRENT credential was issued, epoch ms (#160 phase 6). Set by a renewal, so the row
   * keeps its `enrolledAt` (when the device was first added) and the roster sync can still tell
   * which credential is the newest. Absent: `enrolledAt` is the current credential's issue time.
   */
  credentialAt?: number
  /**
   * Every credential this device ever held (#160 phase 6, spec 6, plan 2.2): the current one and
   * those renewed away or revoked. The home-coming check (decision 5 Q2) reads it, and the roster
   * sync merges it. `token` only on credentials that can still be revoked (F9).
   */
  credentials?: TerminalCredentialEntry[]
  /**
   * A renewal in progress (#160 phase 6, plan 2.3): written BEFORE the mint request, as a
   * `minting` row is, so `resumeRenewal` finishes it from either of the owner's phones.
   */
  renewal?: TerminalRenewal
  /** Set when a till asked for a renewal and the owner has not renewed yet (Q3). */
  renewRequest?: { at: number }
  /**
   * Present when this terminal is an online shop (#402 §0): a redeem-only terminal whose key `S`
   * the shop's plugin generated. The stall advertises it as `online_shop` on its profile while the
   * row is live, and withdraws it on revoke. Display and publishing only: the role is the token's.
   */
  shop?: { url: string; platform: OnlineShopPlatform }
}

/** One credential a terminal held, in the roster's history (#160 phase 6). */
export interface TerminalCredentialEntry {
  voucherId: string
  /** Epoch ms the owner's app recorded it. */
  issuedAt: number
  /** The attestation's nonce, the gateway's one-time claim (spec 4.6.2). */
  nonce?: string
  /** `T`, epoch seconds: the credential's signed expiry. */
  expiresAt?: number
  /** The voucher id this credential renewed, if it was a renewal. */
  renews?: string
  /** Set once the mint took the spend (or reported it spent). */
  revokedAt?: number
  /** Only while unrevoked: what revoking spends. */
  token?: string
}

/** A renewal the owner started for an in-service terminal (#160 phase 6, plan 2.3). */
export interface TerminalRenewal {
  /** Epoch ms the owner pressed Renew. The gateway lapses an unadopted renewal after 24 h. */
  startedAt: number
  /** Sent as `Idempotency-Key`, so a lost answer replays the same credential. */
  mintKey: string
  attestation: OwnerAttestation
  /** Known once the gateway accepted the request. */
  voucherId?: string
  /** Known once the token was fetched and checked. */
  token?: string
  /** The renews-DM reached the relay or the mirror. */
  delivered?: boolean
}

/** The credential's standing at gateway-customer, as the owner's app last learned it. */
export type GatewayState = 'unconfirmed' | 'confirmed' | 'lapsed'

function gatewayStateOf(value: unknown): GatewayState | undefined {
  return value === 'unconfirmed' || value === 'confirmed' || value === 'lapsed' ? value : undefined
}

/**
 * `minting`: the owner asked the gateway for a credential and this phone has
 * not yet checked what came back. Written BEFORE the request (#160 review), so
 * a credential minted while the answer was lost, or one that came back wrong
 * and could not be cancelled, is never left unknown to the roster.
 */
export type TerminalStatus = 'minting' | 'waiting' | 'in-service'

function statusOf(value: unknown): TerminalStatus | undefined {
  return value === 'minting' || value === 'waiting' || value === 'in-service' ? value : undefined
}

const ROSTER_KEY = (stallPubkey: string) => `imani-wallet:terminals:${stallPubkey}`

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function credentialEntryOf(raw: unknown): TerminalCredentialEntry | null {
  const c = raw as Partial<TerminalCredentialEntry>
  if (!c || typeof c.voucherId !== 'string' || typeof c.issuedAt !== 'number') return null
  const entry: TerminalCredentialEntry = { voucherId: c.voucherId, issuedAt: c.issuedAt }
  if (text(c.nonce) !== undefined) entry.nonce = c.nonce
  if (num(c.expiresAt) !== undefined) entry.expiresAt = c.expiresAt
  if (text(c.renews) !== undefined) entry.renews = c.renews
  if (num(c.revokedAt) !== undefined) entry.revokedAt = c.revokedAt
  if (text(c.token) !== undefined) entry.token = c.token
  return entry
}

function shopOf(raw: unknown): TerminalRecord['shop'] {
  const s = raw as Partial<NonNullable<TerminalRecord['shop']>> | undefined
  if (!s || typeof s.url !== 'string' || typeof s.platform !== 'string') return undefined
  if (!(ONLINE_SHOP_PLATFORMS as readonly string[]).includes(s.platform)) return undefined
  return { url: s.url, platform: s.platform }
}

function attestationOf(raw: unknown): OwnerAttestation | undefined {
  return raw && typeof raw === 'object' ? (readOwnerAttestation({ owner_attestation: raw }) ?? undefined) : undefined
}

function renewalOf(raw: unknown): TerminalRenewal | undefined {
  const r = raw as Partial<TerminalRenewal>
  const attestation = attestationOf(r?.attestation)
  if (!r || typeof r.startedAt !== 'number' || typeof r.mintKey !== 'string' || !attestation) return undefined
  return {
    startedAt: r.startedAt,
    mintKey: r.mintKey,
    attestation,
    ...(text(r.voucherId) !== undefined ? { voucherId: r.voucherId } : {}),
    ...(text(r.token) !== undefined ? { token: r.token } : {}),
    ...(typeof r.delivered === 'boolean' ? { delivered: r.delivered } : {}),
  }
}

/**
 * One stored or synced row, validated rather than cast, and folded into its credential history
 * (`normalizeRow`). An old row's single `voucherId` and attestation become `credentials[0]`.
 * A roster row with an unknown role would otherwise render as a terminal whose powers nobody
 * can state, so it is dropped.
 */
export function sanitizeRow(entry: unknown): TerminalRecord | null {
  const row = entry as Partial<TerminalRecord>
  const role = roleOf(row?.role)
  if (!row || !role || typeof row.terminalPubkey !== 'string') return null
  const record: TerminalRecord = {
    terminalPubkey: row.terminalPubkey,
    name: typeof row.name === 'string' ? row.name : 'Terminal',
    role,
    enrolledAt: typeof row.enrolledAt === 'number' ? row.enrolledAt : 0,
    lastUsedAt: num(row.lastUsedAt),
    token: text(row.token),
    voucherId: text(row.voucherId),
    waitingUntil: num(row.waitingUntil),
    idleLockMinutes: num(row.idleLockMinutes),
    revokedAt: num(row.revokedAt),
    status: statusOf(row.status),
    mintKey: text(row.mintKey),
    attestation: attestationOf(row.attestation),
    enrolmentProof:
      typeof row.enrolmentProof === 'string' && /^1:\d{1,12}:[0-9a-f]{128}$/.test(row.enrolmentProof)
        ? row.enrolmentProof
        : undefined,
    defect: text(row.defect),
    delivered: typeof row.delivered === 'boolean' ? row.delivered : undefined,
    gatewayState: gatewayStateOf(row.gatewayState),
    confirmAttempts: num(row.confirmAttempts),
    nextConfirmAt: num(row.nextConfirmAt),
    credentialAt: num(row.credentialAt),
    credentials: Array.isArray(row.credentials)
      ? row.credentials.flatMap((c) => {
          const e = credentialEntryOf(c)
          return e ? [e] : []
        })
      : undefined,
    renewal: renewalOf(row.renewal),
    renewRequest:
      row.renewRequest && typeof row.renewRequest.at === 'number' ? { at: row.renewRequest.at } : undefined,
    shop: shopOf(row.shop),
  }
  for (const key of Object.keys(record) as (keyof TerminalRecord)[]) {
    if (record[key] === undefined) delete record[key]
  }
  return normalizeRow(record)
}

/** Every stored row, forgotten ones included: the roster sync's merge input. */
function readAll(stallPubkey: string): TerminalRecord[] {
  try {
    const raw = localStorage.getItem(ROSTER_KEY(stallPubkey))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): TerminalRecord[] => {
      const row = sanitizeRow(entry)
      return row ? [row] : []
    })
  } catch {
    return []
  }
}

function write(stallPubkey: string, rows: TerminalRecord[]): void {
  try {
    localStorage.setItem(ROSTER_KEY(stallPubkey), JSON.stringify(rows.map(normalizeRow)))
  } catch {
    // Storage refused. The caller has already issued the credential, so losing
    // the roster row costs the owner their list, not the terminal its authority.
  }
  // Every mutation is published, debounced, to the owner's other devices (#160 phase 6).
  for (const listener of rosterListeners) listener(stallPubkey)
  notifyRosterView(stallPubkey)
}

const rosterListeners = new Set<(stallPubkey: string) => void>()

/** Called after every roster write. The roster sync publishes from here. */
export function onRosterChanged(listener: (stallPubkey: string) => void): () => void {
  rosterListeners.add(listener)
  return () => rosterListeners.delete(listener)
}

const viewListeners = new Set<(stallPubkey: string) => void>()

function notifyRosterView(stallPubkey: string): void {
  for (const listener of viewListeners) listener(stallPubkey)
}

/**
 * Called after every change to what the roster reads as, the sync's merge included. For screens
 * that name a till from it (the Vouchers list's "Sold on"): on a restored phone the list opens
 * before the login sync has merged the roster in (found by the local gate, #160 phase 6 E4). Not
 * the publish hook: the sync's own write must not publish again.
 */
export function onRosterView(listener: (stallPubkey: string) => void): () => void {
  viewListeners.add(listener)
  return () => viewListeners.delete(listener)
}

const FORGOTTEN_KEY = (stallPubkey: string) => `imani-wallet:terminals-forgotten:${stallPubkey}`

/** Rows this device deliberately removed, so a sync from another phone does not restore them. */
export function forgottenRows(stallPubkey: string): ForgottenRow[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FORGOTTEN_KEY(stallPubkey)) ?? '[]') as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (f): f is ForgottenRow =>
            !!f && typeof (f as ForgottenRow).terminalPubkey === 'string' && typeof (f as ForgottenRow).enrolledAt === 'number',
        )
      : []
  } catch {
    return []
  }
}

/** The stored roster and tombstones, as the sync merges them. */
export function localRoster(stallPubkey: string): { rows: TerminalRecord[]; forgotten: ForgottenRow[] } {
  return { rows: readAll(stallPubkey), forgotten: forgottenRows(stallPubkey) }
}

/**
 * The rows this device works with: every stored row the owner did not remove on purpose. A
 * synced roster keeps a removed row's history (the merge must), so it is hidden here.
 */
function read(stallPubkey: string): TerminalRecord[] {
  const forgotten = forgottenRows(stallPubkey)
  return readAll(stallPubkey).filter((t) => !isForgotten(t, forgotten))
}

/**
 * Replace the stored roster with a merged one (the sync's only write). Never blind: the caller
 * merged the local roster in, so nothing local is lost (R1).
 */
export function replaceRoster(stallPubkey: string, rows: TerminalRecord[], forgotten: ForgottenRow[]): void {
  try {
    localStorage.setItem(FORGOTTEN_KEY(stallPubkey), JSON.stringify(forgotten))
  } catch {
    // Without the tombstones a forgotten row may come back once; the next forget removes it.
  }
  // Not published again: the sync writes what it just merged and published. Screens are told.
  try {
    localStorage.setItem(ROSTER_KEY(stallPubkey), JSON.stringify(rows.map(normalizeRow)))
  } catch {
    // As `write`.
  }
  notifyRosterView(stallPubkey)
}

/** Everything this stall has ever enrolled, newest first. */
export function allTerminals(stallPubkey: string): TerminalRecord[] {
  return read(stallPubkey).sort((a, b) => b.enrolledAt - a.enrolledAt)
}

/**
 * The terminals currently out.
 *
 * What the list shows by default. A revoked terminal is not "out" — showing it
 * alongside live ones would make the roster a history rather than an answer to
 * "what is trading for me right now".
 */
export function liveTerminals(stallPubkey: string): TerminalRecord[] {
  return allTerminals(stallPubkey).filter((t) => t.revokedAt === undefined)
}

/**
 * How many terminals count against the free allowance.
 *
 * The number `mayEnrol` takes. Revoked terminals are NOT counted: a stall that
 * retired a till has not used up its allowance on a device that no longer
 * trades, and counting them would make revocation a punishment.
 */
export function enrolledCount(stallPubkey: string): number {
  // Waiting rows do NOT count against the free terminal (decision 4 on #160):
  // a botched setup must never block the owner from trying again. They are
  // bounded instead, by `MAX_WAITING` and the 24-hour expiry. A row still
  // minting is a waiting row that has not been checked yet.
  return liveTerminals(stallPubkey).filter((t) => t.status !== 'waiting' && t.status !== 'minting')
    .length
}

/** At most this many terminals may wait for their device at once (decision 4). */
export const MAX_WAITING = 2

/** How long a waiting row lives before it is cancelled (decision 4). */
export const WAITING_TTL_MS = 24 * 3600 * 1000

/**
 * Unrevoked rows still waiting for their device, oldest first.
 *
 * Counted against `MAX_WAITING`. A row still `minting` counts too, because it
 * becomes a waiting row the moment its credential is checked. A phase 0
 * waiting row with no token does NOT count (#160 review): nothing was minted
 * for it, it cannot be cancelled at the mint, and counting it would block Add
 * forever. `unmintedWaiting` finds those so the owner can remove them.
 */
export function waitingTerminals(stallPubkey: string): TerminalRecord[] {
  return liveTerminals(stallPubkey)
    .filter((t) => t.status === 'minting' || (t.status === 'waiting' && isRevocable(t)))
    .sort((a, b) => a.enrolledAt - b.enrolledAt)
}

/**
 * Waiting rows written before anything was minted (phase 0 of #160).
 *
 * They hold no token, so no credential exists for them and retiring them is a
 * local act with nothing to spend.
 */
export function unmintedWaiting(stallPubkey: string): TerminalRecord[] {
  return liveTerminals(stallPubkey).filter((t) => t.status === 'waiting' && !isRevocable(t))
}

/** Rows whose credential request has not been settled yet, oldest first. */
export function mintingTerminals(stallPubkey: string): TerminalRecord[] {
  return liveTerminals(stallPubkey)
    .filter((t) => t.status === 'minting')
    .sort((a, b) => a.enrolledAt - b.enrolledAt)
}

/**
 * Whether this device key already has a credential the owner must not lose.
 *
 * True for an unrevoked row that holds a token (waiting or in service), or one
 * still minting. Re-adding such a key would replace the row, and with it the
 * only revocation handle for a credential that may be in service (#160 review,
 * BLOCKER). `checkEnrolment` refuses it, and `recordTerminal` will not do it.
 */
export function holdsLiveCredential(stallPubkey: string, terminalPubkey: string): boolean {
  const key = terminalPubkey.toLowerCase()
  return read(stallPubkey).some(
    (t) =>
      t.terminalPubkey.toLowerCase() === key &&
      t.revokedAt === undefined &&
      (isRevocable(t) || t.status === 'minting'),
  )
}

/** Waiting rows past their 24 hours, which the owner's wallet must cancel. */
export function expiredWaiting(stallPubkey: string, now: number = Date.now()): TerminalRecord[] {
  // Only rows holding a token: a `minting` row is settled by `resumeMinting`
  // first, and is cancelled here once it has become a waiting row.
  return waitingTerminals(stallPubkey).filter(
    (t) =>
      t.status === 'waiting' && (t.waitingUntil ?? t.enrolledAt + WAITING_TTL_MS) <= now,
  )
}

/** Whether a row holds what revoking needs. Rows set up by hand before #160 do not. */
export function isRevocable(record: TerminalRecord): boolean {
  return typeof record.token === 'string' && record.token.length > 0
}

/**
 * A selling till whose credential carries no owner attestation (#160 decision 5, spec 4.6.5).
 *
 * Read from the token the row holds, not from the row's `attestation` field, so rows minted
 * before 5b-5 (which have the token and nothing else) are found too. It still redeems; it cannot
 * sell, and the roster offers the re-enrol steps. A redeem-only till needs no attestation.
 */
export function needsRenewalToSell(record: TerminalRecord): boolean {
  if (record.revokedAt !== undefined || record.status === 'minting' || !record.token) return false
  if (record.role !== 'issue-and-redeem') return false
  return !tokenCarriesAttestation(record.token)
}

/**
 * What the roster tells the owner about such a row (spec 4.6.5). Since #160 phase 6 (S4) it is
 * one-tap Renew: the four re-enrol steps (revoke, decommission, add again with a new passphrase
 * and setup code) are gone.
 */
export const RENEW_TO_KEEP_SELLING =
  'Renew to keep selling. This terminal was set up before you signed each terminal, so it can ' +
  'redeem but not sell. Renew it here: the device picks up the renewal the next time it is ' +
  'opened, with the same passphrase.'

function tokenCarriesAttestation(token: string): boolean {
  try {
    const metadata = JSON.parse(String(parseVoucherToken(token).voucher.merchantMetadata)) as Record<string, unknown>
    return readOwnerAttestation(metadata) !== null
  } catch {
    return false
  }
}

/** Thrown rather than silently dropping a live credential's revocation handle. */
export class LiveCredentialError extends Error {
  constructor() {
    super('That device already has a live authority on your list. Cancel or revoke it first.')
    this.name = 'LiveCredentialError'
  }
}

/**
 * Record a terminal the owner has just enrolled.
 *
 * Replaces a row for the same key only when that row holds nothing to revoke:
 * a revoked row, or one set up before revocation existed. A live row with a
 * token is the only way to revoke its credential, so replacing it would leave
 * that credential live and unrevocable (#160 review, BLOCKER). That case
 * throws `LiveCredentialError` and changes nothing.
 */
export function recordTerminal(stallPubkey: string, record: TerminalRecord): void {
  if (holdsLiveCredential(stallPubkey, record.terminalPubkey)) throw new LiveCredentialError()
  const key = record.terminalPubkey.toLowerCase()
  const rows = read(stallPubkey).filter((t) => t.terminalPubkey.toLowerCase() !== key)
  write(stallPubkey, [...rows, record])
}

/**
 * Change one row in place, keyed by device key. Used to move a row through
 * `minting` → `waiting` without the replace guard above, which exists to stop
 * a DIFFERENT credential overwriting it.
 *
 * @returns false when there is no such row
 */
export function updateTerminal(
  stallPubkey: string,
  terminalPubkey: string,
  change: (row: TerminalRecord) => TerminalRecord,
): boolean {
  const key = terminalPubkey.toLowerCase()
  const rows = read(stallPubkey)
  const index = rows.findIndex((t) => t.terminalPubkey.toLowerCase() === key)
  if (index < 0) return false
  rows[index] = change(rows[index])
  write(stallPubkey, rows)
  return true
}

/**
 * The device confirmed it holds its credential (#160 phase 2): the row is in service.
 *
 * Matched on BOTH the device key and the voucher id the enrolled DM names, so a stale
 * notice for an earlier credential of the same device does not promote a newer waiting row.
 * A revoked row stays revoked. Returns whether a row changed.
 */
export function markInService(stallPubkey: string, terminalPubkey: string, voucherId: string): boolean {
  const rows = read(stallPubkey)
  const row = rows.find(
    (t) =>
      t.terminalPubkey.toLowerCase() === terminalPubkey.toLowerCase() &&
      t.voucherId === voucherId &&
      t.revokedAt === undefined &&
      t.status === 'waiting',
  )
  if (!row) return false
  row.status = 'in-service'
  row.waitingUntil = undefined
  // The device says it has it; the gateway has not said so yet (#160 round 2).
  row.gatewayState = row.gatewayState ?? 'unconfirmed'
  write(stallPubkey, rows)
  return true
}

/**
 * Rows the owner's app must still confirm at the gateway (#160 round 2): in service by the
 * device's word, not yet confirmed or lapsed there, and due for another try.
 */
export function awaitingGatewayConfirm(stallPubkey: string, now: number = Date.now()): TerminalRecord[] {
  return liveTerminals(stallPubkey).filter(
    (t) =>
      t.status === 'in-service' &&
      t.voucherId !== undefined &&
      t.gatewayState === 'unconfirmed' &&
      (t.nextConfirmAt ?? 0) <= now,
  )
}

/** Whether any row is still waiting on the gateway's confirm, whenever it is due. */
export function hasUnconfirmed(stallPubkey: string): boolean {
  return liveTerminals(stallPubkey).some(
    (t) => t.status === 'in-service' && t.voucherId !== undefined && t.gatewayState === 'unconfirmed',
  )
}

/**
 * Remove a row that never became a terminal: a request the gateway refused, or
 * a credential that came back wrong and has been spent. Nothing ever traded
 * under it, so there is no history to keep.
 */
export function forgetTerminal(stallPubkey: string, terminalPubkey: string): void {
  const key = terminalPubkey.toLowerCase()
  // Remember it, so the roster sync does not bring back what this phone removed (#160 phase 6).
  const gone = read(stallPubkey).filter((t) => t.terminalPubkey.toLowerCase() === key)
  if (gone.length > 0) {
    const at = Math.max(...gone.map((t) => t.credentialAt ?? t.enrolledAt))
    const kept = forgottenRows(stallPubkey).filter((f) => f.terminalPubkey !== key)
    try {
      localStorage.setItem(FORGOTTEN_KEY(stallPubkey), JSON.stringify([...kept, { terminalPubkey: key, enrolledAt: at }]))
    } catch {
      // As `write`.
    }
  }
  write(
    stallPubkey,
    read(stallPubkey).filter((t) => t.terminalPubkey.toLowerCase() !== key),
  )
}

/** Note that a terminal handled something, for the "last used" column. */
export function noteTerminalUse(stallPubkey: string, terminalPubkey: string, at: number): void {
  const rows = read(stallPubkey)
  const row = rows.find((t) => t.terminalPubkey === terminalPubkey)
  if (!row) return
  row.lastUsedAt = at
  write(stallPubkey, rows)
}

export type RevokeOutcome =
  | { revoked: true; record: TerminalRecord }
  | { revoked: false; reason: 'unknown' | 'already-revoked' }

/**
 * Withdraw a terminal's authority.
 *
 * MARKS rather than deletes, which is the fifth acceptance criterion: the
 * stall's records keep pointing at a terminal that existed, and a movement from
 * six months ago can still be attributed to the till that handled it.
 *
 * Takes no argument about the device and makes no call to it. That is the point
 * — the owner holds the credential `token` from enrolment, so a device that is
 * lost, stolen, flat or destroyed is revoked exactly like one on the counter.
 *
 * This only MARKS the row. Since #160 a caller marks it only after the spend at
 * the mint landed (`revokeTerminalAtMint`).
 *
 * Idempotent in the direction that matters: revoking twice reports
 * `already-revoked` rather than moving the timestamp, so an owner who taps
 * twice does not extend the window they were told about.
 */
export function revokeTerminal(
  stallPubkey: string,
  terminalPubkey: string,
  at: number = Date.now(),
): RevokeOutcome {
  const rows = read(stallPubkey)
  const row = rows.find((t) => t.terminalPubkey === terminalPubkey)

  if (!row) return { revoked: false, reason: 'unknown' }
  if (row.revokedAt !== undefined) return { revoked: false, reason: 'already-revoked' }

  row.revokedAt = at
  write(stallPubkey, rows)
  return { revoked: true, record: row }
}

/**
 * Is this terminal still authorised by its stall, as the OWNER sees it?
 *
 * The owner's view, not the terminal's. A revoked terminal keeps working until
 * its session expires — up to `REVOCATION_DELAY_HOURS` — which is precisely why
 * the delay is stated on screen rather than implied by this returning false.
 */
export function isRevoked(stallPubkey: string, terminalPubkey: string): boolean {
  const row = read(stallPubkey).find((t) => t.terminalPubkey === terminalPubkey)
  return row?.revokedAt !== undefined
}

/**
 * When a revoked terminal is expected to stop trading.
 *
 * Derived so a screen can show a time rather than repeat the policy, and so the
 * number in the sentence and the number on the row cannot disagree.
 */
export function revocationBitesAt(record: TerminalRecord): number | null {
  return record.revokedAt === undefined
    ? null
    : record.revokedAt + REVOCATION_DELAY_HOURS * 3600 * 1000
}
