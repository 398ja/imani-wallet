import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import QRCode from 'qrcode'
import type { VoucherRow } from '@imani/wallet-storage'

import { toCouponPass, BARCODE_PREFIX } from '../pass'
import { QrType, QrTypeDetector } from '../../../packages/imani-qr/src/detector'
import { VoucherRedeemHandler } from '../../../packages/imani-qr/src/handlers'

/**
 * DEV-131 end to end: a pass this app builds, through a real QR image, back
 * through the real decoder, to the route a merchant lands on.
 *
 * `voucherRedeemScan.test.ts` starts from a string literal, so it proves the
 * pattern and the handler and takes the ENCODE/DECODE step on faith. This
 * closes that: it renders the actual `barcodes[0].message` off `toCouponPass`
 * into pixels and hands those to the same decoder the camera feeds.
 *
 * I had recorded this as needing hardware. That was wrong, and worth
 * correcting rather than leaving as a permanent caveat: the camera is only the
 * transport. Everything after the photons — the QR symbol, the decode, the
 * classification, the routing — is testable here, and it is where the bugs
 * would be. What remains genuinely device-only is the lens, autofocus and
 * lighting, which are qr-scanner's concern and not ours.
 */

/**
 * The real decoder qr-scanner uses, extracted from its worker bundle.
 *
 * qr-scanner ships its decoder inlined in a Worker blob and needs a browser to
 * run: `new Worker(URL.createObjectURL(...))`, canvas, video. Node has none of
 * those. But the decoding itself is pure — pixels in, string out — so the
 * worker body can be lifted out and driven directly through the same
 * `self.onmessage` contract the browser uses.
 *
 * This is the real library's real decoder, not a re-implementation. A
 * hand-rolled QR reader here would prove nothing about what the app does.
 */
function decodeQr(rgba: Uint8ClampedArray, width: number, height: number): string | null {
  const src = fs.readFileSync('node_modules/qr-scanner/qr-scanner-worker.min.js', 'utf8')
  let body = src.slice(src.indexOf('Blob([`') + 7, src.lastIndexOf('`]'))
  // The worker source sits inside a template literal, so its own backticks and
  // ${...} are escaped in the file. Undo that to get runnable JS.
  body = body.replace(/\\`/g, '`').replace(/\\\$\{/g, '${')

  let result: { data?: string | null } | undefined
  const previous = (globalThis as Record<string, unknown>).self
  ;(globalThis as Record<string, unknown>).self = {
    onmessage: null,
    postMessage: (m: unknown) => {
      result = m as { data?: string | null }
    },
    close() {},
  }
  try {
    // Indirect eval: the worker body declares top-level bindings, which a
    // `new Function` body would scope away from its own later references.
    ;(0, eval)(body)
    const worker = (globalThis as unknown as { self: { onmessage: (e: unknown) => void } }).self
    worker.onmessage({ data: { type: 'decode', id: 1, data: { data: rgba, width, height } } })
    return result?.data ?? null
  } finally {
    ;(globalThis as Record<string, unknown>).self = previous
  }
}

/**
 * Render a payload to the raw RGBA a camera frame would carry.
 *
 * Straight from `QRCode.create`'s module matrix rather than through a PNG,
 * because decoding a PNG would need an image codec this repo does not have.
 * The quiet zone is not decoration — the QR spec requires it, and a decoder
 * will refuse a symbol rendered without one.
 */
function render(payload: string, scale = 4, quiet = 4) {
  const qr = QRCode.create(payload, {})
  const size = qr.modules.size
  const data = qr.modules.data
  const dim = (size + quiet * 2) * scale
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y * size + x]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx)
          rgba[px * 4] = 0
          rgba[px * 4 + 1] = 0
          rgba[px * 4 + 2] = 0
        }
      }
    }
  }
  return { rgba, dim }
}

const VOUCHER_ID = '17be770a-0000-4000-8000-000000000000'

function couponRow(overrides: Partial<VoucherRow> = {}): VoucherRow {
  return {
    token_id: 'e8c77f87a391a72391fafdaaef73918b',
    voucher_id: VOUCHER_ID,
    token: 'cashuBv2F0gb9haUg',
    amount: 200,
    face_value: 5000,
    face_unit: 'XAF',
    face_decimals: 0,
    token_amount: 200,
    issuer_id: 'b'.repeat(64),
    status: 'active',
    created_at: '2026-08-12T09:00:00.000Z',
    updated_at: '2026-08-12T09:00:00.000Z',
    ...overrides,
  } as VoucherRow
}

describe('a real pass barcode, scanned', () => {
  it('survives the round trip from pass to pixels to route', () => {
    // START from the pass the app actually builds — not a literal. If the
    // barcode's payload ever changes shape, this fails at the first hop.
    const pass = toCouponPass(couponRow())
    const printed = pass.barcodes![0].message
    expect(printed).toBe(`${BARCODE_PREFIX}${VOUCHER_ID}`)

    // Through a real QR symbol and the real decoder.
    const { rgba, dim } = render(printed)
    const scanned = decodeQr(rgba, dim, dim)
    expect(scanned).toBe(printed)

    // Into the classification and routing a merchant's scan hits.
    expect(new QrTypeDetector().getType(scanned!)).toBe(QrType.VOUCHER_REDEEM)
    const handler = new VoucherRedeemHandler()
    expect(handler.validate(scanned!)).toBe(true)
  })

  it('yields the id IssuedCouponPage looks its record up by', async () => {
    // The end of the chain, and the part a wrong answer would break silently:
    // `IssuedCouponPage` reads `getTransactionRow('issued:' + voucherId)`, so
    // an id that survived the QR but lost a character reads as a lost coupon.
    const printed = toCouponPass(couponRow()).barcodes![0].message
    const { rgba, dim } = render(printed)
    const parsed = await new VoucherRedeemHandler().parse(decodeQr(rgba, dim, dim)!)
    expect(parsed.voucherId).toBe(VOUCHER_ID)
    expect(`issued:${parsed.voucherId}`).toBe(`issued:${VOUCHER_ID}`)
  })

  it('decodes at the small scale a printed receipt would use', () => {
    // A pass on paper is small. Scale 2 with the minimum 4-module quiet zone is
    // near the floor of what a scanner can resolve; passing here means the
    // payload is not relying on a generous render.
    const printed = toCouponPass(couponRow()).barcodes![0].message
    const { rgba, dim } = render(printed, 2, 4)
    expect(decodeQr(rgba, dim, dim)).toBe(printed)
  })

  it('a VOIDED coupon prints no barcode to scan', () => {
    // The proofs are burnt, so a cashier scanning it would be reading a code
    // for a sale that already happened. Asserted here because this test is the
    // one that starts from the pass rather than from a payload.
    //
    // `redeemed`/`revoked` are the statuses `isVoided` actually recognises. My
    // first version of this test used `spent`, which is NOT one of them, and it
    // failed — correctly. Worth keeping the real vocabulary here rather than a
    // plausible-looking guess, since a wrong status would make this assertion
    // pass for the wrong reason.
    for (const status of ['redeemed', 'revoked']) {
      const pass = toCouponPass(couponRow({ status } as Partial<VoucherRow>))
      expect(pass.barcodes, status).toBeUndefined()
    }
    // And a live coupon still carries one, so the assertion above is about
    // voiding rather than about barcodes never being emitted.
    expect(toCouponPass(couponRow()).barcodes).toHaveLength(1)
  })
})

describe('the decoder harness is honest', () => {
  it('returns null for pixels carrying no QR at all', () => {
    // If this returned a string, every assertion above would be meaningless —
    // the harness would be answering from something other than the image.
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(255)
    expect(decodeQr(blank, 64, 64)).toBeNull()
  })

  it('reads back a DIFFERENT payload as itself, not as a cached answer', () => {
    // Guards against the harness returning a stale result from a previous
    // decode, which would make the round trip prove nothing.
    const other = 'cashuBo2FteCJodHRwczovL21pbnQ'
    const { rgba, dim } = render(other)
    const scanned = decodeQr(rgba, dim, dim)
    expect(scanned).toBe(other)
    // And it classifies as bearer value, NOT as a voucher lookup — the
    // separation DEV-131 exists for, now asserted through a real image.
    expect(new QrTypeDetector().getType(scanned!)).toBe(QrType.CASHU_TOKEN)
  })
})
