import { describe, expect, it } from 'vitest'

import { parseLatLng } from '../coords'

describe('parseLatLng', () => {
  it('splits a well-formed pair', () => {
    expect(parseLatLng('51.5074, -0.1278')).toEqual({ lat: '51.5074', lng: '-0.1278' })
  })

  it('rejects a half-typed pair', () => {
    // Number('') is 0, which is a real coordinate — this is the case that makes
    // the emptiness check load-bearing rather than decorative.
    expect(parseLatLng('51.5, ')).toBeNull()
    expect(parseLatLng(', -0.12')).toBeNull()
  })

  it('rejects anything that is not two numbers', () => {
    expect(parseLatLng('Bridge Street')).toBeNull()
    expect(parseLatLng('1, 2, 3')).toBeNull()
    expect(parseLatLng(undefined)).toBeNull()
  })
})
