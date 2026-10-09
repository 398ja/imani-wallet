import type { NapSession } from '@imani/nap-client-web'

import { COUPON_ISSUE, isMerchant, loadMerchant } from './merchant'

/**
 * Backoff between the re-reads of /auth/session, in ms. Two short reads: the gateway's ACL
 * learns about a new stall record from nostrdb's one-second poll, measured at 10-700 ms after
 * the publish on the local gate (#114 review 3c).
 */
export const CATCH_UP_DELAYS_MS: readonly number[] = [500, 1500]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Close the first-render race after a login (imani-wallet#114 review, MEDIUM).
 *
 * `auth/complete` answers from the gateway's ACL as it stood at that instant. A merchant who
 * publishes their stall record and logs in at once can beat nostrdb's ingest, so the login
 * answer says customer while this device already holds an active stall record. The UI is
 * driven by that answer until the next reload, so without this the new merchant sees a
 * customer home and no Sell button.
 *
 * Only when the two disagree (the local record is active, the session lacks coupon:issue),
 * re-read /auth/session, which resolves the ACL live (nap-java#58), up to twice with a short
 * backoff. It never adds a grant itself: the session state is whatever the server answers.
 * Any failure leaves the login answer in place, which is the fail-closed customer view.
 */
export async function catchUpMerchantGrant(
  session: Pick<NapSession, 'getSession' | 'hasPermission' | 'resume'>,
  delays: readonly number[] = CATCH_UP_DELAYS_MS,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const pubkey = session.getSession()?.pubkey
  if (!pubkey || !isMerchant(loadMerchant(pubkey))) return
  for (const delay of delays) {
    if (session.hasPermission(COUPON_ISSUE)) return
    await wait(delay)
    try {
      const restored = await session.resume()
      // A 401 here is the server ending the session: nothing more to wait for.
      if (!restored) return
    } catch (e) {
      console.warn('[app] merchant grant catch-up: /auth/session read failed', e)
      return
    }
  }
}
