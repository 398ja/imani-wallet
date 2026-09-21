import { ShieldCheck, ShieldAlert } from 'lucide-react'

import { Panel } from './ui'
import { formatFace } from '../lib/format'
import { summariseReconciliation } from '../lib/reconcileIssuance'
import type { WalletTransaction } from '../lib/transactions'

/**
 * What a merchant's own issuance history says when it is re-checked.
 *
 * ## Why this screen exists
 *
 * A stall's records are its own, kept on its own device and encrypted to its
 * own key, so the only reason to believe them has always been that they are
 * yours. With the warrant stored beside each sale, the same history becomes
 * something anyone holding it can verify — including the merchant, about their
 * own past.
 *
 * The question it answers is "does what I issued match what I authorised", and
 * the row worth looking at is a **mismatch**: a sale whose stored figures no
 * longer agree with the signature filed beside them.
 *
 * ## What it deliberately does not claim
 *
 * "Authorised" is not "paid". A warrant proves the stall meant to issue a
 * value; on cash nothing else proves money arrived, because there is no third
 * party to ask. The attested figure is shown separately for exactly that
 * reason — collapsing the two would let a merchant read their own
 * authorisation as proof of payment, which it has never been.
 */
export function IssuanceReconciliation({
  transactions,
  stallPubkey,
}: {
  transactions: readonly WalletTransaction[]
  stallPubkey: string
}) {
  const lines = summariseReconciliation(transactions, stallPubkey)

  // Nothing issued. Rendering an empty table of zeroes would teach a merchant
  // that this screen is usually blank, which is how a panel stops being read.
  if (lines.length === 0) return null

  return (
    <Panel className="mt-4 p-5">
      <p className="font-medium text-mono-900 dark:text-mono-50">Coupons you issued</p>
      <p className="mt-1 text-sm text-mono-500">
        Re-checks every sale against the signature stored with it. “Authorised” means this
        stall signed for it; it does not mean the money arrived.
      </p>

      {lines.map((line) => (
        <div key={line.unit} className="mt-4 border-t border-mono-200 pt-3 dark:border-mono-700">
          <div className="flex items-start gap-3">
            {line.needsAttention ? (
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden />
            ) : (
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-mono-400" aria-hidden />
            )}
            <div className="min-w-0">
              <p className="font-medium text-mono-900 dark:text-mono-50">
                {formatFace(line.authorisedMinor, { unit: line.unit, decimals: line.decimals })} authorised
              </p>
              <p className="mt-1 text-sm text-mono-500">
                {line.counts.authorised} sale{line.counts.authorised === 1 ? '' : 's'} this
                stall signed for
                {line.attestedMinor > 0 && (
                  <>
                    {' · '}
                    {formatFace(line.attestedMinor, { unit: line.unit, decimals: line.decimals })} the
                    customer also signed for
                  </>
                )}
              </p>

              {/* Stated, never alarmed about. Every sale issued before warrants
                  shipped is here, and so is every sale a terminal made, because
                  a terminal's key is not the stall's. Colouring these red would
                  bury the one row that actually disagrees with itself. */}
              {line.counts.unwarranted > 0 && (
                <p className="mt-1 text-sm text-mono-500">
                  {formatFace(line.unwarrantedMinor, { unit: line.unit, decimals: line.decimals })} carries
                  no signature — older sales, and sales made on a terminal.
                </p>
              )}

              {/* The row that wants a human. A stored warrant that no longer
                  covers the sale beside it means one of the two changed after
                  the fact. */}
              {line.counts.mismatch > 0 && (
                <p className="mt-1 text-sm font-medium text-red-600 dark:text-red-400">
                  {formatFace(line.mismatchedMinor, { unit: line.unit, decimals: line.decimals })} does not
                  match its signature — {line.counts.mismatch} sale
                  {line.counts.mismatch === 1 ? '' : 's'} to look at.
                </p>
              )}
            </div>
          </div>
        </div>
      ))}
    </Panel>
  )
}
