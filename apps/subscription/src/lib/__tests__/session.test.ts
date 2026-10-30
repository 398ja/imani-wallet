/**
 * @vitest-environment jsdom
 *
 * The header's name hint from the wallet (`?name=` / `?nip05=` beside `?as=`): display only, kept
 * across the Stripe round trip, and only ever for the pubkey it came with.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { stallLabel } from '../session'

const PK = 'b233db854f554ab10c82b852d15df4f73acd5b358790d5d89d5bf77a6d60de1e'

describe('stallLabel', () => {
  beforeEach(() => sessionStorage.clear())

  it('reads name and handle for the `as` stall', () => {
    expect(stallLabel(`?as=${PK}&name=Bart&nip05=Bart@staging.398ja.xyz`)).toEqual({
      pubkey: PK,
      name: 'Bart',
      nip05: 'bart@staging.398ja.xyz',
    })
  })

  it('keeps it for the tab, so a return from Stripe (no query) still has it', () => {
    stallLabel(`?as=${PK}&name=Bart`)
    expect(stallLabel('')).toEqual({ pubkey: PK, name: 'Bart' })
  })

  it('ignores a hint with no valid `as`, and strips control characters and length', () => {
    expect(stallLabel('?name=Mallory')).toBeUndefined()
    expect(stallLabel('?as=nothex&name=Mallory')).toBeUndefined()
    const long = 'x'.repeat(200)
    const label = stallLabel(`?as=${PK}&name=${encodeURIComponent('Ba\u0000rt\n' + long)}`)
    expect(label?.name?.startsWith('Bart')).toBe(true)
    expect(label?.name?.length).toBe(64)
  })

  it('has nothing to say when the wallet sent no name', () => {
    expect(stallLabel(`?as=${PK}`)).toBeUndefined()
  })
})
