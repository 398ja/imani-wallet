import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardPaste, Check } from 'lucide-react'

import {
  Button,
  Screen,
  BackLink,
  PageHeader,
  Alert,
  Panel,
  Input,
  IdentityInline,
} from '../components/ui'
import { issueAndDeliver, toRecipientPubkey, type IssueStage } from '../lib/issue'
import { identityLabel, useIdentity } from '../lib/identity'
import { currencyDecimals, formatFace, parseAmountToMinor } from '../lib/format'
import type { MerchantProfile } from '../lib/merchant'

/**
 * Sell: issue a coupon to a customer standing in front of you.
 *
 * Three screens — scan, amount, progress — because the flow is deliberately the
 * simplified one: no cart, no line items, no payment method. The merchant scans
 * the address the customer's own `/receive` screen is already showing — their
 * NIP-05 handle — types what they owe, and sends.
 *
 * This is NOT possa-merchant's cashback flow, which mints a bearer QR with a
 * one-time claim key and never learns who the customer is. Here the coupon is
 * addressed to a pubkey and delivered as a DM, which is what makes it show up in
 * the customer's wallet without them doing anything.
 */

const STAGE_LABEL: Record<IssueStage, string> = {
  issuing: 'Issuing the voucher…',
  // Named for what is actually happening: the coupon exists but has no Cashu
  // token yet, because its Lightning backing is still settling.
  minting: 'Waiting for the voucher to be backed…',
  delivering: 'Delivering to the customer…',
}

export function SellPage({ pubkey, merchant }: { pubkey: string; merchant: MerchantProfile }) {
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<string | null>(null)

  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader title="Sell" subtitle={customer ? undefined : "Scan the customer's code"} />

      {customer === null ? (
        <ScanCustomer onFound={setCustomer} />
      ) : (
        <IssueForm
          customer={customer}
          merchant={merchant}
          issuerPubkey={pubkey}
          onRescan={() => setCustomer(null)}
          onDone={() => navigate('/')}
        />
      )}
    </Screen>
  )
}

/**
 * Read the customer's address off their screen.
 *
 * Same shape as ScanPage: dynamic `qr-scanner` import, a `cancelled` flag so the
 * async import losing the race with unmount cannot start a scanner nobody will
 * stop, and a paste fallback for when the camera is unavailable.
 *
 * What comes back is a NIP-05 handle, which `toRecipientPubkey` resolves. npub
 * and hex still work — coupons are addressed to a pubkey either way, and on a
 * dev machine, where no handle resolves, they are the only forms that do.
 */
function ScanCustomer({ onFound }: { onFound: (pubkey: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState('')
  const [looking, setLooking] = useState(false)

  useEffect(() => {
    let scanner: { start(): Promise<void>; destroy(): void } | undefined
    let cancelled = false

    // A handle costs a round trip to resolve, and the scanner fires several
    // times a second on the same code — without this the merchant's phone opens
    // a dozen identical lookups while the first is still in flight.
    let resolving = false

    const accept = async (text: string) => {
      if (resolving) return
      resolving = true
      try {
        const hex = await toRecipientPubkey(text)
        if (cancelled) return
        if (!hex) {
          setError('That code is not a customer account.')
          return
        }
        onFound(hex)
      } finally {
        resolving = false
      }
    }

    ;(async () => {
      const { default: QrScanner } = await import('qr-scanner')
      if (cancelled || !videoRef.current) return

      scanner = new QrScanner(videoRef.current, (result) => void accept(result.data), {
        highlightScanRegion: true,
        highlightCodeOutline: true,
      })
      try {
        await scanner.start()
      } catch (e) {
        setError(
          e instanceof Error
            ? `Camera unavailable: ${e.message}. Paste their code instead.`
            : 'Camera unavailable. Paste their code instead.',
        )
      }
    })()

    return () => {
      cancelled = true
      scanner?.destroy()
    }
    // onFound is a setState updater, stable for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submitManual = async () => {
    setError(null)
    setLooking(true)
    const hex = await toRecipientPubkey(manual)
    setLooking(false)
    if (!hex) {
      setError('That is not a customer we can find.')
      return
    }
    onFound(hex)
  }

  return (
    <>
      <div className="overflow-hidden rounded-2xl bg-mono-900">
        <video ref={videoRef} className="aspect-square w-full object-cover" />
      </div>

      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <Input
          label="Or enter their address"
          placeholder="name@domain"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <Button
          variant="outline"
          className="w-full"
          disabled={looking}
          onClick={() => void submitManual()}
        >
          {looking ? 'Looking them up…' : 'Continue'}
        </Button>
        <Button
          variant="ghost"
          className="w-full"
          onClick={async () => {
            try {
              setManual(await navigator.clipboard.readText())
            } catch {
              setError('Could not read the clipboard.')
            }
          }}
        >
          <ClipboardPaste className="mr-2 h-4 w-4" /> Paste
        </Button>
      </div>
    </>
  )
}

function IssueForm({
  customer,
  merchant,
  issuerPubkey,
  onRescan,
  onDone,
}: {
  customer: string
  merchant: MerchantProfile
  issuerPubkey: string
  onRescan: () => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [stage, setStage] = useState<IssueStage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<number | null>(null)
  const customerIdentity = useIdentity(customer)

  // ISO decimals, which is what the sats backing needs — see currencyDecimals.
  // The gateway labels every coupon 2-decimal regardless; that mismatch is its
  // bug, and matching it here costs a hundredfold over-backing and a 413.
  const decimals = currencyDecimals(merchant.issuanceCurrency)
  const minor = parseAmountToMinor(amount, decimals)
  const busy = stage !== null

  const submit = async () => {
    if (minor === null) return
    setError(null)
    try {
      await issueAndDeliver(
        {
          faceValueMinor: minor,
          currency: merchant.issuanceCurrency,
          expiryDays: merchant.voucherValidityDays,
          memo: memo.trim() || undefined,
          recipientPubkey: customer,
          issuerPubkey,
        },
        setStage,
      )
      setSent(minor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
    }
  }

  // Confirmation only after the DM has actually gone out — the whole reason the
  // merchant was held through the wait rather than told "sent" immediately.
  if (sent !== null) {
    return (
      <>
        <Panel>
          <div className="flex flex-col items-center py-4 text-center">
            <div className="mb-3 rounded-full bg-green-600/10 p-3">
              <Check className="h-7 w-7 text-green-600" />
            </div>
            <p className="text-amount text-mono-900 dark:text-mono-50">
              {formatFace(sent, { unit: merchant.issuanceCurrency, decimals })}
            </p>
            <p className="mt-1 text-sm text-mono-500">
              Sent to {identityLabel(customer, customerIdentity)}. It is in their wallet now.
            </p>
          </div>
        </Panel>

        <div className="mt-4 space-y-2">
          <Button
            size="lg"
            className="w-full"
            onClick={() => {
              setSent(null)
              setAmount('')
              setMemo('')
              onRescan()
            }}
          >
            Sell to someone else
          </Button>
          <Button variant="ghost" className="w-full" onClick={onDone}>
            Done
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <Panel className="p-4">
        <div className="flex items-center justify-between">
          <IdentityInline pubkey={customer} label="Customer" size="md" />
          <Button variant="ghost" size="sm" onClick={onRescan} disabled={busy}>
            Change
          </Button>
        </div>
      </Panel>

      <div className="mt-4 space-y-4">
        <Input
          label={`Amount (${merchant.issuanceCurrency})`}
          // `decimal` gives a keypad with a separator; a zero-decimal currency
          // has nothing to type after the point, so it gets the plain numeric one.
          inputMode={decimals > 0 ? 'decimal' : 'numeric'}
          placeholder={decimals > 0 ? '0.00' : '0'}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
          autoFocus
        />

        <Input
          label="Note (optional)"
          placeholder="£5 welcome voucher"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          disabled={busy}
        />

        <Button
          size="lg"
          className="w-full"
          disabled={busy || minor === null}
          onClick={submit}
        >
          {stage ? STAGE_LABEL[stage] : 'Send voucher'}
        </Button>

        {busy && (
          <p className="text-center text-xs text-mono-400" role="status" aria-live="polite">
            This takes a few seconds. Do not close this screen.
          </p>
        )}

        {error && <Alert>{error}</Alert>}
      </div>
    </>
  )
}
