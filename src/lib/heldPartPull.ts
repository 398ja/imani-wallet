/**
 * The recipient pulls bundle parts the gateway holds for it (imani-gateway-core#220, decision B).
 *
 * The relay DM stays the primary way a part arrives. This is a second, independent one: a part
 * past its bundle's decision is the recipient's money, and one broken relay path must not keep it
 * away. The gateway answers `GET /api/v1/atomic-send/incoming` with the same fields the token DM
 * body carries, and this module turns each row back into that body and hands it to the SAME
 * receive path a gift wrap takes (`DmPollService.processPulledToken`): the same parser, the same
 * received-fingerprint set, the same redeem and so the same `trackArrival`. A part that comes both
 * ways is credited once, whichever is first.
 *
 * After the mint swap, the part is acknowledged so the gateway stops retrying and the sender sees
 * Sent. The ack is bookkeeping only: the money is in the wallet before it is sent, so a failed ack
 * is kept and tried again on the next pull, and is never a reason to swap again.
 *
 * When: at login, on resume, and every minute while a bundle is open ("on its way"). Never more
 * than once a minute, with a doubling backoff after a failure. A gateway without the route (404
 * or 405) is left alone for the rest of the session: the DM path still works.
 */

export type PullOutcome = 'redeemed' | 'duplicate' | 'in_flight' | 'not_redeemed' | 'failed' | 'no_token'

/** One row of `GET /api/v1/atomic-send/incoming`, as the gateway-core#220 contract writes it. */
export interface IncomingPart {
  send_id: string
  token: string
  recipient_pubkey: string
  sender_pubkey?: string | null
  created_at?: number | null
  memo?: string | null
  face_value?: number | null
  face_unit?: string | null
  face_decimals?: number | null
  token_amount?: number | null
  issuer_id?: string | null
  expires_at?: number | null
  bundle_id?: string | null
  bundle_total?: number | null
  bundle_part_index?: number | null
  bundle_part_count?: number | null
  voucher_id?: string | null
  payment_request_id?: string | null
}

export interface HeldPartPullDeps {
  recipientPubkey: string
  getIncoming(opts: { since: number; limit: number }): Promise<{ items?: IncomingPart[]; next_since?: number | null } | null>
  ack(sendId: string): Promise<unknown>
  /** The DM receive path, entered after the unwrap. */
  receive(input: { eventId: string; senderPubkey: string; content: string; createdAt: number }): Promise<PullOutcome>
  /** Whether a bundle is still "on its way" to this wallet. */
  hasOpenBundle(): boolean
  now?: () => number
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}

export const PULL_MIN_INTERVAL_MS = 60_000
export const PULL_MAX_BACKOFF_MS = 15 * 60_000
const PAGE_LIMIT = 50
const MAX_PAGES = 5

/** The DM body the gateway would have published for this part, so one parser reads both. */
export function contentOf(row: IncomingPart): string {
  return JSON.stringify({
    type: 'cashu_token_transfer',
    token: row.token,
    memo: row.memo ?? null,
    voucher_id: row.voucher_id ?? undefined,
    face_value: row.face_value ?? undefined,
    face_unit: row.face_unit ?? undefined,
    face_decimals: row.face_decimals ?? undefined,
    token_amount: row.token_amount ?? undefined,
    issuer_id: row.issuer_id ?? undefined,
    sender_pubkey: row.sender_pubkey ?? undefined,
    expires_at: row.expires_at ?? null,
    request_id: row.payment_request_id ?? null,
    bundle_id: row.bundle_id ?? null,
    bundle_total: row.bundle_total ?? null,
    bundle_part_index: row.bundle_part_index ?? null,
    bundle_part_count: row.bundle_part_count ?? null,
  })
}

function statusOf(error: unknown): number | undefined {
  const s = (error as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

export interface HeldPartPuller {
  /** Pull now if the minute and any backoff have passed. Resolves when that pull is done. */
  poke(reason: 'login' | 'resume' | 'bundle_open'): Promise<void>
  /** A timer pokes every minute while a bundle is open. */
  start(): void
  stop(): void
  /** Test and status surface. */
  readonly unsupported: boolean
  pendingAcks(): string[]
}

export function createHeldPartPuller(deps: HeldPartPullDeps): HeldPartPuller {
  const now = deps.now ?? (() => Date.now())
  const me = deps.recipientPubkey.toLowerCase()
  const ackKey = `imani:pull-acks:${me}`
  const storage = deps.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)

  let unsupported = false
  let lastAt = -Infinity
  let wait = PULL_MIN_INTERVAL_MS
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  const readAcks = (): Set<string> => {
    try {
      const raw = storage?.getItem(ackKey)
      const list = raw ? (JSON.parse(raw) as unknown) : []
      return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  }
  const acks = readAcks()
  const saveAcks = (): void => {
    try {
      storage?.setItem(ackKey, JSON.stringify([...acks].slice(-200)))
    } catch {
      /* in memory still */
    }
  }

  async function flushAcks(): Promise<void> {
    for (const sendId of [...acks]) {
      try {
        await deps.ack(sendId)
        acks.delete(sendId)
      } catch (e) {
        // Not ours (any more), or already settled by the gateway's own spent check: nothing to retry.
        if (statusOf(e) === 404) acks.delete(sendId)
      }
    }
    saveAcks()
  }

  async function pullOnce(): Promise<void> {
    let since = 0
    for (let page = 0; page < MAX_PAGES && !stopped; page++) {
      const res = await deps.getIncoming({ since, limit: PAGE_LIMIT })
      const items = Array.isArray(res?.items) ? res.items : []
      for (const row of items) {
        if (stopped) return
        if (!row || typeof row.send_id !== 'string' || typeof row.token !== 'string') continue
        // Only ever money addressed to this key. The gateway filters on it too.
        if (typeof row.recipient_pubkey !== 'string' || row.recipient_pubkey.toLowerCase() !== me) continue
        const outcome = await deps.receive({
          eventId: `pull:${row.send_id}`,
          senderPubkey: row.sender_pubkey ?? '',
          content: contentOf(row),
          createdAt: row.created_at ?? Math.floor(now() / 1000),
        })
        // In the wallet, now or before: tell the gateway. Anything else stays unacked and comes back.
        if (outcome === 'redeemed' || outcome === 'duplicate') {
          acks.add(row.send_id)
          saveAcks()
        }
      }
      const next = res?.next_since
      if (items.length < PAGE_LIMIT || typeof next !== 'number' || next <= since) break
      since = next
    }
  }

  async function run(): Promise<void> {
    try {
      await pullOnce()
      wait = PULL_MIN_INTERVAL_MS
    } catch (e) {
      const status = statusOf(e)
      if (status === 404 || status === 405) {
        unsupported = true
        return
      }
      wait = Math.min(wait * 2, PULL_MAX_BACKOFF_MS)
      console.warn('[heldPartPull] pull failed, backing off', { status, waitMs: wait })
    }
    await flushAcks()
  }

  return {
    get unsupported() {
      return unsupported
    },
    pendingAcks: () => [...acks],
    poke() {
      if (stopped || unsupported) return Promise.resolve()
      if (running) return running
      if (now() - lastAt < wait) return Promise.resolve()
      lastAt = now()
      running = run().finally(() => {
        running = undefined
      })
      return running
    },
    start() {
      if (timer || typeof setInterval === 'undefined') return
      timer = setInterval(() => {
        if (deps.hasOpenBundle()) void this.poke('bundle_open')
      }, PULL_MIN_INTERVAL_MS)
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
