/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fromRedemptionError, receiveTroubleFor } from '../receiveTrouble'

/**
 * #314 review: the till picks its copy from the stored record's `retryable`, so the record must
 * carry what dm-poll said. A record that always said "retryable" would put "will keep trying"
 * back on a coupon the wallet has given up on.
 */
const PUBKEY = 'b'.repeat(64)
const REQ = 'pr-0123456789abcdef'

beforeEach(() => localStorage.clear())

function emit(eventId: string, retryable?: boolean): void {
  fromRedemptionError(PUBKEY, {
    eventId,
    requestId: REQ,
    message: 'x',
    error: new Error('x'),
    token: 't',
    ...(retryable === undefined ? {} : { retryable }),
  })
}

describe('a failed receive is stored with whether it will be retried (#314)', () => {
  it('keeps retryable: false from a permanent refusal', () => {
    emit('e1', false)
    expect(receiveTroubleFor(PUBKEY, REQ)).toMatchObject([{ eventId: 'e1', kind: 'failed', retryable: false }])
  })

  it('stores a transient failure, and one from an older emitter, as retryable', () => {
    emit('e1', true)
    emit('e2')
    const byId = Object.fromEntries(receiveTroubleFor(PUBKEY, REQ).map((t) => [t.eventId, t.retryable]))
    expect(byId).toEqual({ e1: true, e2: true })
  })
})
