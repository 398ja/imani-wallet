import { parseIssuanceWarrant } from './issuanceWarrant'
import { verifyIssuerDelegation } from './issuerDelegation'
import { parseVoucherToken } from './voucherToken'

/**
 * Who a customer's payment receipt is addressed to.
 *
 * Normally the party that sent the coupon: `meta.senderPubkey` (the gateway's send row), then the
 * envelope signer, then the issuer. That is right for a cash sale, where the stall itself sends.
 *
 * A CARD sale is sent by the purchase issuer, which authenticates with the key the stall delegated
 * `coupon:issue` to. gateway-customer stamps that authenticated key as `sender_pubkey`, so the
 * receipt, and the customer's attestation inside it, was encrypted to the delegate key. Nothing
 * drains that queue, so the stall never saw a customer receipt for any card sale.
 *
 * So when the sender is exactly the delegate named by the coupon's own `delegated` warrant, and
 * that delegation verifies as signed by the coupon's issuer, the receipt goes to the issuer (the
 * stall). Everything here comes off the SIGNED voucher, never the envelope: a sender cannot redirect
 * a receipt by writing fields, only a stall's own signed delegation does.
 *
 * Never throws: an unreadable token keeps the ordinary sender.
 */
export function receiptAddressee(sender: string, token: string, now: number = Date.now()): string {
  try {
    const { voucher } = parseVoucherToken(token)
    const warrant = parseIssuanceWarrant(voucher.issuanceWarrant)
    if (warrant.state !== 'present' || warrant.form !== 'delegated') return sender
    const delegation = verifyIssuerDelegation(warrant.delegation, voucher.issuerId, now)
    if (!delegation.ok) return sender
    return delegation.delegatePubkey.toLowerCase() === sender.toLowerCase()
      ? voucher.issuerId.toLowerCase()
      : sender
  } catch {
    return sender
  }
}
