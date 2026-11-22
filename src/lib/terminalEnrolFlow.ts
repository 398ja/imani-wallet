import { revokeCredential, type CredentialMintApi } from './credentialRevocation'
import type { StallSigner } from './ownerAttestation'
import type { PreparedCredential } from './terminalIssue'
import { CredentialMintError, attestEnrolment, checkCode, formatCheckCode, mintTerminalCredential, type MintTransport } from './terminalMint'
import { ENROLMENT_CODE_MESSAGES, TERMINAL_KEY_CHECK_UNAVAILABLE_MESSAGE } from './terminalEnrolProof'
import { userMessage } from './userMessage'
import { sendCredential, setupCode, type WrapPublisher } from './terminalDelivery'
import { settleMintFailure } from './terminalRevoke'
import { recordTerminal, updateTerminal, WAITING_TTL_MS } from './terminalRoster'
import type { OnlineShopPlatform } from './onlineShop'
import { parseVoucherToken } from './voucherToken'

/**
 * Putting a credential on a device: the steps the enrol screen and the online shop screen share.
 *
 * Extracted from `TerminalEnrolPage` unchanged in order and in what is written when, so a till and
 * a shop cannot drift apart: the row is written BEFORE the request leaves the phone (#160 review),
 * the credential is checked on its own bytes and spent at once if it came back wrong, and only a
 * right one reaches the roster, then the device by NIP-17 (#160 phase 2).
 */

export interface EnrolDeps {
  transport: MintTransport
  spendApi: () => Promise<CredentialMintApi>
  publisher: WrapPublisher
  seal: <T>(borrow: (key: Uint8Array) => T) => T
  stallSigner: () => StallSigner
}

export interface Enrolled {
  name: string
  /** The check code the device shows when it receives its authority. */
  code: string
  /** Whether the credential DM was taken. */
  sent: boolean
  /** The setup code the device scans. */
  setup: string
}

/** Thrown when the row could not even be written: nothing was sent. */
export class EnrolNotStartedError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'EnrolNotStartedError'
  }
}

/**
 * Mint, check, keep and deliver one credential.
 *
 * On a mint failure the row is settled exactly as before (only a definitive 4xx forgets it) and the
 * error is rethrown for the screen to word. `shop` goes on the row, and from there on the profile.
 */
export async function enrolTerminal(
  stallPubkey: string,
  prepared: PreparedCredential,
  options: { idleLockMinutes: number; shop?: { url: string; platform: OnlineShopPlatform } },
  deps: EnrolDeps,
): Promise<Enrolled> {
  const { idleLockMinutes: idleLock, shop } = options
  const mintKey = crypto.randomUUID()
  const startedAt = Date.now()
  let credential: PreparedCredential
  try {
    // The stall's own consent to this till (#160 decision 5): signed here, once, with the key
    // that signs `merchant` warrants, before anything is sent.
    credential = { ...prepared, attestation: attestEnrolment(prepared, deps.stallSigner(), startedAt) }
    recordTerminal(stallPubkey, {
      terminalPubkey: credential.lockedTo,
      name: credential.name,
      role: credential.role,
      enrolledAt: startedAt,
      status: 'minting',
      mintKey,
      // With the key, so a resumed mint re-sends this exact body (spec 4.6.2).
      attestation: credential.attestation,
      ...(credential.enrolmentProof ? { enrolmentProof: credential.enrolmentProof } : {}),
      idleLockMinutes: idleLock,
      waitingUntil: startedAt + WAITING_TTL_MS,
      ...(shop ? { shop: { url: shop.url, platform: shop.platform } } : {}),
    })
  } catch (e) {
    throw new EnrolNotStartedError(e)
  }
  try {
    const minted = await mintTerminalCredential(
      credential,
      async (token) => {
        const metadata = parseVoucherToken(token).voucher.merchantMetadata
        const out = await revokeCredential(token, metadata, await deps.spendApi())
        return out.revoked || out.reason === 'already-revoked'
      },
      deps.transport,
      {
        idempotencyKey: mintKey,
        onAccepted: (voucherId) => updateTerminal(stallPubkey, credential.lockedTo, (row) => ({ ...row, voucherId })),
      },
    )
    const now = Date.now()
    // Waiting, not in service: the device has not confirmed it, and it cannot trade until it has.
    updateTerminal(stallPubkey, credential.lockedTo, (row) => ({
      ...row,
      status: 'waiting',
      token: minted.token,
      voucherId: minted.voucherId,
      enrolledAt: now,
      waitingUntil: now + WAITING_TTL_MS,
      mintKey: undefined,
      idleLockMinutes: idleLock,
    }))
    const sent = await sendCredential(
      { voucherId: minted.voucherId, token: minted.token, stallPubkey, name: credential.name, idleLockMinutes: idleLock },
      credential.lockedTo,
      deps.seal,
      deps.publisher,
    ).catch(() => false)
    // Remembered, so the Terminals list re-sends a DM that did not land (#160 round 2).
    updateTerminal(stallPubkey, credential.lockedTo, (row) => ({ ...row, delivered: sent }))
    return {
      name: credential.name,
      code: formatCheckCode(checkCode(minted.voucherId, stallPubkey, credential.lockedTo)),
      sent,
      setup: setupCode(stallPubkey, minted.voucherId),
    }
  } catch (e) {
    // Shared with resumeMinting: only a definitive 4xx forgets the row (#160 round 2).
    await settleMintFailure(stallPubkey, credential.lockedTo, e)
    throw e
  }
}

/**
 * The gateway's refusals of the KEY, in the owner's words (inv-terminal-not-merchant). Everything
 * else keeps the message it already had.
 */
export function ownerMessageFor(e: unknown): string {
  if (e instanceof CredentialMintError) {
    if (e.code === 'TERMINAL_KEY_NOT_A_TERMINAL') return ENROLMENT_CODE_MESSAGES['not-a-terminal-code']
    if (e.code === 'TERMINAL_KEY_IS_MERCHANT') return ENROLMENT_CODE_MESSAGES.merchant
    if (e.code === 'TERMINAL_KEY_CHECK_UNAVAILABLE') return TERMINAL_KEY_CHECK_UNAVAILABLE_MESSAGE
  }
  return userMessage(e, 'Could not set up the terminal.')
}
