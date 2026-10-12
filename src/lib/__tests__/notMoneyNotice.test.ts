import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

/**
 * A credential, a renewal and a licence are announced as what they are, never as "Payment
 * received" (#160 owner report on wallet 0.19.0).
 */

const toasts: Array<{ title: unknown; options?: Record<string, unknown>; kind: string }> = []
vi.mock('sonner', () => {
  const plain = (title: unknown, options?: Record<string, unknown>) => void toasts.push({ title, options, kind: 'plain' })
  return {
    toast: Object.assign(plain, {
      success: (title: unknown, options?: Record<string, unknown>) => void toasts.push({ title, options, kind: 'success' }),
    }),
  }
})
const recorded: Array<Record<string, unknown>> = []
vi.mock('../notifications/inbox', () => ({
  recordNotification: (pubkey: string, item: Record<string, unknown>) => (recorded.push({ pubkey, ...item }), true),
}))
const profiles = new Map<string, { displayName?: string; nip05?: string }>()
vi.mock('../profile', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    loadProfile: (pk: string) => (profiles.has(pk) ? { pubkey: pk, npub: nip19.npubEncode(pk), updatedAt: 0, ...profiles.get(pk) } : null),
    refreshProfile: async (pk: string) =>
      profiles.has(pk) ? { pubkey: pk, npub: nip19.npubEncode(pk), updatedAt: 0, ...profiles.get(pk) } : { pubkey: pk, npub: nip19.npubEncode(pk), updatedAt: 0 },
  }
})

const { announceTerminalDm, licenceNotice, resetNotices, showNotice, terminalNotice } = await import('../notMoneyNotice')
const { credentialMessageJson } = await import('../terminalDelivery')
const { buildLockedCredentialToken, buildVoucherToken } = await import('./voucherFixtures')

const STALL_KEY = generateSecretKey()
const STALL = getPublicKey(STALL_KEY)
const DEVICE = getPublicKey(generateSecretKey())
const ME = 'd'.repeat(64)
const TOKEN = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, voucherId: 'v-cred' })
const offer = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...JSON.parse(credentialMessageJson({ voucherId: 'v-cred', token: TOKEN, stallPubkey: STALL, name: 'Till', idleLockMinutes: 10 })),
    ...extra,
  })

beforeEach(() => {
  toasts.length = 0
  recorded.length = 0
  profiles.clear()
  resetNotices()
})

describe('a terminal credential is announced as a setup request', () => {
  it('names the stall, the terminal and its role, and links to setup, not /receive', async () => {
    profiles.set(STALL, { displayName: 'Rosa Green Farm' })
    expect(await announceTerminalDm(offer(), ME)).toBe(true)

    expect(recorded).toHaveLength(1)
    const row = recorded[0]
    expect(row.type).toBe('terminal_setup_request')
    expect(row.title).toBe('Terminal setup request from Rosa Green Farm')
    expect(row.body).toMatch(/Front counter \(Redemption only\)/)
    expect(row.url).toBe('/terminal/setup')
    expect(`${row.title} ${row.body}`).not.toMatch(/Payment|received|\bsat\b|\+1/)
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('plain')
    expect(toasts[0].title).toBe('Terminal setup request from Rosa Green Farm')
  })

  it('falls back to a short npub when the stall has published no name', () => {
    const n = terminalNotice(offer())!
    expect(n.title).toMatch(/^Terminal setup request from npub1\w+…$/)
  })

  it('a renewal reads "Terminal renewal from …" with its own type', () => {
    profiles.set(STALL, { nip05: 'rosa@example.com' })
    const n = terminalNotice(offer({ renews: 'v-old' }))!
    expect(n.type).toBe('terminal_renewal')
    expect(n.title).toBe('Terminal renewal from @rosa')
  })

  it('is announced once for a redelivered DM', async () => {
    await announceTerminalDm(offer(), ME)
    await announceTerminalDm(offer(), ME)
    expect(recorded).toHaveLength(1)
  })

  it('is announced once when a resend varies only the envelope voucher_id', async () => {
    expect(terminalNotice(offer({ voucher_id: 'spoofed' }))!.id).toBe('terminal-setup:v-cred')
    await announceTerminalDm(offer(), ME)
    await announceTerminalDm(offer({ voucher_id: 'other-1' }), ME)
    await announceTerminalDm(offer({ voucher_id: 'other-2' }), ME)
    expect(recorded).toHaveLength(1)
  })

  it('a DM that only CLAIMS to carry a credential gets no notice', async () => {
    const forged = JSON.stringify({ type: 'imani-terminal-credential/1', voucher_id: 'x', token: buildVoucherToken().token })
    expect(terminalNotice(forged)).toBeNull()
    expect(await announceTerminalDm(forged, ME)).toBe(false)
    expect(recorded).toEqual([])
  })
})

describe('a licence is announced as a licence', () => {
  it('reads "Licence from <seller>", links to the subscription, carries no amount', () => {
    const seller = 'e'.repeat(64)
    profiles.set(seller, { displayName: 'Imani' })
    showNotice(licenceNotice('sub:v', seller), ME)
    expect(recorded[0]).toMatchObject({ type: 'licence_received', title: 'Licence from Imani', url: '/settings/subscription' })
    expect(toasts[0].kind).toBe('plain')
  })
})
