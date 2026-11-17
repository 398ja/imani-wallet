import { useEffect, useState } from 'react'

import {
  holderCardPaymentState,
  stallCardPaymentStates,
  stateFor,
  type CardPaymentState,
} from '../lib/cardPaymentState'

/** A holder's voucher state, by its card reference. `undefined` while asking or when unknown. */
export function useHolderCardPaymentState(ref: string | undefined): CardPaymentState | undefined {
  const [answer, setAnswer] = useState<{ ref?: string; value?: CardPaymentState }>()
  useEffect(() => {
    let live = true
    void holderCardPaymentState(ref).then((value) => {
      if (live) setAnswer({ ref, value })
    })
    return () => {
      live = false
    }
  }, [ref])
  return answer && answer.ref === ref ? answer.value : undefined
}

/** The stall's state for one of its sales. `undefined` while asking or when unknown. */
export function useStallCardPaymentState(
  stallPubkey: string | undefined,
  match: { ref?: string; voucherId?: string },
): CardPaymentState | undefined {
  const [states, setStates] = useState<{ stall?: string; value?: CardPaymentState[] }>()
  useEffect(() => {
    let live = true
    if (!match.ref) return
    void stallCardPaymentStates(stallPubkey).then((value) => {
      if (live) setStates({ stall: stallPubkey, value })
    })
    return () => {
      live = false
    }
  }, [stallPubkey, match.ref])
  return states?.stall === stallPubkey ? stateFor(states?.value, match) : undefined
}
