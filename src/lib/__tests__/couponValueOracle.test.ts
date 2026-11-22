// @vitest-environment jsdom
/**
 * #640 review: `couponValue` (wallet-core) against the gateway-core v0.42.0 split as modelled by
 * `sendFace.splitOf`. A PROPORTIONAL coupon is worth exactly the most the gateway will send from it
 * (`CouponRate.shownFaceOf`, half up). Under another strategy it is never more than that, and
 * whatever it says can be sent.
 */
import { it, expect } from 'vitest'
import { couponValue } from '@imani/wallet-core'
import { splitOf } from '../sendFace'
import { parseVoucherToken } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'

it('matches what the gateway will really send, across ratios, strategies and sat counts', () => {
  const ratios = [0.05797720797720798, 0.06969334926324174, 131.57894736842104, 128.3, 3.7, 1, 0.5, 0.4999, 2.5, 25]
  const bad: string[] = []
  for (const ratio of ratios)
    for (const strat of ['PROPORTIONAL', 'FULL', 'MINIMAL'])
      for (const sats of [1, 2, 3, 7, 8, 9, 10, 11, 17, 19, 64, 101]) {
        const signed = Math.max(1, Math.round(sats * ratio * 3))
        const token = buildVoucherToken({ voucherId: 'v', faceValue: signed, unit: 'GBP', issuanceRatio: ratio, backingStrategy: strat, expiresAt: 1_900_000_000 }, [sats]).token
        const p = parseVoucherToken(token)
        let most = 0
        for (let a = 1; a <= Math.ceil(sats * ratio) + Math.ceil(ratio) + 2; a++) if (splitOf(p, a)) most = a
        const cv = couponValue({ face_value: signed, token_amount: sats, issuance_ratio: ratio, backing_strategy: strat } as never)
        const at = `${strat} ratio=${ratio} sats=${sats}: couponValue=${cv} gateway=${most}`
        if (strat === 'PROPORTIONAL' ? cv !== most : cv > most) bad.push(at)
        if (cv > 0 && !splitOf(p, cv)) bad.push(`unsendable ${at}`)
      }
  expect(bad).toEqual([])
})
