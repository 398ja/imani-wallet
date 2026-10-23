import { useEffect, useState } from 'react'

import { Button } from './ui'
import { DetailRow, ListSection } from './ui/layout'
import { ClaimLinkPanel } from './CashbackClaimLink'
import { formatDate } from '../lib/format'
import { linkFor, reconcileGiftLinks, takeBack, type TakeBackOutcome } from '../lib/giftLinks'
import { giftStatusLabel, type GiftLinkRecord, type GiftLinkStatus } from '../lib/transactions'
import { RETURN_STATUS_COPY } from '../lib/cashlinkCopy'

const TAKE_BACK_FAILURE: Record<Exclude<TakeBackOutcome['kind'], 'ok'>, string> = {
  claimed: 'It was already claimed, so there is nothing to take back.',
  held: 'It could not be taken back here: its mint is not one this wallet uses.',
  not_found: 'We could not find this Cashlink’s voucher just now. Try again in a moment.',
  failed: 'Could not take it back just now. Try again.',
  // Owner rule 2026-10-13. A merchant account cannot send another stall's voucher by link, so this
  // only meets a link made before the rule, or before the account opened a stall.
  merchant_refused:
    "This account is a merchant account now, and it can only take its own stall's vouchers. Open the link in a customer account to take it back.",
}

/**
 * A gift link's section on its `sent` row: status, the link again while it waits, and **Take it
 * back** (Q4). Opening it runs the same NUT-07 check as start-up (spec 3.3, "on opening History").
 */
export function GiftLinkSection({ link }: { link: GiftLinkRecord | undefined }) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (link?.status === 'outstanding') void reconcileGiftLinks()
  }, [link?.status])

  if (!link) return null
  const status: GiftLinkStatus = link.status
  // #295 phase 4: on its way back, it is no longer on the link and can no longer be shown or taken.
  const returning = status === 'outstanding' && link.arm?.s === 'returning'
  const open = status === 'outstanding' && !returning
  const url = open ? linkFor(link) : null
  const comesBack = returning
    ? RETURN_STATUS_COPY.returning
    : open
      ? link.arm?.s === 'armed'
        ? RETURN_STATUS_COPY.onItsOwn
        : RETURN_STATUS_COPY.whenOpened
      : null

  const run = async () => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    const outcome = await takeBack(link.k)
    setBusy(false)
    setConfirming(false)
    if (outcome.kind !== 'ok') setMessage(TAKE_BACK_FAILURE[outcome.kind])
  }

  return (
    <ListSection title="Cashlink">
      <DetailRow label="Status" value={giftStatusLabel(link)} />
      <DetailRow label="Expires" value={formatDate(link.x * 1000)} />
      {comesBack && <DetailRow label="If unclaimed" value={comesBack} />}
      {open && url && (
        <div className="space-y-2 p-4">
          <ClaimLinkPanel link={url} expiresAt={link.x * 1000} qrAlt="QR code to claim this Cashlink" />
          {message && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {message}
            </p>
          )}
          {confirming ? (
            // Opens in place of the button that asked, so the question stays
            // where the tap was. `expand-row` drops out under reduced motion.
            <div className="expand-row space-y-2">
              <p className="text-sm text-mono-600 dark:text-mono-300">
                Take it back? The Cashlink stops working and the voucher returns to your wallet.
              </p>
              <Button variant="primary" className="w-full" disabled={busy} onClick={() => void run()}>
                {busy ? 'Taking it back…' : 'Take it back'}
              </Button>
              <Button variant="ghost" className="w-full" disabled={busy} onClick={() => setConfirming(false)}>
                Keep the link
              </Button>
            </div>
          ) : (
            <Button variant="ghost" className="w-full" onClick={() => setConfirming(true)}>
              Take it back
            </Button>
          )}
        </div>
      )}
    </ListSection>
  )
}
