import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { receivedRowIdFor } from '../dmPoll'

describe('spec 049: the payee receipt names its incoming row', () => {
  const T = 'ab'.repeat(16)
  it('finds the incoming row by transfer id, not an outgoing one', () => {
    const rows = [
      { id: 'sent:x', type: 'sent', direction: 'out', transferId: T },
      { id: 'other', type: 'received', transferId: 'cd'.repeat(16) },
      { id: 'voucher:new-token-id', type: 'received', transferId: T },
    ]
    expect(receivedRowIdFor(rows, T)).toBe('voucher:new-token-id')
  })
  it('reads the snake_case field and answers undefined when no row matches', () => {
    expect(receivedRowIdFor([{ id: 'r', transfer_id: T }], T)).toBe('r')
    expect(receivedRowIdFor([{ id: 'r', transferId: 'zz' }], T)).toBeUndefined()
  })
})
