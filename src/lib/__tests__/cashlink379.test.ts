/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * imani-wallet#379: a Cashlink whose arm failed AFTER the burn must never read "claimed", its row's
 * expiry must be the lock's locktime, and the sender's wallet must take the gift back itself after
 * the expiry with its return key, whatever the row says. Logout stays off until it has.
 *
 * What happened on staging (R52, 0.39.0): the Send page reloads the app, so start-up's restore scan
 * and settle run WHILE the send is arming. The scan, which read the rows before the send's row was
 * written, adopted the link a second time with "30 days from now" as its expiry. The settle, which
 * read the rows before the arm marked them, then found the bearer gift SPENT (by our own burn) and
 * closed the link as "claimed". The deposit was refused (422 MALFORMED), but "not armed" could no
 * longer be written on a closed row, and the reconcile skips closed rows: the locked gift stayed
 * UNSPENT at the mint past its locktime, and never came back.
 *
 * The gateway and mint are `cashlinkWorld`'s, as in cashlinkWiring.test.ts.
 */

const ID = hexToBytes('33'.repeat(32))

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  wraps: new Map<string, string[]>(),
  redeemed: [] as string[],
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    getAllTransactions: async () => h.rows,
    updateTransaction: async (id: string, patch: Record<string, unknown>) => {
      const row = h.rows.find((r) => r.id === id)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
    addTransaction: async (row: Record<string, unknown>) => {
      h.rows.push(row)
      return row
    },
  }),
  // Logout's own read of the History rows.
  openWallet: async () => ({ getAllVouchers: async () => [], getAllTransactions: async () => h.rows }),
  voucherWriteCount: () => 0,
  wipeWallet: async () => {},
  notifyWalletChanged: () => {},
}))
vi.mock('../txRecords', () => ({ publishTx: async () => {} }))
vi.mock('../nap', () => ({
  getSigner: () => ({ pubkey: 'a'.repeat(64), withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(ID.slice()) }),
  // Logout's side (the confirmation is declined or never reached in these tests).
  getSession: () => ({ logout: async () => {} }),
  keyStore: { clear: async () => {} },
  resetSession: () => {},
}))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}), withCorrelation: async (_i: unknown, run: (id: string) => unknown) => run('c') }))
vi.mock('../trustedMint', () => ({ loadTrustedMints: async () => {}, checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))
vi.mock('../merchant', () => ({ loadMerchant: () => null }))
vi.mock('../merchantVouchers', () => ({
  ForeignVoucherRefusedError: class extends Error {},
  isServerForeignRefusal: () => false,
  refuseForeignIssuer: async () => {},
  refuseForeignVouchers: async () => {},
  sessionAccount: () => 'a'.repeat(64),
}))
vi.mock('../giftLink', async (orig) => {
  const real = await orig<typeof import('../giftLink')>()
  return {
    ...real,
    fetchGiftWraps: async (secret: Uint8Array) => ((h.wraps.get(real.linkPubOf(secret)) ?? []).length ? [{ id: 'w' }] : []),
    giftTokensFrom: async (secret: Uint8Array) => (h.wraps.get(real.linkPubOf(secret)) ?? []).map((token) => ({ token, sentAt: 1_800_000_000 })),
    tokenState: async () => 'UNSPENT',
  }
})
const sent = vi.hoisted(() => ({ token: '' }))
vi.mock('../pay', () => ({
  sendVouchers: async (args: { recipient: { pubkey: string }; link: Record<string, unknown> }) => {
    h.rows.push({ id: 'sent:t0', type: 'sent', timestamp: 1, link: args.link })
    h.wraps.set(args.recipient.pubkey, [sent.token])
    return { id: 's1', requested: 100, delivered: 100, parts: 1 }
  },
}))

const { world, at, bearerSecret, tokenOf } = await import('./cashlinkWorld')
const giftLinks = await import('../giftLinks')
const { deriveLinkSecret, linkPubOf, secretToText } = await import('../giftLink')
const { tokenProofs } = await import('../voucherToken')
const { readLinkLock, deriveRefundSecret, derivedOutputs, sigAllWitness } = await import('../cashlinkLock')
const { armGift, claimLockedGift } = await import('../cashlinkFlow')
const { asGiftLinkRecord, strandedCashlinks } = await import('../transactions')
const { attemptLogout } = await import('../logout')

const PUB = 'a'.repeat(64)
const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
/** A NUT-02 v2 keyset id (66 hex), as staging's mint has. */
const V2_KEYSET = '01' + 'f0'.repeat(32)
const LINK = deriveLinkSecret(ID, 0)
let w: ReturnType<typeof world>

type Link = { status: string; arm?: { s: string; ks?: string }; x: number; k: string; verifiedAt?: number }
const links = () => h.rows.map((r) => r.link as Link)
const lockedOnLink = () => (h.wraps.get(linkPubOf(LINK)) ?? []).filter((t) => readLinkLock(tokenProofs(t)[0].secret))
const locktimeOnLink = () => readLinkLock(tokenProofs(lockedOnLink()[0]).at(0)!.secret)!.locktime
const mintState = async (t: string) => (await w.mint.states('', tokenProofs(t).map((p) => p.secret)))[0]
const send = () => giftLinks.sendGift({ payer: PUB, merchant: { pubkey: PUB } as never, unit: 'GBP', amount: 1000, x: X, settleBudgetMs: 10 })

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/**
 * The staging race, exactly: a restore scan whose row snapshot predates the send, and a settle whose
 * snapshot predates `onArming` and whose mint check lands after the burn. Both start at the lock
 * route's dry run (the pre-check, before anything is burnt). Returns a wait for both.
 */
function stagingRace(): () => Promise<void> {
  const rowWritten = deferred()
  const burnt = deferred()
  let settle: Promise<unknown> = Promise.resolve()
  // The restore scan starts first, as start-up's does, with no row of this link yet.
  const scan = giftLinks.restoreScan(
    PUB,
    async (secret) => {
      if (linkPubOf(secret) !== linkPubOf(LINK)) return []
      await rowWritten.promise
      return (h.wraps.get(linkPubOf(LINK)) ?? []).map((token) => ({ token, sentAt: NOW }))
    },
    mintState,
    NOW * 1000,
  )
  const swap = w.mint.swap.bind(w.mint)
  w.mint.swap = async (m, i, o) => {
    const answer = await swap(m, i, o)
    if (i[0]?.secret.startsWith('["VOUCHER"') && answer.kind === 'signed') burnt.resolve()
    return answer
  }
  const call = w.gateway.call.bind(w.gateway)
  let dryRun = true
  w.gateway.call = async (m, p, b, s) => {
    if (dryRun && p.endsWith('/cashlink/lock')) {
      dryRun = false
      rowWritten.resolve()
      await scan
      // The settle (Send page, History or start-up): its rows are read now, before the arm marks
      // them; the mint is asked about the bearer gift only once our own burn has spent it.
      settle = giftLinks.reconcileGiftLinks(NOW * 1000, async (t) => {
        await burnt.promise
        return mintState(t)
      })
    }
    return call(m, p, b, s)
  }
  return async () => {
    burnt.resolve()
    await settle
  }
}

beforeEach(() => {
  localStorage.clear()
  h.rows = []
  h.wraps.clear()
  h.redeemed = []
  w = world(NOW)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'], shouldAdvanceTime: true })
  vi.setSystemTime(NOW * 1000)
  // Staging's mint signs under a v2 keyset id.
  w.mint.keysets[0].id = V2_KEYSET
  sent.token = tokenOf([w.mint.issue(bearerSecret(), 64)])
  vi.spyOn(giftLinks.cashlinkSeam, 'ports').mockResolvedValue(w.ports)
  w.ports.deliver = async (secret, token) => {
    h.wraps.set(linkPubOf(secret), [...(h.wraps.get(linkPubOf(secret)) ?? []), token])
    return true
  }
  vi.stubGlobal('window', Object.assign(window, { TokenRedemption: { redeem: async (t: string) => void h.redeemed.push(t) } }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function afterExpiry(): Promise<{ claimed: number; reclaimed: number }> {
  at(w, X + 61)
  vi.setSystemTime((X + 61) * 1000)
  return giftLinks.reconcileGiftLinks((X + 61) * 1000, mintState)
}

describe('#379 regression: the R52 staging run, exactly', () => {
  it('deposit refused 422 MALFORMED after the burn: the link is NOT claimed, its expiry is the locktime, and after x the wallet takes it back', async () => {
    // The probe sees 422 (relay on), then the real deposit is refused 422 MALFORMED (gc#265).
    w.gateway.depositAnswers = [
      { status: 422, body: { refusal: 'MALFORMED' } },
      { status: 422, body: { refusal: 'MALFORMED' } },
    ]
    const race = stagingRace()
    const out = await send()
    await race()
    expect(out.returnsOnItsOwn).toBe(false)
    // The gift really is locked to the link and unspent, as on staging.
    expect(lockedOnLink()).toHaveLength(1)
    expect(await mintState(lockedOnLink()[0])).toBe('UNSPENT')
    // Nobody claimed it, so no row says so. The arm failed, so the link is "not armed".
    expect(links().map((l) => l.status)).toEqual(links().map(() => 'outstanding'))
    expect(links().every((l) => l.arm?.s === 'not_armed')).toBe(true)
    // Every row's expiry is the lock's locktime, never "30 days from now".
    expect(links().every((l) => l.x === locktimeOnLink())).toBe(true)
    // After x the sender's next start takes it back with its return key.
    expect((await afterExpiry()).reclaimed).toBe(1)
    expect(links().every((l) => l.status === 'reclaimed')).toBe(true)
    expect(w.kept).toHaveLength(1)
    expect(await mintState(lockedOnLink()[0])).toBe('SPENT')
  })

  it('a keyset id in the v2 form (66 hex) is kept on the row, so a resumed arm knows it was resumed', () => {
    const link = asGiftLinkRecord({ k: secretToText(LINK), x: X, status: 'outstanding', arm: { s: 'arming', ks: V2_KEYSET } })
    expect(link?.arm).toEqual({ s: 'arming', ks: V2_KEYSET })
  })
})

describe('#379: every way the arm can fail after the burn, with the same race, comes back after x', () => {
  const cases: Array<[string, () => void]> = [
    ['the relay switched off between the pre-check and the deposit (503)', () => {
      w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 503, body: { refusal: 'RELAY_DISABLED' } }]
    }],
    ['the relay unreachable at the deposit', () => {
      const call = w.gateway.call.bind(w.gateway)
      w.gateway.call = async (m, p, b, s) => {
        if (p.endsWith('/cashlink/refunds') && (b as { proof?: { secret?: string } })?.proof?.secret) throw new Error('unreachable')
        return call(m, p, b, s)
      }
    }],
    ['another refusal (409 CONFLICT)', () => {
      w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 409, body: { refusal: 'CONFLICT' } }]
    }],
  ]
  for (const [name, arrange] of cases) {
    it(`${name}: never "claimed", expiry is the locktime, back after x`, async () => {
      arrange()
      const race = stagingRace()
      await send()
      await race()
      expect(links().some((l) => l.status === 'claimed')).toBe(false)
      expect(links().every((l) => l.x === locktimeOnLink())).toBe(true)
      expect((await afterExpiry()).reclaimed).toBe(1)
      expect(links().every((l) => l.status === 'reclaimed')).toBe(true)
    })
  }

  it('armed, but the relay FAILED at x (its post refused): the wallet takes it back itself', async () => {
    const race = stagingRace()
    await send()
    await race()
    expect(links().some((l) => l.status === 'claimed')).toBe(false)
    at(w, X + 61)
    vi.setSystemTime((X + 61) * 1000)
    // The mint refuses the relay's post (its clock behind): the deposit ends FAILED, nothing spent.
    w.mint.clockBehindUntil = X + 100
    await w.gateway.runRelay(X + 61)
    expect([...w.gateway.deposits.values()].map((d) => d.state)).toEqual(['FAILED'])
    w.mint.clockBehindUntil = 0
    expect((await giftLinks.reconcileGiftLinks((X + 61) * 1000, mintState)).reclaimed).toBe(1)
    expect(links().every((l) => l.status === 'reclaimed')).toBe(true)
  })
})

/**
 * The row an older build (0.39.0) left on staging, rebuilt: both rows of the link (the send's, and
 * the restore scan's duplicate with "30 days from now") read `claimed` with `arm = arming` and no
 * keyset, while the locked gift sits UNSPENT on the link.
 */
async function stagingBrokenRows(): Promise<void> {
  w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 422, body: { refusal: 'MALFORMED' } }]
  await send()
  const k = secretToText(LINK)
  h.rows = [
    { id: 'sent:t0', type: 'sent', timestamp: 1, link: { k, i: 0, x: X, status: 'claimed', closedAt: NOW * 1000, arm: { s: 'arming' } } },
    { id: 'sent:gift-ede7f5162e888768e11f7d310859f127', type: 'sent', timestamp: NOW * 1000, link: { k, i: 0, x: NOW + 30 * 86_400, status: 'claimed', closedAt: NOW * 1000, arm: { s: 'arming' } } },
  ]
  localStorage.clear()
}

describe('#379 restore and adopt: the broken staging row is repaired on the next start', () => {
  it('after x: the fixed build takes the stranded gift back, with no manual swap', async () => {
    await stagingBrokenRows()
    expect(await mintState(lockedOnLink()[0])).toBe('UNSPENT')
    const out = await afterExpiry()
    expect(out.reclaimed).toBe(1)
    expect(links().every((l) => l.status === 'reclaimed')).toBe(true)
    // History reads the lock's expiry on every row, the duplicate included.
    expect(links().every((l) => l.x === locktimeOnLink())).toBe(true)
    expect(w.kept).toHaveLength(1)
    // It came back by the return key's own path: the SIG_ALL witness on the spend is by R.
    expect(w.gateway.resigns.get(tokenProofs(lockedOnLink()[0])[0].secret)?.caller).toBe('refund')
  })

  it('before x: it is opened again as "not armed", waiting, with the locktime as its expiry', async () => {
    await stagingBrokenRows()
    // As on staging since 23:49Z: the relay is off, so the retried deposit is refused too.
    w.gateway.relayOn = false
    await giftLinks.reconcileGiftLinks(NOW * 1000, mintState)
    expect(links().every((l) => l.status === 'outstanding' && l.arm?.s === 'not_armed')).toBe(true)
    expect(links().every((l) => l.x === locktimeOnLink())).toBe(true)
    expect(w.kept).toHaveLength(0)
  })

  it('a link really claimed by the recipient stays "claimed", now checked, and holds nothing', async () => {
    await stagingBrokenRows()
    await claimLockedGift({ ports: w.ports, pubkey: 'c3'.repeat(32), linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: lockedOnLink()[0], sentAt: NOW }] })
    w.kept.length = 0
    await giftLinks.reconcileGiftLinks(NOW * 1000, mintState)
    expect(links().every((l) => l.status === 'claimed' && typeof l.verifiedAt === 'number')).toBe(true)
    expect(w.kept).toHaveLength(0)
    expect(strandedCashlinks(h.rows, NOW * 1000)).toBe(0)
  })

  it('spent by our OWN refund (the relay posted it) is "Taken back", never "claimed"', async () => {
    // Armed first, so the relay holds the refund; then an older build closes the rows as claimed.
    await send()
    const k = secretToText(LINK)
    for (const r of h.rows) (r as { link: Record<string, unknown> }).link = { k, i: 0, x: X, status: 'claimed', arm: { s: 'arming' } }
    at(w, X + 61)
    vi.setSystemTime((X + 61) * 1000)
    await w.gateway.runRelay(X + 61)
    expect(await mintState(lockedOnLink()[0])).toBe('SPENT')
    expect((await giftLinks.reconcileGiftLinks((X + 61) * 1000, mintState)).reclaimed).toBe(1)
    expect(links().every((l) => l.status === 'reclaimed')).toBe(true)
  })
})

describe('#379: a bearer gift spent by our own burn is never read as claimed', () => {
  it('a fresh arm (no record of the earlier run) that finds our burn finishes the lock instead of "claimed"', async () => {
    h.wraps.set(linkPubOf(LINK), [sent.token])
    const refundSecret = deriveRefundSecret(ID, 0)
    const [proof] = tokenProofs(sent.token)
    // An earlier run burnt it into our derived outputs, and its record is gone.
    const outs = derivedOutputs(refundSecret, 'burn', proof.secret, proof.amount, proof.id)
    expect((await w.mint.swap('', [{ ...proof, witness: sigAllWitness(refundSecret, proof.secret, proof.C, outs) }], outs)).kind).toBe('signed')
    const out = await armGift({ ports: w.ports, linkSecret: LINK, refundSecret, x: X, gifts: [{ token: sent.token, sentAt: NOW }], merchant: false, onArming: async () => {}, onLocked: async () => {} })
    expect(out.kind).toBe('armed')
  })
})

describe('#379: logout stays off while a stranded locked gift exists', () => {
  const okDeps = {
    checkBackups: async () => ({ ok: true as const, confirmed: 0, fingerprint: '' }),
    checkStash: async () => ({ ok: true as const, fingerprint: '', count: 0 }),
    settleInFlight: async () => {},
    writeCount: () => 0,
    heldNow: async () => '',
  }

  it('the broken staging row refuses the logout (read from the History rows), and erases nothing', async () => {
    await stagingBrokenRows()
    const confirm = vi.fn(() => true)
    expect(await attemptLogout(PUB, confirm, () => {}, okDeps)).toMatchObject({ status: 'blocked', reason: 'in-flight' })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('after the repair has brought it back, the same logout gets as far as the confirmation', async () => {
    await stagingBrokenRows()
    await afterExpiry()
    expect(await attemptLogout(PUB, () => false, () => {}, okDeps)).toEqual({ status: 'cancelled' })
  })

  it('a link locked to its expired link with nothing at the service to return it also holds the logout', () => {
    const k = secretToText(LINK)
    expect(strandedCashlinks([{ type: 'sent', link: { k, i: 0, x: NOW - 1, status: 'outstanding', arm: { s: 'not_armed' } } }], NOW * 1000)).toBe(1)
    // Control: an ordinary gift, or one already back, holds nothing.
    expect(strandedCashlinks([{ type: 'sent', link: { k, i: 0, x: NOW - 1, status: 'reclaimed', arm: { s: 'not_armed' } } }], NOW * 1000)).toBe(0)
    expect(strandedCashlinks([{ type: 'sent', link: { k, i: 0, x: NOW - 1, status: 'outstanding' } }], NOW * 1000)).toBe(0)
  })
})
