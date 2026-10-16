import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Check, ChevronRight } from 'lucide-react'
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
import { SendByLinkOption } from './SendLinkPage'
import { SwapBackOffer } from '../components/SwapBackOffer'
import { VoucherFullyRedeemedError } from '../lib/fullyRedeemed'
import { listVouchers } from '../lib/wallet'
import { merchantStatus, type MerchantStatus } from '../lib/merchant'
import { toMerchants, type Merchant } from '../lib/merchants'
import { formatFace, parseAmountToMinor } from '../lib/format'
import {
  humanName,
  identityLabel,
  useIdentity,
  useMerchantHandle,
  useMerchantLabel,
} from '../lib/identity'
import {
  SendOutcomeUnknownError,
  sendVouchers,
  splitObstacle,
  withoutInFlight,
  type SendResult,
} from '../lib/pay'

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

/**
 * `unconfirmed`: the gateway took the send and the wallet could not learn how it ended. It may
 * already have arrived, so the button stays locked: pressing it again could pay twice (#128).
 */
type Status =
  | { step: 'idle' }
  | { step: 'sending' }
  | { step: 'failed'; message: string; swapBackTokenId?: string }
  | { step: 'unconfirmed'; message: string }

export function SendPage({ pubkey }: { pubkey: string }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const from = params.get('from')

  const [merchants, setMerchants] = useState<Merchant[] | null>(null)
  const [recipient, setRecipient] = useState<string | null>(params.get('to'))
  /**
   * The NIP-05 they were reached through, when they were reached through one.
   *
   * Kept because it names someone the moment they are chosen, with no lookup:
   * a customer who typed `cocoa@staging.398ja.xyz` should not then read as a
   * hex key while kind-0 is in flight, and for a recipient who published no
   * profile at all this is the ONLY name the flow will ever have.
   */
  const [recipientHandle, setRecipientHandle] = useState<string | null>(null)
  /** `${merchantPubkey}|${UNIT}`, the picker's answer. Null until it is given. */
  const [picked, setPicked] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState<Status>({ step: 'idle' })
  const [sent, setSent] = useState<SendResult | null>(null)

  useEffect(() => {
    // What can be spent, not all that is held: a coupon behind an unconfirmed send is out (#128).
    listVouchers().then((rows) => setMerchants(toMerchants(withoutInFlight(rows, pubkey))))
  }, [pubkey])

  // Before the early returns — hooks cannot be called conditionally. The same
  // cached lookup every other screen makes, so asking here costs nothing extra.
  const recipientIdentity = useIdentity(recipient ?? undefined)

  /**
   * Is the recipient trading as a merchant? Null until an answer is in.
   *
   * Asked so the picker can offer only what this recipient can actually accept.
   * `deliver` refuses the rest regardless — this exists so the refusal arrives
   * on the step where it can still be acted on, rather than after an amount has
   * been typed and Send tapped. `merchantStatus` caches per session, so the
   * avatar below has usually asked already.
   *
   * All three answers are kept, not just the yes/no: `unknown` means the relay
   * could not be reached, which `deliver` now treats as a refusal, and a screen
   * that showed it as "customer, anything goes" would be promising a send that
   * is about to be turned down.
   *
   * Stamped with the pubkey it answers FOR, rather than cleared on a recipient
   * change: an answer arriving after the user tapped Change would otherwise be
   * applied to whoever they picked next.
   */
  const [merchantAnswer, setMerchantAnswer] = useState<{
    pubkey: string
    status: MerchantStatus
  } | null>(null)
  useEffect(() => {
    if (recipient === null) return
    let live = true
    void merchantStatus(recipient).then((status) => {
      if (live) setMerchantAnswer({ pubkey: recipient, status })
    })
    return () => {
      live = false
    }
  }, [recipient])

  if (merchants === null) return <Centered>Checking your vouchers…</Centered>

  const options = sendOptions(merchants)
  // Narrowed to the merchant whose page we arrived from, when we arrived from
  // one. `from` naming a merchant with nothing spendable leaves this empty,
  // which lands on the same honest refusal as an empty wallet.
  const narrowed = from
    ? options.filter((o) => o.merchant.pubkey.toLowerCase() === from.toLowerCase())
    : options

  // A merchant can only honour their own coupons, so those are the only ones
  // worth offering. Left alone while the lookup is unresolved (null): showing
  // everything for a moment is harmless, since `deliver` still refuses a coupon
  // this recipient cannot take.
  const onlyFrom =
    recipient !== null &&
    merchantAnswer?.status === 'merchant' &&
    merchantAnswer.pubkey === recipient
      ? recipient
      : null

  // The relay could not be reached, so this recipient's role is genuinely
  // unknown and `refuseIfWrongMerchant` will turn the send down.
  const unchecked =
    recipient !== null &&
    merchantAnswer?.status === 'unknown' &&
    merchantAnswer.pubkey === recipient

  // ...but only for a coupon that is not already going home. A voucher sent
  // back to its own issuer is a redemption, settled before anything is asked of
  // the network — warning about those would be crying wolf on the one case an
  // outage does not touch.
  const wouldAskTheRelay = (issuer: string) =>
    recipient !== null && issuer.toLowerCase() !== recipient.toLowerCase()
  const choices =
    onlyFrom === null
      ? narrowed
      : narrowed.filter((o) => o.merchant.pubkey.toLowerCase() === onlyFrom.toLowerCase())

  if (choices.length === 0) {
    return (
      <Screen>
        <BackLink to="/" label="Back" />
        <PageHeader title="Send" />
        <Alert>
          {onlyFrom
            ? 'This merchant only accepts vouchers they issued themselves, and you ' +
              'have none of theirs left.'
            : from
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
  //
  // The word the CUSTOMER sees for it is "Pay", though, and that is not a
  // quibble. "Redeem" is the merchant's word for what happens at their end —
  // value coming back off their books — and the customer standing at the stall
  // is doing the ordinary thing of paying for something. A button reading
  // "Redeem" asks them to adopt the counterparty's accounting language for
  // their own purchase, and it reads as a claim ("redeem a prize") rather than
  // as handing money over. The underlying operation is unchanged: `asMerchant`
  // still drives the saga, the record and the history.
  const asMerchant =
    recipient === null
      ? undefined
      : merchants.find((m) => m.pubkey.toLowerCase() === recipient.toLowerCase())
  /*
    The recipient in prose — "Send to …", "… reached X."

    `asMerchant?.name` is the same floor `IdentityInline` gets as `fallbackName`,
    and it matters for the same reason the merchant leg above did: paying at
    a stall whose kind-0 has not landed yet would otherwise read "Pay
    a1b2c3d4…ef56" while their name sits on the coupon being spent. `humanName`
    keeps the hex placeholder out, and the handle typed into the scanner is the
    last rung before a short key.
  */
  const recipientLabel =
    recipient === null
      ? ''
      : identityLabel(recipient, {
          ...recipientIdentity,
          name: recipientIdentity?.name ?? humanName(asMerchant?.name),
          nip05: recipientIdentity?.nip05 ?? recipientHandle ?? undefined,
        })
  const verb = asMerchant ? 'Pay' : 'Send to'

  if (sent !== null && chosen) {
    // A bundle can land in pieces, and what landed cannot be taken back. So the
    // screen reports the delivered figure rather than the one that was typed —
    // showing the full amount here would send the customer away believing money
    // arrived that never did.
    const partial = sent.delivered < sent.requested
    // A part the gateway accepted but could not confirm may already have arrived: the screen
    // says so, and never suggests sending it again (#125).
    const inFlight = sent.inFlight ?? 0
    // The parts after an unconfirmed one were never tried: that money did not move.
    const notSent = sent.requested - sent.delivered - inFlight
    return (
      <Screen>
        <PageHeader
          title={inFlight > 0 ? 'Still going through' : partial ? 'Partly sent' : asMerchant ? 'Paid' : 'Sent'}
        />
        <Panel>
          <div className="flex flex-col items-center py-4 text-center">
            <div
              className={`mb-3 rounded-full p-3 ${partial ? 'bg-amber-500/10' : 'bg-green-600/10'}`}
            >
              {partial ? (
                <AlertTriangle className="h-7 w-7 text-amber-600" />
              ) : (
                <Check className="h-7 w-7 text-green-600" />
              )}
            </div>
            <p className="text-amount text-mono-900 dark:text-mono-50">
              {formatFace(sent.delivered, chosen)}
            </p>
            <p className="mt-1 text-sm text-mono-500">
              {partial
                ? `of ${formatFace(sent.requested, chosen)} reached ${recipientLabel}.`
                : `${asMerchant ? 'Paid' : 'Sent to'} ${recipientLabel}${
                    // One payment drawn from several vouchers (#94), said in
                    // the same sentence rather than a second grey line under
                    // it: it qualifies how the payment went, so it belongs to
                    // the sentence that says the payment went. Matches the
                    // recipient's "€6.00 received (2 vouchers)".
                    sent.parts > 1 ? ` as ${sent.parts} vouchers` : ''
                  }.${asMerchant ? '' : ' It is in their wallet now.'}`}
            </p>
          </div>
        </Panel>
        {partial && (
          <div className="mt-3">
            {inFlight > 0 ? (
              <Alert>
                {formatFace(inFlight, chosen)} more is still going through and may already have
                arrived. Do not send it again — check your history in a moment.
                {notSent > 0
                  ? ` The last ${formatFace(notSent, chosen)} was not sent and those vouchers are untouched.`
                  : ''}
                {sent.shortfall ? ` (${sent.shortfall})` : ''}
              </Alert>
            ) : (
              <Alert>
                {sent.parts > 1 ? `${sent.parts} vouchers went before the rest stopped. ` : ''}
                The rest was not sent and your remaining vouchers are untouched — send
                the difference again if you still mean to.
                {sent.shortfall ? ` (${sent.shortfall})` : ''}
              </Alert>
            )}
          </div>
        )}
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
        <ScanRecipient
          onFound={(hex, handle) => {
            setRecipient(hex)
            setRecipientHandle(handle ?? null)
          }}
          selfPubkey={pubkey}
        />
        <SendByLinkOption from={from} unit={from ? chosen?.unit : undefined} />
      </Screen>
    )
  }

  // ── Step 2: which voucher ────────────────────────────────────────────────
  if (chosen === null) {
    return (
      <Screen>
        <BackLink to="/" label="Cancel" />
        <PageHeader title="Which voucher?" subtitle={`${verb} ${recipientLabel}`} />
        {unchecked && choices.some((o) => wouldAskTheRelay(o.merchant.pubkey)) && (
          <UncheckedRecipient />
        )}
        <div className="space-y-2">
          {choices.map((option) => (
            <button
              key={key(option)}
              type="button"
              onClick={() => setPicked(key(option))}
              className="pressable flex w-full items-center justify-between rounded-2xl bg-white p-4 text-left dark:bg-mono-900"
            >
              <div className="min-w-0">
                <MerchantName merchant={option.merchant} />
                <p className="text-sm text-mono-500">
                  {formatFace(option.totalFaceValue, option)} ·{' '}
                  {option.vouchers.length === 1 ? '1 voucher' : `${option.vouchers.length} vouchers`}
                </p>
              </div>
              <ChevronRight className="h-5 w-5 text-mono-400" aria-hidden />
            </button>
          ))}
        </div>
      </Screen>
    )
  }

  const minor = parseAmountToMinor(amount, chosen.decimals)
  // The same check `sendVouchers` selects with, so the button and the send agree
  // on what is sendable — a voucher divisible on one and not the other would let
  // the user tap Send only to be refused. It answers for a bundle too: holding
  // enough across several coupons is sendable, and the button must not refuse
  // what the send would happily do.
  const obstacle = minor === null || minor <= 0 ? null : splitObstacle(chosen.vouchers, minor)
  const short = minor !== null && minor > chosen.totalFaceValue

  // ── Step 4: confirm ──────────────────────────────────────────────────────
  if (confirming && minor !== null) {
    return (
      <Screen>
        <BackLink to="/" label="Cancel" />
        <PageHeader title={asMerchant ? 'Confirm payment' : 'Confirm send'} />

        <div className="mb-6">
          <IdentityInline
            pubkey={recipient}
            label={asMerchant ? 'Pay' : 'To'}
            size="md"
            fallbackName={asMerchant?.name}
            fallbackHandle={recipientHandle ?? undefined}
          />
        </div>

        <Panel className="mb-6 p-5">
          <p className="text-amount text-mono-900 dark:text-mono-50">
            {formatFace(minor, chosen)}
          </p>
          {memo.trim() && <p className="mt-2 text-sm text-mono-500">{memo.trim()}</p>}
          <dl className="mt-4 space-y-1 text-sm">
            <Row
              label="From your vouchers with"
              value={<MerchantText merchant={chosen.merchant} />}
            />
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

        {(status.step === 'failed' || status.step === 'unconfirmed') && <Alert>{status.message}</Alert>}
        {status.step === 'failed' && status.swapBackTokenId && (
          <SwapBackOffer tokenId={status.swapBackTokenId} pubkey={pubkey} />
        )}

        <div className="space-y-2">
          <Button
            size="lg"
            className="w-full"
            disabled={status.step === 'sending' || status.step === 'unconfirmed'}
            onClick={async () => {
              setStatus({ step: 'sending' })
              try {
                const result = await sendVouchers({
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
                setSent(result)
                setStatus({ step: 'idle' })
              } catch (e) {
                setStatus({
                  step: e instanceof SendOutcomeUnknownError ? 'unconfirmed' : 'failed',
                  message: e instanceof Error ? e.message : 'Send failed.',
                  swapBackTokenId: e instanceof VoucherFullyRedeemedError ? e.tokenId : undefined,
                })
              }
            }}
          >
            {status.step === 'sending'
              ? 'Sending…'
              : status.step === 'unconfirmed'
                ? 'Still going through'
                : asMerchant
                  ? 'Pay'
                  : 'Send'}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            // Back would clear the lock: after an unknown outcome the way out is Done, not Back.
            disabled={status.step === 'sending' || status.step === 'unconfirmed'}
            onClick={() => {
              setConfirming(false)
              setStatus({ step: 'idle' })
            }}
          >
            Back
          </Button>
          {status.step === 'unconfirmed' && (
            <Button variant="ghost" className="w-full" onClick={() => navigate('/')}>
              Done
            </Button>
          )}
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

      {unchecked && wouldAskTheRelay(chosen.merchant.pubkey) && <UncheckedRecipient />}

      <Panel className="p-4">
        <div className="flex items-center justify-between">
          <IdentityInline
            pubkey={recipient}
            label={asMerchant ? 'Merchant' : 'To'}
            size="md"
            fallbackName={asMerchant?.name}
            fallbackHandle={recipientHandle ?? undefined}
          />
          {/* Only offered when there is another way back to this step: arriving
              with `?to=` means the recipient was scanned, and re-scanning is a
              step, not a correction. */}
          {!params.get('to') && (
            <Button variant="ghost" size="sm" onClick={() => {
                setRecipient(null)
                setRecipientHandle(null)
              }}>
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
          {formatFace(chosen.totalFaceValue, chosen)} available from{' '}
          <MerchantText merchant={chosen.merchant} />
          {choices.length > 1 && (
            <>
              {' · '}
              <button
                type="button"
                className="pressable -my-3 inline-block py-3 underline"
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
 * A merchant's name on the picker, with their handle under it.
 *
 * A COMPONENT rather than a call, because this renders inside the `choices`
 * map and the lookup is a hook — one per row is the only way to ask for a
 * list of them.
 *
 * The handle is shown here and not on the rows below because this is the
 * screen where merchants are told APART. Two stalls trading under similar
 * names are one tap from each other's coupons, and `@cocoa` under the name is
 * what distinguishes them.
 */
function MerchantName({ merchant }: { merchant: Merchant }) {
  const name = useMerchantLabel(merchant)
  const handle = useMerchantHandle(merchant)
  return (
    <>
      <p className="truncate font-medium text-mono-900 dark:text-mono-50">{name}</p>
      {handle ? <p className="truncate text-xs text-mono-500">{handle}</p> : null}
    </>
  )
}

/**
 * Just the merchant's fetched name, as text.
 *
 * Same reason as `MerchantName` for being a component: these two call sites sit
 * AFTER this screen's early returns, where a hook cannot be added to the page
 * body without changing the hook order between renders.
 */
function MerchantText({ merchant }: { merchant: Merchant }) {
  return <>{useMerchantLabel(merchant)}</>
}

function key(option: SendOption): string {
  return `${option.merchant.pubkey}|${option.unit.toUpperCase()}`
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between">
      <dt className="text-mono-500">{label}</dt>
      <dd className="text-mono-900 dark:text-mono-50">{value}</dd>
    </div>
  )
}

/**
 * The recipient's role could not be checked, and the send will say so.
 *
 * Shown while the choice is still being made rather than after Send is tapped,
 * which is the whole reason this screen asks the question early at all.
 *
 * Deliberately does not disable anything. The lookup is not cached when it
 * fails, so the send asks again a moment later and may well succeed — a screen
 * that greyed the button out would strand a user whose connection came back
 * between reading this and acting on it.
 */
function UncheckedRecipient() {
  return (
    <div className="mb-4">
      <Alert>
        Could not reach the network to check who you are sending to. You can keep
        going — the send checks again, and will refuse rather than risk a voucher
        they cannot use.
      </Alert>
    </div>
  )
}
