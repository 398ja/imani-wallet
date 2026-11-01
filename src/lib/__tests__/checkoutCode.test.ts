import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CHECKOUT_ALPHABET, checkSymbol, compact, display, isValidBody, normalise } from '../checkoutCode'

interface Vectors {
  alphabet: string
  generate: Array<{ data: string; check: string; display: string; canonical: string }>
  normalise: Array<{ input: string; canonical: string }>
  reject: Array<{ input: string; reason: 'not_a_code' | 'check' }>
}

const vectors = JSON.parse(readFileSync(resolve(__dirname, '../../../docs/checkout-codes/vectors.json'), 'utf8')) as Vectors

describe('checkout code (#402 contract §1)', () => {
  it('uses the shared alphabet', () => {
    expect(CHECKOUT_ALPHABET).toBe(vectors.alphabet)
  })

  it.each(vectors.generate)('generate vector $data', (v) => {
    expect(checkSymbol(v.data)).toBe(v.check)
    expect(isValidBody(v.data + v.check)).toBe(true)
    expect(display(v.canonical)).toBe(v.display)
    expect(compact(v.canonical)).toBe(v.canonical)
    expect(normalise(v.display)).toEqual({ ok: true, canonical: v.canonical })
  })

  it.each(vectors.normalise)('normalises $input', (v) => {
    expect(normalise(v.input)).toEqual({ ok: true, canonical: v.canonical })
  })

  it.each(vectors.reject)('rejects $input as $reason', (v) => {
    expect(normalise(v.input)).toEqual({ ok: false, problem: v.reason })
  })

  it('catches every single-symbol typo', () => {
    const body = '7K3Q9MXP2DV3'
    for (let i = 0; i < body.length; i++) {
      for (const c of CHECKOUT_ALPHABET) {
        if (c === body[i]) continue
        expect(isValidBody(body.slice(0, i) + c + body.slice(i + 1))).toBe(false)
      }
    }
  })

  it('refuses to display something that is not canonical', () => {
    expect(() => display('IMANI7K3Q9MXP2DV4')).toThrow()
    expect(() => checkSymbol('SHORT')).toThrow()
  })
})
