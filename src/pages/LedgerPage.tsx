import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, RefreshCw, ShieldCheck } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button } from '../components/ui'
import { ledgerPubkey, reconcileAttestations } from '../lib/attestation'
import { listTransactions } from '../lib/wallet'

/**
 * The merchant's public redemption ledger: their ledger ID, and the sweep that
 * makes a missing attestation mean something.
 *
 * Two review findings live here, and they are the same finding twice.
 *
 * 1. **The ledger ID was underivable.** The design says an auditor can fetch
 *    one merchant's whole set with `{authors:[ledgerPub]}` — but `ledgerSk` is
 *    `H(tag | merchantSk)`, derivable ONLY inside this wallet. Nothing exported
 *    it, so the headline capability was not deliverable for any merchant an
 *    auditor could name. This screen is that disclosure point.
 *
 * 2. **Absence did not yet mean anything.** A gap between local redemptions and
 *    published attestations had innocent explanations (tab closed mid-publish,
 *    relay dropped it). Until the merchant can see and close those gaps, a
 *    reader treating a gap as deliberate omission would be accusing honest
 *    stalls. The sweep is the gate; it belongs where the merchant can run it.
 *
 * Deliberately merchant-facing and manual. No customer-facing "this stall has
 * no record of your coupon" check ships until sweeps are routine — see
 * `docs/research/redemption-attestation-privacy.md`, which orders the work
 * producer -> sweep -> reader.
 */
export function LedgerPage() {
  const [pubkey, setPubkey] = useState('')
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    checked: number
    missing: number
    republished: number
  } | null>(null)

  useEffect(() => {
    try {
      setPubkey(ledgerPubkey())
    } catch {
      // Locked wallet or no signer. Show the explanation rather than a blank
      // panel that looks like the feature is broken.
      setFailed(true)
    }
  }, [])

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(pubkey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [pubkey])

  const sweep = useCallback(async () => {
    setBusy(true)
    try {
      setResult(await reconcileAttestations(await listTransactions()))
    } finally {
      // Always clears: a relay timeout must not strand the button disabled
      // with no way back except a reload.
      setBusy(false)
    }
  }, [])

  if (failed) {
    return (
      <Screen>
        <BackLink to="/settings" label="Settings" />
        <PageHeader title="Redemption ledger" />
        {/* A neutral panel, not `Alert`: Alert renders red error styling, and a
            locked wallet is a normal state the merchant can resolve in one tap,
            not something that has gone wrong. */}
        <Panel className="p-5">
          <p className="text-sm text-mono-500">Unlock your wallet to see your ledger ID.</p>
        </Panel>
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader
        title="Redemption ledger"
        subtitle="Proof you honoured the coupons you accepted"
      />

      <Panel className="p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-mono-400" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-mono-900 dark:text-mono-50">Your ledger ID</p>
            <p className="mt-1 text-sm text-mono-500">
              Share this with an auditor or a coupon issuer so they can check your record. It is
              not your account key, and it does not reveal what you redeemed or for how much.
            </p>
            {/* Wrapped, not truncated. An earlier review caught a raw 64-char
                hexpub overflowing the settlement receipt; the fix there was to
                shorten it, but this one exists to be COPIED, so it has to be
                shown in full and made selectable. */}
            <p className="mt-3 break-all font-mono text-xs text-mono-600 dark:text-mono-300 select-all">
              {pubkey}
            </p>
            <Button variant="secondary" className="mt-3" onClick={copy}>
              {copied ? (
                <>
                  <Check className="mr-2 h-4 w-4" aria-hidden />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-2 h-4 w-4" aria-hidden />
                  Copy ledger ID
                </>
              )}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel className="mt-4 p-5">
        <p className="font-medium text-mono-900 dark:text-mono-50">Check for gaps</p>
        <p className="mt-1 text-sm text-mono-500">
          Compares the redemptions on this device against what is published, and republishes
          anything missing. A record can go missing if the app closed or the network dropped
          mid-send.
        </p>
        <Button className="mt-3" onClick={sweep} disabled={busy}>
          <RefreshCw className={`mr-2 h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden />
          {busy ? 'Checking…' : 'Check now'}
        </Button>

        {result && (
          <p className="mt-3 text-sm text-mono-600 dark:text-mono-300" role="status">
            {result.checked === 0
              ? 'No redemptions to check yet.'
              : result.missing === 0
                ? `All ${result.checked} redemptions are published.`
                : `Found ${result.missing} missing of ${result.checked}. Republished ${result.republished}.`}
          </p>
        )}
      </Panel>
    </Screen>
  )
}
