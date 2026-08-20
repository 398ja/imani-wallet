import { describe, it, expect } from 'vitest'

import { ISSUED_D_PREFIX } from '../issuedRecords'

describe('ISSUED_D_PREFIX', () => {
  it('namespaces the legacy issuance records apart from the shop record', () => {
    // Both are kind-30078 under the same key. A prefix collision would make
    // `newestAddressable(…, 'imani:merchant')` and the issuance query fight over
    // the same events. The round-trip these records used to guarantee now lives
    // in txRecords.test.ts — this module only reads what is already published.
    expect(ISSUED_D_PREFIX).toBe('imani:issued:')
    expect('imani:merchant'.startsWith(ISSUED_D_PREFIX)).toBe(false)
  })
})
