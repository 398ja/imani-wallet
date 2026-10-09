/**
 * @vitest-environment jsdom
 */
/**
 * A till's Sell, end to end on one device (#160 phase 5): unlock holds the credential, the
 * warrant carries it under K's signature, every signed request names it, and a customer's wallet
 * reads the coupon as `verified`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

const TILL_SK = '33'.repeat(32)
const TILL = bytesToHex(schnorr.getPublicKey(hexToBytes(TILL_SK)))
const STALL_SK = '22'.repeat(32)
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const SERVICE_SK = '11'.repeat(32)
const SERVICE = bytesToHex(schnorr.getPublicKey(hexToBytes(SERVICE_SK)))

const signerState = vi.hoisted(() => ({ sk: null as string | null }))
vi.mock('../nap', async () => {
  const { schnorr: s } = await import('@noble/curves/secp256k1.js')
  const { bytesToHex: b, hexToBytes: h } = await import('@noble/hashes/utils')
  return {
    getSigner: () => {
      if (!signerState.sk) throw new Error('locked')
      const sk = signerState.sk
      return {
        pubkey: b(s.getPublicKey(h(sk))),
        withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(h(sk)),
        signEvent: async (e: Record<string, unknown>) => ({ ...e, id: '00', pubkey: b(s.getPublicKey(h(sk))), sig: '00' }),
      }
    },
  }
})

const { buildIssuanceWarrant, mayWarrantSale } = await import('../warrantSigner')
const { parseIssuanceWarrant, verifyIssuanceWarrant } = await import('../issuanceWarrant')
const { parseCredentialSecret } = await import('../terminalWarrant')
const { setRequestCredential, TERMINAL_CREDENTIAL_HEADER } = await import('../terminalRequestCredential')
const { signedFetch } = await import('../nip98')
const { openSession, SESSION_KIND } = await import('../terminalSession')
const { grantFor } = await import('../terminalRole')
const { signOwnerAttestation } = await import('../ownerAttestation')
import type { TerminalActor } from '../actor'

const till: TerminalActor = {
  kind: 'terminal',
  stallPubkey: STALL,
  role: 'issue-and-redeem',
  terminalPubkey: TILL,
  permissions: grantFor('issue-and-redeem', STALL),
  // The stall attested this till at enrolment (#160 decision 5), so it may sell.
  attested: true,
}

/**
 * A credential the service minted to K for this stall, as its wire secret. Attested by the stall
 * at enrolment unless `attested` is false, which is a till set up before 0.17.0.
 */
function credentialSecret(attested = true): string {
  const stallSigner = { pubkey: STALL, withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(hexToBytes(STALL_SK)) }
  const owner_attestation = signOwnerAttestation(
    { stallPubkey: STALL, lockKey: TILL, role: 'issue-and-redeem', expiresAt: 4_000_000_000 },
    stallSigner,
  )
  const metadata = JSON.stringify({
    terminal: true,
    stall_pubkey: STALL,
    role: 'issue-and-redeem',
    lock_key: TILL,
    ...(attested ? { owner_attestation } : {}),
  })
  const tags = [
    ['voucher_id', 'cred-1'], ['issuer', STALL], ['unit', 'sat'], ['face_value', '1'],
    ['expires_at', '4000000000'], ['merchant_metadata', metadata],
  ]
  const body = { nonce: 'ab', data: '02' + TILL, tags }
  const signed = parseCredentialSecret(JSON.stringify(['P2PK_VOUCHER', body]))!.signed
  const sig = bytesToHex(schnorr.sign(sha256(signed), hexToBytes(SERVICE_SK)))
  body.tags = [...tags, ['issuer_sig', sig], ['issuer_pubkey', SERVICE]]
  return JSON.stringify(['P2PK_VOUCHER', body])
}

// Signed once: BIP-340 signing is randomised, so two calls give two different secrets.
const SECRET = credentialSecret()

beforeEach(() => {
  signerState.sk = TILL_SK
  setRequestCredential({ voucherId: 'cred-1', stallPubkey: STALL, secret: SECRET })
})

describe('a FULL selling till signs a terminal warrant the customer verifies', () => {
  // A till set up before owner attestation still signs its sales with K, but its credential
  // carries no stall signature: the customer reads the coupon `unwarranted` (review M7), which
  // `refuseIfUnwarranted` refuses before the swap, rather than `failed` (it is not tampered with).
  it('reads `unwarranted`, not `failed`, when the till was never attested', async () => {
    setRequestCredential({ voucherId: 'cred-1', stallPubkey: STALL, secret: credentialSecret(false) })
    const warrant = parseIssuanceWarrant(await buildIssuanceWarrant(till, 2500, 2, 'EUR'))
    expect(
      verifyIssuanceWarrant(warrant, STALL, { faceValueMinor: 2500, unit: 'EUR', faceDecimals: 2 }, {
        trustedServiceKeys: [SERVICE],
      }),
    ).toEqual({ verdict: 'unwarranted' })
  })

  it('may warrant a sale in a FULL session, not a REDUCED one', () => {
    // The gate this phase lifts: before it, every terminal was refused here.
    expect(mayWarrantSale(till, openSession(till, SESSION_KIND.FULL))).toBe(true)
    expect(mayWarrantSale(till, openSession(till, SESSION_KIND.REDUCED))).toBe(false)
    expect(mayWarrantSale(till, null)).toBe(false)
  })

  it("builds the spec's wire form, signed by K, and the customer's verdict is `verified`", async () => {
    const json = await buildIssuanceWarrant(till, 2500, 2, 'EUR')
    const warrant = parseIssuanceWarrant(json)

    expect(warrant.state === 'present' && warrant.form).toBe('terminal')
    expect(
      verifyIssuanceWarrant(warrant, STALL, { faceValueMinor: 2500, unit: 'EUR', faceDecimals: 2 }, {
        trustedServiceKeys: [SERVICE],
      }),
    ).toEqual({ verdict: 'verified' })
  })

  it('never carries the proof: the credential field is the secret alone', async () => {
    const warrant = JSON.parse((await buildIssuanceWarrant(till, 100, 2, 'EUR'))!)
    expect(warrant.credential).toBe(SECRET)
    expect(JSON.stringify(warrant)).not.toMatch(/"C"|cashuB/)
  })

  it("signs `none` when the held credential is another stall's, so Sell refuses it", async () => {
    setRequestCredential({ voucherId: 'cred-1', stallPubkey: 'f'.repeat(64), secret: credentialSecret() })
    expect(JSON.parse((await buildIssuanceWarrant(till, 100, 2, 'EUR'))!)).toEqual({ form: 'none' })
  })

  it('signs `none` when the installed signer is not K', async () => {
    signerState.sk = '44'.repeat(32)
    expect(JSON.parse((await buildIssuanceWarrant(till, 100, 2, 'EUR'))!)).toEqual({ form: 'none' })
  })
})

describe('every signed request from an unlocked till names its credential', () => {
  it('adds X-Imani-Terminal-Credential with the voucher id, and drops it once locked', async () => {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers)
      return new Response('{}')
    })

    await signedFetch('/api/v1/portal/vouchers', 'POST', { a: 1 })
    setRequestCredential(null)
    await signedFetch('/api/v1/portal/vouchers', 'POST', { a: 1 })

    expect(seen[0][TERMINAL_CREDENTIAL_HEADER]).toBe('cred-1')
    expect(seen[1][TERMINAL_CREDENTIAL_HEADER]).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it("does not lend the till's credential to a request signed by some other key", async () => {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers)
      return new Response('{}')
    })
    const other = {
      pubkey: 'e'.repeat(64),
      signEvent: async (e: Record<string, unknown>) => ({ ...e, id: '00', pubkey: 'e'.repeat(64), sig: '00' }),
    }

    await signedFetch('/x', 'GET', undefined, other as never)

    expect(seen[0][TERMINAL_CREDENTIAL_HEADER]).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
