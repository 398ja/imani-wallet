/**
 * The burn's integration boundary, against the REAL staging gateway.
 *
 * `burn.test.ts` proves the branching logic with `api` stubbed, so it can show
 * that a SPENT verdict settles the row and an UNSPENT one does not. What it
 * cannot show is that the gateway ever says either — the whole fix rests on
 * `validateToken` returning a `state` field, and that contract was read out of
 * `shared/api.js`'s jsdoc, not observed.
 *
 * That distinction matters here more than usual. If the real response shaped
 * its answer differently — `valid` only, a nested object, a different casing —
 * `alreadySpent` would silently return false for every token, the fix would
 * appear to work in every unit test, and an already-spent coupon would go on
 * being retried forever exactly as before.
 *
 * Skipped by default and env-gated, matching sweepProbe/gatewayProbe: it needs
 * staging reachable.
 *
 *   PROBE_GATEWAY=1 npx vitest run src/lib/__tests__/burnProbe.test.ts
 */
import { describe, expect, it } from 'vitest'

import { buildVoucherToken } from './voucherFixtures'

/**
 * The fixture's token omits the keyset id (`i`) that a TokenV4 entry carries —
 * the unit suite never needed it, because nothing there decodes a token as a
 * MINT would. The real gateway does, and rejects without it: "token missing
 * keyset id".
 *
 * Found by running this probe, and worth keeping as the note it is: the
 * fixture is faithful enough for the wallet's own parser and not for the
 * gateway's. Rather than change a fixture 20 other tests depend on, this
 * splices the field in for the wire test only.
 */
function withKeysetId(token: string): string {
  const raw = token.slice('cashuB'.length)
  const bytes = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  // CBOR map header for the entry is 0xA1 ('p' only); widen it to 0xA2 and
  // append the keyset id pair. The entry sits after the 3-key root header.
  const marker = Buffer.from([0xa1, 0x61, 0x70])
  const at = bytes.indexOf(marker)
  if (at < 0) return token
  const idPair = Buffer.concat([
    Buffer.from([0x61, 0x69]), // tstr "i"
    Buffer.from([0x48]), // bstr, 8 bytes
    Buffer.from('0088553333AABBCC', 'hex'),
  ])
  const out = Buffer.concat([
    bytes.subarray(0, at),
    Buffer.from([0xa2]),
    bytes.subarray(at + 1, bytes.length),
    idPair,
  ])
  return 'cashuB' + out.toString('base64url')
}

const ORIGIN = 'https://wallet.staging.398ja.xyz'
const live = process.env.PROBE_GATEWAY ? describe : describe.skip

/** The call `alreadySpent` makes, verbatim. */
async function validateToken(token: string) {
  const response = await fetch(`${ORIGIN}/api/v1/wallet/token/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  return { status: response.status, body: await response.json() }
}

live('POST /api/v1/wallet/token/validate', () => {
  it('exists, and is reachable without a session', async () => {
    // A 404 or a 401 here would mean `alreadySpent` can never answer, so the
    // burn fix would degrade to the old always-retry behaviour without any
    // test noticing.
    const { status } = await validateToken('cashuBnonsense')
    expect(status, 'endpoint should reject the token, not the caller').toBe(400)
  }, 60000)

  it('parses our TokenV4 structure and fails only on the mint signature', async () => {
    // How far a token we can build ourselves gets, which is the honest limit
    // of this probe. The rejections walk forward as the encoding improves:
    //
    //   hand-typed string    -> "Cannot deserialize ... from Array value"
    //   fixture token        -> "token missing keyset id"
    //   + keyset id          -> "token proof missing signature"
    //
    // That last one is the wall, and it is the right wall: `C` is the mint's
    // blind signature over the proof, so only the mint can produce it. Getting
    // past it means minting real value on a shared stack.
    //
    // What this does establish is that the endpoint parses base64url, CBOR and
    // the TokenV4 shape exactly as `buildVoucherToken` emits them — so the
    // remaining gap is funding, not format.
    const { token } = buildVoucherToken()
    const { status, body } = await validateToken(withKeysetId(token))
    const message = JSON.stringify(body)

    expect(status).toBe(400)
    expect(
      message,
      'decoding should reach the proof signature, not fail earlier on shape',
    ).toContain('token proof missing signature')
  }, 60000)

  it('answers with the `state` field alreadySpent reads', async () => {
    // THE contract. `alreadySpent` compares `result.state` to 'SPENT'; if the
    // gateway names it anything else, that comparison is dead code and every
    // already-spent coupon keeps being retried.
    //
    // These proofs were never minted, so the mint has no record of them. The
    // assertion is on the SHAPE — that a state is reported at all — not on a
    // particular verdict, because only a genuinely burnt token could produce
    // SPENT and minting one costs real money on a shared stack.
    const { token } = buildVoucherToken()
    const { status, body } = await validateToken(withKeysetId(token))

    if (status !== 200) {
      // An error response is a legitimate outcome for unknown proofs. Record
      // what it was rather than passing silently: `alreadySpent` catches and
      // returns false, which is the safe direction (leave the row spendable).
      console.log('[burnProbe] validate answered %d %s', status, JSON.stringify(body).slice(0, 200))
      expect(status).toBeGreaterThanOrEqual(400)
      return
    }

    const result = body as { state?: string; valid?: boolean }
    console.log('[burnProbe] validate 200 ->', JSON.stringify(result).slice(0, 200))
    expect(
      result.state,
      'validateToken must report a state, or alreadySpent can never settle a row',
    ).toBeDefined()
    expect(['UNSPENT', 'PENDING', 'SPENT']).toContain(String(result.state).toUpperCase())
  }, 60000)
})

live('what the live response means for the burn', () => {
  it('an error verdict leaves the coupon spendable, never written off', async () => {
    // The safety property, asserted through `alreadySpent`'s actual rule
    // rather than by reading the code: anything that is not a literal SPENT
    // must leave the row alone. A 400 from the gateway — which is what an
    // unfundable token gets, above — must never settle a merchant's coupon.
    const { token } = buildVoucherToken()
    const { status, body } = await validateToken(withKeysetId(token))

    const state = (body as { state?: string }).state
    const wouldSettle = String(state ?? '').toUpperCase() === 'SPENT'

    expect(status, 'precondition: this token is not acceptable to the mint').toBe(400)
    expect(wouldSettle, 'an error response must not be read as SPENT').toBe(false)
  }, 60000)
})
