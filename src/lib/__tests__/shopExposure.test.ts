import { describe, expect, it } from 'vitest'
import { exposureLine, parseExposure } from '../shopExposure'

describe('a shop\u2019s outstanding codes (#402 R5)', () => {
  it('reads the summary and says it in the owner\u2019s words', () => {
    const e = parseExposure({ codes: 3, amount: 4500, unit: 'eur' })!
    expect(exposureLine(e, 'https://shop.example')).toMatch(/^3 codes, .*45.*outstanding at shop\.example$/)
    expect(exposureLine({ ...e, codes: 1 }, 'https://shop.example')).toMatch(/^1 code, /)
  })
  it.each([[null], [{}], [{ codes: -1, amount: 1, unit: 'eur' }], [{ codes: 1, amount: 1.5, unit: 'eur' }], [{ codes: 1, amount: 1, unit: 7 }]])(
    'refuses %j rather than guessing',
    (raw) => expect(parseExposure(raw)).toBeNull(),
  )
})
