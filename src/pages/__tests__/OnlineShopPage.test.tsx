/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import { buildLockedCredentialToken } from '../../lib/__tests__/voucherFixtures'

/**
 * Settings › Online shop (#402), driven as a screen.
 *
 * The plan check is injected; the camera is a stub button; the gateway is faked at the network edge
 * only. The real enrolment pipeline (`terminalEnrolFlow.ts`), roster and profile reconciliation run,
 * since they are what the wiring could get wrong.
 */

const STALL_KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(STALL_KEY))
/** The key the shop's plugin generated: `S`. */
const SHOP_KEY = schnorr.utils.randomSecretKey()
const SHOP = bytesToHex(schnorr.getPublicKey(SHOP_KEY))

const { signShopEnrolCode } = await import('../../lib/shopEnrol')
const shopCode = (url = 'https://shop.example', platform: 'woocommerce' | 'shopify' = 'woocommerce') =>
  signShopEnrolCode(SHOP_KEY, SHOP, url, platform, Math.floor(Date.now() / 1000))

/** What the stub camera reads. */
let scanned = ''
vi.mock('../../components/ScanRecipient', () => ({
  ScanRecipient: ({ onText }: { onText?: (t: string) => boolean }) => <button onClick={() => onText?.(scanned)}>scan</button>,
}))

/** Credential DMs re-sent by the open-time pass (#160 round 2). */
let delivered = 0
const deliver = async () => (delivered += 1, 0)

/** The gateway at the network edge. */
let mintRefusal: { status: number; code: string } | null = null
const posts: Array<{ merchant_metadata: Record<string, unknown> }> = []
const postHeaders: Array<Record<string, string> | undefined> = []
const fakeTransport = {
  post: async (_path: string, body: unknown, headers?: Record<string, string>) => {
    postHeaders.push(headers)
    if (mintRefusal) {
      return new Response(JSON.stringify({ error: { code: mintRefusal.code, message: 'refused' } }), { status: mintRefusal.status })
    }
    posts.push(body as never)
    return new Response(JSON.stringify({ voucher_id: '5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9' }), { status: 201 })
  },
  get: async () => {
    const meta = posts.at(-1)!.merchant_metadata as Record<string, unknown> & { owner_attestation?: { expires_at: string } }
    const token = buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: SHOP,
      metadata: JSON.stringify({ ...meta, lock_key: SHOP }),
      ...(meta.owner_attestation ? { expiresAt: Number(meta.owner_attestation.expires_at) } : {}),
    })
    return new Response(JSON.stringify({ status: 'ISSUED', token }), { status: 200 })
  },
  sleep: async () => {},
}
const spends: string[] = []
const fakeSpend = async () => ({
  validateToken: async () => ({ state: 'UNSPENT' }),
  receive: async (token: string) => {
    spends.push(token)
    return {}
  },
})
const stallSigner = () => ({ pubkey: STALL, withPrivkey: <T,>(borrow: (key: Uint8Array) => T) => borrow(STALL_KEY) })

/** A licence status carrying exactly these features, verified now. */
const licensed = (features: string[]) => async () => ({
  checkedAt: Math.floor(Date.now() / 1000),
  decision: { granted: true as const, source: 'verified' as const, grant: { features, expiresAt: Math.floor(Date.now() / 1000) + 86_400 * 30 } },
  grants: [{ features, expiresAt: Math.floor(Date.now() / 1000) + 86_400 * 30 }],
})
const PRO = licensed(['terminals', 'api', 'ecommerce'])
const BASIC = licensed(['terminals'])

vi.mock('../../lib/licenceReport', () => ({ reportLicence: async () => ({ kind: 'skipped' }) }))

/** The real check is replaced only to count it: the screen's default must not re-ask on every render. */
let licenceChecks = 0
vi.mock('../../lib/licenceStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/licenceStatus')>()
  return {
    ...actual,
    licenceStatus: async () => {
      licenceChecks += 1
      // A fresh object every time, as the real check returns.
      return await PRO()
    },
  }
})

const { OnlineShopPage } = await import('../OnlineShopPage')
const { allTerminals, recordTerminal, isRevoked } = await import('../../lib/terminalRoster')
const { TERMINAL_ROLES } = await import('../../lib/terminalRole')
const { readFileSync } = await import('node:fs')
const { join } = await import('node:path')

/** A real signed till credential, so a revoke has something to spend. */
const TOKEN = readFileSync(join(__dirname, '../../lib/__tests__/fixtures/live-terminal-credential.token'), 'utf8').trim()

/** The platform step: the code step appears once one is chosen (progressive disclosure). */
async function choosePlatform(name = 'WooCommerce') {
  fireEvent.click(await screen.findByRole('radio', { name }))
}

type Props = Partial<Parameters<typeof OnlineShopPage>[0]>
function renderPage(props: Props = {}, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/settings/online-shop', state }]}>
      <OnlineShopPage
        stallPubkey={STALL}
        status={PRO as never}
        transport={fakeTransport}
        spendApi={fakeSpend as never}
        publisher={{ publish: async () => true }}
        seal={(borrow) => borrow(STALL_KEY)}
        stallSigner={stallSigner}
        collect={async () => 0}
        confirm={async () => 204}
        exposure={async () => null}
        profile={{ sign: async (t) => ({ ...t, created_at: 1 }), publish: async () => ({ ok: 1 }) }}
        deliver={deliver}
        sync={async () => false}
        renewals={async () => ({ changed: 0, lapsed: [] })}
        {...props}
      />
    </MemoryRouter>,
  )
}

/** A shop row, connected and in service. */
function connectShop(over: Record<string, unknown> = {}) {
  recordTerminal(STALL, {
    terminalPubkey: SHOP,
    name: 'shop.example',
    role: TERMINAL_ROLES.REDEEM_ONLY,
    enrolledAt: 1_000_000,
    status: 'in-service',
    token: TOKEN,
    voucherId: 'cred-shop',
    shop: { url: 'https://shop.example', platform: 'woocommerce' },
    ...over,
  } as Parameters<typeof recordTerminal>[1])
}

beforeEach(() => {
  localStorage.clear()
  scanned = shopCode()
  mintRefusal = null
  posts.length = 0
  postHeaders.length = 0
  spends.length = 0
  licenceChecks = 0
  delivered = 0
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the plan check', () => {
  // Regression: a default written inline was a new function every render, so the effect re-ran,
  // set a new status object, re-rendered, and asked again, for ever.
  it('asks once, with the default check', async () => {
    // Arrange / Act
    render(
      <MemoryRouter>
        <OnlineShopPage stallPubkey={STALL} exposure={async () => null} deliver={deliver} sync={async () => false}
          renewals={async () => ({ changed: 0, lapsed: [] })} spendApi={fakeSpend as never} />
      </MemoryRouter>,
    )
    await screen.findByRole('radio', { name: 'WooCommerce' })
    await new Promise((r) => setTimeout(r, 50))

    // Assert
    expect(licenceChecks).toBe(1)
  })
})

describe('below the plan that includes online shops', () => {
  it('shows the lock and the way to plans, and no way to connect', async () => {
    // Arrange / Act
    renderPage({ status: BASIC as never })

    // Assert
    expect(await screen.findByTestId('online-shop-locked')).toBeTruthy()
    expect(screen.getByText(/part of the Pro plan/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'See plans' }).getAttribute('href')).toBe('/settings/subscription')
    expect(screen.queryByRole('button', { name: 'scan' })).toBeNull()
  })

  it('shows nothing decided while the plan check is still answering', () => {
    // Arrange / Act: a check that never answers.
    renderPage({ status: (() => new Promise(() => {})) as never })

    // Assert: no lock that might be wrong, no form.
    expect(screen.getByTestId('online-shop-loading')).toBeTruthy()
    expect(screen.queryByTestId('online-shop-locked')).toBeNull()
  })
})

describe('connecting a shop on Pro', () => {
  it('asks for the code only once a platform is chosen, and marks the choice', async () => {
    // Arrange
    renderPage()
    await screen.findByRole('radio', { name: 'Magento' })
    expect(screen.queryByRole('button', { name: 'scan' })).toBeNull()

    // Act
    fireEvent.click(screen.getByRole('radio', { name: 'Magento' }))

    // Assert
    expect(screen.getByRole('radio', { name: 'Magento' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Shopify' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('button', { name: 'scan' })).toBeTruthy()
  })

  it('shows the chosen platform its steps', async () => {
    // Arrange
    renderPage()

    // Act
    fireEvent.click(await screen.findByRole('radio', { name: 'Shopify' }))

    // Assert
    expect(screen.getByTestId('platform-steps').textContent).toMatch(/Shopify admin/)
  })

  it('reads the code, confirms the address, and mints a marked redeem-only credential for S', async () => {
    // Arrange
    renderPage()

    // Act: scan, read the confirmation, connect.
    await choosePlatform()
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    const confirm = await screen.findByTestId('online-shop-confirm')
    expect(confirm.textContent).toMatch(/Connect shop\.example\?/)
    expect(confirm.textContent).toMatch(/WooCommerce/)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    // Assert: what left the phone, and what the roster keeps.
    await waitFor(() => expect(screen.getByTestId('online-shop-connected')).toBeTruthy())
    expect(postHeaders[0]?.['X-Imani-Online-Shop']).toBe('1')
    expect(postHeaders[0]?.['X-Imani-Terminal-Enrolment']).toMatch(/^1:\d+:[0-9a-f]{128}$/)
    expect(posts[0].merchant_metadata.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    const row = allTerminals(STALL).find((t) => t.terminalPubkey === SHOP)!
    expect(row.shop).toEqual({ url: 'https://shop.example', platform: 'woocommerce' })
    expect(row.name).toBe('shop.example')
    expect(row.status).toBe('waiting')
    expect(screen.getByTestId('online-shop-waiting').textContent).toMatch(/Waiting for shop\.example to confirm/)
  })

  it("tells the owner their plan lacks online shops when the gateway refuses, and keeps no row", async () => {
    // Arrange: the licence on this device says Pro, the gateway's says otherwise.
    mintRefusal = { status: 422, code: 'FEATURE_NOT_IN_PLAN' }
    renderPage()

    // Act
    await choosePlatform()
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))

    // Assert
    expect(await screen.findByText(/Online shops are part of the Pro plan. Upgrade to connect your shop/)).toBeTruthy()
    expect(allTerminals(STALL)).toEqual([])
  })

  it('takes the code handed over from Add a terminal, straight to the confirmation', async () => {
    // Arrange / Act
    renderPage({}, { shopCode: shopCode('https://handed.example') })

    // Assert
    expect((await screen.findByTestId('online-shop-confirm')).textContent).toMatch(/Connect handed\.example\?/)
  })

  it("refuses the stall's own key and an out-of-date code, in the owner's words", async () => {
    // Arrange: the stall's own key, signed as a shop.
    scanned = signShopEnrolCode(STALL_KEY, STALL, 'https://shop.example', 'woocommerce', Math.floor(Date.now() / 1000))
    renderPage()

    // Act / Assert: own key.
    await choosePlatform()
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    expect(await screen.findByText(/That is your own stall/)).toBeTruthy()

    // Act / Assert: two days old.
    scanned = signShopEnrolCode(SHOP_KEY, SHOP, 'https://shop.example', 'woocommerce', Math.floor(Date.now() / 1000) - 2 * 86_400)
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    expect(await screen.findByText(/out of date/)).toBeTruthy()
    expect(posts).toEqual([])
  })

  it('cancelling the confirmation goes back to the code, with nothing sent', async () => {
    // Arrange
    renderPage()
    await choosePlatform()
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    await screen.findByTestId('online-shop-confirm')

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // Assert
    expect(screen.queryByTestId('online-shop-confirm')).toBeNull()
    expect(screen.getByRole('button', { name: 'scan' })).toBeTruthy()
    expect(posts).toEqual([])
  })
})

describe('a connected shop', () => {
  it('shows its outstanding codes and publishes online_shop', async () => {
    // Arrange
    const { saveMerchant, emptyMerchant, mergeMerchantEvent } = await import('../../lib/merchant')
    saveMerchant({ ...emptyMerchant(STALL), acceptsCards: true })
    connectShop()
    const published: Array<{ content: string }> = []

    // Act
    renderPage({
      exposure: async (_s, key) => (key === SHOP ? { codes: 3, amount: 4500, unit: 'EUR' } : null),
      profile: { sign: async (t) => ({ ...t, created_at: 100 }), publish: async (e) => (published.push(e as never), { ok: 1 }) },
    })

    // Assert
    await waitFor(() => expect(screen.getByTestId('online-shop-exposure').textContent).toMatch(/^3 codes, .*45.*$/))
    await waitFor(() => expect(screen.getByTestId('online-shop-published').textContent).toBe('Yes'))
    expect(mergeMerchantEvent(emptyMerchant(STALL), published[0].content, 1).onlineShop?.redeemKey).toBe(SHOP)
  })

  it('disconnects: spends the credential and withdraws online_shop, keeping the rest of the profile', async () => {
    // Arrange
    const { saveMerchant, emptyMerchant, loadMerchant, mergeMerchantEvent } = await import('../../lib/merchant')
    saveMerchant({ ...emptyMerchant(STALL), acceptsCards: true })
    connectShop()
    const published: Array<{ content: string }> = []
    let at = 100
    renderPage({ profile: { sign: async (t) => ({ ...t, created_at: at++ }), publish: async (e) => (published.push(e as never), { ok: 1 }) } })
    await waitFor(() => expect(published).toHaveLength(1))

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect shop.example' }))

    // Assert
    await waitFor(() => expect(isRevoked(STALL, SHOP)).toBe(true))
    expect(spends).toEqual([TOKEN])
    await waitFor(() => expect(published.length).toBeGreaterThanOrEqual(2))
    const after = mergeMerchantEvent(emptyMerchant(STALL), published.at(-1)!.content, 1)
    expect(after.onlineShop).toBeUndefined()
    expect(after.acceptsCards).toBe(true)
    expect(loadMerchant(STALL)?.onlineShop).toBeUndefined()
    // Back to connecting a new one.
    expect(await screen.findByRole('radio', { name: 'WooCommerce' })).toBeTruthy()
  })

  it('warns about outstanding codes before disconnecting', async () => {
    // Arrange
    connectShop()
    renderPage({ exposure: async () => ({ codes: 2, amount: 1000, unit: 'EUR' }) })
    await screen.findByTestId('online-shop-exposure')

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

    // Assert
    expect(screen.getByTestId('online-shop-disconnect-confirm').textContent).toMatch(/2 codes, .* outstanding at shop\.example/)
  })
})

describe('a shop whose connection did not finish', () => {
  it('finishes a mint whose answer was lost, here rather than only on Terminals', async () => {
    // Arrange: the row was written, the request's answer never arrived.
    posts.push({ merchant_metadata: { role: TERMINAL_ROLES.REDEEM_ONLY } })
    connectShop({ status: 'minting', mintKey: 'key-1', token: undefined, voucherId: undefined })

    // Act
    renderPage()

    // Assert: re-sent with the same key and the shop marker, and now waiting for the shop.
    await waitFor(() => expect(allTerminals(STALL)[0].status).toBe('waiting'))
    expect(postHeaders[0]).toMatchObject({ 'Idempotency-Key': 'key-1', 'X-Imani-Online-Shop': '1' })
  })
})

describe('the shop lifecycle Terminals used to run (review of #402)', () => {
  it('re-sends a credential DM that did not land, and says the shop has not received it', async () => {
    // Arrange: minted, waiting, and the first NIP-17 send failed.
    connectShop({ status: 'waiting', delivered: false, enrolledAt: Date.now(), waitingUntil: Date.now() + 86_400_000 })

    // Act
    renderPage()

    // Assert
    await waitFor(() => expect(delivered).toBe(1))
    expect(screen.getByTestId('online-shop-waiting').textContent).toMatch(/has not received its connection yet/)
  })

  it('shows the check code and the setup code while the shop is waiting', async () => {
    // Arrange
    connectShop({ status: 'waiting', delivered: true, enrolledAt: Date.now(), waitingUntil: Date.now() + 86_400_000 })

    // Act
    renderPage()

    // Assert
    expect((await screen.findByTestId('online-shop-check-code')).textContent).toMatch(/^Check code\s*\d{3}\s+\d{3}$/)
    expect(screen.getByTestId('online-shop-setup-code').textContent).toMatch(STALL)
  })

  it('polls for the pickup of a renewal, which is what completes it', async () => {
    // Arrange: in service, with a renewal sent and not yet collected.
    const { attestEnrolment } = await import('../../lib/terminalMint')
    const { prepareEnrolment } = await import('../../lib/terminalIssue')
    const attestation = attestEnrolment(
      prepareEnrolment({ name: 'shop.example', role: TERMINAL_ROLES.REDEEM_ONLY, terminalPubkey: SHOP }, { stallPubkey: STALL, licence: await PRO(), enrolledCount: 0, online: true } as never),
      stallSigner(),
      Date.now(),
    )
    connectShop({ renewal: { startedAt: Date.now(), mintKey: 'renew-1', attestation, voucherId: 'r1', token: TOKEN } })
    let collected = 0

    // Act
    renderPage({ collect: async () => (collected += 1, 0) })

    // Assert
    await waitFor(() => expect(collected).toBeGreaterThan(0))
  })

  it('runs the renewal pass on opening, and shows a renewal that lapsed', async () => {
    // Arrange
    connectShop()
    let asked = 0

    // Act
    renderPage({ renewals: async () => (asked += 1, { changed: 0, lapsed: ['shop.example'] }) })

    // Assert
    await waitFor(() => expect(asked).toBe(1))
    expect(await screen.findByText(/shop\.example/, { selector: '[role="alert"], [role="alert"] *' })).toBeTruthy()
  })

  it('keeps the reason a connect did not finish when the gateway gave no answer', async () => {
    // Arrange: a 5xx keeps the row minting, so the connected view replaces the form.
    mintRefusal = { status: 503, code: 'UNAVAILABLE' }
    renderPage({ spendApi: (async () => { throw new Error('locked') }) as never })

    // Act
    await choosePlatform()
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))

    // Assert
    await waitFor(() => expect(screen.getByTestId('online-shop-minting')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/Could not connect the shop/)
  })

  it('shows a connected shop, with Disconnect, even when the plan check fails', async () => {
    // Arrange
    connectShop()

    // Act
    renderPage({ status: (async () => { throw new Error('down') }) as never })

    // Assert
    expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeTruthy()
  })

  it('says the plan check failed, rather than "Checking…" for ever, with no shop', async () => {
    // Arrange / Act
    renderPage({ status: (async () => { throw new Error('down') }) as never })

    // Assert
    await waitFor(() => expect(screen.getByTestId('online-shop-loading').textContent).toMatch(/Could not check your plan/))
  })

  it('stops saying "Trying again" once the publish retries are spent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      // Arrange: a relay that never takes the profile.
      const { saveMerchant, emptyMerchant } = await import('../../lib/merchant')
      saveMerchant(emptyMerchant(STALL))
      connectShop()
      renderPage({ profile: { sign: async (t) => ({ ...t, created_at: 1 }), publish: async () => ({ ok: 0 }) } })
      await waitFor(() => expect(screen.getByTestId('online-shop-published').textContent).toMatch(/trying again/))

      // Act
      await vi.advanceTimersByTimeAsync(25 * 5_000)

      // Assert
      await waitFor(() => expect(screen.getByTestId('online-shop-published').textContent).toBe('Not yet'))
      expect(screen.getByText(/tried again the next time you open this screen/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a connected shop after the plan lapsed', () => {
  it('says new codes stop and outstanding ones finish, and can still be disconnected', async () => {
    // Arrange: a shop is connected, and the plan no longer includes online shops.
    connectShop()

    // Act
    renderPage({ status: BASIC as never })

    // Assert
    const banner = await screen.findByTestId('online-shop-lapsed')
    expect(banner.textContent).toMatch(/takes no new checkout codes/)
    expect(banner.textContent).toMatch(/already made still work/)
    expect(screen.getByRole('link', { name: 'Renew Pro' }).getAttribute('href')).toBe('/settings/subscription')
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
    expect(screen.queryByTestId('online-shop-locked')).toBeNull()
  })
})
