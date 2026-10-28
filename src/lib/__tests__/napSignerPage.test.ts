/**
 * @vitest-environment jsdom
 *
 * The wallet's /nap/signer popup (#411, #410 G10): what it refuses before nap is even mounted, that
 * the key is decrypted only after a policy site asks and only with the right passphrase, that
 * consent is asked once and remembered under `imani-wallet:` (so logout forgets it), and that a
 * logout elsewhere zeroes the key. nap's own rules (origin, audiences, framing) run for real here:
 * this mounts the real `mountCrossOriginSigner` on a fake opener.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { CROSS_ORIGIN_PROTOCOL } from '@imani/nap-client-web'

import { createWalletSigner } from '../signer'
import { CONSENT_STORAGE_KEY, startSignerPage, walletConsentStore, type SignerPage, type SignerView } from '../napSignerPage'

const SITE = 'https://gifting.imani.casa'
const OTHER = 'https://subscription.imani.casa'
const POLICY = {
  [SITE]: { kinds: [27235], audiences: [SITE], maxTtlSeconds: 300 },
  [OTHER]: { kinds: [27235], audiences: [OTHER], maxTtlSeconds: 300 },
}
const PASS = 'correct horse battery'
const sk = bytesToHex(generateSecretKey())
const pubkey = getPublicKey(Uint8Array.from(Buffer.from(sk, 'hex')))

type Listener = (event: { data: unknown; origin: string; source: unknown }) => void

/** The site's window (the popup's opener) and this page's message target, as the browser wires them. */
function harness() {
  const posted: Array<{ message: Record<string, unknown>; origin: string }> = []
  const opener = { postMessage: (message: unknown, origin: string) => posted.push({ message: message as Record<string, unknown>, origin }) }
  const listeners = new Set<Listener>()
  const target = {
    addEventListener: (_t: 'message', l: Listener) => listeners.add(l),
    removeEventListener: (_t: 'message', l: Listener) => listeners.delete(l),
  }
  /** A message from `source` claiming nothing about its origin: the browser sets `origin`. */
  const send = (data: Record<string, unknown>, origin = SITE, source: unknown = opener) => {
    for (const l of [...listeners]) l({ data: { nap: CROSS_ORIGIN_PROTOCOL, ...data }, origin, source })
  }
  const replies = (type?: string) => posted.filter((p) => !type || p.message.type === type)
  return { opener, target, send, posted, replies, listeners }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
async function until(pred: () => boolean) {
  for (let i = 0; i < 200 && !pred(); i++) await flush()
  expect(pred()).toBe(true)
}

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m }
}

let pages: SignerPage[] = []
afterEach(() => {
  for (const p of pages) p.close()
  pages = []
})

async function start(over: Partial<Parameters<typeof startSignerPage>[0]> = {}) {
  const h = harness()
  const views: SignerView[] = []
  const storage = memoryStorage()
  const signers: Array<ReturnType<typeof createWalletSigner>> = []
  const loadKey = vi.fn(async (p: string) => {
    if (p !== PASS) throw new Error('Invalid passphrase')
    return sk
  })
  const page = await startSignerPage({
    policy: POLICY,
    keyStore: { hasKey: async () => true, loadKey },
    makeSigner: (hex) => {
      const s = createWalletSigner(hex)
      signers.push(s)
      return s
    },
    isTerminal: () => false,
    consentStore: walletConsentStore(storage),
    onView: (v) => views.push(v),
    opener: h.opener,
    target: h.target,
    isFramed: false,
    sessionChannel: false,
    ...over,
  })
  pages.push(page)
  const last = () => views[views.length - 1]
  return { ...h, page, views, last, storage, signers, loadKey }
}

const connect = (id = 'c1', extra: Record<string, unknown> = {}) => ({ type: 'connect', id, kinds: [27235], audiences: [SITE], ...extra })

describe('/nap/signer', () => {
  it('opened by hand (no opener), framed, on a till, or with no key: says so and answers nobody', async () => {
    for (const [over, reason] of [
      [{ opener: null }, 'no-opener'],
      [{ isFramed: true }, 'framed'],
      [{ isTerminal: () => true }, 'terminal'],
      [{ keyStore: { hasKey: async () => false, loadKey: async () => sk } }, 'no-key'],
    ] as const) {
      const t = await start(over as never)
      expect(t.last()).toEqual({ state: 'unavailable', reason })
      t.send(connect())
      await flush()
      expect(t.posted).toHaveLength(0)
    }
  })

  it('says ready only to the policy origins, and decrypts nothing until a policy site asks', async () => {
    const t = await start()
    expect(t.last()).toEqual({ state: 'waiting' })
    expect(t.replies('ready').map((p) => p.origin).sort()).toEqual([OTHER, SITE].sort())
    expect(t.loadKey).not.toHaveBeenCalled()

    // A stranger's origin, or another window, gets silence and no unlock screen.
    t.send(connect(), 'https://evil.example')
    t.send(connect(), SITE, { postMessage() {} })
    await flush()
    expect(t.last()).toEqual({ state: 'waiting' })
    expect(t.replies('error')).toHaveLength(0)
  })

  it('unlocks with the passphrase in the popup, asks once, then signs only for the site', async () => {
    const t = await start()
    t.send(connect('c1', { expectedPubkey: pubkey }))
    await until(() => t.last().state === 'unlock')
    expect(t.last()).toEqual({ state: 'unlock', origin: SITE })

    // Wrong passphrase: stays on unlock with the reason, the site keeps waiting.
    await expect(t.page.submitPassphrase('nope')).rejects.toThrow(/not right/)
    expect(t.last()).toMatchObject({ state: 'unlock', error: expect.stringMatching(/not right/) })
    expect(t.replies('connected')).toHaveLength(0)

    await t.page.submitPassphrase(PASS)
    await until(() => t.last().state === 'consent')
    const consent = t.last() as Extract<SignerView, { state: 'consent' }>
    expect(consent.request).toMatchObject({ origin: SITE, pubkey, kinds: [27235], audiences: [SITE] })

    t.page.answerConsent(true)
    await until(() => t.replies('connected').length === 1)
    const connected = t.replies('connected')[0]
    expect(connected.origin).toBe(SITE)
    const grant = connected.message.grant as { grantId: string; pubkey: string }
    expect(grant.pubkey).toBe(pubkey)
    expect(t.last().state).toBe('connected')

    // The login proof, addressed to the site: signed.
    const now = Math.floor(Date.now() / 1000)
    t.send({ type: 'sign', id: 's1', grantId: grant.grantId, template: { kind: 27235, created_at: now, content: '', tags: [['u', `${SITE}/v1/auth/complete`], ['method', 'POST'], ['challenge', 'x']] } })
    await until(() => t.replies('signed').length === 1)
    const event = t.replies('signed')[0].message.event as Parameters<typeof verifyEvent>[0]
    expect(verifyEvent(event)).toBe(true)
    expect(event.pubkey).toBe(pubkey)

    // A proof for the gateway, or for the other sister site: refused (origin substitution).
    for (const [id, u] of [['s2', 'https://wallet.imani.casa/api/v1/auth/complete'], ['s3', `${OTHER}/v1/auth/complete`]]) {
      t.send({ type: 'sign', id, grantId: grant.grantId, template: { kind: 27235, created_at: now, content: '', tags: [['u', u], ['method', 'POST']] } })
    }
    await until(() => t.replies('error').length === 2)
    expect(t.replies('error').map((p) => p.message.code)).toEqual(['REFUSED', 'REFUSED'])
    expect(t.replies('signed')).toHaveLength(1)

    // Remembered under imani-wallet: (logout sweeps it), naming no secret.
    const stored = t.storage.map.get(CONSENT_STORAGE_KEY)!
    expect(JSON.parse(stored)).toEqual([{ origin: SITE, pubkey, scope: expect.any(String) }])
    expect(stored).not.toContain(sk)
    expect(CONSENT_STORAGE_KEY.startsWith('imani-wallet:')).toBe(true)
  })

  it('a remembered yes skips the question, never the passphrase', async () => {
    const storage = memoryStorage()
    const first = await start({ consentStore: walletConsentStore(storage) })
    first.send(connect())
    await until(() => first.last().state === 'unlock')
    await first.page.submitPassphrase(PASS)
    await until(() => first.last().state === 'consent')
    first.page.answerConsent(true)
    await until(() => first.replies('connected').length === 1)

    const again = await start({ consentStore: walletConsentStore(storage) })
    again.send(connect())
    await until(() => again.last().state === 'unlock')
    await again.page.submitPassphrase(PASS)
    await until(() => again.replies('connected').length === 1)
    expect(again.views.some((v) => v.state === 'consent')).toBe(false)
  })

  it('"no" and "not now" reach the site as DECLINED, with nothing signed or remembered', async () => {
    const t = await start()
    t.send(connect('c1'))
    await until(() => t.last().state === 'unlock')
    t.page.cancelUnlock()
    await until(() => t.replies('error').length === 1)
    expect(t.replies('error')[0].message).toMatchObject({ code: 'DECLINED', id: 'c1' })
    expect(t.last()).toEqual({ state: 'declined', origin: SITE })

    t.send(connect('c2'))
    await until(() => t.last().state === 'unlock')
    await t.page.submitPassphrase(PASS)
    await until(() => t.last().state === 'consent')
    t.page.answerConsent(false)
    await until(() => t.replies('error').length === 2)
    expect(t.replies('error')[1].message).toMatchObject({ code: 'DECLINED', id: 'c2' })
    expect(t.replies('connected')).toHaveLength(0)
    expect(t.storage.map.get(CONSENT_STORAGE_KEY) ?? '[]').toBe('[]')
  })

  it('a site that expected another stall is refused even after a yes', async () => {
    const t = await start()
    t.send(connect('c1', { expectedPubkey: 'f'.repeat(64) }))
    await until(() => t.last().state === 'unlock')
    await t.page.submitPassphrase(PASS)
    await until(() => t.last().state === 'consent')
    t.page.answerConsent(true)
    await until(() => t.replies('error').length === 1)
    expect(t.replies('error')[0].message).toMatchObject({ code: 'REFUSED' })
    expect(t.replies('connected')).toHaveLength(0)
  })

  it('closing the page zeroes the key and stops answering', async () => {
    const t = await start()
    t.send(connect())
    await until(() => t.last().state === 'unlock')
    await t.page.submitPassphrase(PASS)
    await until(() => t.last().state === 'consent')
    t.page.answerConsent(true)
    await until(() => t.replies('connected').length === 1)
    expect(t.signers[0].hasKey()).toBe(true)

    t.page.close()
    expect(t.signers[0].hasKey()).toBe(false)
    expect(t.listeners.size).toBe(0)
    expect(t.replies('revoked')).toHaveLength(1)
  })

  it('a logout in another wallet tab zeroes the key and ends the page', async () => {
    const name = `nap-session-test-${Math.random()}`
    const t = await start({ sessionChannel: name })
    t.send(connect())
    await until(() => t.last().state === 'unlock')
    await t.page.submitPassphrase(PASS)
    await until(() => t.last().state === 'consent')
    t.page.answerConsent(true)
    await until(() => t.replies('connected').length === 1)

    const other = new BroadcastChannel(name)
    other.postMessage({ type: 'logout' })
    await until(() => t.last().state === 'ended')
    expect(t.signers[0].hasKey()).toBe(false)
    expect(t.replies('revoked')).toHaveLength(1)
    other.close()
  })
})
