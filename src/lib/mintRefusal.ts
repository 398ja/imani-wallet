/**
 * A request the mint answered with an error, carrying the mint's NUT-00 error code.
 *
 * The code is kept because some refusals call for a specific recovery rather than a retry,
 * and the human-readable `detail` is not a stable thing to match on.
 */
export class MintRefusal extends Error {
  readonly code?: number
  readonly detail?: string
  readonly status: number

  constructor(message: string, status: number, code?: number, detail?: string) {
    super(message)
    this.name = 'MintRefusal'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/** NUT-00 `12002`: the outputs name a keyset the mint no longer signs with. */
export const KEYSET_INACTIVE = 12002

/**
 * Whether the mint refused because the outputs are on a retired keyset (cashu-mint keyset
 * rotation). The request was rejected at validation, before any input was spent.
 */
export function isKeysetInactive(failure: unknown): boolean {
  if (!(failure instanceof MintRefusal)) return false
  return failure.code === KEYSET_INACTIVE
}
