import type { CredentialMintApi } from './credentialRevocation'
import { legacyApi } from './legacyBridge'
import { getSigner } from './nap'
import { profilePublisherVia } from './onlineShopPublisher'
import type { ProfilePublisher } from './onlineShopProfile'
import { publish as relayPublish } from './relay'
import { ownerPublisher } from './terminalDeliveryNet'
import { wrapMessage } from './terminalDelivery'
import { startRenewal } from './terminalRenewOwner'
import { mirrorToGateway } from './transferSignature'

/**
 * The owner's own implementations of the ports the Terminals and Online shop screens take, so both
 * screens act with the same key, client and relays. Tests inject their own.
 */

/** The owner's spend client, the one `burn.ts` and decommissioning use. */
export async function ownerSpendApi(): Promise<CredentialMintApi> {
  return (await legacyApi()) as unknown as CredentialMintApi
}

/** Sends a renewal's credential DM to the device, sealed by the stall (#160 phase 6). */
export const ownerSend = (json: string, terminalPubkey: string) =>
  ownerPublisher.publish(getSigner().withPrivkey((key) => wrapMessage(key, terminalPubkey, json)))

/** Renew, with the owner's own key, transport and publisher (#160 phase 6). */
export const ownerRenew = (stallPubkey: string, terminalPubkey: string, api: CredentialMintApi) =>
  startRenewal(stallPubkey, terminalPubkey, { api, send: ownerSend, stallSigner: getSigner() })

// 8 s to connect, not the default 3: right after an enrolment the page has a burst of relay sockets
// open and the profile publish lost the 3 s race every time on staging (2026-10-31).
export const ownerProfilePublisher: ProfilePublisher = profilePublisherVia(
  (e) => relayPublish(e, undefined, { connectMs: 8000 }),
  mirrorToGateway,
)

/** The stall's key, lent for one wrap, as `signer.withPrivkey` lends it everywhere else. */
export const stallSeal = <T,>(borrow: (key: Uint8Array) => T): T => getSigner().withPrivkey(borrow)
