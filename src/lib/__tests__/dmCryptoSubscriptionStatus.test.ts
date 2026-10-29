/**
 * @vitest-environment jsdom
 *
 * A subscription status DM is believed only from the PINNED licence seller, read from the verified
 * seal (#407). It is display only, but a stranger must not be able to make a stall's wallet say its
 * plan was cancelled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

const ME_SK = '3'.repeat(64)
const ME = getPublicKey(hexToBytes(ME_SK))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: getPublicKey(hexToBytes('3'.repeat(64))),
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(hexToBytes('3'.repeat(64))),
  }),
}))

const { createDmCryptoAdapter } = await import('../dmCrypto')
const { wrapMessage } = await import('../giftWrap')
const { subscriptionStatusJson } = await import('../subscriptionStatus')
const { subscriptionStatusFor } = await import('../subscriptionStatusStore')

const SELLER_SK = generateSecretKey()
const SELLER = getPublicKey(SELLER_SK)
const content = subscriptionStatusJson({ subscriptionId: 'sub_738c', status: 'cancelled', endsAt: 1_824_738_835, at: 1_800_000_000 })

beforeEach(() => {
  localStorage.clear()
  vi.stubEnv('VITE_LICENCE_SELLER_PUBKEY', SELLER)
})

describe('a subscription status DM', () => {
  it('from the pinned seller is stored before the unwrap returns, and is never offered as a payment', async () => {
    const dm = await createDmCryptoAdapter().unwrapNip17Dm(wrapMessage(SELLER_SK, ME, content) as never, '')
    expect(subscriptionStatusFor(ME, 'sub_738c')).toMatchObject({ status: 'cancelled', endsAt: 1_824_738_835 })
    // Not a token: the text regex is not let loose on the app's own message.
    expect(createDmCryptoAdapter().parseTokenTransferMessage(dm!.content)).toBeNull()
  })

  it('from anyone else is ignored', async () => {
    const stranger = generateSecretKey()
    await createDmCryptoAdapter().unwrapNip17Dm(wrapMessage(stranger, ME, content) as never, '')
    expect(subscriptionStatusFor(ME, 'sub_738c')).toBeNull()
  })

  it('is ignored when this build pins no seller', async () => {
    vi.stubEnv('VITE_LICENCE_SELLER_PUBKEY', '')
    await createDmCryptoAdapter().unwrapNip17Dm(wrapMessage(SELLER_SK, ME, content) as never, '')
    expect(subscriptionStatusFor(ME, 'sub_738c')).toBeNull()
  })
})
