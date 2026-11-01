/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'

/** #402: the app's notice entry point, and the flag that keeps the feature dark. */
const handled = vi.fn(async () => 'handled' as const)
vi.mock('../checkoutCodeFlow', async (orig) => ({ ...(await orig<object>()), handleCheckoutNotice: handled }))
vi.mock('../checkoutCodePorts', async (orig) => ({ ...(await orig<object>()), appCheckoutPorts: () => ({}) }))

const { onCheckoutNoticeDm } = await import('../checkoutCodesApp')
const { checkoutCodesEnabled } = await import('../checkoutCodePorts')

const NOTICE = JSON.stringify({ type: 'imani-checkout-code/1', event: 'redeemed', code_hash: 'a'.repeat(64), amount: 1 })

describe('checkout-code notices in the app', () => {
  it('ships dark: only `on` turns it on', () => {
    expect(checkoutCodesEnabled(undefined)).toBe(false)
    expect(checkoutCodesEnabled('')).toBe(false)
    expect(checkoutCodesEnabled('true')).toBe(false)
    expect(checkoutCodesEnabled(' ON ')).toBe(true)
  })

  it('anything else is not a notice', async () => {
    expect(await onCheckoutNoticeDm('me', '{"type":"cashu_token_transfer"}', 's')).toBeNull()
  })

  it('off: a notice is consumed without acting on it', async () => {
    vi.stubEnv('VITE_CHECKOUT_CODES', '')
    expect(await onCheckoutNoticeDm('me', NOTICE, 's')).toBe('ignored')
    expect(handled).not.toHaveBeenCalled()
  })

  it('on: handed to the flow with the verified sealer', async () => {
    vi.stubEnv('VITE_CHECKOUT_CODES', 'on')
    expect(await onCheckoutNoticeDm('me', NOTICE, 'sealer')).toBe('handled')
    expect(handled).toHaveBeenCalledWith({}, 'me', expect.objectContaining({ event: 'redeemed' }), 'sealer')
    vi.unstubAllEnvs()
  })
})
