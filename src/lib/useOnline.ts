import { useEffect, useState } from 'react'

/**
 * Whether the device believes it can reach the network.
 *
 * `navigator.onLine` is a weak signal — it reports a link, not reachability, so
 * it can say true on a captive-portal wifi that resolves nothing. It is used
 * here anyway, and only where a FALSE is acted on: enrolment refuses when this
 * is false and says why, which turns the common "no signal in the market" case
 * into a sentence instead of a failed mint call with no explanation.
 *
 * A wrong TRUE costs nothing extra: the mint call fails as it would have
 * anyway. A wrong FALSE would block an owner who actually had a connection,
 * which is why nothing here guesses more aggressively than the browser does.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  return online
}
