/**
 * #543: the app's side of the direct Cashlink ports. The Cashlink ports (`cashlinkPorts.ts`), the
 * wallet key, a publish read back from the relay by id (#532), the coupon rows and the link's sent rows.
 */
import type { TransactionRow } from '@imani/wallet-storage'

import { appCashlinkPorts } from './cashlinkPorts'
import { cashlinkBundleId, wrapForLink } from './cashlinkFlow'
import type { CashlinkIntent } from './cashlinkIntents'
import type { DirectPorts } from './cashlinkDirect'
import { linkPubOf, secretFromText } from './giftLink'
import { getSigner } from './nap'
import { replaceVoucherToken } from './pay'
import { defaultRelayDeliveryPorts, deliverToRelay } from './relayDelivery'
import { buildSentTransaction, type GiftLinkArm, type GiftLinkRecord } from './transactions'
import { mirrorToGateway } from './transferSignature'
import { publishTx } from './txRecords'
import { creditableFaceValue, parseVoucherToken } from './voucherToken'
import { getWallet, notifyWalletChanged } from './wallet'

/**
 * #543 review: how often a wrap's relay publish is tried when the relay could not be REACHED. On
 * staging a send fires several publishes at once (records, history, wraps), each on its own socket,
 * and some lose nostr-tools' 3 s connect race; one such loss left a link `arming` until the next
 * start. A relay that answered `OK false` (too large, #532) is never retried: it will refuse again.
 */
export const WRAP_RELAY_ATTEMPTS = 3

/**
 * One locked wrap onto its link, to the relay and the gateway's cache at once. Delivered means the
 * RELAY holds it (publish OK and a read-back by id from the relay, #532) and the gateway mirror
 * answered 2xx (#543 review: the claimer reads the gateway). The mirror alone never counts: the
 * gateway keeps events strfry refused.
 */
export async function publishWrap(linkSecret: Uint8Array, token: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  let me: string | undefined
  try {
    me = getSigner().pubkey?.toLowerCase()
  } catch {
    me = undefined
  }
  const wrap = wrapForLink(linkSecret, token, me)
  const [relayed, mirrored] = await Promise.all([
    deliverToRelay(wrap, { ...defaultRelayDeliveryPorts, sleep }, { attempts: WRAP_RELAY_ATTEMPTS }),
    mirrorToGateway(wrap),
  ])
  if (!relayed.delivered && relayed.why === 'too_large') console.error('[cashlink] the relay refused a link wrap as too large (#532)')
  return relayed.delivered && mirrored
}

async function settleSource(tokenId: string, rest: string | null): Promise<void> {
  const wallet = getWallet()
  // Already settled by an earlier run whose record of it was lost: nothing to do.
  if (!(await wallet.getVoucher(tokenId))) return
  if (rest) await replaceVoucherToken(wallet, tokenId, rest, creditableFaceValue(parseVoucherToken(rest)).faceValue)
  else await wallet.removeVoucher(tokenId)
  notifyWalletChanged()
}

/** The link's rows, one per locked part, as the atomic-send path writes them, minus the send id. */
export function directRows(intent: CashlinkIntent, arm: GiftLinkArm): TransactionRow[] {
  const L = secretFromText(intent.k)
  if (!L) return []
  const linkPub = linkPubOf(L)
  const link: GiftLinkRecord = { k: intent.k, i: intent.i, x: intent.x, status: 'outstanding', arm }
  return intent.parts
    .filter((p) => p.state === 'locked')
    .map((p) =>
      buildSentTransaction({
        tokenId: p.rowId,
        amount: p.amount,
        unit: intent.unit,
        decimals: intent.decimals,
        merchantId: intent.stall,
        merchantName: intent.merchantName,
        recipientPubkey: linkPub,
        recipientName: 'Link',
        voucherId: p.voucherId,
        memo: intent.memo,
        // #530: every part of one link is one send in History.
        bundleId: cashlinkBundleId(linkPub),
        link,
        at: intent.at,
      }),
    )
}

async function recordRows(intent: CashlinkIntent, arm: GiftLinkArm): Promise<void> {
  const wallet = getWallet()
  for (const row of directRows(intent, arm)) {
    const id = (row as unknown as { id: string }).id
    const existing = (await wallet.getTransaction(id)) as unknown as { link?: GiftLinkRecord } | null
    // A row already closed (claimed, taken back) keeps its outcome; only its arm is brought up to date.
    const merged = existing?.link && existing.link.status !== 'outstanding'
      ? await wallet.updateTransaction(id, { link: { ...existing.link, arm } } as unknown as Partial<TransactionRow>)
      : await wallet.addTransaction(existing?.link ? ({ ...row, link: { ...existing.link, ...(row as unknown as { link: GiftLinkRecord }).link, arm } } as unknown as TransactionRow) : row)
    if (merged) void publishTx(merged)
  }
  notifyWalletChanged()
}

export function appDirectPorts(): DirectPorts {
  return {
    ...appCashlinkPorts(),
    identitySecret: () => {
      try {
        return getSigner().withPrivkey((key) => Uint8Array.from(key))
      } catch {
        return null
      }
    },
    publish: publishWrap,
    settleSource,
    recordRows,
  }
}
