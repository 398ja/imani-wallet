/**
 * A merchant account takes only its own stall's vouchers (owner rule, 2026-10-13).
 *
 * The rule: an account trading as a merchant may receive or redeem only vouchers whose SIGNED
 * issuer is its own stall key. That is how a stall takes its own coupons home (the till's Sell
 * flow, a P2PK payment to the stall, the owner at the till, the burn of a redeemed coupon), and
 * all of that keeps working. It never takes another stall's voucher, by any route: a DM, a `/c/`
 * cashback claim, a `/g` gift link, a pasted token. A merchant who also wants to shop elsewhere
 * uses a separate customer account, which is option A's identity separation.
 *
 * This is the wallet's half, and it is UX: gateway-customer refuses the same receive server-side
 * (403 `FOREIGN_VOUCHER_FOR_MERCHANT`), because a wallet check can be bypassed by calling the API
 * directly. What the wallet adds is refusing BEFORE anything is spent: before a cashback claim's
 * destructive ciphertext fetch, before a gift's swap, and on the prompt instead of an Add button.
 *
 * ## Which account is a merchant
 *
 * The local stall record (`loadMerchant`, any record, closed or open, as `refuseIfAnotherStalls`
 * reads it: a stall winding down is still a stall), else the relay (`merchantStatus`). When the
 * relay cannot be asked the answer is `unknown`, and an unknown account is refused a FOREIGN
 * voucher (fail closed) but never its own (a stall's own sale never waits on the network).
 *
 * ## Exemptions, each with its reason
 *
 * - Plain ecash: not a voucher of any stall.
 * - A voucher the account issued: its own coupon coming home.
 * - A licence (`licenceFromToken`, signed `subscription_id`): not money; sold to stalls by design.
 * - A terminal credential (`terminalCredentialFromToken`): not money; its own stall's.
 */

import { licenceFromToken } from './licences'
import { merchantStatus, loadMerchant, type MerchantStatus } from './merchant'
import { terminalCredentialFromToken } from './notMoney'
import { licenceSellerPubkey } from './licenceStatus'
import { parseVoucherToken, verifyVoucher } from './voucherToken'

/** The copy every refusal shows, on the prompt and in errors. */
export const MERCHANT_FOREIGN_VOUCHER =
  "Merchant accounts can only take their own stall's vouchers. To use a voucher from another stall, use a customer account."

/** When the account's role could not be checked and the voucher is another stall's. */
export const MERCHANT_STATUS_UNKNOWN =
  'We could not check this account just now, so the voucher was not added. Nothing was spent. Try again in a moment.'

/** The server's code for the same refusal (gateway-customer receive, gateway-core atomic send). */
export const FOREIGN_VOUCHER_CODE = 'FOREIGN_VOUCHER_FOR_MERCHANT'

/** Thrown before anything is spent. `reason` says which copy applies. */
export class ForeignVoucherRefusedError extends Error {
  constructor(public readonly reason: 'merchant' | 'unknown') {
    super(reason === 'merchant' ? MERCHANT_FOREIGN_VOUCHER : MERCHANT_STATUS_UNKNOWN)
    this.name = 'ForeignVoucherRefusedError'
  }
}

/**
 * Whose stall the signed voucher names, lower-case hex. `null` when the token is not a readable
 * voucher (plain ecash, a legacy `cashuA`, or bytes this parser cannot read): the server reads every
 * token itself and refuses on its own, so the wallet only answers what it can read. `'unverified'`
 * when it is a voucher whose issuer signature fails: no issuer can be trusted, so it is foreign.
 */
export function stallOfToken(token: string): string | 'unverified' | null {
  let parsed
  try {
    parsed = parseVoucherToken(token)
  } catch {
    return null
  }
  if (!verifyVoucher(parsed.voucher).signatureValid) return 'unverified'
  const id = (parsed.voucher.issuerId ?? '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(id) ? id : parsed.voucher.issuerPublicKey.toLowerCase()
}

/**
 * Is this voucher one of the exemptions (not money)? A licence counts only from the pinned seller
 * when this build names one (`VITE_LICENCE_SELLER_PUBKEY`, e.g. imani-subscriptions), as the
 * server pins `GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS`: otherwise any stall could dress its own
 * coupon up as a licence to pass this check.
 */
function notMoney(token: string): boolean {
  if (terminalCredentialFromToken(token) !== null) return true
  const licence = licenceFromToken(token)
  if (licence === null) return false
  const seller = licenceSellerPubkey()
  return !seller || (licence.issuerId ?? '').toLowerCase() === seller
}

/**
 * This account's role, for the rule. The local stall record first, so a stall's own device
 * answers without the network; else the relay.
 *
 * A `customer` answer is kept for a minute: a customer's wallet receives other stalls' coupons all
 * day, and `merchantStatus` deliberately re-asks the relay for every non-merchant. Opening a stall
 * on this device writes the local record, which is read first, so the cache never hides that; a
 * stall opened on ANOTHER device is seen within the minute, and the server refuses meanwhile.
 */
const CUSTOMER_TTL_MS = 60_000
const customerUntil = new Map<string, number>()

export async function accountRole(pubkey: string): Promise<MerchantStatus> {
  if (loadMerchant(pubkey) !== null) return 'merchant'
  const key = pubkey.toLowerCase()
  if ((customerUntil.get(key) ?? 0) > Date.now()) return 'customer'
  const role = await merchantStatus(pubkey)
  if (role === 'customer') customerUntil.set(key, Date.now() + CUSTOMER_TTL_MS)
  else customerUntil.delete(key)
  return role
}

/** Forget cached answers (logout, tests). */
export function forgetAccountRoles(): void {
  customerUntil.clear()
}

/** What the rule says about one issuer for this account, given its role. */
export function verdictFor(
  issuer: string | 'unverified' | null,
  account: string,
  role: MerchantStatus,
): 'ok' | 'merchant' | 'unknown' {
  if (issuer === null) return 'ok'
  if (issuer !== 'unverified' && issuer === account.toLowerCase()) return 'ok'
  if (role === 'customer') return 'ok'
  return role === 'merchant' ? 'merchant' : 'unknown'
}

/**
 * Refuse, before anything is spent, when this account is (or may be) a merchant and a token is
 * another stall's voucher. Own vouchers, plain ecash, licences and terminal credentials never ask
 * the network, so a stall's own sale never waits on the relay.
 */
export async function refuseForeignVouchers(tokens: readonly string[], account: string): Promise<void> {
  const own = account.toLowerCase()
  const foreign = tokens.filter((token) => {
    if (notMoney(token)) return false
    const issuer = stallOfToken(token)
    return issuer !== null && issuer !== own // 'unverified' counts as foreign
  })
  if (foreign.length === 0) return
  const verdict = verdictFor('unverified', account, await accountRole(account))
  if (verdict !== 'ok') throw new ForeignVoucherRefusedError(verdict)
}

/**
 * The same rule for an issuer known BEFORE a token is in hand (a cashback claim's public metadata):
 * refuse before the destructive claim. `issuer` null means the metadata did not say; that is left
 * to the token check after the claim and to the server.
 */
export async function refuseForeignIssuer(issuer: string | null, account: string): Promise<void> {
  if (!issuer || issuer.toLowerCase() === account.toLowerCase()) return
  const verdict = verdictFor(issuer.toLowerCase(), account, await accountRole(account))
  if (verdict !== 'ok') throw new ForeignVoucherRefusedError(verdict)
}

/**
 * This session's account key, or undefined before unlock. The rule needs an account to ask about;
 * a page with no session receives nothing anyway, and the server is the boundary either way.
 */
export function sessionAccount(signer: () => { pubkey?: string }): string | undefined {
  try {
    const pubkey = signer().pubkey
    return typeof pubkey === 'string' && /^[0-9a-f]{64}$/i.test(pubkey) ? pubkey : undefined
  } catch {
    return undefined
  }
}

/** Did the server refuse a receive under this rule? */
export function isServerForeignRefusal(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null
  return e?.code === FOREIGN_VOUCHER_CODE || (typeof e?.message === 'string' && e.message.includes(FOREIGN_VOUCHER_CODE))
}
