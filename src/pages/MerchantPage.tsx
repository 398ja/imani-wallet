import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Check, Copy, Send, Share2 } from 'lucide-react'
import { nip19 } from 'nostr-tools'

import {
  Button,
  Screen,
  BackLink,
  ListSection,
  SeeAll,
  EmptyRow,
  Centered,
  Pass,
  TransactionListItem,
} from '../components/ui'
import { listVouchers, transactionsWith, onWalletChanged } from '../lib/wallet'
import { findMerchantWithHistory, couponsFor, type Merchant } from '../lib/merchants'
import { toMerchantPass, EMPTY_BRANDING, type MerchantBranding } from '../lib/pass'
import { merchantBranding } from '../lib/branding'
import type { WalletTransaction } from '../lib/transactions'
import { canShare, shareText } from '../lib/native'

/** How many transactions the summary list shows before deferring to a full page. */
const PREVIEW = 3

/**
 * One merchant: their pass, and the history with them.
 *
 * The pass carries the total and IS the way into the coupon list — which is why
 * there is no separate balance panel and no inline coupon list here. Two totals
 * on one screen is worse than one, and the coupon list now lives one level
 * deeper at `/merchants/:pubkey/coupons`.
 */
export function MerchantPage() {
  const { pubkey = '' } = useParams()
  const navigate = useNavigate()
  const [merchant, setMerchant] = useState<Merchant | null | undefined>(undefined)
  const [couponCount, setCouponCount] = useState(0)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [branding, setBranding] = useState<MerchantBranding>(EMPTY_BRANDING)

  useEffect(() => {
    const load = async () => {
      const [rows, history] = await Promise.all([listVouchers(), transactionsWith(pubkey)])
      // Through the history too, or a merchant whose coupons are all spent bounces
      // off the `merchant === null` branch below with "No coupons from this
      // merchant." — over a screen whose whole other half is the history with them.
      setMerchant(findMerchantWithHistory(rows, history, pubkey) ?? null)
      // Rows, not merchant.groups[].vouchers — only the row carries token_id, and
      // that is what addresses a coupon's detail screen.
      setCouponCount(couponsFor(rows, pubkey).length)
      setTransactions(history)
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

  useEffect(() => {
    // Never rejects — an unbranded merchant falls back to the pass defaults.
    merchantBranding(pubkey).then(setBranding)
  }, [pubkey])

  if (merchant === undefined) return <Centered>Loading…</Centered>
  if (merchant === null) return <Centered>No vouchers from this merchant.</Centered>

  return (
    <Screen>
      <BackLink to="/" label="Merchants" />

      <div className="mb-6">
        <Pass pass={toMerchantPass(merchant, branding)} to={`/merchants/${pubkey}/coupons`} />
        <p className="mt-2 text-center text-sm text-mono-500">
          {couponCount === 1 ? '1 voucher' : `${couponCount} vouchers`} · tap to see them
        </p>
      </div>

      <div className={`mb-6 grid gap-3 ${couponCount > 0 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {/* The other way into /send: the voucher is already settled by being on
            this page, so it opens on the recipient rather than on the picker.
            Hidden with nothing to send — a button that can only refuse is worse
            than no button. */}
        {couponCount > 0 && (
          <Button size="lg" onClick={() => navigate(`/send?from=${pubkey}`)}>
            <Send className="mr-2 h-5 w-5" /> Send
          </Button>
        )}
        <ShareMerchant pubkey={pubkey} nip05={branding.nip05} />
      </div>

      <ListSection
        title="Transactions"
        action={
          transactions.length > PREVIEW ? (
            <SeeAll to={`/merchants/${pubkey}/transactions`} count={transactions.length} />
          ) : undefined
        }
      >
        {transactions.length === 0 ? (
          <EmptyRow>Nothing yet.</EmptyRow>
        ) : (
          transactions.slice(0, PREVIEW).map((tx) => <TransactionListItem key={tx.id} tx={tx} />)
        )}
      </ListSection>
    </Screen>
  )
}

/**
 * Hand this stall to somebody else.
 *
 * What goes out is the merchant's own handle — the full `name@domain` from
 * their kind-0, or their npub when they have not claimed one — and nothing
 * else. A bare string is what a wallet can consume: whoever receives it pastes
 * it into Scan or Send and lands on this same merchant. Wrapped in a sentence
 * it would read better and paste worse.
 *
 * Copy stands in where there is no share sheet, so the slot is never dead in a
 * desktop browser. Either way it is one button doing one job, and it says which.
 */
function ShareMerchant({ pubkey, nip05 }: { pubkey: string; nip05?: string }) {
  const [copied, setCopied] = useState(false)

  // Encoding is fallible on a malformed key; without either form there is
  // nothing to hand over, so the button does not appear.
  const handle =
    nip05 ??
    (() => {
      try {
        return nip19.npubEncode(pubkey)
      } catch {
        return null
      }
    })()

  if (handle === null) return null

  const shareable = canShare()

  const act = async () => {
    if (await shareText(handle)) return
    try {
      await navigator.clipboard.writeText(handle)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard denied. Nothing a message would let them do differently.
    }
  }

  return (
    <Button size="lg" variant="outline" onClick={act}>
      {shareable ? (
        <Share2 className="mr-2 h-5 w-5" />
      ) : copied ? (
        <Check className="mr-2 h-5 w-5" />
      ) : (
        <Copy className="mr-2 h-5 w-5" />
      )}
      <span aria-live="polite">
        {shareable ? 'Share' : copied ? 'Copied' : 'Copy'}
      </span>
    </Button>
  )
}
