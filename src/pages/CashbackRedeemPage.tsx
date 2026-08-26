import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'

import { Button, Screen, BackLink, PageHeader, Alert, Panel, Input } from '../components/ui'
import {
  canonicaliseTypedClaimCode,
  redeemCashbackCode,
  replayPendingCashback,
  type RedeemResult,
} from '../lib/cashback'
import { currencyDecimals, formatFace } from '../lib/format'

/**
 * Redeem a cashback code.
 *
 * The first thing a new customer ever does in this wallet, typed off a paper
 * receipt from a shop they visited days ago. Everything here bends toward that:
 * the field takes the code in any shape it was written down, the wait says what
 * is happening, and every failure names what went wrong in words that imply a
 * next step.
 *
 * Three states rather than three screens — entry, working, outcome — because
 * the outcome has to stay next to the code that produced it.
 */
export function CashbackRedeemPage() {
  const navigate = useNavigate()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RedeemResult | null>(null)
  const [recovered, setRecovered] = useState(false)

  // A coupon claimed but never banked — the app died between the two, and the
  // claim is already spent, so this is the only way it comes back. Runs on
  // arrival because this is the screen the customer returns to when the first
  // attempt "did nothing".
  useEffect(() => {
    let live = true
    void replayPendingCashback().then((didRecover) => {
      if (live && didRecover) setRecovered(true)
    })
    return () => {
      live = false
    }
  }, [])

  const canonical = canonicaliseTypedClaimCode(typed)

  const submit = async () => {
    if (canonical === null || busy) return
    setBusy(true)
    setResult(null)
    try {
      setResult(await redeemCashbackCode(canonical))
    } finally {
      setBusy(false)
    }
  }

  if (result?.kind === 'ok') {
    return (
      <Screen>
        <BackLink to="/receive" label="Receive" />
        <PageHeader title="Cashback added" />
        <Panel>
          <div className="flex flex-col items-center py-6 text-center">
            <div className="mb-3 rounded-full bg-green-600/10 p-3">
              <Check className="h-7 w-7 text-green-600" />
            </div>
            {/* The amount comes from the gateway's own record, not from the
                Cashu token underneath — that is denominated in sats and would
                announce a 5 EUR coupon as "782 SAT". Absent when that read
                failed, which costs a line of copy and nothing else. */}
            {result.amountMinor !== null && result.unit !== null ? (
              <p className="text-amount text-mono-900 dark:text-mono-50">
                {formatFace(result.amountMinor, {
                  unit: result.unit,
                  decimals: currencyDecimals(result.unit),
                })}
              </p>
            ) : (
              <p className="text-lg text-mono-900 dark:text-mono-50">It is in your wallet now.</p>
            )}
            {result.memo && <p className="mt-1 text-sm text-mono-500">{result.memo}</p>}
          </div>
        </Panel>

        <div className="mt-4 space-y-2">
          <Button size="lg" className="w-full" onClick={() => navigate('/')}>
            Done
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              setResult(null)
              setTyped('')
            }}
          >
            Redeem another code
          </Button>
        </div>
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to="/receive" label="Receive" />
      <PageHeader title="Cashback code" subtitle="Enter the code from the shop." />

      {recovered && (
        <Alert>An earlier cashback finished arriving just now. Check your wallet before retrying.</Alert>
      )}

      {result && <Alert>{failureMessage(result)}</Alert>}

      <Panel className="p-4">
        <Input
          label="Code"
          placeholder="CB-XXXX-YY"
          value={typed}
          // Uppercased on the way in so what is on screen matches what is on
          // the receipt. Everything else the customer might type — spaces, a
          // missing prefix, no dashes — is absorbed when the code is read, not
          // fought with while the caret is still moving.
          onChange={(e) => setTyped(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          className="font-mono tracking-[0.15em]"
          autoFocus
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
        {/* Confirmation that a forgiving entry was understood, shown only once
            it reads as a real code and only when it differs from what was
            typed — echoing the code back unchanged would be noise. */}
        {canonical !== null && canonical !== typed.trim() && (
          <p className="mt-2 text-sm text-mono-500">
            Reading this as <span className="font-mono">{canonical}</span>
          </p>
        )}
      </Panel>

      <Button
        size="lg"
        className="mt-4 w-full"
        disabled={canonical === null || busy}
        onClick={() => void submit()}
      >
        {busy ? 'Checking the code…' : 'Redeem'}
      </Button>
    </Screen>
  )
}

/**
 * What went wrong, in words that imply what to do next.
 *
 * The three terminal reasons stay separate on purpose: "already used",
 * "expired" and "cancelled" send the customer to three different places — their
 * own wallet, nowhere, and back to the merchant.
 */
function failureMessage(result: RedeemResult): string {
  switch (result.kind) {
    case 'ok':
      return ''
    case 'terminal':
      switch (result.code) {
        case 'claimed':
          return 'This code has already been used. If that was you, the money is in your wallet.'
        case 'expired':
          return 'This code has expired. Ask the shop for a new one.'
        case 'revoked':
          return 'The shop cancelled this code. Ask them for a new one.'
      }
    // falls through — exhaustive above, but the compiler cannot see it
    // eslint-disable-next-line no-fallthrough
    case 'throttled':
      // The one failure the gateway is willing to explain, so it is the one
      // place a wait can be named instead of guessed at.
      return result.retryAfterSeconds !== null
        ? `Too many attempts. Try again in ${Math.ceil(result.retryAfterSeconds)} seconds.`
        : 'Too many attempts. Wait a moment and try again.'
    case 'not_found':
      // Deliberately covers being rate-limited too: the gateway answers 404 for
      // both, so promising "no such code" would sometimes be a lie.
      return "We couldn't find that code. Check it and try again."
    case 'unreachable':
      return 'Could not reach the network. Check your connection and try again — the code is still good.'
    case 'invalid':
      return 'Something was wrong with this code. Ask the shop to issue a new one.'
    case 'disabled':
      return 'Cashback is not available on this network.'
  }
}
