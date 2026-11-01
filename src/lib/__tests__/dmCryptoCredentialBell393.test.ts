import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #393 (E13 on staging, wallet 0.39.2): a terminal credential DM reached a personal wallet, but the
 * bell never said "Terminal setup request from <stall>".
 *
 * The R54 trace shows why. The poller unwrapped the credential while the page was being reloaded.
 * The unwrap fired the notice off WITHOUT waiting for it (`void import('./notMoneyNotice')…`) and
 * returned at once, so dm-poll marked the wrap processed. The reload then aborted the notice's
 * chunk download, and after the reload the poller said "already processed": no bell row, ever.
 *
 * So the rule this test pins: by the time the unwrap hands the DM back (and dm-poll may mark it
 * processed), the bell row is already written. If the page dies before that, the unwrap never
 * returns, the wrap stays unprocessed, and the next page announces it.
 */

const ME_SK = '2'.repeat(64)
const ME = getPublicKey(hexToBytes(ME_SK))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: getPublicKey(hexToBytes('2'.repeat(64))),
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(hexToBytes('2'.repeat(64))),
  }),
}))
const recorded: Array<{ pubkey: string; id: string; type: string; title: string; url: string }> = []
vi.mock('../notifications/inbox', () => ({
  recordNotification: (pubkey: string, item: { id: string; type: string; title: string; url: string }) => (
    recorded.push({ pubkey, ...item }), true
  ),
}))
vi.mock('sonner', () => ({ toast: () => undefined }))
vi.mock('../profile', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  loadProfile: () => null,
  refreshProfile: async () => null,
}))

const { createDmCryptoAdapter } = await import('../dmCrypto')
const { credentialMessageJson } = await import('../terminalDelivery')
const { buildLockedCredentialToken } = await import('./voucherFixtures')

describe('#393: a credential DM is in the bell before its unwrap returns', () => {
  it('writes the "Terminal setup request" row before dm-poll can mark the wrap processed', async () => {
    const stallKey = generateSecretKey()
    const stall = getPublicKey(stallKey)
    const token = buildLockedCredentialToken({ stallKey, devicePubkey: getPublicKey(generateSecretKey()), voucherId: 'v-393' })
    const content = credentialMessageJson({ voucherId: 'v-393', token, stallPubkey: stall, name: 'Wrong path till', idleLockMinutes: 10 })
    const wrap = nip17.wrapEvent(stallKey, { publicKey: ME }, content)

    const dm = await createDmCryptoAdapter().unwrapNip17Dm(wrap as never, '')

    // No extra ticks here on purpose: the moment the unwrap resolves is the moment the page may go.
    expect(dm?.content).toBe(content)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ pubkey: ME, type: 'terminal_setup_request', url: '/terminal/setup' })
    // An unnamed stall is "a stall", never its key.
    expect(recorded[0].title).toBe('Terminal setup request from a stall')
  })
})
