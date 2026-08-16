import { nip19 } from 'nostr-tools'

import { resolveNip05 } from './identity'
import { signedFetch } from './nip98'
import { INTERNAL_RELAY_URL } from './relay'
import { getWallet, notifyWalletChanged } from './wallet'
import { buildIssueTransaction } from './transactions'
import { currencyDecimals } from './format'

/**
 * Issuing a coupon and delivering it to a customer.
 *
 * This is `scripts/seed-farmer.mjs` moved into the app. That script is the only
 * verified implementation of this flow in the repo, and every wait in it is
 * load-bearing — its comments record what breaks without them. Read them before
 * changing the sequence here.
 *
 * WHY THE PORTAL TIER, not the customer gateway: voucher issuance on
 * customer-wallet is refused by design —
 *
 *   "Voucher creation not supported on JdbcWalletPort — customer-wallet is
 *    self-custodial (Constitution Principle II). Voucher state is client-held;
 *    backend MUST NOT persist vouchers, proofs, balances. If a caller is
 *    hitting this guard, the request is routing to the wrong tier."
 *
 * Issuing is a merchant action, so it goes to gateway-portal's
 * PortalVoucherController. The issuer pubkey is NEVER a request field — it comes
 * from whoever the portal authenticated, which is the point: the coupon is
 * stamped with the farmer's identity key.
 *
 * AUTH: the seed script sends `X-Auth-Pubkey` + `X-Edge-Auth` because it stands
 * in for the edge proxy that a real deployment runs. A browser is not that proxy
 * and must not hold that shared secret, so the page sends nothing but its NIP-98
 * Authorization header and its session cookie: Vite's `portal-edge-auth`
 * middleware validates the cookie against account-app and injects the pubkey and
 * permissions the portal actually trusts. Issuance is guarded by `coupon:issue`
 * there, so a customer's session reaches this endpoint and gets 403.
 * `signedFetch` needs `changeOrigin: false` on the proxy rule; see lib/nip98.ts.
 */

/**
 * Resolve whatever was scanned or pasted into a hex pubkey.
 *
 * Accepts the `npub1…` the customer's own /receive screen shows, a raw hex key,
 * and an `nprofile` — a customer who shares one still means "send it here". A
 * `nostr:` URI prefix is tolerated because some QR encoders add it and the
 * scanner hands back whatever was encoded.
 *
 * Returns null rather than throwing: the caller is a camera loop that will see
 * plenty of things that are not customer codes.
 */
export function toPubkeyHex(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  const stripped = raw.replace(/^nostr:/i, '')

  if (/^[0-9a-f]{64}$/i.test(stripped)) return stripped.toLowerCase()

  try {
    const decoded = nip19.decode(stripped)
    if (decoded.type === 'npub') return decoded.data
    if (decoded.type === 'nprofile') return decoded.data.pubkey
  } catch {
    return null
  }
  return null
}

/**
 * The same, plus NIP-05 handles — what the scanner and the paste box use.
 *
 * The customer's `/receive` screen now shows their handle, so `alice@domain` is
 * the ordinary case and the key forms are the fallback. Handles are resolved
 * through `/api/v1/resolve` (see `lib/identity.ts`), which is a network call, so
 * this is async where `toPubkeyHex` is not; the sync one stays for callers that
 * already hold a key form and must not await.
 *
 * The handle test is deliberately loose — one `@`, something either side. A
 * stricter pattern would reject a valid handle we had not thought of and leave
 * the merchant with "not a customer account" and no way forward, while a loose
 * one costs at most one 404 from an endpoint that answers null.
 *
 * Returns null rather than throwing, for the camera loop.
 */
export async function toRecipientPubkey(input: string): Promise<string | null> {
  const direct = toPubkeyHex(input)
  if (direct) return direct

  const raw = input.trim().replace(/^nostr:/i, '')
  if (!/^[^\s@]+@[^\s@]+$/.test(raw)) return null

  return resolveNip05(raw)
}

/** Poll budget for the issuance saga: 30 x 2s = 60s. */
const POLL_ATTEMPTS = 30
const POLL_INTERVAL_MS = 2000

/**
 * How long to keep re-reading after ISSUED, waiting for `expires_at` to appear.
 *
 * Bounded because a null expiry is a degraded coupon, not a failed one — better
 * to deliver it without an expiry than to fail a sale over a missing field.
 */
const EXPIRY_GRACE_MS = 15_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What the portal and wallet tiers return for a voucher. Only the read fields. */
export interface IssuedVoucher {
  voucher_id: string
  status?: string
  payment_state?: string
  token?: string
  memo?: string
  face_value?: number
  face_unit?: string
  face_decimals?: number
  token_amount?: number
  backing_strategy?: string
  expires_at?: number | string | null
}

export interface IssueParams {
  /** Minor units — cents. The amount the merchant typed, already canonicalised. */
  faceValueMinor: number
  currency: string
  expiryDays: number
  memo?: string
  /** Hex pubkey of the customer receiving the coupon. */
  recipientPubkey: string
  /** The issuing merchant's own hex pubkey. */
  issuerPubkey: string
}

/** Where the caller has got to, for the progress screen. */
export type IssueStage = 'issuing' | 'minting' | 'delivering'

/**
 * Epoch SECONDS, from whatever the gateway returned.
 *
 * Straight from seed-farmer.mjs, and the reason is worth keeping: a voucher's
 * `expires_at` has been seen as both an ISO-8601 string and a number, and the
 * number itself could be seconds or milliseconds. Sending milliseconds where
 * seconds are expected dates the coupon to the year 58000; sending an ISO string
 * fails Jackson's `Long` binding on the DM endpoint.
 *
 * Not `toEpochMs` from lib/format.ts — that answers the opposite question (it
 * returns milliseconds, for display), and the DM endpoint declares
 * `@JsonProperty("expires_at") Long` in seconds.
 */
export function toEpochSeconds(value: number | string | undefined | null): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    // Below 1e11 can only be seconds — the same magnitude test `toEpochMs` uses.
    return Math.floor(value < 1e11 ? value : value / 1000)
  }
  const ms = Date.parse(String(value))
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
}

/** Surface the gateway's own error message; they are specific and actionable. */
async function detail(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return `${fallback} (${response.status}).`
  try {
    const body = JSON.parse(text) as { error?: string | { message?: string }; message?: string }
    const message =
      typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message)
    if (message) return message
  } catch {
    // Not JSON — fall through to the raw text, truncated.
  }
  return `${fallback} (${response.status}): ${text.slice(0, 200)}`
}

/** Ask the portal to mint one coupon. Returns as soon as the record exists. */
async function createVoucher(params: IssueParams): Promise<IssuedVoucher> {
  const response = await signedFetch(
    '/api/v1/portal/vouchers',
    'POST',
    {
      face_value_minor: params.faceValueMinor,
      currency: params.currency,
      quantity: 1,
      expiry_days: params.expiryDays,
      memo: params.memo,
    },
    // No X-Auth-Pubkey from here, deliberately. The portal's NIP-98 filter does
    // not authenticate on this image — verified by calling :28084 directly with a
    // matching `u` and still getting 401 — so the edge path is the only one, and
    // the edge is what must say who the caller is. Vite's `portal-edge-auth`
    // middleware validates the session cookie against account-app and sets both
    // X-Auth-Pubkey and X-Auth-Permissions from the answer, discarding anything
    // this page sent. Sending a pubkey here would be decoration that reads like a
    // credential. The NIP-98 Authorization header still goes along: it is what a
    // fixed portal would use, and what the DM endpoint below actually enforces.
  )

  if (!response.ok) throw new Error(await detail(response, 'Could not issue the coupon'))

  const body = (await response.json()) as { items?: IssuedVoucher[] } | IssuedVoucher[]
  const items = Array.isArray(body) ? body : (body.items ?? [])
  const voucher = items[0]
  if (!voucher?.voucher_id) throw new Error('The portal issued no coupon.')
  return voucher
}

/**
 * Wait until the coupon actually carries a Cashu token.
 *
 * Issuance returns PENDING behind a bolt11 top-up invoice — the farmer starts at
 * 0 sats, so backing takes the insufficient_balance_fallback path. phoenixd-mock
 * auto-settles it about two seconds later, and only THEN does the voucher carry
 * a real token. Delivering before that DMs an empty token, which the customer
 * receives as a coupon worth nothing.
 *
 * POLL ON `token` PRESENCE, not on `expires_at`: that field stays null for 5-10s
 * after the voucher already reports ISSUED, so it is not a readiness signal.
 */
async function waitForToken(voucherId: string): Promise<IssuedVoucher> {
  let last: IssuedVoucher = { voucher_id: voucherId }

  for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
    // Signed, not plain: /api/v1/wallet is a NIP-98-protected prefix and the
    // filter authenticates reads as well as writes now, so an unsigned GET here
    // 401s and the poll silently never sees a token. The 2s interval keeps each
    // signature's created_at distinct, so the replay cache does not reject the
    // repeats. signedFetch carries credentials: 'include' already.
    const response = await signedFetch(`/api/v1/wallet/vouchers/${voucherId}`, 'GET')
    if (response.ok) {
      last = (await response.json()) as IssuedVoucher
      if (last.token && last.status === 'ISSUED') return last
    }
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(
    `The coupon never finished minting (status ${last.status ?? 'unknown'}, ` +
      `payment ${last.payment_state ?? 'unknown'}). It has NOT been delivered.`,
  )
}

/**
 * Re-read until `expires_at` settles, or the grace period runs out.
 *
 * The gateway populates this field asynchronously, and `deliver` passes it
 * straight into the DM — the gateway forwards only what the sender supplies. The
 * lag means that without this wait EVERY issued coupon reaches the customer's
 * wallet with no expiry date at all. That was observed for every seeded coupon
 * before the script grew this step.
 */
async function waitForExpiry(voucher: IssuedVoucher): Promise<IssuedVoucher> {
  let last = voucher
  const deadline = Date.now() + EXPIRY_GRACE_MS

  while (Date.now() < deadline) {
    const seconds = toEpochSeconds(last.expires_at)
    // An hour out clears the 60-second mint-quote deadline by a wide margin, so
    // this is the issuer's real expiry rather than the quote's.
    if (seconds && seconds * 1000 > Date.now() + 3_600_000) return last

    await sleep(POLL_INTERVAL_MS)
    // Signed for the same reason as waitForToken above.
    const response = await signedFetch(`/api/v1/wallet/vouchers/${last.voucher_id}`, 'GET')
    if (response.ok) last = (await response.json()) as IssuedVoucher
  }

  // Degraded, not failed: deliver it anyway rather than lose the sale.
  return last
}

/**
 * Hand the coupon to the customer as a NIP-17 gift-wrapped DM.
 *
 * The GATEWAY does the wrapping, not this code. TokenDmTransferAdapter builds
 * the kind-1059 gift wrap in exactly the shape the receive pipeline parses, so
 * hand-rolling it here would only risk drifting from that format.
 *
 * The DM is signed with the gateway's own identity rather than the farmer's, but
 * farmer attribution rides on `issuer_id` inside the payload — which is also
 * what the wallet groups coupons by — not on the signed envelope.
 */
async function deliver(
  voucher: IssuedVoucher,
  params: IssueParams,
): Promise<{ event_id?: string; eventId?: string }> {
  const response = await signedFetch('/api/v1/dm/tokens/send', 'POST', {
    recipient_pubkey: params.recipientPubkey,
    token: voucher.token,
    memo: voucher.memo ?? params.memo,
    voucher_id: voucher.voucher_id,
    face_value: voucher.face_value,
    face_unit: voucher.face_unit,
    face_decimals: voucher.face_decimals,
    token_amount: voucher.token_amount,
    backing_strategy: voucher.backing_strategy,
    issuer_id: params.issuerPubkey,
    sender_pubkey: params.issuerPubkey,
    // SendTokenDmRequest declares `@JsonProperty("expires_at") Long` — epoch
    // SECONDS. The gateway only forwards what the sender supplies
    // (TokenDmController is a straight `request.expiresAt()` passthrough), which
    // is why omitting it leaves the received coupon with a blank expiry.
    expires_at: toEpochSeconds(voucher.expires_at),
    // The gateway-reachable url, NOT the browser's — see INTERNAL_RELAY_URL.
    relay_urls: [INTERNAL_RELAY_URL],
  })

  if (!response.ok) {
    throw new Error(
      `${await detail(response, 'The coupon was issued but could not be delivered')} ` +
        `It is held under coupon ${voucher.voucher_id.slice(0, 8)}.`,
    )
  }
  return (await response.json()) as { event_id?: string; eventId?: string }
}

/**
 * Issue one coupon and deliver it. The whole Sell flow.
 *
 * `onStage` drives the progress screen. The caller is held for the full ~10s
 * because confirming earlier would mean confirming a delivery that has not
 * happened — and on a market stall the customer has already walked away by the
 * time a background failure surfaces.
 */
export async function issueAndDeliver(
  params: IssueParams,
  onStage?: (stage: IssueStage) => void,
): Promise<{ voucher: IssuedVoucher; eventId?: string }> {
  onStage?.('issuing')
  const created = await createVoucher(params)

  onStage?.('minting')
  const minted = await waitForToken(created.voucher_id)
  const ready = await waitForExpiry(minted)

  onStage?.('delivering')
  const result = await deliver(ready, params)

  // The merchant's own record of the sale, written here for the same reason
  // payRequest writes its row: nothing else will. See buildIssueTransaction on
  // why gateway-portal's voucher list is not this history.
  //
  // Non-fatal but never silent, again matching payRequest: the coupon IS with
  // the customer at this point, so throwing would report a delivered sale as a
  // failed one. A missing history entry beats a phantom failure.
  try {
    const row = buildIssueTransaction({
      voucherId: ready.voucher_id,
      amount: ready.face_value ?? params.faceValueMinor,
      unit: ready.face_unit ?? params.currency,
        // The CURRENCY's decimals, not the voucher's `face_decimals`. The
        // gateway stamps 2 on everything (probed: `face_value_minor: 1000`
        // returns `JPY 10.00` and `XOF 10.00` as readily as `€10.00`), so
        // trusting it would file a 2,500 XAF sale in the merchant's own history
        // as 25.00 — disagreeing with the confirmation they just read.
        //
        // This only fixes the merchant's side. The coupon still travels with
        // face_decimals=2, so the customer sees 25.00 until the gateway derives
        // decimals from the currency. That is a backend defect, recorded in the
        // design spec; do not "fix" it by scaling the amount, which over-backs
        // the coupon a hundredfold and 413s on delivery.
      decimals: currencyDecimals(ready.face_unit ?? params.currency),
      recipientPubkey: params.recipientPubkey,
      memo: params.memo,
      expiresAt: toEpochSeconds(ready.expires_at),
      at: Date.now(),
    })

    // The relay copy rides along with the write: `openWallet` wraps
    // `addTransaction` so every row is published, encrypted to this merchant's
    // own key, and the sale survives this device (lib/txRecords.ts). Publishing
    // from here as well would write the same sale twice.
    await getWallet().addTransaction(row)
    notifyWalletChanged()
  } catch (error) {
    console.error('[issue] delivered, but not recorded in local history', error)
  }

  return { voucher: ready, eventId: result.event_id ?? result.eventId }
}
