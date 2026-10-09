import { getSigner } from './nap'
import { giftWraps, devicePublisher, ownerPublisher } from './terminalDeliveryNet'
import { unwrapSealed, wrapMessage } from './terminalDelivery'
import { enrolledMessageJson } from './terminalDelivery'
import { deviceConfirm } from './terminalConfirm'
import { clearPreviousToken, storedTerminal, storeRenewedCredential } from './terminalEnrol'
import { credentialFromToken } from './terminalLogin'
import { parseTerminalMetadata } from './terminalCredential'
import { roleOf } from './terminalRole'
import { revokeCredential } from './credentialRevocation'
import { terminalMintApi } from './terminalTill'
import { adoptRenewal, findRenewal, renewRequestJson, type AcceptedRenewal } from './terminalRenewal'

/**
 * The device half of renewal, on the network (#160 phase 6, plan 2.3). Run after every unlock,
 * the idle re-unlock included, and every five minutes while the till is open.
 */

/** How often an open till looks for a renewal. */
export const RENEWAL_POLL_MS = 5 * 60_000

/** How far back a renewal is looked for: the gateway lapses an unadopted one after 24 hours. */
const RENEWAL_LOOKBACK_SECONDS = 2 * 24 * 3600

/**
 * Spend the credential a renewal replaced, with K, if one is still held. Retried at every unlock.
 * `already-revoked` counts as spent: the owner's fallback revoke got there first.
 */
export async function spendPreviousCredential(): Promise<boolean> {
  const stored = storedTerminal()
  if (!stored?.previousToken) return true
  const facts = credentialFromToken(stored.previousToken)
  const metadata = facts?.merchantMetadata ?? null
  const out = await revokeCredential(stored.previousToken, metadata, terminalMintApi())
  if (out.revoked || out.reason === 'already-revoked' || out.reason === 'not-a-credential') {
    clearPreviousToken()
    return true
  }
  return false
}

/**
 * Look for a renewal of the credential this till holds, and adopt it. Never throws.
 *
 * @returns the adopted renewal, or null when there was none
 */
export async function checkForRenewal(): Promise<AcceptedRenewal | null> {
  try {
    // A spend that failed last time first: the free slot follows only once it lands (F7).
    await spendPreviousCredential().catch(() => false)

    const stored = storedTerminal()
    if (!stored) return null
    const facts = credentialFromToken(stored.token)
    const metadata = facts ? parseTerminalMetadata(facts.merchantMetadata) : null
    const role = roleOf(metadata?.role)
    if (!facts || !role) return null
    const held = {
      stallPubkey: facts.issuerId.toLowerCase(),
      voucherId: facts.voucherId,
      role,
      terminalPubkey: stored.terminalPubkey.toLowerCase(),
    }
    const signer = getSigner()
    const since = Math.max(Math.floor(stored.enrolledAt / 1000), Math.floor(Date.now() / 1000) - RENEWAL_LOOKBACK_SECONDS)
    const wraps = await giftWraps(held.terminalPubkey, since)
    const renewal = findRenewal(wraps, (w) => signer.withPrivkey((key) => unwrapSealed(w, key)), held)
    if (!renewal) return null

    const publisher = devicePublisher(signer)
    await adoptRenewal(renewal, stored.token, {
      store: (token, voucherId, previous, r) =>
        storeRenewedCredential(token, voucherId, previous, { name: r.name, idleLockMinutes: r.idleLockMinutes }),
      confirm: (voucherId) => deviceConfirm(voucherId, signer),
      announce: async (voucherId) =>
        publisher.publish(
          signer.withPrivkey((key) => wrapMessage(key, held.stallPubkey, enrolledMessageJson(voucherId, held.terminalPubkey))),
        ),
      spendOld: () => spendPreviousCredential(),
      clearPrevious: () => clearPreviousToken(),
    })
    return renewal
  } catch (error) {
    console.warn('[renewal] could not check for a renewal', error)
    return null
  }
}

/**
 * The till's "Ask the owner to renew" button (Q3): sends its own credential to the stall, sealed
 * by K, so an owner whose roster lost this till can adopt it and press Renew. Never throws.
 */
export async function sendRenewRequest(): Promise<boolean> {
  try {
    const stored = storedTerminal()
    const facts = stored ? credentialFromToken(stored.token) : null
    if (!stored || !facts) return false
    const signer = getSigner()
    const wrap = signer.withPrivkey((key) =>
      wrapMessage(key, facts.issuerId.toLowerCase(), renewRequestJson(facts.voucherId, stored.token)),
    )
    return await devicePublisher(signer).publish(wrap)
  } catch {
    return false
  }
}

export { ownerPublisher }
