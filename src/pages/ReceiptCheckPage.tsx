import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, CircleDashed, HelpCircle, ScanLine, XCircle } from 'lucide-react'

import { BackLink, Button, DetailRow, IdentityInline, ListSection, Screen } from '../components/ui'
import { ReceiptAmount } from '../components/ReceiptSection'
import { formatDate } from '../lib/format'
import { verifyScanned, type VerifyResult } from '../lib/receipts'

/**
 * The stall's answer to "did this customer pay me?" after scanning a receipt (spec 049 story 4).
 *
 * One verdict, large, at the top: a merchant with a queue reads one word and a
 * colour and moves on. Everything below is for the rare case where they want to
 * know why. Each state has its own GLYPH as well as its colour, so the card
 * still reads in sun glare and for colour-blind staff.
 *
 * The QR text arrives in router state, never in the URL: it carries a payer
 * signature and a key to the evidence, and URLs end up in history and logs.
 */
export function ReceiptCheckPage({
  forStall,
  scanPath = '/scan',
}: {
  /** A terminal: the stall it checks for (`receipt:read`). The owner's app passes nothing. */
  forStall?: string
  /** Where Back and Scan another go. */
  scanPath?: string
} = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const qrText = (location.state as { qr?: string } | null)?.qr
  const [result, setResult] = useState<VerifyResult | undefined>(undefined)

  useEffect(() => {
    if (!qrText) return
    let live = true
    void verifyScanned(qrText, forStall).then((r) => live && setResult(r))
    return () => {
      live = false
    }
  }, [qrText, forStall])

  if (!qrText) {
    return (
      <Screen>
        <BackLink to={scanPath} label="Scan" />
        <p className="text-sm text-mono-500">Scan a receipt code to check it.</p>
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to={scanPath} label="Scan" />
      {result ? <ResultCard result={result} forStall={forStall !== undefined} /> : <CheckingCard />}
      {result ? <Details result={result} /> : null}
      <Button variant="outline" className="mt-2 w-full" onClick={() => navigate(scanPath, { replace: true })}>
        <ScanLine className="mr-2 h-4 w-4" aria-hidden /> Scan another
      </Button>
    </Screen>
  )
}

function CheckingCard() {
  return (
    <section
      role="status"
      className="mb-6 flex flex-col items-center gap-3 rounded-2xl border border-mono-200 p-6 text-center dark:border-mono-800"
    >
      <CircleDashed className="h-10 w-10 animate-spin text-mono-400 motion-reduce:animate-none" aria-hidden />
      <p className="text-[17px] font-semibold text-mono-900 dark:text-mono-50">Checking the receipt…</p>
    </section>
  )
}

type Tone = 'good' | 'caution' | 'bad'

/**
 * What the verdict means to the person at the till, in their words. On a terminal (`forStall`) the
 * till is not the payee, the stall is: "Paid to this stall", confirmed by the mint.
 */
function headline(r: VerifyResult, forStall = false): { tone: Tone; title: string; line: string } {
  const paidTitle = forStall ? 'Paid to this stall' : 'Paid to you'
  if (r.verdict === 'invalid') {
    return { tone: 'bad', title: 'Not a valid receipt', line: 'Do not accept it as proof of payment.' }
  }
  if (r.mint === 'not_valid') {
    return { tone: 'bad', title: 'Payment not confirmed', line: 'The mint has no record of this payment being collected.' }
  }
  if (r.mine === 'payee' && r.records === 'found_in_records') {
    return { tone: 'good', title: paidTitle, line: 'This payment is in your records.' }
  }
  // The mint saying "spent" proves only that SOMEONE spent the proofs. It is the payee's collection
  // only when the spend is tied to the payee: a countersignature or a payee lock, which is exactly
  // when the verdict is verified. An unacknowledged receipt of unlocked proofs falls through.
  if (r.mine === 'payee' && r.mint === 'confirmed' && (r.verdict === 'verified' || r.verdict === 'verified_offline')) {
    return {
      tone: 'good',
      title: paidTitle,
      line: forStall
        ? 'The mint confirms the stall collected this payment.'
        : 'The mint confirms the payment was collected with your key.',
    }
  }
  if (r.verdict === 'verified' || r.verdict === 'verified_offline') {
    const other = r.mine === 'neither'
    return {
      tone: other ? 'caution' : 'good',
      title: other ? (forStall ? 'Valid, but not paid to this stall' : 'Valid, but not paid to you') : 'Valid receipt',
      line: other ? 'The signatures check out, for a payment to someone else.' : 'The signatures check out.',
    }
  }
  if (r.verdict === 'unacknowledged') {
    return { tone: 'caution', title: 'Not yet confirmed by the payee', line: 'The payer signed it, the payee has not.' }
  }
  return { tone: 'caution', title: 'Partly checked', line: 'Only the summary could be checked. The proof was unreachable.' }
}

const TONE: Record<Tone, { Icon: typeof CheckCircle2; ring: string; icon: string }> = {
  good: { Icon: CheckCircle2, ring: 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40', icon: 'text-green-600' },
  caution: { Icon: AlertTriangle, ring: 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40', icon: 'text-amber-600' },
  bad: { Icon: XCircle, ring: 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40', icon: 'text-red-600' },
}

function ResultCard({ result, forStall = false }: { result: VerifyResult; forStall?: boolean }) {
  const h = headline(result, forStall)
  const { Icon, ring, icon } = TONE[h.tone]
  return (
    <section
      // Polite: the result appears in answer to the scan the merchant just did.
      role="status"
      data-tone={h.tone}
      className={`materialize mb-6 flex flex-col items-center gap-2 rounded-2xl border p-6 text-center ${ring}`}
    >
      <Icon className={`h-10 w-10 ${icon}`} aria-hidden />
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-mono-900 dark:text-mono-50">
        {h.title}
      </h1>
      {result.face ? (
        <div className="mt-1 flex flex-col items-center gap-0.5">
          <ReceiptAmount face={result.face} />
        </div>
      ) : null}
      <p className="text-[15px] leading-snug text-mono-600 dark:text-mono-300">{h.line}</p>
    </section>
  )
}

const PRESENTER_LINE: Record<VerifyResult['presenter'], string> = {
  PRESENTER_IS_PAYER: 'The payer’s own phone',
  PRESENTER_NOT_PROVEN: 'Not proven: could be a copy',
  NOT_CHECKED: 'Not checked',
}

const MINT_LINE: Record<VerifyResult['mint'], string> = {
  confirmed: 'Collected',
  not_valid: 'No record of collection',
  unreachable: 'Could not reach the mint',
  not_checked: 'Not checked',
}

/** One row per check, in the library's order, with a glyph for pass, fail and unknown. */
const CHECK_LABEL: Record<string, string> = {
  PAYER_SIGNATURE: 'Payer signature',
  PAYEE_COUNTERSIGNATURE: 'Payee confirmation',
  EVIDENCE_DIGEST: 'Proof matches receipt',
  MINT_SIGNATURE_DLEQ: 'Mint signed the amount',
  PAYEE_LOCK: 'Locked to the payee',
  AMOUNT: 'Amount adds up',
  SPENT_STATE: 'Collected at the mint',
  LIGHTNING_INVOICE: 'Lightning invoice',
  LIGHTNING_PREIMAGE: 'Lightning preimage',
  TIMESTAMP: 'Date',
}

function CheckMark({ ok }: { ok: boolean | null }) {
  if (ok === true) return <CheckCircle2 className="h-[1em] w-[1em] shrink-0 text-green-600" role="img" aria-label="Passed" />
  if (ok === false) return <XCircle className="h-[1em] w-[1em] shrink-0 text-red-500" role="img" aria-label="Failed" />
  return <HelpCircle className="h-[1em] w-[1em] shrink-0 text-mono-500" role="img" aria-label="Not checked" />
}

function Details({ result }: { result: VerifyResult }) {
  const s = result.summary
  return (
    <>
      {s ? (
        <ListSection title="Payment">
          <DetailRow label="Paid to" value={<IdentityInline pubkey={s.payee} />} />
          {s.payer ? <DetailRow label="Paid by" value={<IdentityInline pubkey={s.payer} />} /> : null}
          <DetailRow label="Date" value={formatDate(s.paidAt * 1000)} />
          {s.reference ? <DetailRow label="Reference" value={s.reference} /> : null}
          <DetailRow label="Shown on" value={PRESENTER_LINE[result.presenter]} />
          <DetailRow label="Mint" value={MINT_LINE[result.mint]} />
        </ListSection>
      ) : null}

      <ListSection title="Checks">
        {result.checks
          .filter((c) => c.ok !== null || c.check === 'PAYEE_COUNTERSIGNATURE')
          .map((c) => (
            <DetailRow
              key={c.check}
              label={CHECK_LABEL[c.check] ?? c.check}
              value={
                <span className="flex items-center gap-2 text-mono-900 dark:text-mono-50">
                  <CheckMark ok={c.ok} />
                  {c.detail ? <span className="text-sm text-mono-500">{c.detail}</span> : null}
                </span>
              }
            />
          ))}
      </ListSection>
    </>
  )
}
