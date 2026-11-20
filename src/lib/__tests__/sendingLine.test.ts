import { describe, expect, it } from 'vitest'
import { sendingLine } from '../sendingLine'

describe('sendingLine (#552)', () => {
  it('keeps the plain line for a send that is going normally', () => {
    expect(sendingLine(null)).toBe('This takes a few seconds. Do not close this screen.')
    expect(sendingLine({ part: 1, parts: 1, retrying: false })).toBe('This takes a few seconds. Do not close this screen.')
  })

  it('says which voucher of a bundle is going', () => {
    expect(sendingLine({ part: 2, parts: 8, retrying: false })).toBe(
      'This takes a few seconds. Voucher 2 of 8. Do not close this screen.',
    )
  })

  it('never says "a few seconds" while the gateway is retrying, and says nothing is lost', () => {
    const line = sendingLine({ part: 5, parts: 8, retrying: true })
    expect(line).not.toMatch(/few seconds/)
    expect(line).toMatch(/few minutes/)
    expect(line).toMatch(/Voucher 5 of 8/)
    expect(line).toMatch(/Nothing is lost/)
  })
  it('says not sent while the gateway calls it off (#651)', () => {
    expect(sendingLine({ part: 1, parts: 3, retrying: true, aborting: true })).toMatch(/^Not sent: .*coming back/)
  })
})
