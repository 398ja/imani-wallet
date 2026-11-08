/**
 * Voucher ledger v2: encrypted, pseudonymous voucher status events
 * (imani-gateway-customer#310, cashu-voucher `docs/explanation/voucher-ledger-v2.md`).
 *
 * A byte-level port of cashu-voucher's `VoucherLedgerRef` + `VoucherLedgerV2` + `LedgerJson`.
 * The bytes are a wire contract: `__tests__/voucherLedgerV2Parity.test.ts` replays the Java's
 * golden vectors. If a vector fails, one side changed; do not edit the vectors to make it pass.
 *
 * Pure: no relay, no signer. `seal` makes an unsigned template plus the per-voucher event key,
 * `open` verifies one event's plaintext, `resolve` folds every event at a locator. Neither checks
 * the outer NIP-01 id and signature: the transport does that first (see `readVoucherLedgerStatus`).
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { nip44 } from 'nostr-tools'

import { decodeCbor, javaDoubleToString, verifyVoucher, voucherOfBlob, type SignedVoucherFields } from './voucherToken'

export const LEDGER_V2_KIND = 30078
export const BUCKETS = [1024, 2048, 4096, 8192, 16384, 32768, 65535] as const
const STATEMENT_DOMAIN = 'imani-voucher-ledger-v2'
const DAY = 86_400
const GRACE_DAYS = 30

const REF_PREFIX = 'imani-voucher-ref-v1:'
const KEY_LABEL = 'imani-voucher-key-v1'
const LOCATOR_LABEL = 'imani-voucher-locator-v1'
const EVENT_KEY_LABEL = 'imani-voucher-ledger-v1'
const ROOT_LABEL = 'imani-ledger-key-v1:'
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

const UUID_CANONICAL = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/
const ZEROS = /^0*$/

export type LedgerStatus = 'ISSUED' | 'REDEEMED' | 'REVOKED'

/** The reason names of the Java's `LedgerRefusal`, shared with the vector file. */
export type LedgerRefusal =
  | 'NOT_THIS_ADDRESS'
  | 'UNDECRYPTABLE'
  | 'MALFORMED_ENVELOPE'
  | 'DUPLICATE_KEY'
  | 'UNKNOWN_KEY'
  | 'BAD_SIGNATURE'
  | 'MALFORMED_BODY'
  | 'WRONG_VERSION'
  | 'REF_MISMATCH'
  | 'STATUS_REFUSED'
  | 'SEQ_MISMATCH'
  | 'UNAUTHORISED_SIGNER'
  | 'TERMINAL_CREDENTIAL'
  | 'TOO_LARGE'

export class LedgerRefusedError extends Error {
  constructor(
    readonly reason: LedgerRefusal,
    message: string,
  ) {
    super(`${reason}: ${message}`)
    this.name = 'LedgerRefusedError'
  }
}

// ===================================================================== derivations

/** ASCII-lowercased; must be 1..256 characters in 0x21..0x7e. Throws otherwise. */
export function normaliseIssuerId(issuerId: string): string {
  if (typeof issuerId !== 'string' || issuerId.length === 0 || issuerId.length > 256) {
    throw new Error('issuerId must be 1..256 visible ASCII characters')
  }
  for (let i = 0; i < issuerId.length; i++) {
    const c = issuerId.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) throw new Error('issuerId must be 1..256 visible ASCII characters')
  }
  // ASCII only by now, so toLowerCase is exactly Java's toLowerCase(Locale.ROOT).
  return issuerId.toLowerCase()
}

/** The canonical lowercase UUID (8-4-4-4-12 hex, either case accepted). Throws otherwise. */
export function normaliseVoucherId(voucherId: string): string {
  if (typeof voucherId !== 'string' || !UUID_CANONICAL.test(voucherId)) throw new Error('voucherId must be a UUID')
  return voucherId.toLowerCase()
}

/** `ref = SHA256("imani-voucher-ref-v1:" + issuerId + ":" + voucherId)`, inputs normalised. */
export function voucherRef(issuerId: string, voucherId: string): Uint8Array {
  return sha256(utf8ToBytes(`${REF_PREFIX}${normaliseIssuerId(issuerId)}:${normaliseVoucherId(voucherId)}`))
}

function requireRef(ref: Uint8Array): void {
  if (!(ref instanceof Uint8Array) || ref.length !== 32) throw new Error('ref must be 32 bytes')
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** `k = HMAC("imani-voucher-key-v1", ref)`, the NIP-44 v2 conversation key. */
export function conversationKey(ref: Uint8Array): Uint8Array {
  requireRef(ref)
  return hmac(sha256, utf8ToBytes(KEY_LABEL), ref)
}

/** `d = hex(SHA256("imani-voucher-locator-v1" || ref))`. */
export function locator(ref: Uint8Array): string {
  requireRef(ref)
  return bytesToHex(sha256(concat(utf8ToBytes(LOCATOR_LABEL), ref)))
}

/** `sk_v = HMAC(root, "imani-voucher-ledger-v1" || ref)`, refused outside `[1, n-1]`. */
export function eventKey(root: Uint8Array, ref: Uint8Array): Uint8Array {
  if (!(root instanceof Uint8Array) || root.length !== 32) throw new Error('ledger root must be 32 bytes')
  requireRef(ref)
  const sk = hmac(sha256, root, concat(utf8ToBytes(EVENT_KEY_LABEL), ref))
  const s = BigInt(`0x${bytesToHex(sk)}`)
  if (s === 0n || s >= CURVE_N) {
    sk.fill(0)
    throw new Error('derived event key is not a valid secp256k1 scalar')
  }
  return sk
}

/**
 * `root = SHA256("imani-ledger-key-v1:" || secretKey)`. The same bytes as `attestation.ts`'s
 * `ledgerSk`; exported for the vectors and the platform, never called with the stall key outside
 * `attestation.ts`.
 */
export function ledgerRoot(secretKey32: Uint8Array): Uint8Array {
  if (!(secretKey32 instanceof Uint8Array) || secretKey32.length !== 32) throw new Error('secret key must be 32 bytes')
  const input = concat(utf8ToBytes(ROOT_LABEL), secretKey32)
  try {
    return sha256(input)
  } finally {
    input.fill(0)
  }
}

/** `E = ceil(expiresAt / 86400) * 86400 + 30 * 86400`. */
export function expirationTag(expiresAt: number): number {
  return Math.ceil(expiresAt / DAY) * DAY + GRACE_DAYS * DAY
}

// ===================================================================== JSON writing rule

/** A JSON string literal under the ledger writing rule. Refuses a lone surrogate. */
export function quoteJson(value: string): string {
  let out = '"'
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1
      if (next < 0xdc00 || next > 0xdfff) throw new Error('string contains a lone surrogate')
      out += value[i] + value[i + 1]
      i++
      continue
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new Error('string contains a lone surrogate')
    switch (c) {
      case 0x22: out += '\\"'; break
      case 0x5c: out += '\\\\'; break
      case 0x08: out += '\\b'; break
      case 0x09: out += '\\t'; break
      case 0x0a: out += '\\n'; break
      case 0x0c: out += '\\f'; break
      case 0x0d: out += '\\r'; break
      default:
        out += c < 0x20 ? `\\u00${c.toString(16).padStart(2, '0')}` : value[i]
    }
  }
  return `${out}"`
}

function writeInt(n: number): string {
  if (!Number.isSafeInteger(n)) throw new Error('ledger numbers must be safe integers')
  return String(n)
}

// ===================================================================== the entry

/** The `voucher` object of a body. Optional fields are omitted when undefined, null or empty. */
export interface VoucherFields {
  voucherId: string
  issuerId: string
  issuerPublicKey?: string
  unit?: string
  faceValue?: number
  faceDecimals?: number
  expiresAt?: number
  memo?: string
  backingStrategy?: string
  /** Canonical spelling, as signed: "2", "0.5". */
  issuanceRatio?: string
  merchantMetadata?: string
  issuanceWarrant?: string
}

export interface LedgerEntry {
  status: LedgerStatus
  voucher: VoucherFields
  /** Voucher document bytes (unlocked signed CBOR blob), or undefined. */
  doc?: Uint8Array
}

export function seqOf(status: LedgerStatus): number {
  return status === 'ISSUED' ? 1 : 2
}

const blank = (s: string | null | undefined): string | undefined => (s == null || s === '' ? undefined : s)

/** Normalises ids and blanks, as the Java `VoucherFields` constructor does. Throws on bad ids. */
export function voucherFields(v: VoucherFields): VoucherFields {
  const out: VoucherFields = {
    voucherId: normaliseVoucherId(v.voucherId),
    issuerId: normaliseIssuerId(v.issuerId),
  }
  const strs = ['issuerPublicKey', 'unit', 'memo', 'backingStrategy', 'issuanceRatio', 'merchantMetadata', 'issuanceWarrant'] as const
  for (const k of strs) {
    const s = blank(v[k])
    if (s !== undefined) out[k] = s
  }
  for (const k of ['faceValue', 'faceDecimals', 'expiresAt'] as const) {
    if (v[k] != null) out[k] = v[k]
  }
  return out
}

/** Java's `VoucherSecret.canonicalIssuanceRatio`: integral doubles as a long, else `Double.toString`. */
export function canonicalIssuanceRatio(ratio: number): string {
  return Number.isInteger(ratio) ? String(ratio) : javaDoubleToString(ratio)
}

/** Ledger fields of a voucher as the wallet parses it. A locked voucher carries no warrant. */
export function voucherFieldsOf(v: SignedVoucherFields): VoucherFields {
  return voucherFields({
    voucherId: v.voucherId,
    issuerId: v.issuerId,
    issuerPublicKey: v.issuerPublicKey,
    unit: v.unit,
    faceValue: v.faceValue,
    faceDecimals: v.faceDecimals,
    expiresAt: v.expiresAt,
    memo: v.memo,
    backingStrategy: v.backingStrategy,
    issuanceRatio: canonicalIssuanceRatio(v.issuanceRatio),
    merchantMetadata: v.merchantMetadata ?? undefined,
    issuanceWarrant: v.lockKey ? undefined : v.issuanceWarrant,
  })
}

/**
 * True when the voucher must be treated as a terminal credential, which is never published.
 * Fails closed exactly like the Java: unreadable, duplicate-keyed or non-object metadata counts as
 * a credential; `terminal` counts as boolean `true` or the string "true" (any case, Java-trimmed).
 */
export function isTerminalCredential(merchantMetadata: string | null | undefined): boolean {
  if (merchantMetadata == null || merchantMetadata === '') return false
  let node: JValue
  try {
    node = parseStrictJson(merchantMetadata)
  } catch {
    return true
  }
  if (!isObj(node)) return true
  const t = node.map.get('terminal')
  if (t === undefined || t === null) return false
  if (typeof t === 'boolean') return t
  return typeof t === 'string' && javaTrim(t).toLowerCase() === 'true'
}

/** Java's `String.trim`: strips code units <= U+0020 only. */
function javaTrim(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && s.charCodeAt(a) <= 0x20) a++
  while (b > a && s.charCodeAt(b - 1) <= 0x20) b--
  return s.slice(a, b)
}

// ===================================================================== writing

export function writeBody(entry: LedgerEntry, ref: Uint8Array): string {
  const v = voucherFields(entry.voucher)
  const parts: string[] = [`"voucherId":${quoteJson(v.voucherId)}`, `"issuerId":${quoteJson(v.issuerId)}`]
  const str = (k: keyof VoucherFields): void => {
    const s = v[k]
    if (typeof s === 'string' && s !== '') parts.push(`${quoteJson(k)}:${quoteJson(s)}`)
  }
  const num = (k: keyof VoucherFields): void => {
    const n = v[k]
    if (typeof n === 'number') parts.push(`${quoteJson(k)}:${writeInt(n)}`)
  }
  str('issuerPublicKey')
  str('unit')
  num('faceValue')
  num('faceDecimals')
  num('expiresAt')
  str('memo')
  str('backingStrategy')
  str('issuanceRatio')
  str('merchantMetadata')
  str('issuanceWarrant')
  let body =
    `{"v":2,"ref":${quoteJson(bytesToHex(ref))},"status":${quoteJson(entry.status)},"seq":${seqOf(entry.status)}` +
    `,"voucher":{${parts.join(',')}}`
  if (entry.doc && entry.doc.length > 0) body += `,"doc":${quoteJson(bytesToHex(entry.doc))}`
  return `${body}}`
}

/** `SHA256("imani-voucher-ledger-v2" || US || d || US || hex(SHA256(body)))`. */
export function statement(d: string, body: string): Uint8Array {
  const bodyHash = bytesToHex(sha256(utf8ToBytes(body)))
  return sha256(utf8ToBytes(`${STATEMENT_DOMAIN}\u001f${d}\u001f${bodyHash}`))
}

const utf8Length = (s: string): number => utf8ToBytes(s).length

/** Signs `body` and pads the envelope to its bucket. */
export function writeEnvelope(body: string, d: string, signerSecretKey: Uint8Array, auxRand: Uint8Array): string {
  const signer = bytesToHex(schnorr.getPublicKey(signerSecretKey))
  const sig = bytesToHex(schnorr.sign(statement(d, body), signerSecretKey, auxRand))
  const head = `{"body":${quoteJson(body)},"sig":"${sig}","signer":"${signer}","pad":"`
  const tail = '"}'
  const unpadded = utf8Length(head) + tail.length
  for (const bucket of BUCKETS) {
    if (unpadded <= bucket) return head + '0'.repeat(bucket - unpadded) + tail
  }
  throw new LedgerRefusedError('TOO_LARGE', `envelope of ${unpadded} bytes does not fit 65535`)
}

export interface LedgerEventTemplate {
  pubkey: string
  kind: number
  tags: string[][]
  content: string
}

export interface Sealed {
  template: LedgerEventTemplate
  /** The per-voucher key that signs the template. The caller must `fill(0)` it after signing. */
  eventSecretKey: Uint8Array
}

/**
 * Seals an entry. `signerSecretKey` is the inner signer (the stall key for REDEEMED/REVOKED,
 * which must equal `issuerId`); `eventKeyRoot` is `ledgerRoot` of the publisher's key. `nip44Nonce`
 * and `auxRand` are fixed only in test vectors.
 */
export function seal(
  entry: LedgerEntry,
  signerSecretKey: Uint8Array,
  eventKeyRoot: Uint8Array,
  nip44Nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
  auxRand: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): Sealed {
  const voucher = voucherFields(entry.voucher)
  if (isTerminalCredential(voucher.merchantMetadata)) {
    throw new LedgerRefusedError('TERMINAL_CREDENTIAL', 'terminal credentials are never published')
  }
  const signer = bytesToHex(schnorr.getPublicKey(signerSecretKey))
  if (entry.status !== 'ISSUED' && signer !== voucher.issuerId) {
    throw new LedgerRefusedError('UNAUTHORISED_SIGNER', `${entry.status} must be signed by the stall (issuerId)`)
  }
  const ref = voucherRef(voucher.issuerId, voucher.voucherId)
  const d = locator(ref)
  const body = writeBody({ ...entry, voucher }, ref)
  const envelope = writeEnvelope(body, d, signerSecretKey, auxRand)
  const k = conversationKey(ref)
  const skV = eventKey(eventKeyRoot, ref)
  try {
    const content = nip44.v2.encrypt(envelope, k, nip44Nonce)
    const tags: string[][] = [['d', d]]
    if (voucher.expiresAt != null) tags.push(['expiration', String(expirationTag(voucher.expiresAt))])
    const template = { pubkey: bytesToHex(schnorr.getPublicKey(skV)), kind: LEDGER_V2_KIND, tags, content }
    return { template, eventSecretKey: skV.slice() }
  } finally {
    k.fill(0)
    skV.fill(0)
  }
}

// ===================================================================== strict JSON reading

interface JNum {
  kind: 'num'
  raw: string
  integral: boolean
}
interface JObj {
  kind: 'obj'
  map: Map<string, JValue>
}
type JValue = null | boolean | string | JNum | JObj | JValue[]

class DuplicateKeyError extends Error {}

const isObj = (v: JValue | undefined): v is JObj => typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'obj'
const isNum = (v: JValue | undefined): v is JNum => typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'num'

/**
 * RFC 8259 JSON, refusing duplicate keys and trailing data, keeping numbers as text so integral
 * and fractional numbers stay distinguishable (Jackson's `isIntegralNumber`). `JSON.parse` keeps
 * the last duplicate silently, so it cannot be used here.
 */
export function parseStrictJson(text: string): JValue {
  let i = 0
  const fail = (m: string): never => {
    throw new SyntaxError(`${m} at ${i}`)
  }
  const ws = (): void => {
    while (i < text.length) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++
      else break
    }
  }
  const str = (): string => {
    if (text[i] !== '"') fail('expected string')
    i++
    let out = ''
    for (;;) {
      if (i >= text.length) fail('unterminated string')
      const c = text.charCodeAt(i)
      if (c === 0x22) {
        i++
        return out
      }
      if (c < 0x20) fail('control character in string')
      if (c !== 0x5c) {
        out += text[i++]
        continue
      }
      const e = text[i + 1]
      i += 2
      switch (e) {
        case '"': out += '"'; break
        case '\\': out += '\\'; break
        case '/': out += '/'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case 'n': out += '\n'; break
        case 'r': out += '\r'; break
        case 't': out += '\t'; break
        case 'u': {
          const h = text.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('bad unicode escape')
          out += String.fromCharCode(parseInt(h, 16))
          i += 4
          break
        }
        default:
          fail('bad escape')
      }
    }
  }
  const num = (): JNum => {
    const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i))
    if (!m) return fail('bad number')
    i += m[0].length
    return { kind: 'num', raw: m[0], integral: m[1] === undefined && m[2] === undefined }
  }
  const value = (): JValue => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      const map = new Map<string, JValue>()
      ws()
      if (text[i] === '}') {
        i++
        return { kind: 'obj', map }
      }
      for (;;) {
        ws()
        const k = str()
        if (map.has(k)) throw new DuplicateKeyError(`duplicate key ${k}`)
        ws()
        if (text[i] !== ':') fail('expected :')
        i++
        map.set(k, value())
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') {
          i++
          return { kind: 'obj', map }
        }
        fail('expected , or }')
      }
    }
    if (c === '[') {
      i++
      const arr: JValue[] = []
      ws()
      if (text[i] === ']') {
        i++
        return arr
      }
      for (;;) {
        arr.push(value())
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') {
          i++
          return arr
        }
        fail('expected , or ]')
      }
    }
    if (c === '"') return str()
    if (text.startsWith('true', i)) {
      i += 4
      return true
    }
    if (text.startsWith('false', i)) {
      i += 5
      return false
    }
    if (text.startsWith('null', i)) {
      i += 4
      return null
    }
    return num()
  }
  const v = value()
  ws()
  if (i !== text.length) fail('trailing data')
  return v
}

// ===================================================================== reading

export interface Opened {
  status: LedgerStatus
  seq: number
  voucher: VoucherFields
  /** Verified document bytes; undefined when absent or dropped. */
  doc?: Uint8Array
  /** x-only hex of the inner signer. */
  signer: string
  /** True when a `doc` was present but did not verify. */
  docDropped: boolean
}

export interface Resolved {
  status: LedgerStatus
  voucher: VoucherFields
  doc?: Uint8Array
  accepted: Opened[]
}

const ENVELOPE_KEYS = ['body', 'sig', 'signer', 'pad']
const BODY_KEYS = new Set(['v', 'ref', 'status', 'seq', 'voucher', 'doc'])
const VOUCHER_KEYS = new Set([
  'voucherId', 'issuerId', 'issuerPublicKey', 'unit', 'faceValue', 'faceDecimals', 'expiresAt', 'memo',
  'backingStrategy', 'issuanceRatio', 'merchantMetadata', 'issuanceWarrant',
])
const INT32 = [-(2n ** 31n), 2n ** 31n - 1n] as const
const INT64 = [-(2n ** 63n), 2n ** 63n - 1n] as const

function parseObject(json: string, malformed: LedgerRefusal): JObj {
  let node: JValue
  try {
    node = parseStrictJson(json)
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw new LedgerRefusedError('DUPLICATE_KEY', e.message)
    throw new LedgerRefusedError(malformed, 'not JSON')
  }
  if (!isObj(node)) throw new LedgerRefusedError(malformed, 'not a JSON object')
  return node
}

function requireKnownKeys(node: JObj, allowed: Set<string>): void {
  for (const k of node.map.keys()) {
    if (!allowed.has(k)) throw new LedgerRefusedError('UNKNOWN_KEY', `unknown key ${k}`)
  }
}

function text(node: JObj, key: string, malformed: LedgerRefusal): string {
  const v = node.map.get(key)
  if (typeof v !== 'string') throw new LedgerRefusedError(malformed, `${key} must be a string`)
  return v
}

function intIn(n: JNum, [lo, hi]: readonly [bigint, bigint]): bigint | null {
  const b = BigInt(n.raw)
  return b >= lo && b <= hi ? b : null
}

function optText(node: JObj, key: string): string | undefined {
  const v = node.map.get(key)
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new LedgerRefusedError('MALFORMED_BODY', `voucher.${key} must be a string`)
  return v
}

function optLong(node: JObj, key: string): number | undefined {
  const v = node.map.get(key)
  if (v === undefined) return undefined
  const b = isNum(v) && v.integral ? intIn(v, INT64) : null
  if (b === null) throw new LedgerRefusedError('MALFORMED_BODY', `voucher.${key} must be an int64`)
  // Java holds any int64; a JS number holds exactly the safe ones. Beyond that the two readers
  // would see different values, so the event is refused here rather than misread.
  if (b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new LedgerRefusedError('MALFORMED_BODY', `voucher.${key} is beyond a safe integer`)
  }
  return Number(b)
}

function readVoucher(vo: JObj): VoucherFields {
  const voucherId = text(vo, 'voucherId', 'MALFORMED_BODY')
  const issuerId = text(vo, 'issuerId', 'MALFORMED_BODY')
  const raw: VoucherFields = {
    voucherId,
    issuerId,
    issuerPublicKey: optText(vo, 'issuerPublicKey'),
    unit: optText(vo, 'unit'),
    faceValue: optLong(vo, 'faceValue'),
    faceDecimals: optLong(vo, 'faceDecimals'),
    expiresAt: optLong(vo, 'expiresAt'),
    memo: optText(vo, 'memo'),
    backingStrategy: optText(vo, 'backingStrategy'),
    issuanceRatio: optText(vo, 'issuanceRatio'),
    merchantMetadata: optText(vo, 'merchantMetadata'),
    issuanceWarrant: optText(vo, 'issuanceWarrant'),
  }
  let fields: VoucherFields
  try {
    fields = voucherFields(raw)
  } catch (e) {
    throw new LedgerRefusedError('MALFORMED_BODY', e instanceof Error ? e.message : String(e))
  }
  if (fields.voucherId !== voucherId || fields.issuerId !== issuerId) {
    throw new LedgerRefusedError('MALFORMED_BODY', 'voucherId and issuerId must be in their normalised (lowercase) form')
  }
  return fields
}

/** The document bytes when `hex` is a signed unlocked voucher blob for this voucher; else undefined. */
function verifiedDoc(hex: string, fields: VoucherFields): Uint8Array | undefined {
  if (!EVEN_HEX.test(hex)) return undefined
  try {
    const bytes = hexToBytes(hex)
    const v = voucherOfBlob(decodeCbor(bytes))
    if (!UUID_CANONICAL.test(v.voucherId) || v.voucherId.toLowerCase() !== fields.voucherId) return undefined
    if (v.issuerId.toLowerCase() !== fields.issuerId) return undefined
    return verifyVoucher(v).signatureValid ? bytes : undefined
  } catch {
    return undefined
  }
}

/** The event shape `open` reads. The outer id and signature must already be verified by the caller. */
export interface LedgerEventLike {
  kind: number
  tags: string[][]
  content: string
}

/**
 * Verifies one event's plaintext against `ref`, following the spec's Reading section. Throws a
 * `LedgerRefusedError` naming the first failing check, in the Java's order.
 */
export function read(event: LedgerEventLike, ref: Uint8Array, trustedIssuerKeys: readonly string[] = []): Opened {
  const d = locator(ref)
  if (!event || event.kind !== LEDGER_V2_KIND) throw new LedgerRefusedError('NOT_THIS_ADDRESS', 'not kind 30078')
  const dTags = (event.tags ?? []).filter((t) => t.length > 0 && t[0] === 'd')
  if (dTags.length !== 1 || dTags[0].length < 2 || dTags[0][1] !== d) {
    throw new LedgerRefusedError('NOT_THIS_ADDRESS', 'not exactly one d tag equal to d')
  }
  if (typeof event.content !== 'string') throw new LedgerRefusedError('UNDECRYPTABLE', 'no content')

  const k = conversationKey(ref)
  let plaintext: string
  try {
    plaintext = nip44.v2.decrypt(event.content, k)
  } catch (e) {
    throw new LedgerRefusedError('UNDECRYPTABLE', e instanceof Error ? e.message : String(e))
  } finally {
    k.fill(0)
  }

  const envelope = parseObject(plaintext, 'MALFORMED_ENVELOPE')
  requireKnownKeys(envelope, new Set(ENVELOPE_KEYS))
  for (const key of ENVELOPE_KEYS) {
    if (!envelope.map.has(key)) throw new LedgerRefusedError('MALFORMED_ENVELOPE', `missing ${key}`)
  }
  const body = text(envelope, 'body', 'MALFORMED_ENVELOPE')
  const sig = text(envelope, 'sig', 'MALFORMED_ENVELOPE')
  const signer = text(envelope, 'signer', 'MALFORMED_ENVELOPE')
  const pad = text(envelope, 'pad', 'MALFORMED_ENVELOPE')
  if (!HEX128.test(sig) || !HEX64.test(signer) || !ZEROS.test(pad)) {
    throw new LedgerRefusedError('MALFORMED_ENVELOPE', 'sig, signer or pad malformed')
  }
  let verified = false
  try {
    verified = schnorr.verify(hexToBytes(sig), statement(d, body), hexToBytes(signer))
  } catch {
    verified = false
  }
  if (!verified) throw new LedgerRefusedError('BAD_SIGNATURE', 'inner signature does not verify')

  const b = parseObject(body, 'MALFORMED_BODY')
  requireKnownKeys(b, BODY_KEYS)
  const v = b.map.get('v')
  if (!isNum(v) || !v.integral) throw new LedgerRefusedError('MALFORMED_BODY', 'v must be an integer')
  if (intIn(v, INT32) !== 2n) throw new LedgerRefusedError('WRONG_VERSION', 'v is not 2')
  const bodyRef = text(b, 'ref', 'MALFORMED_BODY')
  const statusName = text(b, 'status', 'MALFORMED_BODY')
  const seqNode = b.map.get('seq')
  if (!isNum(seqNode) || !seqNode.integral) throw new LedgerRefusedError('MALFORMED_BODY', 'seq must be an integer')
  const vo = b.map.get('voucher')
  if (!isObj(vo)) throw new LedgerRefusedError('MALFORMED_BODY', 'voucher must be an object')
  requireKnownKeys(vo, VOUCHER_KEYS)
  const fields = readVoucher(vo)
  const docNode = b.map.get('doc')
  if (docNode !== undefined && typeof docNode !== 'string') throw new LedgerRefusedError('MALFORMED_BODY', 'doc must be a string')

  if (bytesToHex(ref) !== bodyRef || bytesToHex(voucherRef(fields.issuerId, fields.voucherId)) !== bytesToHex(ref)) {
    throw new LedgerRefusedError('REF_MISMATCH', 'event is for another voucher')
  }
  if (statusName !== 'ISSUED' && statusName !== 'REDEEMED' && statusName !== 'REVOKED') {
    throw new LedgerRefusedError('STATUS_REFUSED', `status ${statusName} is never published`)
  }
  const status: LedgerStatus = statusName
  if (intIn(seqNode, INT32) !== BigInt(seqOf(status))) throw new LedgerRefusedError('SEQ_MISMATCH', `seq does not match ${status}`)
  const trusted = new Set(trustedIssuerKeys.filter((x) => typeof x === 'string').map((x) => x.toLowerCase()))
  if (!(signer === fields.issuerId || (status === 'ISSUED' && trusted.has(signer)))) {
    throw new LedgerRefusedError('UNAUTHORISED_SIGNER', `signer may not publish ${status}`)
  }

  let doc: Uint8Array | undefined
  let docDropped = false
  if (typeof docNode === 'string') {
    doc = verifiedDoc(docNode, fields)
    docDropped = doc === undefined
  }
  return { status, seq: seqOf(status), voucher: fields, doc, signer, docDropped }
}

/** `read` that answers null instead of throwing. */
export function open(event: LedgerEventLike, ref: Uint8Array, trustedIssuerKeys: readonly string[] = []): Opened | null {
  try {
    return read(event, ref, trustedIssuerKeys)
  } catch {
    return null
  }
}

const RANK: Record<LedgerStatus, number> = { ISSUED: 1, REDEEMED: 2, REVOKED: 3 }

/**
 * Folds every event at a voucher's locator: highest `seq`, ties REVOKED > REDEEMED > ISSUED.
 * Voucher fields come from the first accepted ISSUED with a verified doc, else the first ISSUED,
 * else the winner. Null when nothing is accepted. The outer author is never consulted.
 */
export function resolve(events: readonly LedgerEventLike[], ref: Uint8Array, trustedIssuerKeys: readonly string[] = []): Resolved | null {
  const accepted = events.map((e) => open(e, ref, trustedIssuerKeys)).filter((o): o is Opened => o !== null)
  if (accepted.length === 0) return null
  let winner = accepted[0]
  for (const o of accepted) {
    if (o.seq > winner.seq || (o.seq === winner.seq && RANK[o.status] > RANK[winner.status])) winner = o
  }
  const issued = accepted.filter((o) => o.status === 'ISSUED')
  const source = issued.find((o) => o.doc !== undefined) ?? issued[0] ?? winner
  const doc = source.doc ?? accepted.find((o) => o.doc !== undefined)?.doc
  return { status: winner.status, voucher: source.voucher, doc, accepted }
}
