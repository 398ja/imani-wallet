/**
 * The app's side of minted-locked gifts (#410 G14): filing them from DMs, and the sweep that claims
 * the ones locked to this wallet and takes back the unclaimed ones this wallet bought. The rules are
 * in `lockedGifts.ts`; this is where they meet storage, the signer and the network.
 */
import { getSigner } from './nap'
import { getWallet, notifyWalletChanged } from './wallet'
import { beginReceive } from './receiveGate'
import type { CashlinkPorts } from './cashlinkFlow'
import { parseVoucherToken, tokenProofs } from './voucherToken'
import {
  acceptGiftSent,
  asLockedGiftRecord,
  checkLockedGift,
  lockedGiftMemo,
  lockedGiftRow,
  lockedGiftRowId,
  settleIncoming,
  takeBackLockedGift,
  type GiftSentMessage,
  type LockedGiftRecord,
} from './lockedGifts'

export const lockedGiftSeam = {
  ports: async (): Promise<CashlinkPorts> => (await import('./cashlinkPorts')).appCashlinkPorts(),
  /** The wallet key, borrowed as a copy the caller wipes; null for a signer that cannot lend it. */
  ownKey: (): Uint8Array | null => {
    try {
      return getSigner().withPrivkey((k) => Uint8Array.from(k))
    } catch {
      return null
    }
  },
  ownPub: (): string => getSigner().pubkey,
  /** The Purchase Issuer's seal key (payment-adapter `GET /api/v1/gifting/issuer-key`). */
  issuerKey: async (): Promise<string | null> => {
    const res = await fetch('/api/v1/gifting/issuer-key', { credentials: 'omit' })
    if (!res.ok) throw new Error(`issuer-key answered ${res.status}`)
    const body = (await res.json()) as { pubkey?: unknown }
    return typeof body.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(body.pubkey) ? body.pubkey.toLowerCase() : null
  },
  now: (): number => Date.now(),
}

async function save(rec: LockedGiftRecord, nowMs: number): Promise<void> {
  const wallet = getWallet()
  const id = lockedGiftRowId(rec.dir, rec.token)
  const prior = await wallet.getTransaction(id)
  if (prior) {
    await wallet.updateTransaction(id, { lockedGift: rec, memo: lockedGiftMemo(rec) } as never)
  } else {
    await wallet.addTransaction(lockedGiftRow(rec, nowMs) as never)
  }
  notifyWalletChanged()
}

async function existing(dir: 'in' | 'out', token: string): Promise<LockedGiftRecord | undefined> {
  const row = (await getWallet().getTransaction(lockedGiftRowId(dir, token))) as unknown as Record<string, unknown> | null
  return row ? asLockedGiftRecord(row.lockedGift) : undefined
}

/**
 * A `cashu_token_transfer` whose token is locked to this wallet's own key. 'filed': kept as a
 * pending gift (and claimed now when the key can be lent); 'not_mine': not a locked gift for us,
 * let the ordinary receive path see it. Throws when it could not be written (the DM is retried).
 */
export async function fileIncomingLockedGift(token: string, stall?: string): Promise<'filed' | 'not_mine'> {
  const check = checkLockedGift(token, 'lock', lockedGiftSeam.ownPub())
  if (!check.ok) {
    if (check.why === 'not_locked' || check.why === 'unreadable' || check.why === 'wrong_key') return 'not_mine'
    // Locked to us but not acceptable (forged, untrusted mint, open after its locktime): refused,
    // never redeemed, and the DM is marked handled.
    console.warn('[lockedGifts] refused a locked gift:', check.why)
    return 'filed'
  }
  const now = lockedGiftSeam.now()
  if (!(await existing('in', token))) await save({ dir: 'in', token, x: check.x, status: 'waiting', ...(stall ? { stall } : {}) }, now)
  void sweepLockedGifts().catch(() => undefined)
  return 'filed'
}

/** An `imani_gift_sent` DM (seal author already verified). True when filed or already filed. */
export async function fileGiftSent(msg: GiftSentMessage, sealAuthor: string | undefined): Promise<boolean> {
  let issuerKey: string | null
  try {
    issuerKey = await lockedGiftSeam.issuerKey()
  } catch {
    // Unknown issuer key: not accepted now; the DM stays unprocessed and is offered again.
    throw new Error('gift issuer key unavailable')
  }
  if (!issuerKey) return false
  const ok = acceptGiftSent(msg, lockedGiftSeam.ownPub(), sealAuthor, issuerKey)
  if (!ok.ok) {
    console.warn('[lockedGifts] refused a gift-sent notice:', ok.why)
    return false
  }
  if (!(await existing('out', msg.token))) {
    await save({ dir: 'out', token: msg.token, x: ok.x, status: 'waiting', stall: msg.stall, to: msg.to }, lockedGiftSeam.now())
  }
  return true
}

let sweeping: Promise<{ claimed: number; returned: number }> | null = null

/** Claim what is locked to us, take back what we bought and nobody claimed. Never throws. */
export function sweepLockedGifts(): Promise<{ claimed: number; returned: number }> {
  sweeping ??= runSweep().finally(() => {
    sweeping = null
  })
  return sweeping
}

async function runSweep(): Promise<{ claimed: number; returned: number }> {
  let claimed = 0
  let returned = 0
  let end: () => void
  try {
    end = beginReceive()
  } catch {
    return { claimed, returned }
  }
  try {
    const rows = (await getWallet().getAllTransactions()) as unknown as Array<Record<string, unknown>>
    const open = rows.map((r) => asLockedGiftRecord(r.lockedGift)).filter((r): r is LockedGiftRecord => !!r && (r.status === 'waiting' || r.status === 'returning'))
    if (open.length === 0) return { claimed, returned }
    const ports = await lockedGiftSeam.ports()
    const pubkey = lockedGiftSeam.ownPub()
    for (const rec of open) {
      const now = lockedGiftSeam.now()
      try {
        if (rec.dir === 'in') {
          const out = await settleIncoming(ports, pubkey, rec.token, lockedGiftSeam.ownKey)
          if (out === 'claimed') {
            claimed += 1
            await save({ ...rec, status: 'claimed', closedAt: now }, now)
          } else if (out === 'gone') {
            await save({ ...rec, status: 'gone', closedAt: now }, now)
          }
          continue
        }
        if (now / 1000 < rec.x && rec.status === 'waiting') {
          // Before x only the lock key spends it: a spend now is the recipient's claim.
          const states = await ports.mint.states(parseMint(rec.token), proofSecrets(rec.token))
          if (states.length > 0 && states.every((s) => s === 'SPENT')) await save({ ...rec, status: 'claimed', closedAt: now }, now)
          continue
        }
        const key = lockedGiftSeam.ownKey()
        if (!key) continue
        try {
          const out = await takeBackLockedGift(ports, key, rec.token, async () => {
            if (rec.status !== 'returning') await save({ ...rec, status: 'returning' }, now)
          })
          if (out.kind === 'returned') {
            returned += 1
            await save({ ...rec, status: 'returned', closedAt: now }, now)
          } else if (out.kind === 'claimed') {
            await save({ ...rec, status: 'claimed', closedAt: now }, now)
          }
        } finally {
          key.fill(0)
        }
      } catch {
        // Left for the next run.
      }
    }
  } catch {
    // Storage not open, or unreadable: next run.
  } finally {
    end()
  }
  return { claimed, returned }
}

const parseMint = (token: string) => parseVoucherToken(token).mintUrl.trim().replace(/\/+$/, '')
const proofSecrets = (token: string) => tokenProofs(token).map((p) => p.secret)
