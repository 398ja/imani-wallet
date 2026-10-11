import { useState } from 'react'

import { Button } from './ui'
import { getVoucherRow } from '../lib/wallet'
import { swapBackToSats } from '../lib/swapBack'

/**
 * "Swap back to sats" for one coupon the mint refused as redeemed in full (cashu-mint#540).
 *
 * Shown under the refusal. The swap is the wallet's own and declares nothing, so it consumes none
 * of the coupon's cap: the holder takes the coupon's sats as plain ecash. Offered, never done
 * automatically: giving up a coupon is the holder's decision, and they may prefer to contact the
 * stall first with the reference.
 */
export function SwapBackOffer({ tokenId, pubkey }: { tokenId: string; pubkey: string }) {
  const [state, setState] = useState<
    { step: 'offer' } | { step: 'swapping' } | { step: 'done'; sats: number } | { step: 'failed'; message: string }
  >({ step: 'offer' })

  if (state.step === 'done') {
    return (
      <p className="mt-2 text-sm text-mono-600 dark:text-mono-300" role="status">
        Swapped back: {state.sats} sats are in your wallet as plain ecash.
      </p>
    )
  }

  return (
    <div className="mt-2 space-y-1">
      <Button
        variant="outline"
        className="w-full"
        disabled={state.step === 'swapping'}
        onClick={async () => {
          setState({ step: 'swapping' })
          try {
            const row = await getVoucherRow(tokenId)
            if (!row) throw new Error('This coupon is no longer in your wallet.')
            const { sats } = await swapBackToSats(row, pubkey)
            setState({ step: 'done', sats })
          } catch (e) {
            setState({ step: 'failed', message: e instanceof Error ? e.message : 'The swap back failed.' })
          }
        }}
      >
        {state.step === 'swapping' ? 'Swapping back…' : 'Swap back to sats'}
      </Button>
      {state.step === 'failed' && (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {state.message}
        </p>
      )}
    </div>
  )
}
