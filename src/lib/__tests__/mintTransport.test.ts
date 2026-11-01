/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

import { createMintTransport } from '../mintTransport'

/**
 * Talking to the mint over HTTP.
 *
 * The only part of the receive that touches the network. Kept apart from
 * `receiveSwap` so the orchestration can be driven by a fake, and so the wire
 * format has somewhere to be pinned on its own.
 *
 * Every test drives a stubbed `fetch`. The live mint is covered by
 * `walletSwapProbe` and `swapRecoveryProbe`; what matters here is the shapes,
 * the failures and the things that must never be sent.
 */

const MINT = 'https://mint.example.test'
const KEYSET = '01ef5b830da1f32acd88bdf30c246627833672eb53112b7e2962a608ba96773aa9'
const RETIRED = '00e3372e61d05605'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('finding the keyset to receive into', () => {
  /**
   * The ACTIVE keyset, not merely the first one. Receiving into a retired keyset
   * produces proofs whose keys the mint may stop serving, which is how a coupon
   * becomes unspendable weeks after it was safely received.
   */
  it('picks the active sat keyset, ignoring retired ones', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        keysets: [
          { id: RETIRED, unit: 'sat', active: false },
          { id: KEYSET, unit: 'sat', active: true },
        ],
      }),
    )

    expect(await createMintTransport().activeKeysetId(MINT)).toBe(KEYSET)
  })

  /** A keyset in another unit is not ours, however active it is. */
  it('ignores an active keyset in another unit', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        keysets: [
          { id: 'abc', unit: 'usd', active: true },
          { id: KEYSET, unit: 'sat', active: true },
        ],
      }),
    )

    expect(await createMintTransport().activeKeysetId(MINT)).toBe(KEYSET)
  })

  /**
   * No active sat keyset is a mint we cannot receive from. Throwing beats
   * returning something arbitrary, which would be discovered at the swap with a
   * far less useful message.
   */
  it('refuses when the mint has no active sat keyset', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ keysets: [{ id: RETIRED, unit: 'sat', active: false }] }),
    )

    await expect(createMintTransport().activeKeysetId(MINT)).rejects.toThrow(/active/)
  })

  it('reports an unreachable mint rather than hanging', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(createMintTransport().activeKeysetId(MINT)).rejects.toThrow(/network down/)
  })

  /**
   * The mint's own reason is preferred over the status code, because it is the
   * more useful of the two. "Token already spent" and "amounts do not balance"
   * lead to different actions. A bare 400 leads to the logs.
   */
  it('reports the mint reason when it gives one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'keyset unavailable' }, 500))
    await expect(createMintTransport().activeKeysetId(MINT)).rejects.toThrow(/keyset unavailable/)
  })

  /** And falls back to the status when the mint says nothing useful. */
  it('reports the status when the mint gives no reason', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }))
    await expect(createMintTransport().activeKeysetId(MINT)).rejects.toThrow(/500/)
  })
})

describe('reading the keyset public keys', () => {
  it('returns the amount-to-key map for a keyset', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ keysets: [{ id: KEYSET, unit: 'sat', keys: { '1': '02aa', '2': '02bb' } }] }),
    )

    expect(await createMintTransport().keysetKeys(MINT, KEYSET)).toEqual({
      '1': '02aa',
      '2': '02bb',
    })
  })

  /**
   * Asking for one keyset and being handed another is the class of wrong answer
   * `unblindOutputs` guards against downstream. Catching it here names the real
   * problem instead of surfacing it as a proof that fails at its next spend.
   */
  it('refuses keys returned for a different keyset', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ keysets: [{ id: RETIRED, unit: 'sat', keys: { '1': '02aa' } }] }),
    )

    await expect(createMintTransport().keysetKeys(MINT, KEYSET)).rejects.toThrow(/keyset/)
  })

  it('refuses an empty key map', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ keysets: [{ id: KEYSET, unit: 'sat', keys: {} }] }),
    )

    await expect(createMintTransport().keysetKeys(MINT, KEYSET)).rejects.toThrow(/keys/)
  })
})

describe('the swap request', () => {
  const inputs = [{ amount: 2, id: KEYSET, secret: 'aa'.repeat(32), C: '02' + 'bb'.repeat(32) }]
  const outputs = [{ amount: 2, id: KEYSET, B_: '02' + 'cc'.repeat(32) }]

  it('posts inputs and outputs and returns the signatures', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ signatures: [{ id: KEYSET, amount: 2, C_: '02' + 'dd'.repeat(32) }] }),
    )

    const result = await createMintTransport().swap(MINT, { inputs, outputs })

    expect(result.signatures).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${MINT}/v1/swap`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ inputs, outputs })
  })

  /**
   * The witness travels INSIDE the input proof, which is where NUT-11 puts it.
   * The gateway path used a header, so this is the one place the wire genuinely
   * differs, and getting it wrong means a locked coupon cannot be received.
   */
  it('carries the witness on the input proof itself', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ signatures: [] }))
    const witnessed = [{ ...inputs[0], witness: '{"signatures":["ab"]}' }]

    await createMintTransport().swap(MINT, { inputs: witnessed, outputs })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.inputs[0].witness).toBe('{"signatures":["ab"]}')
  })

  /**
   * The security claim, asserted on the bytes actually sent. A blinding factor
   * reaching the mint would make the whole design pointless, and it is the kind
   * of mistake a stray spread operator makes silently.
   */
  it('sends nothing but the blinded message for each output', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ signatures: [] }))

    await createMintTransport().swap(MINT, {
      inputs,
      // A caller passing a full BlindedOutput by mistake must still not leak.
      outputs: [{ ...outputs[0], secret: 'SECRET-VALUE', r: 'BLINDING-FACTOR' } as never],
    })

    const body = fetchMock.mock.calls[0][1].body as string
    expect(body).not.toContain('SECRET-VALUE')
    expect(body).not.toContain('BLINDING-FACTOR')
    expect(body).toContain('B_')
  })

  /**
   * A refused swap must say WHY. `already spent` and `amounts do not balance`
   * lead to completely different actions, and an opaque "swap failed" sends
   * somebody to the logs for an answer the response already had.
   */
  it('reports the mint error detail on a refusal', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Token already spent.', code: 11001 }, 400),
    )

    await expect(createMintTransport().swap(MINT, { inputs, outputs })).rejects.toThrow(
      /already spent/i,
    )
  })

  it('includes the status when the mint sends no detail', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }))
    await expect(createMintTransport().swap(MINT, { inputs, outputs })).rejects.toThrow(/502/)
  })
})

describe('the restore request', () => {
  const outputs = [
    { amount: 2, id: KEYSET, B_: '02' + 'cc'.repeat(32) },
    { amount: 1, id: KEYSET, B_: '02' + 'ee'.repeat(32) },
  ]

  /**
   * Both arrays come back, because a partial answer has to be readable. Returning
   * only the signatures would leave the caller unable to tell WHICH outputs were
   * signed, so it could take all or nothing, which is the bug the review found.
   */
  it('returns the matched outputs alongside the signatures', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        outputs: [{ amount: 2, id: KEYSET, B_: outputs[0].B_ }],
        signatures: [{ id: KEYSET, amount: 2, C_: '02' + 'dd'.repeat(32) }],
      }),
    )

    const result = await createMintTransport().restore(MINT, outputs)

    expect(result.outputs).toEqual([{ amount: 2, id: KEYSET, B_: outputs[0].B_ }])
    expect(result.signatures).toHaveLength(1)
  })

  /** Nothing signed is a normal answer, not a failure. */
  it('returns empty arrays when the mint signed none of them', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outputs: [], signatures: [] }))

    const result = await createMintTransport().restore(MINT, outputs)

    expect(result.outputs).toEqual([])
    expect(result.signatures).toEqual([])
  })

  /**
   * An older mint that answers with signatures alone cannot be read safely: the
   * caller would have to guess which outputs they belong to, and guessing wrong
   * builds a proof against the wrong secret. Refuse rather than guess.
   */
  it('refuses an answer that omits the outputs array', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ signatures: [{ id: KEYSET, amount: 2, C_: '02' + 'dd'.repeat(32) }] }),
    )

    await expect(createMintTransport().restore(MINT, outputs)).rejects.toThrow(/outputs/)
  })

  it('posts the blinded messages to the restore endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outputs: [], signatures: [] }))

    await createMintTransport().restore(MINT, outputs)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${MINT}/v1/restore`)
    expect(JSON.parse(init.body)).toEqual({ outputs })
  })
})

describe('a mint URL with a trailing slash', () => {
  /**
   * The gateway reports its mint with and without one at different times, and a
   * doubled slash is a 404 on some servers. Normalised once here rather than at
   * every call site.
   */
  it('does not produce a doubled slash in the path', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ keysets: [{ id: KEYSET, unit: 'sat', active: true }] }),
    )

    await createMintTransport().activeKeysetId(`${MINT}/`)

    expect(fetchMock.mock.calls[0][0]).toBe(`${MINT}/v1/keysets`)
  })
})

describe('a mint that never answers', () => {
  /**
   * A receive must fail rather than hang a screen for ever. The abort is
   * reported as a timeout so the caller can distinguish it from a refusal, which
   * matters because a timeout may mean the swap DID happen.
   */
  it('gives up after the timeout', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )

    const pending = createMintTransport({ timeoutMs: 1000 }).activeKeysetId(MINT)
    const assertion = expect(pending).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
    vi.useRealTimers()
  })
})
