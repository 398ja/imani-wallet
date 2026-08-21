import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Check, ChevronRight } from 'lucide-react'
import type { Voucher } from '@imani/voucher-send'

import {
  Button,
  Screen,
  BackLink,
  PageHeader,
  Alert,
  Panel,
  Input,
  Centered,
  IdentityInline,
} from '../components/ui'
import { ScanRecipient } from '../components/ScanRecipient'
import { listVouchers } from '../lib/wallet'
import { toMerchants, type Merchant } from '../lib/merchants'
import { formatFace, parseAmountToMinor } from '../lib/format'
import { identityLabel, useIdentity } from '../lib/identity'
import { sendVouchers, splitObstacle } from '../lib/pay'

/**
 * Send a voucher to someone — a friend, or a merchant redeeming it.
 *
 * Four steps, each SKIPPED when its answer is already known, which is what lets
 * one screen serve both ways in:
 *
 *  - `/send?to=<pubkey>` from the scanner: recipient known, so it opens on the
 *    voucher picker (or straight on the amount, when there is only one voucher
 *    to send).
 *  - `/send?from=<merchantPubkey>` from a merchant's page: the voucher is
 *    settled, so it opens on the recipient.
 *
 * A merchant is NOT a separate flow. `sendVouchers` is the same saga either way
 * — the gateway's atomic send has always taken a plain recipient pubkey, and a
 * redemption is only that call with a payment request attached. The difference
 * here is one line of copy, so that redeeming reads as redeeming.
 */

/**
 * One choice on the picker: a merchant AND a currency.
 *
 * Not just a merchant, because a voucher cannot be split across units — a
 * merchant selling in both EUR and SAT is two different things to spend. The
 * merchant's own `groups` split finer still (by issuance ratio), which is a
 * distinction about backing that nobody buying a coffee has any use for, so
 * groups sharing a unit are merged back together here.
 */
type SendOption = {
  merchant: Merchant
  unit: string
  decimals: number
  totalFaceValue: number
  vouchers: Voucher[]
}

function sendOptions(merchants: Merchant[]): SendOption[] {
  const byUnit = new Map<string, SendOption>()
  for (const merchant of merchants) {
    for (const group of merchant.groups) {
      const key = `${merchant.pubkey}|${group.unit.toUpperCase()}`
      const found = byUnit.get(key)
      if (found) {
        found.totalFaceValue += group.totalFaceValue
        found.vouchers.push(...group.vouchers)
      } else {
        byUnit.set(key, {
          merchant,
          unit: group.unit,
          decimals: group.decimals,
          totalFaceValue: group.totalFaceValue,
          vouchers: [...group.vouchers],
        })
      }
    }
  }
  // Most valuable first — the same order the home deck puts merchants in.
  return [...byUnit.values()].sort((a, b) => b.totalFaceValue - a.totalFaceValue)
}

type Status = { step: 'idle' } | { step: 'sending' } | { step: 'failed'; message: string }

export function SendPage({ pubkey }: { pubkey: string }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const from = params.get('from')

  const [merchants, setMerchants] = useState<Merchant[] | null>(null)
  const [recipient, setRecipient] = useState<string | null>(params.get('to'))
  /** `${merchantPubkey}|${UNIT}`, the picker's answer. Null until it is given. */
  const [picked, setPicked] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState<Status>({ step: 'idle' })
  const [sent, setSent] = useState<number | null>(null)

  useEffect(() => {
    listVouchers().then((rows) => setMerchants(toMerchants(rows)))
  }, [])

  // Before the early returns — hooks cannot be called conditionally. The same
  // cached lookup every other screen makes, so asking here costs nothing extra.
  const recipientIdentity = useIdentity(recipient ?? undefined)

  if (merchants === null) return <Centered>Checking your vouchers…</Centered>

  const options = sendOptions(merchants)
  // Narrowed to the merchant whose page we arrived from, when we arrived from
  // one. `from` naming a merchant with nothing spendable leaves this empty,
  // which lands on the same honest refusal as an empty wallet.
  const choices = from
    ? options.filter((o) => o.merchant.pubkey.toLowerCase() === from.toLowerCase())
    : options

  if (choices.length === 0) {
    return (
      <Screen>
        <BackLink to="/" label="Back" />
        <PageHeader title="Send" />
        <Alert>
          {from
            ? 'You have no vouchers left from this merchant to send.'
            : 'You have no vouchers to send.'}
        </Alert>
      </Screen>
    )
  }

  // One choice needs no choosing. Derived rather than pushed into state by an
  // effect, so the step is a function of what is known and never a render behind
  // it — the picker must not flash up on its way to being skipped.
  const chosen =
    choices.length === 1 ? choices[0] : choices.find((o) => key(o) === picked) ?? null

  // A voucher going back to the merchant who issued it is a redemption. Said
  // here and nowhere else: the saga, the record and the history are identical.
  const asMerchant =
    recipient === null
      ? undefined
      : merchants.find((m) => m.pubkey.toLowerCase() === recipient.toLowerCase())
  const recipientLabel = recipient === null ? '' : identityLabel(recipient, recipientIdentity)
  const verb = asMerchant ? 'Redeem at' : 'Send to'

  if (sent !== null && chosen) {
    return (
      <Screen>
        <PageHeader title={asMerchant ? 'Redeemed' : 'Sent'} />
        <Panel>
          <div className="flex flex-col items-center py-4 text-center">
            <div className="mb-3 rounded-full bg-green-600/10 p-3">
              <Check className="h-7 w-7 text-green-600" />
            </div>
            <p className="text-amount text-mono-900 dark:text-mono-50">
              {formatFace(sent, chosen)}
            </p>
            <p className="mt-1 text-sm text-mono-500">
              {asMerchant ? 'Redeemed at' : 'Sent to'} {recipientLabel}.
              {asMerchant ? '' : ' It is in their wallet now.'}
            </p>
          </div>
        </Panel>
        <Button size="lg" className="mt-4 w-full" onClick={() => navigate('/')}>
          Done
        </Button>
      </Screen>
    )
  }

  // ── Step 1: who ──────────────────────────────────────────────────────────
  if (recipient === null) {
    return (
      <Screen>
        <BackLink to="/" label="Cancel" />
        <PageHeader title="Send" subtitle="Scan their code, or enter their handle" />
        <ScanRecipient onFound={setRecipient} selfPubkey={pubkey} />
      </Screen>
    )
  }

  // ── Step 2: which voucher ────────────────────────────────────────────────
  if (chosen === null) {
    return (
      <Screen>
        <BackLink to="/" label="Cancel" />
        <PageHeader title="Which voucher?" subtitle={`${verb} ${recipientLabel}`} />
        <div className="space-y-2">
          {choices.map((option) => (
            <button
              key={key(option)}
              type="button"
              onClick={() => setPicked(key(option))}
              className="flex w-full items-center justify-between rounded-2xl bg-white p-4 text-left dark:bg-mono-900"
            >
              <div>
                <p className="font-medium text-mono-900 dark:text-mono-50">
                  {merchantLabel(option.merchant)}
                </p>
                <p className="text-sm text-mono-500">
                  {formatFace(option.totalFaceValue, option)} ·{' '}
                  {option.vouchers.length === 1 ? '1 voucher' : `${option.vouchers.length} vouchers`}
                </p>
              </div>
              <ChevronRight className="h-5 w-5 text-mono-400" />
            </button>
          ))}
        </div>
      </Screen>
    )
  }

  const minor = parseAmountToMinor(amount, chosen.decimals)
  // The same check `sendVouchers` selects with, so the button and the send agree
  // on what is sendable — a voucher divisible on one and not the other would let
  // the user tap Send only to be refused.
  const obstacle = minor === null || minor <= 0 ? null : splitObstacle(chosen.vouchers, minor)
  const short = minor !== null && minor > chosen.totalFaceValue

  // ── Step 4: confirm ──────────────────────────────────────────────────────
  if (confirming && minor !== null) {
    return (
      <Screen>
        <BackLink to="/" label="Cancel" />
        <PageHeader title={asMerchant ? 'Confirm redemption' : 'Confirm send'} />

        <div className="mb-6">
          <IdentityInline
            pubkey={recipient}
            label={asMerchant ? 'Redeem at' : 'To'}
            size="md"
            fallbackName={asMerchant?.name}
          />
        </div>

        <Panel className="mb-6 p-5">
          <p className="text-amount text-mono-900 dark:text-mono-50">
            {formatFace(minor, chosen)}
          </p>
          {memo.trim() && <p className="mt-2 text-sm text-mono-500">{memo.trim()}</p>}
          <dl className="mt-4 space-y-1 text-sm">
            <Row label="From your vouchers with" value={merchantLabel(chosen.merchant)} />
            <Row label="Your balance" value={formatFace(chosen.totalFaceValue, chosen)} />
          </dl>
        </Panel>

        {/* Said before the tap, not after it. On this stack a send that fails at
            delivery cannot be reclaimed — the voucher is held at the gateway and
            settled on the next login — and that is worth knowing while it is
            still a customer's own money going to a friend. */}
        <p className="mb-4 text-xs text-mono-400">
          Once sent, this cannot be undone from here.
        </p>

        {status.step === 'failed' && <Alert>{status.message}</Alert>}

        <div className="space-y-2">
          <Button
            size="lg"
            className="w-full"
            disabled={status.step === 'sending'}
            onClick={async () => {
              setStatus({ step: 'sending' })
              try {
                await sendVouchers({
                  payer: pubkey,
                  recipient: {
                    pubkey: recipient,
                    // Only a real name. `identityLabel` falls back to a short
                    // key, and storing that on the row would freeze a stranger's
                    // hex into the history where a name could still arrive.
                    name: recipientIdentity?.name ?? asMerchant?.name,
                  },
                  merchant: chosen.merchant,
                  unit: chosen.unit,
                  amount: minor,
                  memo: memo.trim() || undefined,
                })
                setSent(minor)
                setStatus({ step: 'idle' })
              } catch (e) {
                setStatus({
                  step: 'failed',
                  message: e instanceof Error ? e.message : 'Send failed.',
                })
              }
            }}
          >
            {status.step === 'sending' ? 'Sending…' : asMerchant ? 'Redeem' : 'Send'}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            disabled={status.step === 'sending'}
            onClick={() => {
              setConfirming(false)
              setStatus({ step: 'idle' })
            }}
          >
            Back
          </Button>
        </div>

        {status.step === 'sending' && (
          <p className="mt-3 text-center text-xs text-mono-400" role="status" aria-live="polite">
            This takes a few seconds. Do not close this screen.
          </p>
        )}
      </Screen>
    )
  }

  // ── Step 3: how much ─────────────────────────────────────────────────────
  return (
    <Screen>
      <BackLink to="/" label="Cancel" />
      <PageHeader title="How much?" subtitle={`${verb} ${recipientLabel}`} />

      <Panel className="p-4">
        <div className="flex items-center justify-between">
          <IdentityInline
            pubkey={recipient}
            label={asMerchant ? 'Merchant' : 'To'}
            size="md"
            fallbackName={asMerchant?.name}
          />
          {/* Only offered when there is another way back to this step: arriving
              with `?to=` means the recipient was scanned, and re-scanning is a
              step, not a correction. */}
          {!params.get('to') && (
            <Button variant="ghost" size="sm" onClick={() => setRecipient(null)}>
              Change
            </Button>
          )}
        </div>
      </Panel>

      <div className="mt-4 space-y-4">
        <Input
          label={`Amount (${chosen.unit})`}
          // `decimal` gives a keypad with a separator; a zero-decimal currency
          // has nothing to type after the point, so it gets the plain numeric one.
          inputMode={chosen.decimals > 0 ? 'decimal' : 'numeric'}
          placeholder={chosen.decimals > 0 ? '0.00' : '0'}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
        <p className="text-sm text-mono-500">
          {formatFace(chosen.totalFaceValue, chosen)} available from {merchantLabel(chosen.merchant)}
          {choices.length > 1 && (
            <>
              {' · '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setPicked(null)
                  setAmount('')
                }}
              >
                change
              </button>
            </>
          )}
        </p>

        <Input
          label="Note (optional)"
          placeholder="Thanks for lunch"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />

        {short && <Alert>Short by {formatFace(minor - chosen.totalFaceValue, chosen)}.</Alert>}
        {/* Holding enough is not the same as being able to send it: a voucher
            cannot be divided below one sat's worth of face value. */}
        {!short && obstacle && <Alert>{obstacle}</Alert>}

        <Button
          size="lg"
          className="w-full"
          disabled={minor === null || minor <= 0 || short || !!obstacle}
          onClick={() => setConfirming(true)}
        >
          Continue
        </Button>
      </div>
    </Screen>
  )
}

/**
 * A merchant's name, or a short key when they have none.
 *
 * `toMerchants` fills `name` with `merchantName || merchantId`, so an unbranded
 * merchant's "name" is 64 hex characters — which overflows every row it lands
 * in. `identityLabel` already knows to reject that.
 */
function merchantLabel(merchant: Merchant): string {
  return identityLabel(merchant.pubkey, { name: merchant.name })
}

function key(option: SendOption): string {
  return `${option.merchant.pubkey}|${option.unit.toUpperCase()}`
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-mono-500">{label}</dt>
      <dd className="text-mono-900 dark:text-mono-50">{value}</dd>
    </div>
  )
}
