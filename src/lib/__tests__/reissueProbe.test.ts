/**
 * @vitest-environment node
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils'
import { blindMessage } from '@cashu/crypto/modules/client'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

import { createMintTransport } from '../mintTransport'
import type { ReceivableProof } from '../receiveSwap'
import { tokenProofs, type TokenProof } from '../voucherToken'
import { reissueVoucherSecret, VoucherReissueRefused, type LockKeyLender } from '../voucherReissue'
import { blindOutputs, splitIntoDenominations, unblindOutputs, type BlindedOutput } from '../walletSwap'
import type { RequestSigner } from '../nip98'

/**
 * A voucher re-lock, end to end, against the real staging gateway and mint.
 *
 * The unit tests prove each side agrees with a written-down message. This proves
 * the whole transfer works with nothing faked: the gateway issues a coupon locked
 * to A, A burns it at the mint, the gateway re-signs a successor locked to B only
 * because A signed for it, and the mint then treats that successor as a real,
 * locked voucher that B alone can spend.
 *
 * Each refusal arm is checked on the live service too, because a guard that only
 * refuses in a unit test is a guard nobody has seen refuse:
 *
 *  - asked before the burn: `PREDECESSOR_NOT_SPENT`, retryable
 *  - asked by someone who knows both secrets but not A's key: `NOT_AUTHORISED_BY_HOLDER`
 *  - asked again, identically: the SAME successor, so a lost response is recoverable
 *  - asked again with a different proposal: `PREDECESSOR_ALREADY_CLAIMED`
 *  - the successor spent without B's witness: refused by the mint
 *
 * Costs a few sats of the staging gateway's float, so gated:
 *
 *   PROBE_REISSUE=1 npx vitest run src/lib/__tests__/reissueProbe.test.ts
 *
 * The staging mint rate-limits, so leave about 70 s between runs.
 */
const ORIGIN = process.env.STAGING_WALLET_URL ?? 'https://wallet.staging.398ja.xyz'
const MINT = process.env.STAGING_MINT_URL ?? 'https://mint.staging.398ja.xyz'
const FACE_VALUE_SATS = 1
const live = process.env.PROBE_REISSUE ? describe : describe.skip

/**
 * `signedFetch` is written for the page, so it signs `window.location.origin + path`
 * and fetches the bare path. Under node there is no page, so both are pointed at
 * staging here. Production code is unchanged.
 */
function actAsTheWalletPage(): void {
  Object.defineProperty(globalThis, 'window', {
    value: { location: { origin: ORIGIN } },
    configurable: true,
    writable: true,
  })
  const nodeFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nodeFetch(typeof input === 'string' && input.startsWith('/') ? ORIGIN + input : input, init)) as typeof fetch
}

/** One party in the transfer: a nostr key that is also the key coupons lock to. */
interface Party {
  secretKey: Uint8Array
  /** Compressed, as a voucher's `data` carries it. `02` because BIP-340 keys are even-y. */
  lockKey: string
  signer: RequestSigner
  lendKey: LockKeyLender
}

function newParty(): Party {
  const secretKey = generateSecretKey()
  return {
    secretKey,
    lockKey: '02' + getPublicKey(secretKey),
    signer: { signEvent: async (template) => finalizeEvent(template, secretKey) },
    lendKey: (borrow) => borrow(secretKey.slice()),
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function gateway(party: Party, path: string, method: string, payload?: unknown) {
  const { signedFetch } = await import('../nip98')
  const response = await signedFetch(path, method, payload, party.signer)
  return { status: response.status, body: (await response.json().catch(() => null)) as never }
}

/** A coupon the staging gateway issues, locked to `holder`. */
async function issueLockedCoupon(holder: Party): Promise<TokenProof> {
  const created = await gateway(holder, '/api/v1/wallet/vouchers', 'POST', {
    face_value: FACE_VALUE_SATS,
    face_unit: 'sat',
    face_decimals: 0,
    mint_url: MINT,
    backing_strategy: 'FIXED',
    recipient_pubkey: holder.lockKey.slice(2),
    backing_sats: FACE_VALUE_SATS,
  })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const { voucher_id: voucherId } = created.body as { voucher_id: string; token?: string }
  let token = (created.body as { token?: string }).token
  // Issuance is funded asynchronously, so the token can lag the 201.
  for (let attempt = 0; !token && attempt < 10; attempt++) {
    await pause(3_000)
    token = ((await gateway(holder, `/api/v1/wallet/vouchers/${voucherId}`, 'GET')).body as { token?: string })?.token
  }
  expect(token, `voucher ${voucherId} never produced a token`).toBeTruthy()
  const proofs = tokenProofs(token!)
  expect(proofs, 'a 1 sat coupon is one proof').toHaveLength(1)
  return proofs[0]
}

/** A NUT-11 witness: the lock key's signature over the secret. */
function witnessFor(secret: string, secretKey: Uint8Array): string {
  const signature = schnorr.sign(sha256(utf8ToBytes(secret)), secretKey)
  return JSON.stringify({ signatures: [bytesToHex(signature)] })
}

/**
 * The successor A proposes for B: the same coupon with only the lock key and the
 * nonce changed. The issuer signature is dropped, because it no longer covers
 * these bytes and the gateway supplies the new one.
 */
function successorFor(predecessor: string, receiver: Party): string {
  const [kind, body] = JSON.parse(predecessor) as [string, { nonce: string; data: string; tags: string[][] }]
  return JSON.stringify([
    kind,
    {
      nonce: bytesToHex(randomBytes(32)),
      data: receiver.lockKey,
      tags: body.tags.filter(([key]) => key !== 'issuer_sig' && key !== 'issuer_pubkey'),
    },
  ])
}

/** A blinded output whose secret the caller chose, here the gateway-signed successor. */
function outputCarrying(secret: string, amount: number, keysetId: string): BlindedOutput {
  const blinded = blindMessage(utf8ToBytes(secret), undefined)
  return {
    amount,
    id: keysetId,
    B_: blinded.B_.toHex(true),
    secret,
    r: blinded.r.toString(16).padStart(64, '0'),
  }
}

/** The mint's view of whether these secrets are still spendable. */
async function statesOf(secrets: string[]): Promise<string[]> {
  const { hashToCurve } = await import('@cashu/crypto/modules/common')
  const Ys = secrets.map((secret) => bytesToHex(hashToCurve(utf8ToBytes(secret)).toRawBytes(true)))
  const response = await fetch(MINT + '/v1/checkstate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys }),
  })
  const body = (await response.json()) as { states: { state: string }[] }
  return body.states.map((entry) => entry.state)
}

async function refusalOf(attempt: Promise<unknown>): Promise<VoucherReissueRefused> {
  const outcome = await attempt.then(
    (value) => new Error(`expected a refusal, got ${String(value).slice(0, 80)}`),
    (error: unknown) => error,
  )
  expect(outcome).toBeInstanceOf(VoucherReissueRefused)
  return outcome as VoucherReissueRefused
}

live('a voucher re-locked from A to B through the live gateway', () => {
  beforeAll(actAsTheWalletPage)

  it('moves the coupon to B, and only A could have asked for it', async () => {
    const transport = createMintTransport()
    const holder = newParty()
    const receiver = newParty()
    const stranger = newParty()

    const predecessor = await issueLockedCoupon(holder)
    const proposed = successorFor(predecessor.secret, receiver)
    const reissue = (asker: Party, proposal = proposed) =>
      reissueVoucherSecret(predecessor.secret, proposal, { signer: asker.signer, lendKey: asker.lendKey })

    const early = await refusalOf(reissue(holder))
    expect(early.refusal, 'the coupon is still live, so signing would make two').toBe('PREDECESSOR_NOT_SPENT')
    expect(early.retryable).toBe(true)

    // Burn: A spends the coupon into plain proofs of its own. This is what pays for
    // the re-signature, and what stops A spending the old coupon afterwards.
    const keysetId = await transport.activeKeysetId(MINT)
    const keys = await transport.keysetKeys(MINT, keysetId)
    const burnOutputs = blindOutputs(splitIntoDenominations(predecessor.amount), keysetId)
    const burnInput: ReceivableProof = { ...predecessor, witness: witnessFor(predecessor.secret, holder.secretKey) }
    const burnt = await transport.swap(MINT, { inputs: [burnInput], outputs: burnOutputs })
    const intermediate = unblindOutputs(burnOutputs, burnt.signatures, keys)
    expect(await statesOf([predecessor.secret])).toEqual(['SPENT'])

    // The front-run of #136: the stranger knows both secrets, as the sender would.
    const stolen = await refusalOf(reissue(stranger))
    expect(stolen.refusal).toBe('NOT_AUTHORISED_BY_HOLDER')
    expect(stolen.retryable).toBe(false)

    const signed = await reissue(holder)
    const [, signedBody] = JSON.parse(signed) as [string, { data: string; tags: string[][] }]
    expect(signedBody.data, 'the successor is locked to B').toBe(receiver.lockKey)
    expect(signedBody.tags.some(([key]) => key === 'issuer_sig')).toBe(true)

    expect(await reissue(holder), 'a resent proposal buys back the same successor').toBe(signed)
    const second = await refusalOf(reissue(holder, successorFor(predecessor.secret, receiver)))
    expect(second.refusal, 'one burn buys one signature').toBe('PREDECESSOR_ALREADY_CLAIMED')

    // Mint the successor from the plain proofs the burn produced.
    const successorOutput = outputCarrying(signed, predecessor.amount, keysetId)
    const minted = await transport.swap(MINT, { inputs: intermediate, outputs: [successorOutput] })
    const [successor] = unblindOutputs([successorOutput], minted.signatures, keys)
    expect(await statesOf([successor.secret])).toEqual(['UNSPENT'])

    // The lock is real: without B's witness the mint refuses it.
    await pause(1_500)
    const unsignedSpend = blindOutputs(splitIntoDenominations(successor.amount), keysetId)
    await expect(transport.swap(MINT, { inputs: [successor], outputs: unsignedSpend })).rejects.toThrow()

    // And the issuer signature is real: with B's witness the mint accepts it, and it
    // checks a locked voucher's signature before it does.
    const spend = blindOutputs(splitIntoDenominations(successor.amount), keysetId)
    const spent = await transport.swap(MINT, {
      inputs: [{ ...successor, witness: witnessFor(successor.secret, receiver.secretKey) }],
      outputs: spend,
    })
    expect(spent.signatures).toHaveLength(spend.length)
    expect(await statesOf([successor.secret])).toEqual(['SPENT'])
  }, 180_000)
})
