import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button } from '../components/ui'
import { ATTESTATION_KIND } from '../lib/attestationKind'
import { ledgerPubkey, reconcileAttestations } from '../lib/attestation'
import { findDuplicates, readAttestations, summarise, type LedgerSummary } from '../lib/audit'
import { allEvents } from '../lib/relay'
import { listTransactions, recordAttestationReceipt } from '../lib/wallet'

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
 *
 * ## Why the merchant sees the AUDITOR's view, not a friendlier one
 *
 * "Your published record" reads the stream back off the relay through
 * `src/lib/audit.ts` — the same reader the hosted audit API runs, and the same
 * one an external auditor would use. Nothing here reads local rows for that
 * panel, which is the whole point: a merchant is shown what everyone else can
 * see about them, so the reassurance means something. A screen that ran a
 * gentler check would be reassurance about nothing.
 *
 * No amounts appear, and there is nowhere to put one. The commitments are what
 * keep a stall's takings private, and the merchant can already read their own
 * figures in their transaction list.
 *
 * The customer's half of DEV-245 is NOT here, and cannot be built in the wallet
 * today: the nullifier hashes the token the merchant RECEIVED, and
 * `AtomicSendResponse` states that the send token "is NEVER returned during the
 * saga — it stays server-side". The customer holds `keep_token` (their change)
 * and never the bytes that were redeemed, so their wallet cannot compute the
 * nullifier to look up. That needs the gateway to return the nullifier on
 * COMPLETED, and it has its own card.
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

  /**
   * What the merchant's OWN stream looks like when read back by the same reader
   * an external auditor uses.
   *
   * The point is that it is the same code. A merchant should be able to see
   * exactly what an auditor sees about them — if this screen ran a friendlier
   * check than `src/lib/audit.ts`, the reassurance it gave would be worthless.
   *
   * Scoped to this merchant's ledger key, so it reads one stall's records and
   * nobody else's.
   */
  const [ledger, setLedger] = useState<LedgerSummary | null>(null)
  const [conflicts, setConflicts] = useState(0)
  const [refused, setRefused] = useState(0)
  const [reading, setReading] = useState(false)
  /** The sweep threw. Distinct from "ran and found nothing", which is a result. */
  const [sweepFailed, setSweepFailed] = useState(false)

  const audit = useCallback(async () => {
    setReading(true)
    try {
      const key = ledgerPubkey()
      const events = await allEvents(key, ATTESTATION_KIND)
      const { accepted, rejected } = readAttestations(events)
      setLedger(summarise(accepted, key))
      // Conflicting only. A byte-identical republication is the sweep working
      // as designed, and showing it as a problem would make a merchant think
      // the button they just pressed broke something.
      setConflicts(findDuplicates(accepted).filter((d) => !d.benign).length)
      setRefused(rejected.length)
    } catch (error) {
      // Never throws to the screen: this is a read of a public stream, and a
      // relay that will not answer is not a fault of the merchant's books.
      console.error('[ledger] could not read the published stream', error)
    } finally {
      setReading(false)
    }
  }, [])

  useEffect(() => {
    try {
      setPubkey(ledgerPubkey())
      void audit()
    } catch {
      // Locked wallet or no signer. Show the explanation rather than a blank
      // panel that looks like the feature is broken.
      setFailed(true)
    }
  }, [audit])

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(pubkey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [pubkey])

  const sweep = useCallback(async () => {
    setBusy(true)
    setSweepFailed(false)
    try {
      // The sweep stamps a receipt onto every row it can (DEV-246): the gaps it
      // republishes, and the rows whose attestation was already published but
      // which carry no receipt — every redemption from before that feature.
      setResult(await reconcileAttestations(await listTransactions(), recordAttestationReceipt))
      // Re-read afterwards, so what the merchant sees is the ledger AS IT NOW
      // STANDS rather than the state that prompted the sweep. Reading first
      // would show the gaps it had just closed.
      await audit()
    } catch (error) {
      // Say something. Without this the promise rejected, the button re-enabled
      // itself, and the screen rendered NOTHING — a merchant taps "Check now"
      // and gets silence, which reads as a dead button rather than as a
      // failure they could act on.
      //
      // Found by driving the real screen in a real browser: the sweep reaches
      // IndexedDB through `listTransactions`, which throws "Wallet not opened
      // yet" whenever the store is not open. The jsdom tests mocked
      // `listTransactions`, so the whole failure path was invisible to them.
      console.error('[ledger] sweep failed', error)
      setResult(null)
      setSweepFailed(true)
    } finally {
      // Always clears: a relay timeout must not strand the button disabled
      // with no way back except a reload.
      setBusy(false)
    }
  }, [audit])

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
                shown in full and made selectable.

                `break-all` rather than the default: seen in a real browser, a
                64-char hash breaks wherever the line happens to end, which
                splits it mid-character-run and makes reading it back to an
                auditor by eye error-prone. `select-all` means a tap still takes
                the whole value regardless of where it wrapped, and the Copy
                button remains the intended path. */}
            <p className="mt-3 break-all font-mono text-xs leading-relaxed text-mono-600 dark:text-mono-300 select-all">
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
        <div className="flex items-start gap-3">
          {conflicts > 0 ? (
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden />
          ) : (
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-mono-400" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium text-mono-900 dark:text-mono-50">Your published record</p>
            <p className="mt-1 text-sm text-mono-500">
              Read back from the relay the same way an auditor reads it — not from this device.
            </p>

            {reading && !ledger ? (
              <p className="mt-3 text-sm text-mono-500">Reading…</p>
            ) : ledger ? (
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-mono-500">Redemptions published</dt>
                  <dd className="font-medium text-mono-900 dark:text-mono-50">
                    {ledger.redemptions}
                  </dd>
                </div>
                {ledger.units.length > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-mono-500">Currencies</dt>
                    <dd className="text-mono-900 dark:text-mono-50">{ledger.units.join(', ')}</dd>
                  </div>
                )}
                {ledger.lastAt && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-mono-500">Most recent</dt>
                    <dd className="text-mono-900 dark:text-mono-50">
                      {new Date(ledger.lastAt).toLocaleString()}
                    </dd>
                  </div>
                )}
                {/* Only ever rendered when non-zero. A permanent "Conflicts: 0"
                    row trains the eye to skip the line that matters. */}
                {conflicts > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-red-600 dark:text-red-400">Conflicting records</dt>
                    <dd className="font-medium text-red-600 dark:text-red-400">{conflicts}</dd>
                  </div>
                )}
                {refused > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-mono-500">Unreadable records</dt>
                    <dd className="text-mono-900 dark:text-mono-50">{refused}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="mt-3 text-sm text-mono-500">
                Could not reach the relay. Your records are unaffected — this screen only reads.
              </p>
            )}

            {conflicts > 0 && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                The same coupon appears twice with different details. That should not happen;
                contact support with your ledger ID.
              </p>
            )}

            {/* No amounts, anywhere on this panel, and no way to add one: the
                commitments are what keep a stall's takings private, and a screen
                that opened them would defeat the scheme for the sake of a number
                the merchant can already read in their own transaction list. */}
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
          {/* motion-reduce: a continuous rotation is the vestibular motion that
              setting asks us to drop, and the button's own label already says
              the sweep is running. */}
          <RefreshCw
            className={`mr-2 h-4 w-4 ${busy ? 'animate-spin motion-reduce:animate-none' : ''}`}
            aria-hidden
          />
          {busy ? 'Checking…' : 'Check now'}
        </Button>

        {sweepFailed && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="status">
            Could not finish the check. Nothing was changed — try again in a moment.
          </p>
        )}

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
