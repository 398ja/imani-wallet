/**
 * `@imani/cashlink-sender`: send Cashlinks from a server, the way the wallet app does (#366).
 *
 * For automated senders, an employer's integration sending gifts to staff. Each gift is a Cashlink
 * (#295): a coupon wrapped to a one-off LINK key and then LOCKED to it, with the sender's REFUND key
 * able to take it back after the link's expiry `x`. The pre-signed take-back waits at the gateway's
 * refund relay, so an unclaimed gift leaves its link at `x` without anyone running anything. The
 * sender's next `reconcile()` turns it back into the coupon (unlocked) and hands it to `keep`.
 *
 * ## Where the keys are
 *
 * Here, in the caller's process, and nowhere else (ADR 0001, 0002). Link and refund keys are DERIVED
 * from the sender's secret key and a link index `i`, exactly as the app derives them, so the state
 * this module keeps holds no secret at all: every link can be re-derived from the sender key and its
 * index. wallet-api is asked only read-only questions (`/v1/links/plan`, `/v1/links/status`).
 *
 * ## State
 *
 * The caller persists `SenderState` (JSON) after every call that changes it, transactionally with its
 * own records, exactly as wallet-api's README asks for coupons. It holds link indices, expiries, the
 * locked coupon's public points and the high-water mark of indices used. A lost state file is
 * recovered with `restore()`, which scans derived indices past the high-water mark by the account
 * type's restore gap.
 *
 * ## What it never does
 *
 * - It never puts a link URL, link secret or refund secret in state, logs or errors.
 * - It never sends a coupon of the sender's own stall (stalls' Cashlinks lapse, Q3).
 * - It never makes a locktime without a refund key (the engine's `assertNotOpenAfterLocktime`).
 */
import { nip17 } from 'nostr-tools'

import {
  armGift,
  restoreFinding,
  settleLockedGift,
  wrapForLink,
  type ArmOutcome,
  type CashlinkPorts,
  type KeptCoupon,
  type ReturnOutcome,
} from '../../../src/lib/cashlinkFlow'
import { deriveRefundSecret, lockWindowProblem, readLinkLock, xOnlyPub } from '../../../src/lib/cashlinkLock'
import { deriveLinkSecret, formatGiftLink, linkPubOf, type GiftToken, type GiftWrap } from '../../../src/lib/giftLink'
import { parseVoucherToken, tokenProofs, verifyVoucher } from '../../../src/lib/voucherToken'
import { INDIVIDUAL_LIMITS, linkAllowance, restoreScanEnd, type LinkLimits } from '../../../packages/wallet-core/src/linkLimits'
import { gatewayReceive, nip98, nodeGateway, nodeMint, publishEvent, queryWraps, type Endpoints } from './ports'
import type { CashlinkGateway, CashlinkMint } from '../../../src/lib/cashlinkFlow'

// ─── State ───────────────────────────────────────────────────────────────────

export type LinkStatus =
  /** On its link, locked, before `x`, take-back waiting at the relay. */
  | 'armed'
  /** On its link and locked, but the relay did not take the take-back: `reconcile` takes it back after `x`. */
  | 'not_armed'
  /** On its link as a plain bearer gift (could not be locked: see `why`). `reconcile` takes it back after `x`. */
  | 'unarmed'
  /** Part way through arming; `reconcile` finishes it. */
  | 'arming'
  /** Off the link on its way back; `reconcile` finishes re-forming it. */
  | 'returning'
  | 'claimed'
  | 'returned'

export interface SentLink {
  /** The derivation index. With the sender key it re-derives the link and refund keys. */
  i: number
  /** The caller's own reference (an employee id, a payroll line). Never a secret. */
  ref?: string
  x: number
  status: LinkStatus
  /** Why a link is not armed, when it is not. */
  why?: string
  /** The keyset the take-back was deposited with (the engine needs it to rebuild the same outputs). */
  keyset?: string
  /** The coupon on the link now: the locked one once armed, else the bearer one. Public data. */
  token: string
  sentAt: number
  settledAt?: number
}

export interface SenderState {
  version: 1
  /** The sender's x-only pubkey, so a state file cannot be used with another key by mistake. */
  pubkey: string
  /** The highest link index ever used, or -1. Restore scans past it. */
  highWater: number
  links: SentLink[]
}

export function emptyState(pubkey: string): SenderState {
  return { version: 1, pubkey, highWater: -1, links: [] }
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface SenderOptions extends Endpoints {
  /** The sender's 32-byte secret key. Held in this process only. */
  secretKey: Uint8Array
  /** Where recipients open links: the wallet's public origin. */
  walletOrigin: string
  /** Optional: wallet-api, for the limits and plan (`/v1/links/limits`, `/v1/links/plan`). */
  walletApiUrl?: string
  /** Called with every coupon that comes back. MUST persist it before returning (it is value). */
  keep(coupon: KeptCoupon & { ref?: string; i: number }): Promise<void>
  fetchImpl?: typeof fetch
  /**
   * Replace how the mint, the gateway and the relay are reached (tests, or a caller with its own
   * HTTP stack). Each part is optional; the default is plain fetch to the configured URLs.
   */
  transport?: Partial<SenderTransport>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** The four things the sender talks to. Defaults are in `ports.ts`. */
export interface SenderTransport {
  mint: CashlinkMint
  /** Calls signed by the sender key unless a signer is passed (the engine passes link/refund signers). */
  gateway: CashlinkGateway
  /** Publish a gift wrap to the relay, NIP-98 by the link key. True once stored. */
  publish(linkSecret: Uint8Array, wrap: Record<string, unknown>): Promise<boolean>
  /** The gift wraps addressed to a link (kind 1059, `p` = linkPub), NIP-98 by the link key. */
  query(linkSecret: Uint8Array, linkPub: string): Promise<GiftWrap[]>
  /**
   * Receive a bearer coupon into the sender's own gateway wallet (`POST /api/v1/wallet/receive`,
   * NIP-98 by the sender): the re-formed coupon, `spent` when someone else already has it, or
   * `failed` (try again later).
   */
  receive(token: string): Promise<{ token: string } | 'spent' | 'failed'>
}

export class CashlinkSenderError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// ─── The sender ───────────────────────────────────────────────────────────────

export interface SendResult {
  /** The link to give the recipient (email it, print it). Contains the link secret: never log it. */
  url: string
  link: SentLink
  /** True when the gift will leave its link at `x` on its own (locked, take-back at the relay). */
  returnsOnItsOwn: boolean
}

export function createCashlinkSender(opts: SenderOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const senderPub = xOnlyPub(opts.secretKey)
  const endpoints: Endpoints = { gatewayUrl: opts.gatewayUrl, mintUrl: opts.mintUrl, ...(opts.publicOrigin ? { publicOrigin: opts.publicOrigin } : {}) }
  const sameMint = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase()
  /** Only the configured mint is ever reached; a coupon naming another is refused before this. */
  const route = (mintUrl: string) => {
    if (!sameMint(mintUrl, opts.mintUrl)) throw new CashlinkSenderError('wrong_mint', 'a coupon names a mint other than the configured one')
    return opts.mintTransportUrl ?? opts.mintUrl
  }

  const transport: SenderTransport = {
    mint: opts.transport?.mint ?? nodeMint(fetchImpl, 20_000, route),
    gateway: opts.transport?.gateway ?? nodeGateway(endpoints, { secret: opts.secretKey }, fetchImpl),
    publish: opts.transport?.publish ?? ((linkSecret, wrap) => publishEvent(endpoints, linkSecret, wrap, fetchImpl)),
    query: opts.transport?.query ?? ((linkSecret, linkPub) => queryWraps(endpoints, linkSecret, linkPub, fetchImpl)),
    receive: opts.transport?.receive ?? ((token) => gatewayReceive(endpoints, opts.secretKey, token, fetchImpl)),
  }

  /** The coupons to keep, re-tagged with the link they came from. */
  let current: { i: number; ref?: string } = { i: -1 }
  const ports: CashlinkPorts = {
    mint: transport.mint,
    gateway: transport.gateway,
    async deliver(linkSecret, token) {
      const wrap = wrapForLink(linkSecret, token)
      if (!(await transport.publish(linkSecret, wrap as unknown as Record<string, unknown>))) return false
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          if ((await tokensOn(linkSecret)).some((t) => t.token === token)) return true
        } catch {
          // read again
        }
        await sleep(1000)
      }
      return false
    },
    keep: async (coupon) => opts.keep({ ...coupon, i: current.i, ...(current.ref ? { ref: current.ref } : {}) }),
    sleep,
    now,
  }

  /** Every coupon on a link, from its wraps (only `cashu_token_transfer` payloads; chunked transfers are not used here). */
  async function tokensOn(linkSecret: Uint8Array): Promise<GiftToken[]> {
    const linkPub = linkPubOf(linkSecret)
    const wraps: GiftWrap[] = await transport.query(linkSecret, linkPub)
    const found = new Map<string, GiftToken>()
    for (const wrap of wraps) {
      try {
        const rumor = nip17.unwrapEvent(wrap as never, linkSecret) as { content: string; created_at: number }
        const payload = JSON.parse(rumor.content) as { type?: unknown; token?: unknown }
        if (payload?.type === 'cashu_token_transfer' && typeof payload.token === 'string' && !found.has(payload.token)) {
          found.set(payload.token, { token: payload.token, sentAt: rumor.created_at })
        }
      } catch {
        // not ours
      }
    }
    return [...found.values()]
  }

  /** The tokens on a link that this sender may act on: verified coupons at the configured mint. */
  function ours(tokens: GiftToken[], linkPub: string, refundPub: string): { bearer: GiftToken[]; locked: GiftToken[] } {
    const bearer: GiftToken[] = []
    const locked: GiftToken[] = []
    for (const t of tokens) {
      try {
        const p = parseVoucherToken(t.token)
        if (!sameMint(p.mintUrl, opts.mintUrl)) continue
        if (!verifyVoucher(p.voucher).signatureValid) continue
        const proofs = tokenProofs(t.token)
        const locks = proofs.map((pr) => readLinkLock(pr.secret))
        if (locks.every((l) => l && l.linkPub === linkPub && l.refundPub === refundPub)) locked.push(t)
        else if (locks.every((l) => l === null) && !p.voucher.lockKey && !proofs.some((pr) => /^\["P2PK/.test(pr.secret))) bearer.push(t)
      } catch {
        // unreadable: not ours
      }
    }
    return { bearer, locked }
  }

  const keysFor = (i: number) => ({ linkSecret: deriveLinkSecret(opts.secretKey, i), refundSecret: deriveRefundSecret(opts.secretKey, i) })

  function assertState(state: SenderState) {
    if (state.version !== 1 || state.pubkey !== senderPub) {
      throw new CashlinkSenderError('wrong_state', 'this state belongs to another sender key (or another version)')
    }
  }

  /** Outstanding and expired-unreturned, as the limit counts them, from the state. */
  function counts(state: SenderState) {
    const nowS = Math.floor(now() / 1000)
    let outstanding = 0
    let expiredUnreturned = 0
    for (const l of state.links) {
      if (l.status === 'claimed' || l.status === 'returned') continue
      if (nowS < l.x) outstanding += 1
      else expiredUnreturned += 1
    }
    return { outstanding, expiredUnreturned }
  }

  /** The signer's limits from wallet-api when configured, else the individual ones (the safe default). */
  async function limits(): Promise<LinkLimits> {
    if (!opts.walletApiUrl) return INDIVIDUAL_LIMITS
    const base = opts.walletApiUrl.replace(/\/+$/, '')
    const r = await fetchImpl(`${base}/v1/links/limits`, { headers: { Authorization: nip98(opts.secretKey, `${base}/v1/links/limits`, 'GET') }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new CashlinkSenderError('limits_unavailable', `wallet-api answered ${r.status} for the link limits`)
    return ((await r.json()) as { limits: LinkLimits }).limits
  }

  return {
    pubkey: senderPub,
    limits,
    counts,

    /**
     * Send one coupon as a Cashlink expiring at `x` (unix seconds). The coupon must be the sender's
     * (it is spent onto the link) and whole: the caller splits first if it wants a smaller gift.
     *
     * Order matters and is the app's: the index is reserved in `state` BEFORE anything moves, so a
     * crash after the coupon left can always be found again (`reconcile`/`restore`). Persist `state`
     * after this resolves, and persist the returned `url` wherever it must go (it is the gift).
     */
    async send(state: SenderState, coupon: string, x: number, ref?: string, lim?: LinkLimits): Promise<SendResult> {
      assertState(state)
      const nowS = Math.floor(now() / 1000)
      let parsed: ReturnType<typeof parseVoucherToken>
      try {
        parsed = parseVoucherToken(coupon)
      } catch {
        throw new CashlinkSenderError('bad_coupon', 'the coupon cannot be read')
      }
      if (!sameMint(parsed.mintUrl, opts.mintUrl)) throw new CashlinkSenderError('wrong_mint', 'the coupon is not at the configured mint')
      if (!verifyVoucher(parsed.voucher).signatureValid) throw new CashlinkSenderError('unverified', 'the coupon’s issuer signature does not verify')
      const stall = (/^[0-9a-f]{64}$/i.test(parsed.voucher.issuerId) ? parsed.voucher.issuerId : parsed.voucher.issuerPublicKey).toLowerCase()
      if (stall === senderPub) throw new CashlinkSenderError('own_stall', 'a stall does not send Cashlinks of its own coupons (they would lapse, Q3)')
      const window = lockWindowProblem(x, parsed.voucher.expiresAt, nowS)
      if (window === 'too_near' || window === 'too_far') throw new CashlinkSenderError('window', `the expiry is ${window.replace('_', ' ')} (1 hour to 30 days from now)`)
      if (window === 'too_close_to_expiry') throw new CashlinkSenderError('window', 'the expiry must be at least a day before the coupon itself expires')
      const allowance = linkAllowance(counts(state), lim ?? (await limits()))
      if (!allowance.ok) throw new CashlinkSenderError(allowance.reason, `link limit reached (${allowance.limit}); reconcile, or wait for links to be claimed or come back`)

      // Reserve the index first, past anything ever used, and check the relay for wraps there.
      let i = state.highWater + 1
      for (let probe = 0; probe < 64; probe++, i++) {
        const { linkSecret } = keysFor(i)
        const there = await transport.query(linkSecret, linkPubOf(linkSecret)).catch(() => {
          throw new CashlinkSenderError('unreachable', 'could not check the link with the gateway; nothing was sent')
        })
        state.highWater = Math.max(state.highWater, i)
        if (there.length === 0) break
        if (probe === 63) throw new CashlinkSenderError('no_free_link', 'could not find a free link index; nothing was sent')
      }
      const { linkSecret, refundSecret } = keysFor(i)
      const url = formatGiftLink(opts.walletOrigin, linkSecret, x)
      if (!url) throw new CashlinkSenderError('bad_origin', 'walletOrigin is not an http(s) origin')
      const link: SentLink = { i, x, status: 'arming', token: coupon, sentAt: nowS, ...(ref ? { ref } : {}) }
      state.links.push(link)

      // 1. On the link as a bearer gift (the app's atomic send puts it there the same way: a wrap to
      //    the link key). 2. Armed: burnt, locked to the link with refund = [R], minted, take-back
      //    deposited at the relay.
      if (!(await ports.deliver(linkSecret, coupon))) {
        link.status = 'unarmed'
        link.why = 'not_on_link_yet'
        return { url, link, returnsOnItsOwn: false }
      }
      current = { i, ...(ref ? { ref } : {}) }
      const linkPub = linkPubOf(linkSecret)
      const outcome = await armGift({
        ports,
        linkSecret,
        refundSecret,
        x,
        gifts: ours(await tokensOn(linkSecret), linkPub, xOnlyPub(refundSecret)).bearer,
        merchant: false,
        onArming: async (ks) => {
          link.status = 'arming'
          link.keyset = ks
        },
        onLocked: async () => {},
      })
      await applyArm(link, linkSecret, refundSecret, outcome)
      refundSecret.fill(0)
      return { url, link, returnsOnItsOwn: link.status === 'armed' }
    },

    /**
     * One pass over every open link: finish arms, retry deposits, mark claims, and after `x` take
     * the gift back (or fetch what the relay already took back) and re-form the coupon into `keep`.
     * Safe to run as often as you like (a cron every few minutes). Persist `state` afterwards.
     */
    async reconcile(state: SenderState): Promise<{ checked: number; claimed: number; returned: number; pending: number }> {
      assertState(state)
      const tally = { checked: 0, claimed: 0, returned: 0, pending: 0 }
      for (const link of state.links) {
        if (link.status === 'claimed' || link.status === 'returned') continue
        tally.checked += 1
        const outcome = await settleOne(link)
        if (outcome === 'claimed') tally.claimed += 1
        else if (outcome === 'returned') tally.returned += 1
        else tally.pending += 1
      }
      return tally
    },

    /** Take one link back now, before `x` (by its index). The coupon goes to `keep`. */
    async takeBack(state: SenderState, i: number): Promise<LinkStatus> {
      assertState(state)
      const link = state.links.find((l) => l.i === i)
      if (!link) throw new CashlinkSenderError('unknown_link', `no link ${i} in this state`)
      if (link.status === 'claimed' || link.status === 'returned') return link.status
      await settleOne(link, true)
      return link.status
    },

    /**
     * Rebuild state from the gateway and the mint alone, for a lost state file. Scans derived indices
     * up to the recorded high-water mark (when there is one) plus the account type's restore gap, and
     * adopts every link of ours still holding a gift or on its way back.
     */
    async restore(state: SenderState, lim?: LinkLimits): Promise<{ scannedTo: number; adopted: number }> {
      assertState(state)
      const limitsNow = lim ?? (await limits())
      const known = new Set(state.links.map((l) => l.i))
      let last = Math.max(-1, ...state.links.map((l) => l.i))
      let end = restoreScanEnd(last, state.highWater, limitsNow)
      let adopted = 0
      for (let i = 0; i <= end; i++) {
        const { linkSecret, refundSecret } = keysFor(i)
        let tokens: GiftToken[]
        try {
          tokens = await tokensOn(linkSecret)
        } catch {
          continue
        }
        if (tokens.length === 0) continue
        if (i > last) {
          last = i
          end = restoreScanEnd(last, state.highWater, limitsNow)
        }
        state.highWater = Math.max(state.highWater, i)
        if (known.has(i)) continue
        const linkPub = linkPubOf(linkSecret)
        const mine = ours(tokens, linkPub, xOnlyPub(refundSecret))
        const found = await restoreFinding(ports, linkSecret, refundSecret, [...mine.locked, ...mine.bearer])
        if (found.kind === 'locked' || found.kind === 'returning') {
          state.links.push({ i, x: found.x, status: found.kind === 'locked' ? 'not_armed' : 'returning', token: found.lockedToken, sentAt: mine.locked[0]?.sentAt ?? 0 })
          known.add(i)
          adopted += 1
        } else if (mine.bearer.length > 0) {
          // A bearer gift still on a link we have no record of: unknown x. Adopted with x = now so the
          // next reconcile takes it back; an unclaimed gift with a lost record must not stay out.
          const states = await ports.mint.states(opts.mintUrl, tokenProofs(mine.bearer[0].token).map((p) => p.secret))
          if (states.every((s) => s === 'UNSPENT')) {
            state.links.push({ i, x: Math.floor(now() / 1000), status: 'unarmed', why: 'restored_without_record', token: mine.bearer[0].token, sentAt: mine.bearer[0].sentAt })
            known.add(i)
            adopted += 1
          }
        }
        refundSecret.fill(0)
      }
      return { scannedTo: end, adopted }
    },
  }

  async function applyArm(link: SentLink, _linkSecret: Uint8Array, _refundSecret: Uint8Array, outcome: ArmOutcome) {
    switch (outcome.kind) {
      case 'armed':
        link.status = 'armed'
        link.keyset = outcome.keyset
        delete link.why
        break
      case 'not_armed':
        link.status = 'not_armed'
        if (outcome.keyset) link.keyset = outcome.keyset
        link.why = outcome.why
        break
      case 'unarmed':
        link.status = 'unarmed'
        link.why = outcome.why
        break
      case 'arming':
        link.status = 'arming'
        link.why = outcome.why
        break
      case 'claimed':
        link.status = 'claimed'
        link.settledAt = Math.floor(now() / 1000)
        break
      case 'kept_as_sats':
        link.status = 'returned'
        link.why = 'kept_as_sats'
        link.settledAt = Math.floor(now() / 1000)
        break
    }
    // The coupon on the link now: the locked one once it is there.
    if (link.status === 'armed' || link.status === 'not_armed') {
      const { linkSecret, refundSecret } = keysFor(link.i)
      const mine = ours(await tokensOn(linkSecret).catch(() => []), linkPubOf(linkSecret), xOnlyPub(refundSecret))
      if (mine.locked[0]) link.token = mine.locked[0].token
      refundSecret.fill(0)
    }
  }

  async function settleOne(link: SentLink, takeBackNow = false): Promise<'claimed' | 'returned' | 'pending'> {
    const { linkSecret, refundSecret } = keysFor(link.i)
    current = { i: link.i, ...(link.ref ? { ref: link.ref } : {}) }
    try {
      const linkPub = linkPubOf(linkSecret)
      const refundPub = xOnlyPub(refundSecret)
      const nowS = Math.floor(now() / 1000)
      let tokens: GiftToken[] = []
      try {
        tokens = await tokensOn(linkSecret)
      } catch {
        return 'pending'
      }
      const mine = ours(tokens, linkPub, refundPub)

      if (link.status === 'arming') {
        // Finish an arm a crash interrupted: never re-run the pre-check (it would read our own burn as a claim).
        const outcome = await armGift({ ports, linkSecret, refundSecret, x: link.x, gifts: mine.bearer, merchant: false, resuming: true, ...(link.keyset ? { burnKeyset: link.keyset } : {}), onArming: async () => {}, onLocked: async () => {} })
        await applyArm(link, linkSecret, refundSecret, outcome)
        // applyArm moved the status on: TypeScript still narrows it to 'arming' from the check above.
        const after = link.status as LinkStatus
        if (after === 'claimed') return 'claimed'
        if (after === 'returned') return 'returned'
        if (after === 'arming') return 'pending'
      }

      const locked = mine.locked[0]?.token ?? (readLinkLock(tokenProofs(link.token)[0]?.secret ?? '') ? link.token : null)
      if (locked) {
        const outcome: ReturnOutcome = await settleLockedGift({
          ports,
          linkSecret,
          refundSecret,
          lockedToken: locked,
          ...(link.keyset ? { depositKeyset: link.keyset } : {}),
          takeBackNow,
          onReturning: async () => {
            link.status = 'returning'
          },
        })
        if (outcome.kind === 'returned' || outcome.kind === 'claimed') {
          link.status = outcome.kind
          link.settledAt = nowS
          return outcome.kind
        }
        if (outcome.kind === 'waiting' && link.status === 'not_armed' && nowS < link.x) {
          // Retry the deposit while there is time, so it comes back on its own.
          const { retryDeposit } = await import('../../../src/lib/cashlinkFlow')
          const again = await retryDeposit(ports, linkSecret, refundSecret, locked)
          if (again.kind === 'armed') {
            link.status = 'armed'
            link.keyset = again.keyset
            delete link.why
          }
        }
        return 'pending'
      }

      // A bearer gift (never locked): claimed when its proofs are spent; after x (or now, when asked)
      // the sender takes it back by receiving it into its own wallet through the gateway.
      // Its wrap stays on the link after a claim (wraps are never deleted), so the mint decides: all
      // spent is claimed. Our own take-back marks the link returned before anything else could read it.
      const states = await ports.mint.states(opts.mintUrl, tokenProofs(link.token).map((p) => p.secret))
      if (states.every((s) => s === 'SPENT')) {
        link.status = 'claimed'
        link.settledAt = nowS
        return 'claimed'
      }
      if (!(takeBackNow || nowS >= link.x) || !states.every((s) => s === 'UNSPENT')) return 'pending'
      const received = await receiveBearer(link.token)
      if (received === 'received') {
        link.status = 'returned'
        link.settledAt = nowS
        return 'returned'
      }
      if (received === 'spent') {
        link.status = 'claimed'
        link.settledAt = nowS
        return 'claimed'
      }
      return 'pending'
    } finally {
      refundSecret.fill(0)
      current = { i: -1 }
    }
  }

  /** Take a bearer gift back into the sender's own wallet, and hand the result to `keep`. */
  async function receiveBearer(token: string): Promise<'received' | 'spent' | 'failed'> {
    let answer: { token: string } | 'spent' | 'failed'
    try {
      answer = await transport.receive(token)
    } catch {
      return 'failed'
    }
    if (answer === 'spent' || answer === 'failed') return answer
    await ports.keep({ token: answer.token, why: 'returned' })
    return 'received'
  }
}

export type CashlinkSender = ReturnType<typeof createCashlinkSender>
export { type KeptCoupon }
