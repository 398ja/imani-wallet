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

  it('never shows a key when the stall has published no name', () => {
    const n = terminalNotice(offer())!
    expect(n.title).toBe('Terminal setup request from a stall')
    expect(`${n.title} ${n.body}`).not.toMatch(/npub|[0-9a-f]{16}/)
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

describe('a licence is announced by the plan it is', () => {
  const NOW = Date.UTC(2026, 9, 28) / 1000
  const END = Date.UTC(2026, 10, 28) / 1000

  it('names the plan and its end date, links to the subscription, carries no amount and no key', () => {
    showNotice(licenceNotice('sub:v', { tier: 'basic', expiresAt: END }, { now: NOW }), ME)
    const row = recorded[0]
    expect(row).toMatchObject({ type: 'licence_received', title: 'Imani Essentials plan activated', url: '/settings/subscription' })
    expect(String(row.body)).toMatch(/^Your stall is on the Imani Essentials plan until .*2026\. It is not part of your balance\.$/)
    expect(`${row.title} ${row.body}`).not.toMatch(/npub|[0-9a-f]{16}|Licence from/)
    expect(toasts[0].kind).toBe('plain')
  })

  it('a renewal says renewed; a plan that starts later says when', () => {
    expect(licenceNotice('sub:v2', { tier: 'pro', expiresAt: END }, { renewal: true, now: NOW }).title).toBe('Imani Pro plan renewed')
    expect(licenceNotice('sub:v3', { tier: 'basic', validFrom: NOW + 86_400 * 3, expiresAt: END }, { now: NOW }).body).toMatch(/, from .* until /)
  })

  it('the `basic` tier is sold as Essentials: a licence sold before the rename never says Basic', () => {
    const n = licenceNotice('sub:v4', { tier: 'basic', expiresAt: END }, { renewal: true, now: NOW })
    expect(n.title).toBe('Imani Essentials plan renewed')
    expect(`${n.title} ${n.body}`).not.toMatch(/basic/i)
  })

  it('a hand grant is a plan grant, and a licence with no tier is still a plan', () => {
    expect(licenceNotice('g:1', { tier: 'custom', grantKind: 'custom', expiresAt: END }, { now: NOW }).title).toBe('Your Imani plan grant arrived')
    expect(licenceNotice('l:1', { expiresAt: END }, { now: NOW }).title).toBe('Imani plan activated')
  })
})
