import { describe, expect, it } from 'vitest'

import { toRenderable } from '../render'

/**
 * The renderer is the one piece both transports and the service worker share,
 * so its failure modes are everyone's. These pin the two that bite in
 * production: a payload that does not match what we expect, and a URL that
 * would take the user somewhere wrong.
 */
describe('toRenderable', () => {
  it('renders a voucher_received push the way the gateway sends it', () => {
    // Shape copied from PushNotificationService.notifyVoucherReceived.
    const result = toRenderable({
      title: 'Voucher Received',
      body: 'You received a $5.00 voucher from Alice',
      type: 'voucher_received',
      data: { type: 'voucher_received', face_value: 5, face_unit: 'USD', sender: 'Alice' },
    })

    expect(result.title).toBe('Voucher Received')
    expect(result.body).toBe('You received a $5.00 voucher from Alice')
    expect(result.type).toBe('voucher_received')
    expect(result.url).toBe('/receive')
  })

  it('refuses the imani-apps URL the gateway actually sends on a claim', () => {
    // gateway-core hardcodes data.url = "/voucher/home.html", a page that does
    // not exist in this SPA. Honouring it would 404 the user on tap.
    const result = toRenderable({
      title: 'Voucher Claimed',
      body: 'Bob claimed your $5.00 voucher',
      type: 'voucher_claimed',
      data: { type: 'voucher_claimed', url: '/voucher/home.html' },
    })

    expect(result.url).toBe('/merchant/transactions')
  })

  it('honours a server URL that is already wallet-shaped', () => {
    // So the gateway can deep-link somewhere specific without a release here.
    const result = toRenderable({
      type: 'voucher_received',
      data: { url: '/coupon/abc123' },
    })

    expect(result.url).toBe('/coupon/abc123')
  })

  it.each([
    ['absolute', 'https://evil.example/steal'],
    ['protocol-relative', '//evil.example/steal'],
    ['javascript', 'javascript:alert(1)'],
  ])('refuses a %s URL rather than turning a tap into an open redirect', (_label, url) => {
    const result = toRenderable({ type: 'voucher_received', data: { url } })
    expect(result.url).toBe('/receive')
  })

  it('still renders when the server sends a type this build does not know', () => {
    // A wallet that predates a new server event must not drop it silently:
    // the phone already buzzed.
    const result = toRenderable({
      title: 'Something new',
      body: 'A thing happened',
      type: 'terminal_enrolled',
    })

    expect(result.type).toBe('generic')
    expect(result.title).toBe('Something new')
    expect(result.url).toBe('/')
  })

  it('supplies words when the payload has none', () => {
    const result = toRenderable({ type: 'voucher_expiring' })

    expect(result.title).toBe('Coupon expiring')
    expect(result.body).toBe('A coupon in your wallet expires soon.')
  })

  it.each([[null], [undefined], [{}]])('never throws on %s', (input) => {
    const result = toRenderable(input as never)
    expect(result.title).toBe('Imani')
    expect(result.url).toBe('/')
  })

  it('reads the type from data when the top level omits it', () => {
    const result = toRenderable({ data: { type: 'voucher_claimed' } })
    expect(result.type).toBe('voucher_claimed')
  })

  it('collapses same-type notifications onto one tag', () => {
    const first = toRenderable({ type: 'voucher_received', data: { sender: 'Alice' } })
    const second = toRenderable({ type: 'voucher_received', data: { sender: 'Bob' } })
    expect(first.tag).toBe(second.tag)
  })

  it('treats blank server text as absent rather than rendering an empty line', () => {
    const result = toRenderable({ title: '   ', body: '', type: 'voucher_received' })
    expect(result.title).toBe('Coupon received')
    expect(result.body).toBe('A coupon arrived in your wallet.')
  })
})
