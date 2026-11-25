/**
 * #543: a Cashlink locked from the start. Made the way a checkout code is (#402,
 * `checkoutCodeFlow.ts`), with the link key `L` in place of the shop key `S`. Nothing goes through
 * gateway-core's atomic send, so there is never a bearer copy on the link to burn later.
 *
 *   1. Plan the parts (`planDirectParts`, the checkout planner): whole coupons, a part carved from
 *      whole proofs (`carveProofs`), or one split by `/vouchers/bearer-split` (`voucherSplit.ts`,
 *      done by the caller before this module, with its own intent).
 *   2. Persist the intent (`cashlinkIntents.ts`) synchronously, before anything moves.
 *   3. Preflight every part side by side (`armPreflight`), nothing burnt. Any refusal: the intent is
 *      forgotten, every coupon is what it was, and the caller takes the legacy path.
 *   4. Arm each part (`armGift`) with `L`, `R_i = deriveRefundSecret(identity, i)` and `preChecked`:
 *      burn, lock-batch, mint the `P2PK(L)` successor, deposit the pre-signed refunds. `deliver`
 *      only collects the locked wraps into the intent.
 *   5. Publish the wraps to the relay and the gateway (`ports.publish`), started as soon as a part's
 *      wraps are collected, so they run beside its refunds/batch. Delivered means the relay said OK
 *      and the gateway mirror answered 2xx; nothing is read back.
 *   6. Write the sent rows (one per part, sharing `cashlinkBundleId(L)`), then forget the intent.
 *
 * Every step derives from `R_i`, the wallet key and the intent, so `finishCashlinkIntents` finishes
 * a page that died anywhere (spec section 5).
 */
import { armGift, armPreflight, inParallel, retryDeposit, type ArmContext, type ArmOutcome, type CashlinkPorts, type UnarmedReason } from './cashlinkFlow'
import { deriveRefundSecret } from './cashlinkLock'
import { forgetCashlinkIntent, loadCashlinkIntents, saveCashlinkIntent, type CashlinkIntent, type CashlinkIntentPart } from './cashlinkIntents'
import { carveProofs } from './checkoutCarve'
import { deriveLinkSecret, secretFromText, secretToText } from './giftLink'
import type { GiftLinkArm } from './transactions'
import { creditableFaceValue, parseVoucherToken } from './voucherToken'
import { withQueuedLock } from './webLock'

// --- Ports ------------------------------------------------------------------

export interface DirectPorts extends CashlinkPorts {
  /** A COPY of the wallet key K, which the caller zeroes; null when this wallet cannot read it. */
  identitySecret(): Uint8Array | null
  /** Put one locked wrap on the link: true only once the relay said OK AND the gateway took it (2xx). */
  publish(linkSecret: Uint8Array, token: string): Promise<boolean>
  /**
   * The coupon row a part was drawn from has left this wallet (its proofs are locked to the link, or
   * kept as sats): removed, or rewritten to `rest` when the part was carved from it. Idempotent.
   */
  settleSource(tokenId: string, rest: string | null): Promise<void>
  /** Write (or bring up to date) the link's sent rows, one per locked part, with `arm`. */
  recordRows(intent: CashlinkIntent, arm: GiftLinkArm): Promise<void>
}

// --- Why the legacy path ----------------------------------------------------

/** Why a Cashlink was made the old way (atomic send, bearer gift, then arm). Decided before anything moves. */
export type LegacyReason =
  | 'merchant'
  | 'remote_signer'
  | 'no_plan'
  | 'no_dleq'
  | 'relay_off'
  | 'routes_unavailable'
  | 'window'
  | 'split_refused'
  | `preflight_${string}`

/** The legacy reason a pre-check refusal stands for. */
export function legacyReasonOf(out: ArmOutcome): LegacyReason {
  if (out.kind !== 'unarmed') return `preflight_${out.kind}`
  const why: UnarmedReason = out.why
  if (why === 'relay_unavailable') return 'relay_off'
  if (why === 'lock_route_unavailable') return 'routes_unavailable'
  if (why === 'window') return 'window'
  if (why === 'no_amount_proof') return 'no_dleq'
  if (why === 'merchant') return 'merchant'
  return `preflight_${why}`
}

// --- 1. The plan ----------------------------------------------------------------

// In `cashlinkDebit.ts`, which the Send screen loads without the rest of this module.
export { planDirectParts } from './cashlinkDebit'

/** A part of the intent, carved when it draws less than its coupon. Null when it cannot be carved. */
export function intentPart(p: { tokenId: string; token: string; amount: number; faceValue: number }): CashlinkIntentPart | null {
  const base = { sourceTokenId: p.tokenId, rowId: p.tokenId, amount: p.amount, state: 'new' as const, voucherId: voucherIdOf(p.token) }
  if (p.amount === p.faceValue) return { ...base, token: p.token }
  const carved = carveProofs(p.token, p.amount)
  if (!carved) return null
  return { ...base, token: carved.part, carved: true, rest: carved.rest }
}

function voucherIdOf(token: string): string | undefined {
  try {
    return parseVoucherToken(token).voucher.voucherId
  } catch {
    return undefined
  }
}

// --- 2-6. Making it -------------------------------------------------------------

export interface StartDirect {
  ports: DirectPorts
  pubkey: string
  /** The link: its secret's index `i` (the key is derived from it) and expiry. */
  i: number
  x: number
  stall: string
  merchantName?: string
  unit: string
  decimals: number
  amount: number
  memo?: string
  parts: Array<{ tokenId: string; token: string; amount: number; faceValue: number }>
}

export type DirectOutcome =
  /** Nothing moved: every coupon is what it was. The caller makes it the legacy way. */
  | { kind: 'legacy'; why: LegacyReason }
  /** The link holds `delivered` (minor units); `published` says whether every wrap is on it yet. */
  | { kind: 'made'; delivered: number; published: boolean; armed: boolean; kept: number }
  /** Something moved and nothing was locked: what was burnt is kept as sats. No link. */
  | { kind: 'nothing'; kept: number }
  /** Part way; the next run (`finishCashlinkIntents`) carries on. Nothing is lost. */
  | { kind: 'pending'; why: string }

/** Plan written, checked, then run. `legacy` means nothing moved. */
export async function startDirectCashlink(req: StartDirect): Promise<DirectOutcome> {
  if (req.parts.length < 1 || req.parts.length > 20) return { kind: 'legacy', why: 'no_plan' }
  if (req.parts.reduce((n, p) => n + p.amount, 0) !== req.amount) return { kind: 'legacy', why: 'no_plan' }
  // Each part's row id carries the link index: a carved coupon's rest may go out again later.
  const parts = req.parts.map((p) => {
    const part = intentPart(p)
    return part ? { ...part, rowId: `${p.tokenId}:link-${req.i}` } : null
  })
  if (parts.some((p) => p === null)) return { kind: 'legacy', why: 'no_plan' }
  const identity = req.ports.identitySecret()
  if (!identity) return { kind: 'legacy', why: 'remote_signer' }
  const L = deriveLinkSecret(identity, req.i)
  identity.fill(0)
  const k = secretToText(L)
  const intent: CashlinkIntent = {
    id: k,
    k,
    i: req.i,
    x: req.x,
    stall: req.stall.toLowerCase(),
    ...(req.merchantName ? { merchantName: req.merchantName } : {}),
    unit: req.unit,
    decimals: req.decimals,
    amount: req.amount,
    ...(req.memo ? { memo: req.memo } : {}),
    at: req.ports.now(),
    parts: parts as CashlinkIntentPart[],
  }
  // 2. Written before anything moves, or nothing moves.
  try {
    saveCashlinkIntent(req.pubkey, intent)
  } catch {
    return { kind: 'legacy', why: 'preflight_storage' }
  }
  return runCashlinkIntent(req.ports, req.pubkey, k, { fresh: true })
}

/** One run per intent at a time, across this tab and every other tab of the origin. */
export function runCashlinkIntent(ports: DirectPorts, pubkey: string, id: string, opts: { fresh?: boolean } = {}): Promise<DirectOutcome> {
  return withQueuedLock(`imani-cashlink-intent:${pubkey}:${id}`, () => runLocked(ports, pubkey, id, opts.fresh === true))
}

const find = (pubkey: string, id: string) => loadCashlinkIntents(pubkey).find((r) => r.id === id)

/** Parts of one link armed at once; each part runs its own proofs side by side too. */
const PART_CONCURRENCY = 3

async function runLocked(ports: DirectPorts, pubkey: string, id: string, fresh: boolean): Promise<DirectOutcome> {
  const intent = find(pubkey, id)
  if (!intent) return { kind: 'pending', why: 'no such Cashlink intent' }
  const identity = ports.identitySecret()
  if (!identity) return { kind: 'pending', why: 'the wallet key is locked' }
  const L = secretFromText(intent.k)
  if (!L) {
    identity.fill(0)
    forgetCashlinkIntent(pubkey, id)
    return { kind: 'pending', why: 'unreadable link key' }
  }
  const R = deriveRefundSecret(identity, intent.i)
  const save = () => saveCashlinkIntent(pubkey, intent)
  try {
    // 3. Every part checked before the first burn, side by side, while nothing has moved. A run
    // that finds every part still `new` (a page that died before the first burn) checks again.
    const checked = new Set<CashlinkIntentPart>()
    if (intent.parts.every((p) => p.state === 'new')) {
      const checks = await inParallel(
        intent.parts.map((part) => () => armPreflight(context(ports, intent, part, L, R, identity, save))),
        PART_CONCURRENCY,
      )
      for (const c of checks) {
        const refusal = c.ok ? c.value : ({ kind: 'unarmed', why: 'unreachable' } as const)
        if (refusal) {
          forgetCashlinkIntent(pubkey, id)
          return { kind: 'legacy', why: legacyReasonOf(refusal) }
        }
      }
      for (const p of intent.parts) checked.add(p)
      if (!fresh) console.info('[cashlink] resuming a direct Cashlink from its pre-check')
    }

    // 4 and 5. Each part armed; its wraps go out as soon as they are collected, beside its refunds.
    const publishing: Array<Promise<void>> = []
    const publishPart = (part: CashlinkIntentPart) => {
      for (const token of part.wraps ?? []) {
        if (part.published?.includes(token)) continue
        publishing.push(
          ports.publish(L, token).then(
            (ok) => {
              if (!ok) return
              part.published = [...new Set([...(part.published ?? []), token])]
              save()
            },
            () => undefined,
          ),
        )
      }
    }
    let pending: string | undefined
    const armOne = async (part: CashlinkIntentPart): Promise<void> => {
      if (part.state === 'kept' || part.state === 'gone') return settle(ports, part, save)
      if (part.state === 'locked') {
        // Minted, maybe not published, maybe its refunds not deposited (section 5).
        publishPart(part)
        await settle(ports, part, save)
        if (part.armed === false && part.wraps?.length) {
          const again = await retryAll(ports, L, R, part.wraps)
          if (again.kind === 'armed') {
            part.armed = true
            part.depositKeyset = again.keyset
            save()
          }
        }
        return
      }
      if (part.state !== 'new' && part.state !== 'arming') return
      const wasChecked = checked.has(part)
      if (part.state === 'new' && wasChecked) {
        // Recorded as arming BEFORE its burn, so the pre-check is never run again (it would read
        // our own burn as a claim).
        part.state = 'arming'
        save()
      }
      let onLinkNow = false
      const out = await armGift({
        ...context(ports, intent, part, L, R, identity, save, () => {
          if (onLinkNow) return
          onLinkNow = true
          publishPart(part)
        }),
        ...(wasChecked ? { preChecked: true } : {}),
      })
      if (out.kind === 'armed' || out.kind === 'not_armed') {
        part.state = 'locked'
        part.armed = out.kind === 'armed'
        part.depositKeyset = out.keyset
        delete part.token
        save()
        if (!onLinkNow) publishPart(part)
        await settle(ports, part, save)
        return
      }
      if (out.kind === 'arming') {
        pending ??= out.why
        return
      }
      if (out.kind === 'unarmed') {
        // The mint refused the burn outright (or, for a part not checked by this run, its own
        // pre-check refused): nothing of it moved. The coupon is as it was.
        part.state = 'unarmed'
        save()
        return
      }
      // Refused after the burn (kept as sats) or spent by someone else: the coupon left this wallet.
      part.state = out.kind === 'kept_as_sats' ? 'kept' : 'gone'
      delete part.token
      save()
      await settle(ports, part, save)
    }
    // Every part was just checked together, so all are armed side by side (one burn round, one
    // lock-batch round, one mint round: section 2's round trips). A part refused after its burn is
    // kept as sats and dropped; the link holds what was locked.
    const done = await inParallel(intent.parts.map((part) => () => armOne(part)), PART_CONCURRENCY)
    for (const r of done) if (!r.ok) pending ??= r.error instanceof Error ? r.error.message : String(r.error)
    await Promise.all(publishing)

    const locked = intent.parts.filter((p) => p.state === 'locked')
    const kept = intent.parts.filter((p) => p.state === 'kept').reduce((n, p) => n + p.amount, 0)
    if (pending !== undefined) {
      if (locked.length > 0) await writeRows(ports, intent, save)
      return { kind: 'pending', why: pending }
    }
    if (locked.length === 0) {
      forgetCashlinkIntent(pubkey, id)
      return kept > 0 ? { kind: 'nothing', kept } : { kind: 'legacy', why: 'preflight_burn_refused' }
    }
    // 6. The rows, and the intent forgotten once every wrap is on the link.
    const arm = await writeRows(ports, intent, save)
    const published = locked.every((p) => (p.wraps ?? []).every((t) => p.published?.includes(t)))
    // Kept while a wrap is not on the link (the next run republishes it), and while a refund is not
    // at the relay before `x` (the next run retries the deposit): section 5. Only the first holds
    // logout (`inFlightMoney`): a locked link on its link is safe either way.
    if (published && (arm.s === 'armed' || Math.floor(ports.now() / 1000) >= intent.x)) forgetCashlinkIntent(pubkey, id)
    return { kind: 'made', delivered: locked.reduce((n, p) => n + p.amount, 0), published, armed: arm.s === 'armed', kept }
  } catch (error) {
    return { kind: 'pending', why: error instanceof Error ? error.message : String(error) }
  } finally {
    identity.fill(0)
    R.fill(0)
  }
}

function context(
  ports: DirectPorts,
  intent: CashlinkIntent,
  part: CashlinkIntentPart,
  L: Uint8Array,
  R: Uint8Array,
  identity: Uint8Array,
  save: () => void,
  onDelivered?: () => void,
): ArmContext {
  let collected: string[] | undefined
  return {
    // Delivery is into the intent: the wraps are published from there (step 5), never read back.
    ports: {
      ...ports,
      deliver: async (_key: Uint8Array, token: string) => {
        collected = collected ?? []
        if (!collected.includes(token)) collected.push(token)
        part.wraps = [...collected]
        save()
        return true
      },
    },
    ...(onDelivered ? { onDelivered } : {}),
    linkSecret: L,
    refundSecret: R,
    x: intent.x,
    gifts: [{ token: part.token ?? '', sentAt: Math.floor(intent.at / 1000) }],
    merchant: false,
    onArming: async (keyset: string) => {
      part.state = 'arming'
      part.burnKeyset = keyset
      save()
    },
    onLocked: async (secret: string, signed: string) => {
      part.locks = { ...(part.locks ?? {}), [secret]: signed }
      save()
    },
    knownLocks: new Map(Object.entries(part.locks ?? {})),
    // #402: a part locked to the wallet's own key (a split voucher's part) is burnt and locked by it.
    selfSecret: identity,
    ...(part.state === 'arming' ? { resuming: true, ...(part.burnKeyset ? { burnKeyset: part.burnKeyset } : {}) } : {}),
  }
}

/** The source row once its part left the wallet: removed, or its rest kept. Recorded, so done once. */
async function settle(ports: DirectPorts, part: CashlinkIntentPart, save: () => void): Promise<void> {
  if (part.sourceSettled) return
  await ports.settleSource(part.sourceTokenId, part.carved ? (part.rest ?? null) : null)
  part.sourceSettled = true
  save()
}

async function retryAll(ports: DirectPorts, L: Uint8Array, R: Uint8Array, wraps: string[]): Promise<ArmOutcome> {
  let last: ArmOutcome = { kind: 'not_armed', keyset: '', why: 'no wraps' }
  for (const token of wraps) {
    last = await retryDeposit(ports, L, R, token)
    if (last.kind !== 'armed') return last
  }
  return last
}

/** The arm the rows carry: `arming` until every wrap is on the link, then armed when every refund is. */
function armOf(intent: CashlinkIntent): GiftLinkArm {
  const locked = intent.parts.filter((p) => p.state === 'locked')
  const published = locked.every((p) => (p.wraps ?? []).every((t) => p.published?.includes(t)))
  const ks = locked.find((p) => p.depositKeyset)?.depositKeyset ?? locked.find((p) => p.burnKeyset)?.burnKeyset
  const s: GiftLinkArm['s'] = !published ? 'arming' : locked.every((p) => p.armed) ? 'armed' : 'not_armed'
  return { s, ...(ks ? { ks } : {}) }
}

async function writeRows(ports: DirectPorts, intent: CashlinkIntent, save: () => void): Promise<GiftLinkArm> {
  const arm = armOf(intent)
  await ports.recordRows(intent, arm)
  if (!intent.rowsWritten) {
    intent.rowsWritten = true
    save()
  }
  return arm
}

// --- Start-up ---------------------------------------------------------------------

/** Every direct Cashlink a page left part way, finished or left for the next run. Never throws. */
export async function finishCashlinkIntents(ports: DirectPorts, pubkey: string): Promise<number> {
  let done = 0
  for (const intent of loadCashlinkIntents(pubkey)) {
    try {
      const out = await runCashlinkIntent(ports, pubkey, intent.id)
      if (out.kind !== 'pending') done += 1
    } catch {
      // Left for the next run.
    }
  }
  return done
}

/** The credited face of a token, minor units (0 when unreadable). */
export function faceOf(token: string): number {
  try {
    return creditableFaceValue(parseVoucherToken(token)).faceValue
  } catch {
    return 0
  }
}
