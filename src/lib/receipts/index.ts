/**
 * The app's receipts module (spec 049): the UI contract, and the service and verifier wired to
 * the real wallet (signer, IndexedDB store, mint, gateway nostrdb cache, relays, telemetry).
 *
 * Never logs secrets: at most `paymentId.slice(0, 8)`.
 */
import { nip17, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import {
  decodeEvidence,
  decodeSummary,
  localReceiptSigner,
  RAIL_CASHU,
  xOnly,
  type ReceiptSigner,
  type StoredReceipt,
} from '@imani/receipts'
import { getSigner } from '../nap'
import { publish, RELAY_URL } from '../relay'
import { gatewayQuery } from '../gatewayNostr'
import { mirrorToGateway } from '../transferSignature'
import { normaliseMintUrl, trustedMintUrls } from '../trustedMint'
import { hasStall, loadMerchant } from '../merchant'
import { getTransactionRow } from '../wallet'
import { toTransaction } from '../transactions'
import { openReceiptStore, type PendingReason, type ReceiptStore } from './store'
import { countReceiptEvent, flushReceiptTelemetry } from './telemetry'
import { fetchEvidenceBlob, publishEvidenceBlob, restoreBackups, saveBackup, type NostrIo } from './nostrPorts'
import * as service from './service'
import { verifyScannedWith, type SpentState, type VerifyPorts, type VerifyResult } from './verify'

export * from './verify'
export type { CheckedBy, PriorCheck } from './checks'
export { countReceiptEvent, flushReceiptTelemetry } from './telemetry'
export { ReceiptNotReadyError, parseAckEnvelope, type AckEnvelope, type CaptureInput, type IncomingPayment } from './service'
export type { PendingReason } from './store'

// ---------------------------------------------------------------- UI contract

export type ReceiptStatus = 'pending' | 'signed' | 'countersigned'

export interface ReceiptView {
  paymentId: string
  role: 'PAYER' | 'PAYEE'
  status: ReceiptStatus
  /** Set when `status` is 'pending'. */
  pendingReason?: PendingReason
  /** The signed amount, in `unit`. */
  amount: number
  unit: string
  /** Epoch seconds. */
  paidAt: number
  txId?: string
  /** The coupon's face value from the transaction row, display only, never signed. */
  face?: { value: number; unit: string; decimals: number }
}

const listeners = new Set<() => void>()
export function onReceiptsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function changed(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      // a listener never breaks the writer
    }
  }
}

// ---------------------------------------------------------------- wiring

let opened: { pubkey: string; store: Promise<ReceiptStore> } | undefined

function myPubkey(): string | null {
  try {
    return getSigner().pubkey
  } catch {
    return null
  }
}

function storeFor(pubkey: string): Promise<ReceiptStore> {
  if (opened?.pubkey !== pubkey) {
    const store = openReceiptStore(pubkey)
    store.catch(() => {
      if (opened?.store === store) opened = undefined
    })
    opened = { pubkey, store }
  }
  return opened.store
}

/** For tests and sign-out. */
export function resetReceipts(): void {
  void opened?.store.then((s) => s.close(), () => undefined)
  opened = undefined
}

const now = () => Math.floor(Date.now() / 1000)

const io: NostrIo = {
  publish: async (e: Event) => {
    const [relayed, mirrored] = await Promise.all([
      publish(e).then((r) => r.ok, () => 0),
      mirrorToGateway(e),
    ])
    return relayed + (mirrored ? 1 : 0)
  },
  query: gatewayQuery,
}

function signerOrNull(): ReceiptSigner | null {
  try {
    const s = getSigner()
    if (!s.hasKey()) return null
    return localReceiptSigner(xOnly(s.pubkey), (use) => s.withPrivkey(use))
  } catch {
    return null
  }
}

const MINT_TIMEOUT_MS = 15_000
const mintBase = (url: string) => url.trim().replace(/\/+$/, '')
const mintFetch = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(MINT_TIMEOUT_MS), credentials: 'omit', referrerPolicy: 'no-referrer' })

/** NUT-07 with witnesses. Throws when the mint is unreachable or answers out of shape. */
async function checkStateWithWitness(mintUrl: string, ys: string[]): Promise<SpentState[]> {
  const r = await mintFetch(`${mintBase(mintUrl)}/v1/checkstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys: ys }),
  })
  if (!r.ok) throw new Error(`checkstate HTTP ${r.status}`)
  const { states } = (await r.json()) as { states?: Array<{ Y?: string; state?: string; witness?: string | null }> }
  if (!Array.isArray(states) || states.length !== ys.length) throw new Error('checkstate out of shape')
  return states.map((s) => {
    if (s.state !== 'UNSPENT' && s.state !== 'SPENT' && s.state !== 'PENDING') throw new Error('checkstate state unknown')
    return { state: s.state, witness: typeof s.witness === 'string' ? s.witness : null }
  })
}

const mintAllowed = (mintUrl: string): boolean => {
  try {
    const m = normaliseMintUrl(mintUrl)
    return trustedMintUrls().some((t) => normaliseMintUrl(t) === m)
  } catch {
    return false
  }
}

const ACK_SETTING_KEY = (pubkey: string) => `imani-receipts-ack:${pubkey}`

/** The owner's answer to "acknowledge payments?" (FR-017), or null when never asked. */
export function receiptAcknowledgementSetting(): boolean | null {
  const me = myPubkey()
  if (!me) return null
  try {
    const v = localStorage.getItem(ACK_SETTING_KEY(me))
    return v === 'yes' ? true : v === 'no' ? false : null
  } catch {
    return null
  }
}

/** Records the owner's answer; a yes acknowledges what was waiting for it. */
export async function setReceiptAcknowledgement(allow: boolean): Promise<void> {
  const me = myPubkey()
  if (!me) return
  try {
    localStorage.setItem(ACK_SETTING_KEY(me), allow ? 'yes' : 'no')
  } catch {
    // private mode: asked again next time
  }
  if (allow) {
    const ports = await portsOrNull()
    if (ports) await service.acknowledgeWaiting(ports).catch(() => 0)
  }
  // The prompt and the settings switch both listen: either answer hides the prompt.
  changed()
}

/**
 * Whether acknowledgements are on now, and whether that is the owner's answer or the default
 * (FR-017): on for a merchant wallet, off until asked for a personal one.
 */
export function receiptAcknowledgementState(): { on: boolean; answered: boolean } {
  const setting = receiptAcknowledgementSetting()
  if (setting !== null) return { on: setting, answered: true }
  const me = myPubkey()
  return { on: me !== null && hasStall(loadMerchant(me)), answered: false }
}

/** Received payments waiting on the owner's answer; 0 once answered or when locked. */
export function receiptsAwaitingAnswer(): Promise<number> {
  if (receiptAcknowledgementSetting() !== null) return Promise.resolve(0)
  return withPorts(0, (p) => service.awaitingOwnerAnswer(p.store))
}

async function sendAck(recipient: string, envelope: service.AckEnvelope): Promise<void> {
  const signer = getSigner()
  const wrap = signer.withPrivkey((key) => nip17.wrapEvent(key, { publicKey: recipient }, JSON.stringify(envelope)))
  if ((await io.publish(wrap)) <= 0) throw new Error('acknowledgement not delivered')
}

async function portsOrNull(): Promise<service.ReceiptPorts | null> {
  const me = myPubkey()
  if (!me) return null
  const store = await storeFor(me)
  return {
    store,
    publicKey: xOnly(me),
    signer: signerOrNull,
    // Every signer in this build is a local key (nap's createWalletSigner).
    mayAcknowledgeUnattended: () => true,
    checkState: async (mintUrl, ys) => {
      if (!mintAllowed(mintUrl)) throw new Error('mint not trusted')
      return (await checkStateWithWitness(mintUrl, ys)).map((s) => s.state)
    },
    publishEvidence: (blob) => publishEvidenceBlob(io, blob, RELAY_URL.length <= 64 ? RELAY_URL : null, now()),
    fetchEvidence: async (loc) => fetchEvidenceBlob(io, loc.eventId),
    backup: (r) => saveBackup(io, (use) => getSigner().withPrivkey(use), r, now()),
    sendAck,
    count: countReceiptEvent,
    walletKind: () => (hasStall(loadMerchant(me)) ? 'MERCHANT' : 'PERSONAL'),
    acknowledgementSetting: receiptAcknowledgementSetting,
    now,
    changed,
  }
}

async function withPorts<T>(fallback: T, use: (p: service.ReceiptPorts) => Promise<T>): Promise<T> {
  try {
    const ports = await portsOrNull()
    return ports ? await use(ports) : fallback
  } catch (error) {
    console.warn('[receipts]', (error as Error)?.name ?? 'error')
    return fallback
  }
}

// ---------------------------------------------------------------- views

async function faceOf(txId: string | undefined): Promise<ReceiptView['face']> {
  if (!txId) return undefined
  try {
    const row = await getTransactionRow(txId)
    if (!row) return undefined
    const tx = toTransaction(row)
    if (!tx.unit || tx.unit === 'sat' || tx.unit === 'UNKNOWN') return undefined
    return { value: tx.amount, unit: tx.unit, decimals: tx.decimals }
  } catch {
    return undefined
  }
}

function viewOfStored(r: StoredReceipt, txId: string | undefined): Omit<ReceiptView, 'face'> {
  const s = decodeSummary(r.receipt.summaryBytes)
  const status: ReceiptStatus = r.receipt.countersignature ? 'countersigned' : r.showable ? 'signed' : 'pending'
  return {
    paymentId: s.paymentId,
    role: r.role,
    status,
    ...(status === 'pending' ? { pendingReason: 'other' as const } : {}),
    amount: s.amount,
    unit: s.unit,
    paidAt: s.paidAt,
    ...(txId ? { txId } : {}),
  }
}

async function allViews(store: ReceiptStore): Promise<ReceiptView[]> {
  const out: ReceiptView[] = []
  const seen = new Set<string>()
  for (const { row, receipt } of await store.all()) {
    try {
      out.push({ ...viewOfStored(receipt, row.txId), face: await faceOf(row.txId) })
      seen.add(row.paymentId)
    } catch {
      // an unreadable row is skipped, never shown wrong
    }
  }
  for (const p of await store.allPending()) {
    if (seen.has(p.paymentId) || p.state !== 'PENDING_SETTLEMENT') continue
    try {
      const ev = decodeEvidence(hexToBytes(p.evidenceHex))
      const amount = ev.rail === RAIL_CASHU ? ev.proofs.reduce((n, x) => n + x.amount, 0) : 0
      out.push({
        paymentId: p.paymentId,
        role: 'PAYER',
        status: 'pending',
        pendingReason: p.reason ?? 'other',
        amount,
        unit: p.unit,
        paidAt: p.paidAt,
        ...(p.txId ? { txId: p.txId } : {}),
        face: await faceOf(p.txId),
      })
    } catch {
      // skipped
    }
  }
  return out.sort((a, b) => b.paidAt - a.paidAt)
}

/** Every receipt and pending receipt of this wallet, newest first. */
export function listReceipts(): Promise<ReceiptView[]> {
  return withPorts([], (p) => allViews(p.store))
}

/** The receipt of one transaction row, or null when it has none. */
export function receiptForTransaction(txId: string): Promise<ReceiptView | null> {
  return withPorts(null, async (p) => (await allViews(p.store)).find((v) => v.txId === txId) ?? null)
}

/** The QR for a receipt. Throws `ReceiptNotReadyError` with a user-facing message. */
export async function presentReceipt(paymentId: string) {
  const ports = await portsOrNull()
  if (!ports) throw new service.ReceiptNotReadyError('the wallet is locked')
  return service.presentReceipt(ports, paymentId)
}

// ---------------------------------------------------------------- lifecycle hooks

/** Call where `reconcilePendingSends` runs. Never throws. */
export function settlePendingReceipts(): Promise<service.SettleResult> {
  return withPorts({ built: 0, waiting: 0 }, (p) => service.settlePending(p))
}

/** Payer: a COMPLETED send. Durable before it returns; never throws, never blocks a payment for long. */
export function captureSendEvidence(input: service.CaptureInput): Promise<service.CaptureOutcome> {
  return withPorts<service.CaptureOutcome>('skipped', (p) => service.captureSendEvidence(p, input))
}

/** Payee: a token this wallet just redeemed. Never throws. */
export function noteClaimedPayment(inc: service.IncomingPayment): Promise<service.ClaimOutcome | 'skipped'> {
  return withPorts<service.ClaimOutcome | 'skipped'>('skipped', async (p) => {
    const outcome = await service.onClaimed(p, inc)
    console.info('[receipts] claim', outcome, inc.payerKey ? inc.payerKey.slice(0, 8) : 'no-payer')
    return outcome
  })
}

/** A decrypted DM: true when it was a receipt acknowledgement (handled or refused). */
export async function handleReceiptDm(author: string, content: string): Promise<boolean> {
  if (!content.includes('imani-receipt/ack')) return false
  const env = service.parseAckEnvelope(content)
  if (!env) {
    console.warn('[receipts] ack DM unreadable')
    return false
  }
  const outcome = await withPorts<service.AckOutcome | 'skipped'>('skipped', (p) => service.onAcknowledgement(p, author, env, 'message'))
  console.info('[receipts] ack', outcome)
  return true
}

/** Restore from the kind 30740 backup. Never throws. */
export function restoreReceiptBackup(): Promise<{ added: number; merged: number }> {
  return withPorts({ added: 0, merged: 0 }, async (p) => {
    const { restored, unreadable } = await restoreBackups(io, (use) => getSigner().withPrivkey(use), p.publicKey)
    return service.restoreReceipts(p, restored, unreadable)
  })
}

/** Flush receipt telemetry (on hide / sign-out). */
export const flushReceipts = flushReceiptTelemetry

let lifecycleInstalled = false
/** Flushes telemetry whenever the page is hidden. Idempotent. */
export function installReceiptLifecycle(): void {
  if (lifecycleInstalled || typeof document === 'undefined') return
  lifecycleInstalled = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushReceiptTelemetry().catch(() => undefined)
  })
}

// ---------------------------------------------------------------- verifier

async function keysetOf(mintUrl: string, keysetId: string): Promise<{ unit: string; keys: Record<string, string> } | null> {
  const base = mintBase(mintUrl)
  const list = await mintFetch(`${base}/v1/keysets`)
  if (!list.ok) throw new Error(`keysets HTTP ${list.status}`)
  const { keysets } = (await list.json()) as { keysets?: Array<{ id: string; unit: string }> }
  const meta = keysets?.find((k) => k.id === keysetId)
  if (!meta) return null
  const r = await mintFetch(`${base}/v1/keys/${encodeURIComponent(keysetId)}`)
  if (r.status === 404 || r.status === 400) return null
  if (!r.ok) throw new Error(`keys HTTP ${r.status}`)
  const body = (await r.json()) as { keysets?: Array<{ id: string; keys: Record<string, string> }> }
  const k = body.keysets?.find((x) => x.id === keysetId)
  return k?.keys ? { unit: meta.unit, keys: k.keys } : null
}

function verifyPorts(forStall?: string): VerifyPorts {
  return {
    // A terminal checks for the stall it acts for, not its own device key.
    publicKey: forStall ? () => forStall : myPubkey,
    keyset: keysetOf,
    checkState: checkStateWithWitness,
    fetchEvidence: (eventId) => fetchEvidenceBlob(io, eventId),
    ownRecord: async (paymentId) => {
      // The payment records are the owner's (its receipt store, keyed by its own key). A terminal
      // holds none: it relies on the mint, which saw the payment collected with the stall's key.
      if (forStall) return 'no_records'
      const ports = await portsOrNull()
      const found = ports ? await ports.store.get(paymentId) : null
      if (!found || found.receipt.role !== 'PAYEE') return null
      const [face, memo] = await Promise.all([faceOf(found.row.txId), memoOf(found.row.txId)])
      return { ...(face ? { face } : {}), ...(memo ? { memo } : {}) }
    },
    remember: (payee, paymentId, paidAt) => rememberHere(payee, paymentId, paidAt, forStall),
    mintAllowed,
    count: countReceiptEvent,
    now,
  }
}

/** FR-027f: the memo on the payee's own transaction row. Display only. */
async function memoOf(txId: string | undefined): Promise<string | undefined> {
  if (!txId) return undefined
  try {
    const row = await getTransactionRow(txId)
    const memo = row ? toTransaction(row).memo?.trim() : undefined
    return memo || undefined
  } catch {
    return undefined
  }
}

async function checkDevice(forStall?: string): Promise<import('./checkMemory').CheckDevice | null> {
  let signer: ReturnType<typeof getSigner>
  try {
    signer = getSigner()
    if (typeof signer.hasKey === 'function' && !signer.hasKey()) return null
  } catch {
    // A locked till holds no key: nothing can be signed, and the check is reported unknown.
    return null
  }
  let terminal: import('./checks').TerminalProof | undefined
  let publishCheck: (e: Event) => Promise<boolean>
  let roster: import('./checks').RosterView & { nameOf: (k: string) => string } | undefined
  if (forStall) {
    const [{ tillCheckProof }, { devicePublisher }] = await Promise.all([import('../terminalUnlock'), import('../terminalDeliveryNet')])
    terminal = tillCheckProof() ?? undefined
    const publisher = devicePublisher(signer)
    publishCheck = (e) => publisher.publish(e).catch(() => false)
  } else {
    const [{ allTerminals }, { describeHandler }] = await Promise.all([import('../terminalRoster'), import('../terminalAttribution')])
    const terminals = allTerminals(signer.pubkey)
    roster = {
      // Revocation times in seconds: a revoked till's checks count only from before it was revoked.
      keys: new Map(terminals.map((t) => [t.terminalPubkey.toLowerCase(), t.revokedAt === undefined ? undefined : Math.floor(t.revokedAt / 1000)])),
      // The same words as the owner's transaction history: a name, a retired name, or unlisted.
      nameOf: (k: string) => describeHandler({ terminalPubkey: k.toLowerCase() }, terminals).label,
    }
    publishCheck = (e) => io.publish(e).then((n) => n > 0, () => false)
  }
  return {
    device: signer.pubkey,
    withKey: (use) => signer.withPrivkey(use),
    ...(terminal ? { terminal } : {}),
    ...(roster ? { roster } : {}),
    publish: publishCheck,
    query: gatewayQuery,
    store: localStorage,
    now,
  }
}

/**
 * FR-027a-e on this device: the owner's wallet signs as the stall and names its tills from the
 * roster; a till signs with its own key and carries its attestation. Reads through the gateway
 * cache, writes to the relay and the gateway.
 */
async function rememberHere(payee: string, paymentId: string, paidAt: number, forStall?: string) {
  const device = await checkDevice(forStall)
  if (!device) return { prior: [], known: false, record: null }
  const { rememberCheck } = await import('./checkMemory')
  return rememberCheck(device, payee, paymentId, paidAt)
}

/**
 * FR-027c: send this device's unsent receipt checks. Called when the app opens or a till unlocks,
 * and installed on `online` by `installReceiptCheckFlush`. Never throws.
 */
export async function flushReceiptChecks(forStall?: string): Promise<number> {
  try {
    const device = await checkDevice(forStall)
    if (!device) return 0
    const { flushCheckOutbox } = await import('./checkMemory')
    return await flushCheckOutbox(device)
  } catch {
    return 0
  }
}

/** Flush now and whenever the device comes back online. Returns the uninstaller. */
export function installReceiptCheckFlush(forStall?: string): () => void {
  if (typeof window === 'undefined') return () => undefined
  const flush = () => void flushReceiptChecks(forStall)
  flush()
  window.addEventListener('online', flush)
  return () => window.removeEventListener('online', flush)
}

let ownerFlushInstalled = false
/** The owner's wallet: flush now, and install the `online` listener once per page. */
export function installReceiptCheckFlushOnce(): void {
  if (ownerFlushInstalled) {
    void flushReceiptChecks()
    return
  }
  ownerFlushInstalled = true
  installReceiptCheckFlush()
}

/**
 * Verify a scanned `imrc1:` receipt with the app's ports. Never throws.
 *
 * `forStall`: a terminal passes the stall it acts for (it holds `receipt:read` for it), so "Paid to
 * you" means paid to that stall, confirmed by the mint. The owner's app passes nothing.
 */
export function verifyScanned(qrText: string, forStall?: string): Promise<VerifyResult> {
  return verifyScannedWith(verifyPorts(forStall), qrText)
}
