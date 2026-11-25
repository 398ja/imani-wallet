import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { BadgeCheck, Clock, QrCode, Share2 } from 'lucide-react'

import { DetailRow, ListSection } from './ui'
import { formatFace } from '../lib/format'
import { canShare, shareText, writeClipboard } from '../lib/native'
import { receiptShareText } from '../lib/receipts/shareText'
import {
  onReceiptsChanged,
  presentReceipt,
  receiptForTransaction,
  type ReceiptView,
} from '../lib/receipts'

/**
 * The receipt for one outgoing payment (spec 049), on that payment's own record.
 *
 * Placed on the transaction screen rather than in a list of its own: a receipt
 * answers "prove I paid THIS", so it belongs to the payment it proves, one tap
 * from the amount the customer is looking at. Wayfinding: the customer never
 * has to work out which receipt goes with which purchase.
 *
 * Absent entirely when the payment has none (a send to a friend through an old
 * gateway, a payment from before receipts). A permanent "no receipt" line on
 * every old row would read as a fault the customer can do nothing about.
 */
export function ReceiptSection({ txId }: { txId: string }) {
  const [receipt, setReceipt] = useState<ReceiptView | null | undefined>(undefined)
  const [showing, setShowing] = useState(false)

  useEffect(() => {
    let live = true
    const load = () =>
      receiptForTransaction(txId).then(
        (r) => live && setReceipt(r),
        () => live && setReceipt(null),
      )
    void load()
    const off = onReceiptsChanged(() => void load())
    return () => {
      live = false
      off()
    }
  }, [txId])

  if (!receipt) return null

  const ready = receipt.status !== 'pending'

  return (
    <>
      <ListSection title="Receipt">
        <DetailRow label="Status" value={<ReceiptStatusLine receipt={receipt} />} />
        {ready ? (
          <button
            type="button"
            onClick={() => setShowing(true)}
            className="press-row flex w-full items-center gap-3 p-4 text-left outline-none ring-mono-400 focus-visible:ring-2"
          >
            <QrCode className="h-5 w-5 shrink-0 text-mono-500" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-mono-900 dark:text-mono-50">Show receipt</span>
              <span className="block text-sm text-mono-500">A code the stall can scan to check you paid</span>
            </span>
          </button>
        ) : null}
      </ListSection>

      {showing ? <ReceiptQrDialog receipt={receipt} onClose={() => setShowing(false)} /> : null}
    </>
  )
}

/**
 * What the receipt can prove, in one line. A glyph AND words for each state, so
 * it still reads in greyscale and in bright sun.
 */
function ReceiptStatusLine({ receipt }: { receipt: ReceiptView }) {
  if (receipt.status === 'countersigned') {
    return (
      <span className="flex items-center gap-2 text-mono-900 dark:text-mono-50">
        <BadgeCheck className="h-[1em] w-[1em] shrink-0 text-green-600" aria-hidden />
        Confirmed by the stall
      </span>
    )
  }
  if (receipt.status === 'signed') {
    return (
      <span className="flex items-center gap-2 text-mono-900 dark:text-mono-50">
        <BadgeCheck className="h-[1em] w-[1em] shrink-0 text-mono-500" aria-hidden />
        Signed by you
      </span>
    )
  }
  return (
    <span className="flex items-center gap-2 text-right text-mono-900 dark:text-mono-50">
      <Clock className="h-[1em] w-[1em] shrink-0 text-mono-500" aria-hidden />
      {PENDING_LINE[receipt.pendingReason ?? 'other']}
    </span>
  )
}

/**
 * Each says what is happening, not the enum, and none of them is an error: the
 * payment itself went through, only its receipt is still on its way.
 */
const PENDING_LINE: Record<NonNullable<ReceiptView['pendingReason']>, string> = {
  awaiting_spend: 'Ready once the stall collects the payment',
  mint_unreachable: 'Waiting to check with the mint',
  signer_unsupported: 'Your sign-in method cannot sign receipts',
  other: 'Being prepared',
}

/**
 * The receipt as a QR code, re-signed every PRESENTER_REFRESH_SECONDS.
 *
 * The code carries a fresh "presenter" signature, which is what lets the stall
 * tell the payer's own phone from a screenshot of it (spec 049 story 6). So the
 * code is redrawn on a timer, and the redraw swaps the image in place: no
 * flash, no layout shift, the scanner sees one continuous code.
 *
 * Amount: the coupon's face value only, the amount the customer paid in their own terms. The signed
 * sat amount is what the receipt proves, but it is not shown: customers and stalls price in their
 * currency, and a second figure in sats reads as a different price.
 */
function ReceiptQrDialog({ receipt, onClose }: { receipt: ReceiptView; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [qr, setQr] = useState<{ url: string } | { error: string } | undefined>(undefined)
  const [deferred, setDeferred] = useState(false)
  // What Share sends: the same code the QR shows, as text, for a stall that cannot scan it.
  const [code, setCode] = useState<string | null>(null)
  const [shareNote, setShareNote] = useState<string | null>(null)

  const share = async () => {
    setShareNote(null)
    let text = code
    try {
      // Signed now, so the presenter proof is as fresh as it can be when it leaves the phone.
      text = (await presentReceipt(receipt.paymentId)).qrText
    } catch {
      // Keep the code on screen.
    }
    if (!text) {
      setShareNote('Could not prepare the receipt just now. Try again in a moment.')
      return
    }
    const message = receiptShareText(text)
    if (canShare() && (await shareText(message))) return
    setShareNote(
      (await writeClipboard(message))
        ? 'Receipt copied. Paste it in a message to the stall.'
        : 'Could not share or copy the receipt on this device.',
    )
  }

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const draw = async () => {
      try {
        const shown = await presentReceipt(receipt.paymentId)
        const url = await QRCode.toDataURL(shown.qrText, { width: 640, margin: 1, errorCorrectionLevel: 'M' })
        if (!live) return
        setQr({ url })
        setCode(shown.qrText)
        setDeferred(shown.evidence === 'deferred')
        timer = setTimeout(() => void draw(), Math.max(5_000, shown.refreshAt - Date.now()))
      } catch {
        if (live) setQr((prev) => (prev && 'url' in prev ? prev : { error: 'Could not prepare the receipt just now. Try again in a moment.' }))
        // Keep the last good code on screen and try again soon: a code a few
        // seconds stale still proves the payment, only the presenter check ages.
        if (live) timer = setTimeout(() => void draw(), 10_000)
      }
    }
    void draw()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [receipt.paymentId])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="materialize m-auto w-[calc(100%-2.5rem)] max-w-sm rounded-[20px] bg-transparent p-0 backdrop:bg-mono-950/50 backdrop:backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
      aria-labelledby="receipt-qr-title"
    >
      <div className="material flex flex-col items-center gap-4 rounded-[20px] p-5 shadow-xl shadow-mono-950/20 ring-1 ring-mono-900/5 dark:ring-mono-50/10">
        <h2
          id="receipt-qr-title"
          className="self-start text-[17px] font-semibold leading-snug tracking-[-0.01em] text-mono-900 dark:text-mono-50"
        >
          Receipt
        </h2>

        {/* White behind the code in dark mode too: scanners read dark on light. */}
        <div className="aspect-square w-full overflow-hidden rounded-2xl bg-white p-3">
          {qr && 'url' in qr ? (
            <img src={qr.url} alt="Receipt QR code" className="h-full w-full" style={{ imageRendering: 'pixelated' }} />
          ) : (
            <div className="flex h-full items-center justify-center text-center text-sm text-mono-500">
              {qr && 'error' in qr ? qr.error : 'Preparing…'}
            </div>
          )}
        </div>

        <div className="flex flex-col items-center gap-0.5 text-center">
          <ReceiptAmount face={receipt.face} />
        </div>

        <p className="text-center text-[13px] leading-snug text-mono-500">
          {deferred
            ? 'Shown without its proof for now, because the network is unreachable. The stall can still check the signatures.'
            : 'The code renews itself while it is on screen, so a screenshot cannot pass for this phone.'}
        </p>

        {shareNote ? (
          <p role="status" className="text-center text-[13px] leading-snug text-mono-700 dark:text-mono-300">
            {shareNote}
          </p>
        ) : null}

        <div className="flex w-full gap-3">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="pressable min-h-11 flex-1 rounded-2xl bg-mono-100 text-sm font-medium text-mono-900 outline-none ring-mono-400 focus-visible:ring-2 dark:bg-mono-800 dark:text-mono-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void share()}
            disabled={!code}
            className="pressable flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-mono-900 text-sm font-medium text-mono-50 outline-none ring-mono-400 focus-visible:ring-2 disabled:opacity-50 dark:bg-mono-50 dark:text-mono-900"
          >
            <Share2 className="h-4 w-4" aria-hidden /> Share
          </button>
        </div>
      </div>
    </dialog>
  )
}

/**
 * The face value, large. Shared with the stall's scan result, so the two screens of one receipt
 * speak with one voice. The signed amount is in sats and is never shown (owner decision): when the
 * face value is not known on this device, no amount line is drawn.
 */
export function ReceiptAmount({ face }: { face?: { value: number; unit: string; decimals: number } }) {
  if (!face) return null
  return (
    <p className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-mono-900 dark:text-mono-50">
      {formatFace(face.value, { unit: face.unit, decimals: face.decimals })}
    </p>
  )
}
