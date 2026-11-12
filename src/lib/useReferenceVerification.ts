import { useEffect, useState } from 'react'

import { verifyCardReference, type ReferenceVerification } from './referenceVerification'

/**
 * Ask, in the background, whether a reference is genuine. `undefined` while
 * asking. Never blocks the page: the reference is on screen and copyable
 * whatever this says.
 */
export function useReferenceVerification(reference: string): ReferenceVerification | undefined {
  const [answer, setAnswer] = useState<{ ref: string; value: ReferenceVerification }>()
  useEffect(() => {
    let live = true
    void verifyCardReference(reference).then((value) => {
      if (live) setAnswer({ ref: reference, value })
    })
    return () => {
      live = false
    }
  }, [reference])
  return answer?.ref === reference ? answer.value : undefined
}
