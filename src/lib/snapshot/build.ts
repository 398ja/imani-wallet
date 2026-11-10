import { strToU8, zipSync, type Zippable } from 'fflate'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { nip19 } from 'nostr-tools'
import type { TransactionRow, VoucherRow } from '@imani/wallet-storage'

import { Pseudonyms, saltedHash, type PseudonymType } from './ids'
import { reportableKeyName, ruleFor, type ReduceContext } from './inventory'
import { findPattern, PII_SCRUBBER_VERSION, scrub } from './scrub'
import type { BuildOptions, BuiltSnapshot, EnvironmentFacts, ErrorEntry, Manifest, SnapshotSources } from './types'

/** Owner decision: 20 MB of ciphertext. AES-GCM adds 16 bytes, so the zip cap leaves room for the tag. */
export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024
const GCM_TAG = 16

/**
 * Generation stopped because the final scan of `data/` found something that might identify a
 * person (#589 2b rule 6). Names the file and the kind of match, never the value, so the message
 * itself can be reported to support without leaking what it found.
 */
export class SnapshotLeakError extends Error {
  constructor(readonly file: string, readonly kind: string) {
    super(`The snapshot was not created: a check found possible personal data (${kind}) in ${file}. Nothing was shared. Please tell support this message.`)
    this.name = 'SnapshotLeakError'
  }
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/i

/** A pubkey in hex, from hex or npub, or null when the value is not a pubkey. */
function pubkeyOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (HEX64.test(v)) return v.toLowerCase()
  if (v.startsWith('npub1')) {
    try {
      const d = nip19.decode(v)
      if (d.type === 'npub') return d.data as string
    } catch {
      return null
    }
  }
  return null
}

/** Reduce a user agent to family, major version and OS family (2b rule 5). */
export function coarseBrowser(ua: string): string {
  const fam =
    /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}` :
    /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}` :
    /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` :
    /Version\/(\d+).*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}` : 'Other'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other'
  return `${fam} / ${os}`
}

/** Infrastructure URLs are kept, but only scheme, host, port and path. */
function infraUrl(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    const p = new URL(u)
    if (!/^(https?|wss?):$/.test(p.protocol)) return null
    return `${p.protocol}//${p.host}${p.pathname === '/' ? '' : p.pathname}`
  } catch {
    return null
  }
}

function environment(env: EnvironmentFacts) {
  return {
    app_version: env.appVersion,
    build_ref: env.buildRef,
    gateway_url: infraUrl(env.gatewayUrl),
    mint_urls: env.mintUrls.map(infraUrl).filter(Boolean),
    relay_urls: env.relayUrls.map(infraUrl).filter(Boolean),
    blossom_url: infraUrl(env.blossomUrl),
    browser: coarseBrowser(env.userAgent),
    standalone: env.standalone,
    language: (env.language || '').split(/[-_]/)[0].toLowerCase().slice(0, 3),
    storage_usage_mb: env.storageUsage === undefined ? null : Math.round(env.storageUsage / 1048576),
    storage_quota_gb: env.storageQuota === undefined ? null : Math.round(env.storageQuota / 1073741824),
  }
}

/** Two passes over the same reducers: collect real ids, then name them. */
function context(ps: Pseudonyms, salt: Uint8Array, known: Set<string>, mode: 'collect' | 'name', opts: { memos: boolean; stall: boolean }): ReduceContext {
  return {
    stall: opts.stall,
    id(type, real) {
      if (real === undefined || real === null || real === '') return undefined
      let r = String(real)
      const pk = pubkeyOf(r)
      if (pk) r = pk
      if (mode === 'collect') {
        ps.see(type, r)
        known.add(String(real))
        if (pk) known.add(nip19.npubEncode(pk))
        return undefined
      }
      return ps.name(type, r)
    },
    hash(real) {
      if (real === undefined || real === null || real === '') return undefined
      if (mode === 'collect') {
        known.add(String(real))
        return undefined
      }
      return 'h:' + saltedHash(salt, String(real))
    },
    memo(text) {
      if (!opts.memos || typeof text !== 'string' || text === '') return undefined
      return mode === 'collect' ? undefined : scrub(text, known).slice(0, 280)
    },
  }
}

function stallSet(sources: SnapshotSources): Set<string> {
  const s = new Set<string>()
  for (const v of sources.vouchers) {
    const pk = pubkeyOf(v.issuer_id)
    if (pk && pk !== sources.selfPubkey) s.add(pk)
  }
  for (const [k, raw] of sources.storage) {
    if (!k.startsWith('imani-wallet:pending-sends:')) continue
    try {
      for (const r of JSON.parse(raw) as Rec[]) {
        const pk = pubkeyOf(r.merchantPubkey)
        if (pk) s.add(pk)
      }
    } catch {
      /* unparseable: the reducer will see it as nothing */
    }
  }
  return s
}

function counterpartyType(v: unknown, stalls: Set<string>, self: string): PseudonymType {
  const pk = pubkeyOf(v)
  if (pk === self) return 'party'
  if (pk) return stalls.has(pk) ? 'stall' : 'customer'
  if (typeof v === 'string' && /^gift/i.test(v)) return 'gift_link'
  return 'party'
}

const timeStr = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z?$/.test(v) ? v : undefined)
const numOr = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const enumStr = (v: unknown) => (typeof v === 'string' && /^[a-z0-9_\-:.]{1,40}$/i.test(v) ? v : undefined)

function voucherRow(v: VoucherRow, ctx: ReduceContext, shape: SnapshotSources['proofShapes']) {
  const r = v as unknown as Rec
  const s = shape?.[v.token_id]
  return {
    token: ctx.hash(v.token_id),
    voucher: ctx.id('voucher', v.voucher_id),
    template: ctx.id('template', v.merchant_template_id),
    bundle: ctx.id('bundle', v.bundle_id),
    purchase: ctx.id('purchase', r.purchase_id),
    issuer: ctx.id('stall', v.issuer_id),
    amount: v.amount,
    token_amount: numOr(v.token_amount),
    proof_sum: s ? s.amounts.reduce((a, b) => a + b, 0) : numOr(r.proof_sum),
    face_value: numOr(v.face_value),
    face_unit: enumStr(v.face_unit),
    face_decimals: numOr(v.face_decimals),
    backing_strategy: enumStr(v.backing_strategy),
    status: enumStr(v.status),
    source_transport: enumStr(r.source_transport),
    expires_at: numOr(v.expires_at) ?? timeStr(v.expires_at),
    created_at: timeStr(v.created_at),
    updated_at: timeStr(v.updated_at),
    swap_completed_at: timeStr(v.swap_completed_at),
    materialized_at: timeStr(r.materialized_at),
    received_via: ctx.id('event', v.received_via_event_id),
    keyset_ids: s?.keysets ?? (Array.isArray(r.keyset_ids) ? (r.keyset_ids as unknown[]).filter((k) => typeof k === 'string' && /^[0-9a-f]{2,20}$/i.test(k)) : undefined),
    swap_proofs: v.swap_proof_ids?.map((p) => ctx.hash(p)),
    proof_count: s?.amounts.length,
    proof_amounts: s?.amounts,
    has_dleq: s?.hasDleq,
  }
}

function transactionRow(t: TransactionRow, ctx: ReduceContext, stalls: Set<string>, self: string) {
  const r = t as unknown as Rec
  return {
    tx: ctx.id('tx', t.id),
    type: enumStr(t.type),
    direction: t.direction,
    timestamp: t.timestamp,
    amount: numOr(t.amount),
    face_value: numOr(t.face_value),
    face_unit: enumStr(t.face_unit),
    delivery_state: t.delivery_state,
    delivered_at: numOr(t.delivered_at),
    bundle_most_recent_part_at: timeStr(t.bundle_most_recent_part_at),
    voucher: ctx.id('voucher', t.voucher_id),
    bundle: ctx.id('bundle', t.bundle_id),
    send: ctx.id('send', r.send_id),
    request: ctx.id('request', r.payment_request_id),
    payment: ctx.id('payment', r.payment_intent_id ?? r.stripe_payment_intent),
    counterparty: ctx.id(counterpartyType(t.counterparty, stalls, self), t.counterparty),
    bundle_parts: t.bundle_parts?.map((p) => ({
      voucher: ctx.id('voucher', p.voucherId),
      amount: p.amount,
      timestamp: p.timestamp,
      redemption_status: enumStr(p.redemptionStatus),
    })),
    memo: ctx.memo(t.memo),
  }
}

function errorRow(e: ErrorEntry, known: Set<string>) {
  return {
    at: e.at,
    name: enumStr(e.name) ?? 'Error',
    code: enumStr(e.code),
    template: scrub(String(e.template), known).slice(0, 300),
    frames: e.frames.filter((f) => /^[\w./-]{1,80}:\d{1,6}(:\d{1,6})?$/.test(f)).slice(0, 12),
  }
}

/** Strip `undefined` fields so the JSON is stable and small. */
function json(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x === undefined ? undefined : x), 1)
}

function dayOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

/** Seconds, from a transaction timestamp that may be seconds or ms (spec-020 rows use ms). */
const secs = (t: number) => (t > 1e12 ? Math.floor(t / 1000) : t)

interface Assembled {
  data: Record<string, string>
  correlation: Record<string, string>
  unknownKeys: Array<{ key: string; bytes: number }>
  counts: Manifest['counts']
  summary: BuiltSnapshot['summary']
  known: Set<string>
  rowsOmitted: number
}

function assemble(sources: SnapshotSources, opts: BuildOptions, kCorr: Uint8Array, salt: Uint8Array, sinceSeconds: number | null): Assembled {
  const self = sources.selfPubkey.toLowerCase()
  const ps = new Pseudonyms(kCorr, self)
  const known = new Set<string>([self, nip19.npubEncode(self)])
  const stalls = stallSet(sources)
  const flags = { memos: opts.includeMemos, stall: sources.stall }

  const keep = (ts: number | undefined) => sinceSeconds === null || ts === undefined || secs(ts) >= sinceSeconds
  const txAll = [...sources.transactions].sort((a, b) => b.timestamp - a.timestamp)
  const tx = txAll.filter((t) => keep(t.timestamp))
  let rowsOmitted = txAll.length - tx.length

  // Storage: which keys, by rule, before ids are collected.
  const unknownKeys: Array<{ key: string; bytes: number }> = []
  const kept: Array<{ name: string; value: unknown; rule: NonNullable<ReturnType<typeof ruleFor>> }> = []
  for (const [key, raw] of [...sources.storage].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rule = ruleFor(key)
    if (!rule) {
      unknownKeys.push({ key: scrub(reportableKeyName(key), known), bytes: new TextEncoder().encode(raw).length })
      continue
    }
    if (rule.action === 'exclude' || (rule.stallOnly && !sources.stall)) continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      value = raw
    }
    if (rule.ledger && sinceSeconds !== null && Array.isArray(value)) {
      const before = value.length
      value = value.filter((r) => {
        const t = isRec(r) ? (r.at ?? r.createdAt ?? r.timestamp) : undefined
        return typeof t !== 'number' || keep(t)
      })
      rowsOmitted += before - (value as unknown[]).length
    }
    kept.push({ name: reportableKeyName(key), value, rule })
  }

  // Pass 1: collect every real id. Pass 2: name them.
  const collect = context(ps, salt, known, 'collect', flags)
  sources.vouchers.forEach((v) => voucherRow(v, collect, sources.proofShapes))
  tx.forEach((t) => transactionRow(t, collect, stalls, self))
  kept.forEach(({ value, rule }) => rule.reduce!(value, collect))
  // Names people gave things, so the memo scrubber and final scan can recognise them.
  for (const [k, raw] of sources.storage) {
    if (!/profile:|pending-sends:|merchant/.test(k)) continue
    for (const m of raw.matchAll(/"(?:name|display_name|merchantName|recipientName|nip05)"\s*:\s*"([^"]{4,})"/g)) known.add(m[1])
  }
  ps.freeze()
  const name = context(ps, salt, known, 'name', flags)

  const vouchers = sources.vouchers.map((v) => voucherRow(v, name, sources.proofShapes))
  const transactions = tx.map((t) => transactionRow(t, name, stalls, self))
  const storage: Rec = {}
  const reduced: Record<string, unknown> = {}
  for (const { name: n, value, rule } of kept) {
    let label = n
    for (let i = 2; label in storage; i++) label = `${n}#${i}`
    storage[label] = rule.reduce!(value, name)
    reduced[rule.prefix] = storage[label]
  }
  const errors = sources.errors.map((e) => errorRow(e, known))

  // derived.json: the balance check and money in flight (#589 section 4).
  const balances: Record<string, { count: number; amount: number }> = {}
  for (const v of vouchers) {
    const k = `${v.status ?? 'unknown'}:${v.face_unit ?? 'sat'}`
    balances[k] = { count: (balances[k]?.count ?? 0) + 1, amount: (balances[k]?.amount ?? 0) + (v.amount ?? 0) }
  }
  const mismatches = vouchers.filter((v) => v.proof_sum !== undefined && v.token_amount !== undefined && v.proof_sum !== v.token_amount).map((v) => v.token)
  const pending = (reduced['imani-wallet:pending-sends:'] as unknown[] | undefined) ?? []
  const pendingAmount = pending.reduce<number>((a, r) => a + (isRec(r) && typeof r.amount === 'number' ? r.amount : 0), 0)
  const derived: Rec = {
    balances,
    proof_sum_mismatches: mismatches,
    money_in_flight: {
      pending_sends: { count: pending.length, amount: pendingAmount },
      cashback: reduced['imani:cashback:pending'] ?? null,
      cashback_stash: reduced['imani:cashback-stash'] ?? null,
      cashlink_claims: reduced['imani-wallet:cashlink-claims:'] ?? null,
      cashlink_moving: reduced['imani-wallet:cashlink-moving:'] ?? null,
      checkout_codes: reduced['imani-wallet:checkout-codes:'] ?? null,
    },
  }
  if (sources.stall) {
    const takings: Record<string, { count: number; amount: number }> = {}
    for (const t of transactions) {
      if (t.direction !== 'in') continue
      const k = `${dayOf(secs(t.timestamp))}:${t.face_unit ?? 'sat'}`
      takings[k] = { count: (takings[k]?.count ?? 0) + 1, amount: (takings[k]?.amount ?? 0) + (t.amount ?? 0) }
    }
    derived.stall = {
      terminals: (reduced['imani-wallet:terminals:'] as unknown[] | undefined) ?? [],
      takings,
      payment_requests: reduced['imani-wallet:payment-requests:'] ?? [],
    }
  }

  const data = {
    'data/environment.json': json(environment(sources.environment)),
    'data/vouchers.json': json({ rows: vouchers }),
    'data/transactions.json': json({ rows: transactions }),
    'data/storage.json': json({ keys: storage, unknown_key_count: unknownKeys.length, idb_stores: sources.idbStores.filter((s) => /^[a-z_]{1,40}$/.test(s)) }),
    'data/derived.json': json(derived),
    'data/errors.json': json({ rows: errors }),
  }
  return {
    data,
    correlation: ps.correlationMap(),
    unknownKeys,
    counts: { vouchers: vouchers.length, transactions: transactions.length, storage_keys: sources.storage.length },
    summary: {
      vouchers: vouchers.length,
      transactions: transactions.length,
      pendingSends: pending.length,
      errors: errors.length,
      terminals: sources.stall ? ((reduced['imani-wallet:terminals:'] as unknown[] | undefined)?.length ?? 0) : null,
      truncatedSince: sinceSeconds === null ? null : dayOf(sinceSeconds),
    },
    known: new Set([...known, ...ps.realIds]),
    rowsOmitted,
  }
}

/** Every string value in a JSON document, object keys included. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
  else if (isRec(v)) for (const [k, x] of Object.entries(v)) {
    out.push(k)
    strings(x, out)
  }
  return out
}

/**
 * The fail-closed gate (2b rule 6). Over every byte of every `data/` file: no real identifier (in
 * hex, lower case or npub form); over every string value: no PII or secret pattern. Any hit throws.
 */
export function finalScan(files: Record<string, string>, known: Iterable<string>): void {
  const ids: string[] = []
  for (const k of known) {
    if (k.length < 6) continue
    ids.push(k, k.toLowerCase())
    if (HEX64.test(k)) ids.push(nip19.npubEncode(k.toLowerCase()))
  }
  for (const [file, text] of Object.entries(files)) {
    if (!file.startsWith('data/')) continue
    if (ids.some((id) => text.includes(id))) throw new SnapshotLeakError(file, 'identifier')
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      throw new SnapshotLeakError(file, 'unparseable')
    }
    for (const s of strings(doc)) {
      const kind = findPattern(s)
      if (kind) throw new SnapshotLeakError(file, kind)
    }
  }
}

const README = `Imani support snapshot.

envelope/ is for support's validation code only: manifest, signature, correlation map.
data/ is pseudonymised: every identifier is a placeholder such as self, stall#1, send#14.
It holds no keys, no vouchers themselves, no gift links, no coupon codes, no email and no messages.
Schema: https://github.com/398ja/imani-wallet/blob/main/docs/support-snapshot.md
`

async function zipAll(files: Record<string, string>, mtime: Date): Promise<Uint8Array> {
  const z: Zippable = {}
  for (const path of Object.keys(files).sort()) z[path] = [strToU8(files[path]), { mtime, level: 6 }]
  return zipSync(z)
}

/**
 * Build, redact, pseudonymise, scan and sign a snapshot. Nothing leaves the device here: the caller
 * encrypts the result (crypto.ts) and uploads it only after the user confirms (service.ts).
 */
export async function buildSnapshot(sources: SnapshotSources, opts: BuildOptions): Promise<BuiltSnapshot> {
  const now = opts.now ?? Date.now()
  const kCorr = opts.kCorr ?? randomBytes(32)
  const salt = opts.salt ?? randomBytes(16)
  const cap = (opts.maxBytes ?? MAX_SNAPSHOT_BYTES) - GCM_TAG
  const created = new Date(Math.floor(now / 1000) * 1000)

  const attempt = async (since: number | null) => {
    const a = assemble(sources, opts, kCorr, salt, since)
    opts.afterData?.(a.data)
    finalScan(a.data, a.known)
    const createdAt = created.toISOString().replace(/\.\d{3}Z$/, 'Z')
    const others: Record<string, string> = {
      ...a.data,
      'envelope/correlation.json': json({ v: 1, entries: a.correlation }),
      'README.txt': README,
    }
    const files: Record<string, string> = {}
    for (const [p, body] of Object.entries(others)) files[p] = bytesToHex(sha256(strToU8(body)))
    const manifest: Manifest = {
      format: 'imani-support-snapshot',
      schema_version: 1,
      app_version: sources.environment.appVersion,
      build_ref: sources.environment.buildRef,
      created_at: createdAt,
      expires_at: Math.floor(now / 1000) + opts.ttlSeconds,
      wallet_pubkey: opts.signer.pubkey,
      ticket_id: opts.ticket,
      code_ref: opts.codeRef,
      support_pubkey: opts.supportPubkey,
      stall: sources.stall,
      counts: a.counts,
      files,
      truncated: since === null ? null : { since: dayOf(since), rows_omitted: a.rowsOmitted },
      redaction: {
        ruleset_version: 1,
        memos_included: opts.includeMemos,
        unknown_keys: a.unknownKeys,
        pseudonymised: true,
        pii_scrubber_version: PII_SCRUBBER_VERSION,
        final_scan: 'passed',
      },
    }
    const manifestText = json(manifest)
    const sig = await opts.signer.signEvent({
      kind: 30078,
      created_at: Math.floor(now / 1000),
      content: bytesToHex(sha256(strToU8(manifestText))),
      tags: [
        ['d', 'imani-support-snapshot'],
        ['ticket', opts.ticket],
        ['code', opts.codeRef],
        ['support', opts.supportPubkey],
        ['expiration', String(manifest.expires_at)],
      ],
    })
    const zip = await zipAll({ ...others, 'envelope/manifest.json': manifestText, 'envelope/manifest.sig.json': JSON.stringify(sig) }, created)
    return { zip, manifest, summary: a.summary }
  }

  let result = await attempt(null)
  if (result.zip.length > cap) {
    // Keep every non-ledger section whole; keep the most recent whole days of ledger that fit.
    const days = [...new Set(sources.transactions.map((t) => dayOf(secs(t.timestamp))))].sort().reverse()
    let lo = 1
    let hi = days.length - 1
    let best: typeof result | null = null
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const since = Date.parse(days[mid - 1] + 'T00:00:00Z') / 1000
      const r = await attempt(since)
      if (r.zip.length <= cap) {
        best = r
        lo = mid + 1
      } else hi = mid - 1
    }
    if (!best) {
      best = await attempt(Date.parse(days[0] + 'T00:00:00Z') / 1000 + 86400)
      if (best.zip.length > cap) throw new Error('The snapshot is too large to share even without history.')
    }
    result = best
  }
  return { ...result, kCorr }
}
