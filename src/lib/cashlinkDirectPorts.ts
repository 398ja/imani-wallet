/**
 * #543: the app's side of the direct Cashlink ports. The Cashlink ports (`cashlinkPorts.ts`), the
 * wallet key, a publish that does not read back, the coupon rows and the link's sent rows.
 */
import type { TransactionRow } from '@imani/wallet-storage'

import { appCashlinkPorts } from './cashlinkPorts'
import { cashlinkBundleId, wrapForLink } from './cashlinkFlow'
import type { CashlinkIntent } from './cashlinkIntents'
import type { DirectPorts } from './cashlinkDirect'
import { linkPubOf, secretFromText } from './giftLink'
import { getSigner } from './nap'
import { replaceVoucherToken } from './pay'
import { publish } from './relay'
import { buildSentTransaction, type GiftLinkArm, type GiftLinkRecord } from './transactions'
import { mirrorToGateway } from './transferSignature'
import { publishTx } from './txRecords'
import { creditableFaceValue, parseVoucherToken } from './voucherToken'
import { getWallet, notifyWalletChanged } from './wallet'

/**
 * One locked wrap onto its link, to the relay and the gateway's cache at once. Delivered means the
 * relay said OK and the gateway mirror answered 2xx (#532 follow-up): the claimer reads the gateway,
 * so a relay-only copy is not yet "on the link". Nothing is read back.
 */
async function publishWrap(linkSecret: Uint8Array, token: string): Promise<boolean> {
  let me: string | undefined
  try {
    me = getSigner().pubkey?.toLowerCase()
  } catch {
    me = undefined
  }
  const wrap = wrapForLink(linkSecret, token, me)
  const [relayed, mirrored] = await Promise.all([publish(wrap).then((r) => r.ok > 0, () => false), mirrorToGateway(wrap)])
  return relayed && mirrored
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
