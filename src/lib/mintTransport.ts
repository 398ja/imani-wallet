import type { MintTransport, ReceivableProof } from './receiveSwap'
import type { BlindSignatureResponse } from './walletSwap'
import { referencedDocuments } from './voucherToken'
import { MintRefusal } from './mintRefusal'

/**
 * Talking to the mint over HTTP.
 *
 * The only part of a wallet-side receive that touches the network, kept apart
 * from the orchestration in `receiveSwap` for two reasons. The sequence there can
 * be driven against a fake mint, including the failures a real one will not
 * produce on request. And the wire format gets somewhere of its own to be pinned,
 * rather than being asserted incidentally in tests about something else.
 *
 * ## What it must never send
 *
 * Outputs are projected to `{amount, id, B_}` before the request. The secret and
 * the blinding factor stay in the wallet, and that is the whole reason a
 * wallet-side swap fixes the custody bug. The projection is deliberate rather
 * than incidental: callers hold full `BlindedOutput` values, so passing one
 * straight through would leak both without anything failing.
 *
 * See `imani-docs/wallet/explanation/the-wallet-swaps-its-own-receives.md`.
 */

/** How long to wait before giving up on the mint. */
const DEFAULT_TIMEOUT_MS = 30_000

export interface MintTransportOptions {
  /**
   * Abort a request after this long.
   *
   * A receive that hangs is worse than one that fails: the screen waits forever
   * and the customer cannot tell whether their coupon arrived. The abort is
   * reported as a timeout so the caller can tell it from a refusal, which matters
   * because a timeout may mean the swap DID happen.
   */
  timeoutMs?: number
}

/** A mint URL without the trailing slash that would double up in a path. */
function baseUrl(mintUrl: string): string {
  return mintUrl.trim().replace(/\/+$/, '')
}

/** The mint's own reason for refusing, when it gave one. */
async function refusal(response: Response, what: string): Promise<Error> {
  // The body is read for its `detail`, which is where the mint puts the reason.
  // "Token already spent" and "amounts do not balance" lead to entirely different
  // actions, so losing it would send somebody to the logs for an answer the
  // response already carried.
  const body = (await response.json().catch(() => null)) as { detail?: string; code?: unknown } | null
  const detail = typeof body?.detail === 'string' ? body.detail : undefined
  // The NUT-00 code too, so a caller can act on a specific refusal (12002, #248).
  const code = typeof body?.code === 'number' ? body.code : undefined
  return new MintRefusal(
    detail ? `${what} refused by the mint: ${detail}` : `${what} failed with HTTP ${response.status}`,
    response.status,
    code,
    detail,
  )
}

/**
 * The mint transport the app uses.
 *
 * A factory rather than a module-level object so a caller can vary the timeout,
 * and so nothing is constructed at import time.
 */
export function createMintTransport(options: MintTransportOptions = {}): MintTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /** `fetch` that gives up rather than hanging a screen forever. */
  async function request(url: string, init: RequestInit, what: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } catch (failure) {
      // Named distinctly, because the caller's response to each differs: a refusal
      // is final, a timeout is not.
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error(`${what} timed out after ${timeoutMs}ms`)
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  async function getJson<T>(mintUrl: string, path: string, what: string): Promise<T> {
    const response = await request(`${baseUrl(mintUrl)}${path}`, { method: 'GET' }, what)
    if (!response.ok) throw await refusal(response, what)
    return (await response.json()) as T
  }

  async function postJson<T>(
    mintUrl: string,
    path: string,
    body: unknown,
    what: string,
  ): Promise<T> {
    const response = await request(
      `${baseUrl(mintUrl)}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      what,
    )
    if (!response.ok) throw await refusal(response, what)
    return (await response.json()) as T
  }

  return {
    /**
     * The keyset fresh proofs should be signed under.
     *
     * The ACTIVE sat keyset, and both words matter. A retired keyset still
     * verifies today and may stop being served later, which is how a coupon
     * becomes unspendable weeks after it was safely received. A keyset in another
     * unit is not ours at all.
     */
    async activeKeysetId(mintUrl: string): Promise<string> {
      const { keysets } = await getJson<{
        keysets: { id: string; unit: string; active: boolean }[]
      }>(mintUrl, '/v1/keysets', 'reading the mint keysets')

      const active = keysets?.find((keyset) => keyset.active && keyset.unit === 'sat')
      if (!active) {
        throw new Error(`${mintUrl} has no active sat keyset to receive into`)
      }
      return active.id
    },

    /**
     * The mint's public key per denomination, needed to unblind.
     *
     * Checks the answer is for the keyset that was ASKED for. Being handed another
     * is the same class of wrong answer `unblindOutputs` guards against, and
     * catching it here names the real problem rather than surfacing it later as a
     * proof that fails at its next spend for no visible reason.
     */
    async keysetKeys(mintUrl: string, keysetId: string): Promise<Record<string, string>> {
      const { keysets } = await getJson<{
        keysets: { id: string; keys: Record<string, string> }[]
      }>(mintUrl, `/v1/keys/${keysetId}`, 'reading the mint keys')

      const keyset = keysets?.[0]
      if (!keyset || keyset.id !== keysetId) {
        throw new Error(
          `asked for keyset ${keysetId} and the mint answered for ${keyset?.id ?? 'nothing'}`,
        )
      }
      if (!keyset.keys || Object.keys(keyset.keys).length === 0) {
        throw new Error(`keyset ${keysetId} came back with no keys`)
      }
      return keyset.keys
    },

    /**
     * The swap itself: spend these proofs, sign these blinded messages.
     *
     * The witness travels INSIDE each input proof, which is where NUT-11 puts it.
     * The old gateway path carried witnesses in a request header, so this is the
     * one place the wire genuinely differs, and getting it wrong means a locked
     * coupon cannot be received at all.
     */
    async swap(
      mintUrl: string,
      { inputs, outputs }: { inputs: ReceivableProof[]; outputs: { amount: number; id: string; B_: string }[] },
    ): Promise<{ signatures: BlindSignatureResponse[] }> {
      // cashu-voucher#64: the documents by-reference inputs point at, once each. Only when needed,
      // so a request without one is byte-identical to before.
      const vouchers = referencedDocuments(inputs)
      return postJson(
        mintUrl,
        '/v1/swap',
        {
          inputs: inputs.map(({ amount, id, secret, C, witness }) => ({
            amount,
            id,
            secret,
            C,
            ...(witness === undefined ? {} : { witness }),
          })),
          // Projected explicitly. A caller holding a full `BlindedOutput` would
          // otherwise send its secret and blinding factor, which is precisely what
          // must never leave the wallet.
          outputs: outputs.map(({ amount, id, B_ }) => ({ amount, id, B_ })),
          ...(vouchers ? { vouchers } : {}),
        },
        'the swap',
      )
    },

    /**
     * NUT-09: which of these blinded messages has the mint already signed?
     *
     * Returns the matched outputs ALONGSIDE the signatures, and that pairing is
     * load-bearing. The mint answers only for messages it holds signatures for, so
     * a partial answer is normal, and without knowing which outputs were matched
     * the caller could only take all or nothing. Taking nothing abandons money the
     * mint really did sign.
     */
    async restore(
      mintUrl: string,
      outputs: { amount: number; id: string; B_: string }[],
    ): Promise<{ outputs: { B_: string }[]; signatures: BlindSignatureResponse[] }> {
      const answer = await postJson<{
        outputs?: { B_: string }[]
        signatures?: BlindSignatureResponse[]
      }>(
        mintUrl,
        '/v1/restore',
        { outputs: outputs.map(({ amount, id, B_ }) => ({ amount, id, B_ })) },
        'the restore',
      )

      // A mint that answers with signatures alone cannot be read safely: the
      // caller would have to GUESS which outputs they belong to, and a wrong guess
      // builds a proof against the wrong secret. Refusing is the honest response.
      if (!Array.isArray(answer.outputs)) {
        throw new Error('the mint restored signatures without saying which outputs they are for')
      }
      return { outputs: answer.outputs, signatures: answer.signatures ?? [] }
    },
  }
}
