/**
 * The customer's wallet checks a till's `terminal` warrant offline (#160 phase 5, spec 5.1/5.5).
 *
 * `verifyTerminalWarrant` mirrors cashu-voucher 0.16.1's `IssuanceWarrant.verifyTerminal`. The
 * portal runs the Java when the till sells and the customer's wallet runs this when the coupon
 * arrives, so every refusal there must be a refusal here. Each test below is one forgery or one
 * shape the Java refuses, written as plainly as we could.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import {
  TERMINAL_REFUSAL,
  hasControlCharacter,
  parseCredentialSecret,
  verifyTerminalWarrant,
  type TerminalSale,
} from '../terminalWarrant'
import { parseIssuanceWarrant, verifyIssuanceWarrant, warrantSaleDigest } from '../issuanceWarrant'
import { lockedCanonicalBytes } from '../voucherToken'
import parityCorpus from './fixtures/terminalWarrantParity0161.json'

// Keys: the gateway's credential-minting service, the stall, and the till's own K.
const SERVICE_SK = '11'.repeat(32)
const SERVICE = bytesToHex(schnorr.getPublicKey(hexToBytes(SERVICE_SK)))
const STALL_SK = '22'.repeat(32)
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const TILL_SK = '33'.repeat(32)
const TILL = bytesToHex(schnorr.getPublicKey(hexToBytes(TILL_SK)))
const STRANGER_SK = '44'.repeat(32)
const STRANGER = bytesToHex(schnorr.getPublicKey(hexToBytes(STRANGER_SK)))

const UNIT = 'EUR'
const DECIMALS = 2
const NONCE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const SALE_TOTAL = 2500
const EXPIRES_AT = 4_000_000_000

interface CredentialShape {
  issuer?: string
  expiresAt?: string | null
  lock?: string
  metadata?: Record<string, unknown> | string
  signer?: string
  /** The stall co-key row; null leaves it out, as the Java fixture does. */
  pubkeys?: string | null
}

/**
 * A terminal credential secret, signed by `signer` (the service by default), in the exact wire
 * shape cashu-lib writes: P2PK lock tags, then voucher tags, then the two signature tags.
 */
function credential(over: CredentialShape = {}): string {
  const lock = over.lock ?? TILL
  const metadata =
    typeof over.metadata === 'string'
      ? over.metadata
      : JSON.stringify(
          over.metadata ?? { terminal: true, stall_pubkey: STALL, role: 'issue-and-redeem', lock_key: TILL, name: 'Front' },
        )
  const tags: string[][] = [
    ['n_sigs', '1'],
    ['sigflag', 'SIG_ALL'],
    ...(over.pubkeys === null ? [] : [['pubkeys', over.pubkeys ?? '02' + STALL]]),
    ['voucher_id', '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f'],
    ['issuer', over.issuer ?? STALL],
    ['unit', 'sat'],
    ['face_value', '1'],
  ]
  if (over.expiresAt !== null) tags.push(['expires_at', over.expiresAt ?? String(EXPIRES_AT)])
  tags.push(['merchant_metadata', metadata])
  const body = { nonce: '9a8b7c6d5e4f30211203f4e5d6c7b8a9', data: '02' + lock, tags }
  const signed = lockedCanonicalBytes(body.data, body.nonce, tags)
  const signerSk = over.signer ?? SERVICE_SK
  const sig = bytesToHex(schnorr.sign(sha256(signed), hexToBytes(signerSk)))
  const pub = bytesToHex(schnorr.getPublicKey(hexToBytes(signerSk)))
  body.tags = [...tags, ['issuer_sig', sig], ['issuer_pubkey', pub]]
  return JSON.stringify(['P2PK_VOUCHER', body])
}

function saleSignature(signerSk = TILL_SK, total = SALE_TOTAL, nonce = NONCE): string {
  return bytesToHex(schnorr.sign(warrantSaleDigest(STALL, total, DECIMALS, UNIT, nonce), hexToBytes(signerSk)))
}

/** The genuine sale. A test changes exactly one field. */
function sale(over: Partial<TerminalSale> = {}): TerminalSale {
  return {
    issuerId: STALL,
    credential: credential(),
    trustedServiceKeys: [SERVICE],
    saleTotalMinor: SALE_TOTAL,
    faceDecimals: DECIMALS,
    unit: UNIT,
    saleNonce: NONCE,
    signatureHex: saleSignature(),
    couponFaceMinor: SALE_TOTAL,
    expiryCheck: 'skip-offline',
    ...over,
  }
}

function refusal(over: Partial<TerminalSale>) {
  const verdict = verifyTerminalWarrant(sale(over))
  return verdict.valid ? 'VALID' : verdict.refusal
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('the golden credential cashu-voucher 0.16.0 froze', () => {
  // Copied byte for byte from IssuanceWarrantTerminalTest.GOLDEN_CREDENTIAL_WIRE. The Java
  // test asserts this string re-serialises to itself and its service signature verifies. If
  // our canonical bytes differ from the Java's by one character, this signature fails here.
  const GOLDEN =
    '["P2PK_VOUCHER",{"nonce":"9a8b7c6d5e4f30211203f4e5d6c7b8a9",' +
    '"data":"02531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",' +
    '"tags":[["n_sigs","1"],["sigflag","SIG_ALL"],' +
    '["pubkeys","024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766"],' +
    '["voucher_id","6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f"],' +
    '["issuer","4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766"],' +
    '["unit","sat"],["face_value","1"],["expires_at","4000000000"],' +
    '["merchant_metadata","{\\"terminal\\":true,' +
    '\\"stall_pubkey\\":\\"4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766\\",' +
    '\\"role\\":\\"issue-and-redeem\\",' +
    '\\"lock_key\\":\\"531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337\\",' +
    '\\"name\\":\\"Pizza till \uD83C\uDF55\\"}"],' +
    '["issuer_sig","e83f6f38db9679b773c9d6c6fc01cecbcecd6411c43d35569854094c44ef06cf' +
    '85da8aad04444bcdea87132097e535fc9a45dc48faee439b101c4efef0f62b82"],' +
    '["issuer_pubkey","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"]]}]'
  // The Java test's fixed keys: 0x01.. service, 0x02.. stall, 0x03.. till.
  const G_STALL = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'
  const G_SERVICE = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
  const G_TILL_SK = '03'.repeat(32)

  it('parses byte-exact, and a sale its till signs verifies against the Java-signed credential', () => {
    expect(parseCredentialSecret(GOLDEN)).not.toBeNull()
    const signature = bytesToHex(
      schnorr.sign(warrantSaleDigest(G_STALL, 2500, 2, 'EUR', NONCE), hexToBytes(G_TILL_SK)),
    )
    const verdict = verifyTerminalWarrant({
      ...sale(),
      issuerId: G_STALL,
      credential: GOLDEN,
      trustedServiceKeys: [G_SERVICE],
      signatureHex: signature,
    })
    expect(verdict).toEqual({ valid: true })
  })
})

describe('a genuine terminal sale verifies', () => {
  it('verifies, and a split part under the total still verifies', () => {
    expect(refusal({})).toBe('VALID')
    expect(refusal({ couponFaceMinor: 1000 })).toBe('VALID')
  })

  it('reads as `verified` through the customer-side parser and verifier', () => {
    // The whole round trip a customer's wallet runs on a coupon from a till.
    const json = JSON.stringify({
      form: 'terminal',
      sale_total: SALE_TOTAL,
      face_decimals: DECIMALS,
      unit: UNIT,
      nonce: NONCE,
      signature: saleSignature(),
      credential: credential(),
    })
    const warrant = parseIssuanceWarrant(json)
    expect(warrant.state).toBe('present')
    expect(
      verifyIssuanceWarrant(warrant, STALL, { faceValueMinor: SALE_TOTAL, unit: UNIT, faceDecimals: DECIMALS }, {
        trustedServiceKeys: [SERVICE],
      }),
    ).toEqual({ verdict: 'verified' })
  })

  it('skips the credential expiry offline: a coupon sold before the till expired stays valid', () => {
    // ExpiryCheck.skipOffline. The credential expired long ago, the coupon is still good.
    expect(refusal({ credential: credential({ expiresAt: '1000' }) })).toBe('VALID')
  })
})

describe('malformed sale inputs (MALFORMED_SALE)', () => {
  it('refuses an issuer that is not lowercase hex64', () => {
    expect(refusal({ issuerId: STALL.toUpperCase() })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
    expect(refusal({ issuerId: STALL.slice(1) })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
  })

  it('refuses US, other C0, DEL and C1 controls in unit or nonce', () => {
    // US is the digest's separator: a nonce carrying one could smuggle in an extra field.
    for (const bad of ['n\u001fx', 'n\u0000', 'n\u007f', 'n\u0085', 'n\u009f']) {
      expect(refusal({ saleNonce: bad })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
      expect(refusal({ unit: bad })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
    }
  })

  it('refuses a lone surrogate, which Java and TextEncoder encode differently', () => {
    expect(refusal({ saleNonce: 'n1\uD800' })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
    expect(refusal({ saleNonce: 'n1\uDC00x' })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
    // A properly paired surrogate (an emoji) is fine.
    expect(hasControlCharacter('n1\uD83C\uDF55')).toBe(false)
  })

  it('refuses out-of-range amounts and decimals', () => {
    expect(refusal({ saleTotalMinor: -1 })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
    expect(refusal({ saleTotalMinor: 2 ** 53 })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
    expect(refusal({ couponFaceMinor: -1 })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
    expect(refusal({ faceDecimals: -1 })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
    expect(refusal({ faceDecimals: 19 })).toBe(TERMINAL_REFUSAL.MALFORMED_SALE)
  })
})

describe('each forgery the Java refuses, refused here', () => {
  it('a coupon worth more than the sale (COUPON_ABOVE_SALE)', () => {
    expect(refusal({ couponFaceMinor: SALE_TOTAL + 1 })).toBe(TERMINAL_REFUSAL.COUPON_ABOVE_SALE)
  })

  it('a credential minted by a key we do not trust, or with no trusted keys at all', () => {
    // Anyone can mint themselves a credential under their own key: the allow-list is what stops it.
    expect(refusal({ credential: credential({ signer: STRANGER_SK }) })).toBe(TERMINAL_REFUSAL.UNTRUSTED_SERVICE_KEY)
    expect(refusal({ trustedServiceKeys: [] })).toBe(TERMINAL_REFUSAL.UNTRUSTED_SERVICE_KEY)
  })

  it('a credential whose signed fields were edited (BAD_CREDENTIAL_SIGNATURE)', () => {
    const edited = credential().replace('"face_value","1"', '"face_value","2"')
    expect(refusal({ credential: edited })).toBe(TERMINAL_REFUSAL.BAD_CREDENTIAL_SIGNATURE)
  })

  it('no legacy window: expires_at rewritten from 1000 to 1000.5 does not verify', () => {
    // Strict canonical verification. Under the legacy truncation both hash alike, and Java would
    // then read the expiry as absent. The credential is refused before anything reads it.
    const signed = credential({ expiresAt: '1000' })
    expect(refusal({ credential: signed.replace('"expires_at","1000"', '"expires_at","1000.5"') })).toBe(
      TERMINAL_REFUSAL.BAD_CREDENTIAL_SIGNATURE,
    )
  })

  it('a credential not in canonical wire form: padding or reordered keys', () => {
    expect(refusal({ credential: credential().replace('{"nonce"', '{ "nonce"') })).toBe(
      TERMINAL_REFUSAL.BAD_CREDENTIAL_SIGNATURE,
    )
  })

  it('a number rewritten into another spelling of itself ("1000" to "1000.0" or "1e3")', () => {
    // These normalise to the very bytes the service signed, so the signature alone would hold.
    // The Java parses neither as a long, so it reads them differently: refused before that matters.
    const signed = credential({ expiresAt: '1000' })
    for (const spelling of ['1000.0', '1e3', '01000']) {
      expect(refusal({ credential: signed.replace('"expires_at","1000"', `"expires_at","${spelling}"`) })).toBe(
        TERMINAL_REFUSAL.BAD_CREDENTIAL_SIGNATURE,
      )
    }
  })

  it('a credential with no expiry, or one that is not a canonical integer (MALFORMED_CREDENTIAL)', () => {
    expect(refusal({ credential: credential({ expiresAt: null }) })).toBe(TERMINAL_REFUSAL.MALFORMED_CREDENTIAL)
    // Signed as-is by the service (so the signature holds), but not an integer we can read.
    expect(refusal({ credential: credential({ expiresAt: '1000.5' }) })).toBe(TERMINAL_REFUSAL.MALFORMED_CREDENTIAL)
    // Too long to be an epoch at all: refused, whichever check sees it first.
    expect(refusal({ credential: credential({ expiresAt: '99999999999999999999' }) })).not.toBe('VALID')
  })

  it('a till of another stall (WRONG_STALL)', () => {
    expect(refusal({ credential: credential({ issuer: STRANGER }) })).toBe(TERMINAL_REFUSAL.WRONG_STALL)
  })

  it('the expiry boundary: refused only when now > expires_at', () => {
    // expires_at is the last valid second, as at the mint.
    expect(refusal({ expiryCheck: { at: EXPIRES_AT } })).toBe('VALID')
    expect(refusal({ expiryCheck: { at: EXPIRES_AT + 1 } })).toBe(TERMINAL_REFUSAL.CREDENTIAL_EXPIRED)
  })

  it('metadata that is not a selling terminal of this stall (NOT_A_SELLING_TERMINAL)', () => {
    const base = { terminal: true, stall_pubkey: STALL, role: 'issue-and-redeem', lock_key: TILL }
    for (const metadata of [
      { ...base, role: 'redeem-only' },
      { ...base, terminal: 'yes' },
      { ...base, stall_pubkey: STRANGER },
      { ...base, lock_key: 'zz' },
    ]) {
      expect(refusal({ credential: credential({ metadata }) })).toBe(TERMINAL_REFUSAL.NOT_A_SELLING_TERMINAL)
    }
    // Duplicate keys, which JSON.parse would resolve (last wins) and Java refuses.
    const dup = `{"terminal":true,"stall_pubkey":"${STALL}","role":"redeem-only","role":"issue-and-redeem","lock_key":"${TILL}"}`
    expect(refusal({ credential: credential({ metadata: dup }) })).toBe(TERMINAL_REFUSAL.NOT_A_SELLING_TERMINAL)
  })

  it("a lock_key that is the stall's own key (LOCK_IS_STALL)", () => {
    const metadata = { terminal: true, stall_pubkey: STALL, role: 'issue-and-redeem', lock_key: STALL }
    expect(
      refusal({ credential: credential({ metadata, lock: STALL, pubkeys: null }), signatureHex: saleSignature(STALL_SK) }),
    ).toBe(TERMINAL_REFUSAL.LOCK_IS_STALL)
  })

  it('a mint lock that is not lock_key (LOCK_MISMATCH)', () => {
    expect(refusal({ credential: credential({ lock: STRANGER }) })).toBe(TERMINAL_REFUSAL.LOCK_MISMATCH)
  })

  it("a sale signed by anyone but K, or for another total (BAD_SALE_SIGNATURE)", () => {
    expect(refusal({ signatureHex: saleSignature(STRANGER_SK) })).toBe(TERMINAL_REFUSAL.BAD_SALE_SIGNATURE)
    expect(refusal({ signatureHex: saleSignature(TILL_SK, 100) })).toBe(TERMINAL_REFUSAL.BAD_SALE_SIGNATURE)
    expect(refusal({ signatureHex: 'zz' })).toBe(TERMINAL_REFUSAL.BAD_SALE_SIGNATURE)
  })
})

describe('the customer side refuses a broken terminal warrant', () => {
  it('a terminal warrant with no credential is unreadable, not absent', () => {
    const json = JSON.stringify({ form: 'terminal', sale_total: 1, face_decimals: 2, unit: 'EUR', nonce: 'n', signature: 'aa' })
    expect(parseIssuanceWarrant(json)).toEqual({ state: 'invalid', reason: 'terminal warrant carries no credential' })
  })

  it('a build that trusts no service key refuses every terminal warrant', () => {
    const json = JSON.stringify({
      form: 'terminal', sale_total: SALE_TOTAL, face_decimals: DECIMALS, unit: UNIT, nonce: NONCE,
      signature: saleSignature(), credential: credential(),
    })
    const verdict = verifyIssuanceWarrant(parseIssuanceWarrant(json), STALL, {
      faceValueMinor: SALE_TOTAL, unit: UNIT, faceDecimals: DECIMALS,
    }, { trustedServiceKeys: [] })
    expect(verdict.verdict).toBe('failed')
  })
})

/**
 * cashu-voucher 0.16.1 parity: the wallet and the Java accept exactly the same credentials, and
 * both take the strict reading. The #196 review fuzz found each of these accepted on one side and
 * refused on the other.
 */
describe('one credential, one reading (0.16.1 parity)', () => {
  /** The genuine credential with its wire text rewritten by `edit`, re-signed by the service. */
  function withTags(edit: (tags: string[][]) => string[][], over: { data?: string } = {}): string {
    const [, body] = JSON.parse(credential()) as [string, { nonce: string; data: string; tags: string[][] }]
    const unsigned = body.tags.filter((t) => t[0] !== 'issuer_sig' && t[0] !== 'issuer_pubkey')
    const tags = edit(unsigned)
    const data = over.data ?? body.data
    const sig = bytesToHex(schnorr.sign(sha256(lockedCanonicalBytes(data, body.nonce, tags)), hexToBytes(SERVICE_SK)))
    return JSON.stringify(['P2PK_VOUCHER', { nonce: body.nonce, data, tags: [...tags, ['issuer_sig', sig], ['issuer_pubkey', SERVICE]] }])
  }

  // Two rows of one tag are two readings: one verifier takes the first, another the last. The
  // Java's parser (NUT-11) refuses any repeated tag, so the wallet must too, for every tag.
  it('refuses a repeated tag row, whichever tag and wherever it sits', () => {
    const rogue = bytesToHex(schnorr.getPublicKey(hexToBytes(STRANGER_SK)))
    const extra: string[][] = [
      ['issuer', STRANGER],
      ['merchant_metadata', JSON.stringify({ terminal: true, stall_pubkey: STALL, role: 'redeem-only', lock_key: TILL })],
      ['expires_at', '1'],
      ['voucher_id', 'x'],
      ['unit', 'sat'],
      ['memo', 'a'],
    ]
    for (const row of extra) {
      const tagsFirst = withTags((t) => [row, ...t, ...(row[0] === 'memo' ? [row] : [])])
      const tagsLast = withTags((t) => [...t, row, ...(row[0] === 'memo' ? [row] : [])])
      expect(parseCredentialSecret(tagsFirst), row[0]).toBeNull()
      expect(parseCredentialSecret(tagsLast), row[0]).toBeNull()
    }
    // The signature rows, appended after signing as an attacker would.
    const wire = credential()
    for (const row of [['issuer_pubkey', rogue], ['issuer_sig', '00'.repeat(64)]]) {
      const appended = wire.replace(/\]\]\}\]$/, '],' + JSON.stringify(row) + ']}]')
      expect(appended).not.toBe(wire)
      expect(parseCredentialSecret(appended), row[0]).toBeNull()
      expect(refusal({ credential: appended })).toBe(TERMINAL_REFUSAL.BAD_CREDENTIAL_SIGNATURE)
    }
  })

  // `data` is the till's mint lock, written by the gateway as a lowercase compressed key. An
  // uppercase spelling, or a 04/05 prefix, is not one the Java parses, so it is not one here.
  it('refuses data that is not lowercase hex with a 02 or 03 prefix', () => {
    for (const data of ['04' + TILL, '05' + TILL, ('02' + TILL).toUpperCase(), '02' + TILL.slice(0, 10).toUpperCase() + TILL.slice(10)]) {
      expect(parseCredentialSecret(withTags((t) => t, { data })), data).toBeNull()
    }
    expect(parseCredentialSecret(withTags((t) => t, { data: '03' + TILL }))).not.toBeNull()
  })

  // An uppercase lock_key is a second spelling of the same key. Both sides take only lowercase.
  it('refuses an uppercase lock_key', () => {
    const metadata = { terminal: true, stall_pubkey: STALL, role: 'issue-and-redeem', lock_key: TILL.toUpperCase() }
    expect(refusal({ credential: credential({ metadata }) })).toBe(TERMINAL_REFUSAL.NOT_A_SELLING_TERMINAL)
  })

  // A lone surrogate hashes as '?' in Java and as U+FFFD here, so the same credential would have
  // two digests. Refused at parse, in a tag value or (escaped) inside the metadata JSON.
  it('refuses a lone surrogate anywhere in a signed tag', () => {
    expect(parseCredentialSecret(withTags((t) => [...t, ['memo', 'a\ud800b']]))).toBeNull()
    expect(parseCredentialSecret(withTags((t) => [...t, ['memo', 'a\udc00']]))).toBeNull()
    // Raw in the metadata text (the wire escapes it as \\ud800, which JSON.parse turns back).
    const metadata = JSON.stringify({ terminal: true, stall_pubkey: STALL, role: 'issue-and-redeem', lock_key: TILL }).replace('}', ',"name":"a\ud800b"}')
    expect(parseCredentialSecret(credential({ metadata }))).toBeNull()
    // A paired surrogate (an emoji) is well-formed and still fine.
    const emoji = { terminal: true, stall_pubkey: STALL, role: 'issue-and-redeem', lock_key: TILL, name: 'Pizza \u{1F355}' }
    expect(refusal({ credential: credential({ metadata: emoji }) })).toBe('VALID')
  })

  // A `data` that repeats the stall co-key is a duplicate in NUT-11's main pathway, which the
  // Java refuses at parse. Here too, so it never reaches LOCK_MISMATCH on one side only.
  it('refuses data that repeats a pubkeys key, as NUT-11 does', () => {
    expect(parseCredentialSecret(credential({ lock: STALL }))).toBeNull()
  })

  /** The genuine wire text with `rows` appended after signing (the signature rows stay as they are). */
  function withSignatureRows(edit: (rows: string[][]) => string[][]): string {
    const [, body] = JSON.parse(credential()) as [string, { nonce: string; data: string; tags: string[][] }]
    return JSON.stringify(['P2PK_VOUCHER', { ...body, tags: edit(body.tags) }])
  }
  const parses = (wire: string) => parseCredentialSecret(wire) !== null
  // An x-coordinate with no point on secp256k1 above it, so 02||x and 03||x are not keys.
  const OFF_CURVE_X = '00'.repeat(31) + '05'

  // Each tag the verdict reads must hold exactly one value. A row such as
  // ["issuer", STALL, STRANGER] is two readings, so it is refused even when the first one is right.
  it('refuses a read tag row that carries more than one value', () => {
    const meta = JSON.stringify({ terminal: true, stall_pubkey: STALL, role: 'issue-and-redeem', lock_key: TILL, name: 'Front' })
    for (const [key, extra] of [['issuer', STALL], ['issuer', STRANGER], ['merchant_metadata', meta], ['expires_at', '1']]) {
      const wire = withTags((t) => t.map((r) => (r[0] === key ? [...r, extra] : r)))
      expect(refusal({ credential: wire }), key).not.toBe('VALID')
    }
    for (const key of ['issuer_sig', 'issuer_pubkey']) {
      const wire = withSignatureRows((t) => t.map((r) => (r[0] === key ? [...r, r[1]] : r)))
      expect(refusal({ credential: wire }), key).not.toBe('VALID')
    }
    // The genuine one-value rows still verify.
    expect(refusal({})).toBe('VALID')
  })

  // A lone surrogate in the credential nonce hashes differently in Java and here, like one in a tag.
  it('refuses a lone surrogate in the credential nonce', () => {
    const [, body] = JSON.parse(credential()) as [string, { nonce: string; data: string; tags: string[][] }]
    for (const nonce of ['ab\ud800', 'ab\udc00cd']) {
      expect(parseCredentialSecret(JSON.stringify(['P2PK_VOUCHER', { ...body, nonce }])), nonce).toBeNull()
    }
  })

  // The tag key is hashed too, so a lone surrogate there is refused just as one in a value is.
  it('refuses a lone surrogate in a tag key', () => {
    expect(parses(withTags((t) => [...t, ['me\ud800mo', 'a']]))).toBe(false)
    expect(parses(withTags((t) => [...t, ['memo', 'a']]))).toBe(true)
  })

  // NUT-11 knows two sigflags, spelled in upper case. Anything else fails Java's parse.
  it('refuses a sigflag other than SIG_INPUTS or SIG_ALL', () => {
    const set = (v: string) => withTags((t) => t.map((r) => (r[0] === 'sigflag' ? ['sigflag', v] : r)))
    for (const v of ['sig_all', 'SIG_NONE', '']) expect(parses(set(v)), v).toBe(false)
    expect(parses(set('SIG_INPUTS'))).toBe(true)
    expect(parses(set('SIG_ALL'))).toBe(true)
  })

  // n_sigs must be at least 1 and no more than the keys in the main pathway (data plus pubkeys).
  it('refuses an n_sigs below 1 or above the number of keys', () => {
    const set = (v: string) => withTags((t) => t.map((r) => (r[0] === 'n_sigs' ? ['n_sigs', v] : r)))
    for (const v of ['0', '-1', '3', '9223372036854775807']) expect(parses(set(v)), v).toBe(false)
    expect(parses(set('1'))).toBe(true)
    expect(parses(set('2'))).toBe(true)
  })

  // Numbers are read as Java's Long.parseLong(s.trim()): surrounding spaces are fine, but a
  // value outside a signed 64-bit long is refused.
  it('reads n_sigs and locktime as Java longs: trimmed, and within 64 bits', () => {
    const refund = ['refund', '02' + STRANGER]
    const lock = (v: string) => withTags((t) => [...t, ['locktime', v], refund])
    expect(parses(withTags((t) => t.map((r) => (r[0] === 'n_sigs' ? ['n_sigs', ' 1'] : r))))).toBe(true)
    expect(parses(withTags((t) => t.map((r) => (r[0] === 'n_sigs' ? ['n_sigs', '1 '] : r))))).toBe(true)
    expect(parses(lock(' 1'))).toBe(true)
    expect(parses(lock('9223372036854775807'))).toBe(true)
    expect(parses(lock('9223372036854775808'))).toBe(false)
    expect(parses(lock('1e3'))).toBe(false)
  })

  // A locktime must be non-negative and needs refund keys to unlock to. Either fault fails parse.
  it('refuses a negative locktime, and a locktime with no refund keys', () => {
    const refund = ['refund', '02' + STRANGER]
    expect(parses(withTags((t) => [...t, ['locktime', '100'], refund]))).toBe(true)
    expect(parses(withTags((t) => [...t, ['locktime', '-1'], refund]))).toBe(false)
    expect(parses(withTags((t) => [...t, ['locktime', '100']]))).toBe(false)
  })

  // Keys are compared on the x-coordinate, so 02||x and 03||x are the same key twice. That holds in
  // the main pathway and, separately, among refund keys.
  it('refuses the same key twice in a pathway, whatever its 02/03 prefix', () => {
    const pub = (v: string) => withTags((t) => t.map((r) => (r[0] === 'pubkeys' ? ['pubkeys', v] : r)))
    expect(parses(pub('03' + TILL))).toBe(false)
    expect(parses(pub('03' + STALL))).toBe(true)
    expect(parses(withTags((t) => [...t, ['refund', '02' + STRANGER, '03' + STRANGER]]))).toBe(false)
    expect(parses(withTags((t) => [...t, ['refund', '02' + STRANGER, '02' + SERVICE]]))).toBe(true)
  })

  // Every pubkeys and refund key must be a real point on the curve, not just 66 hex characters
  // starting 02 or 03. The service signs whatever it is handed, so a signature does not save it.
  it('refuses a pubkeys or refund key that is not a point on secp256k1', () => {
    for (const p of ['02', '03']) {
      expect(parses(withTags((t) => t.map((r) => (r[0] === 'pubkeys' ? ['pubkeys', p + OFF_CURVE_X] : r)))), p).toBe(false)
      expect(parses(withTags((t) => [...t, ['refund', p + OFF_CURVE_X]])), p).toBe(false)
    }
    expect(parses(withTags((t) => t.map((r) => (r[0] === 'pubkeys' ? ['pubkeys', '04' + STALL] : r))))).toBe(false)
  })

  // `data` too must be a point on the curve. Java refuses a well-formed but off-curve lock at
  // parse, so the wallet must not let it through to a later check.
  it('refuses data that is not a point on secp256k1', () => {
    expect(parses(withTags((t) => t, { data: '02' + OFF_CURVE_X }))).toBe(false)
    expect(parses(withTags((t) => t, { data: '03' + OFF_CURVE_X }))).toBe(false)
  })
})

/**
 * A golden corpus taken from the #196 review fuzz: each credential and sale, with the verdict
 * cashu-voucher 0.16.1 (Java) gave it. If the wallet ever accepts what Java refuses, or the other
 * way round, this fails. The reasons may differ (Java refuses at parse, the wallet often later),
 * so only accept/refuse is compared, plus the wallet's own reason as a change detector.
 */
describe('parity with cashu-voucher 0.16.1 on the review corpus', () => {
  interface ParityCase {
    id: string
    java: string
    wallet: string
    issuerId: string
    credential: string
    trusted: string[]
    saleTotal: number
    faceDecimals: number
    unit: string
    nonce: string
    sig: string
    couponFace: number
    expiry: 'skip' | number
  }
  const cases = parityCorpus as ParityCase[]

  // The corpus is the size we committed, so a truncated file cannot pass silently.
  it('holds every committed case', () => {
    expect(cases.length).toBe(438)
    expect(cases.filter((c) => c.java === 'VALID').length).toBe(131)
  })

  // Each case gets the same accept/refuse verdict as Java, and the wallet's reason is unchanged.
  it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const v = verifyTerminalWarrant({
      issuerId: c.issuerId,
      credential: c.credential,
      trustedServiceKeys: c.trusted,
      saleTotalMinor: c.saleTotal,
      faceDecimals: c.faceDecimals,
      unit: c.unit,
      saleNonce: c.nonce,
      signatureHex: c.sig,
      couponFaceMinor: c.couponFace,
      expiryCheck: c.expiry === 'skip' ? 'skip-offline' : { at: c.expiry },
    })
    const got = v.valid ? 'VALID' : v.refusal
    expect(got === 'VALID', `java said ${c.java}`).toBe(c.java === 'VALID')
    expect(got).toBe(c.wallet)
  })
})

/**
 * The customer's offline check (`verifyIssuanceWarrant`). Each test below fails if one line of
 * that call is changed: the review's mutation run left them alive.
 */
describe('the customer-side call into verifyTerminalWarrant', () => {
  const coupon = { faceValueMinor: SALE_TOTAL, unit: UNIT, faceDecimals: DECIMALS }
  const json = (cred: string) =>
    JSON.stringify({ form: 'terminal', sale_total: SALE_TOTAL, face_decimals: DECIMALS, unit: UNIT, nonce: NONCE, signature: saleSignature(), credential: cred })

  // Offline, a coupon sold before the till's credential expired stays good, today and forever.
  // Checking the expiry "as of now" instead would turn every old coupon from a till into a
  // failure the day the till's year runs out.
  it('skips the credential expiry: a coupon from a till whose credential has since expired verifies', () => {
    const expired = credential({ expiresAt: '1000' })
    expect(
      verifyIssuanceWarrant(parseIssuanceWarrant(json(expired)), STALL, coupon, {
        trustedServiceKeys: [SERVICE],
        now: 2_000_000_000_000,
      }),
    ).toEqual({ verdict: 'verified' })
  })

  // With no keys passed, the build's own VITE_VOUCHER_ISSUER_PUBKEYS is the allow-list. A build
  // that names the service key verifies; dropping the default would refuse every till's coupon.
  it('uses the build’s trusted service keys when none are passed', () => {
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', SERVICE)
    try {
      const verdict = verifyIssuanceWarrant(parseIssuanceWarrant(json(credential())), STALL, coupon)
      expect(verdict).toEqual({ verdict: 'verified' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
