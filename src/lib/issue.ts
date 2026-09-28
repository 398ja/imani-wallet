import { nip19 } from 'nostr-tools'

import { gatewayConfig } from './config'
import { resolveNip05 } from './identity'
import { signedFetch } from './nip98'
import { INTERNAL_RELAY_URL } from './relay'
import { getWallet, notifyWalletChanged } from './wallet'
import { buildIssueTransaction } from './transactions'
import { issuingStall, mayIssue, type Actor } from './actor'
import { canIssueNow, sessionState, type TerminalSession } from './terminalSession'
import { attributionFor } from './terminalAttribution'
import { currencyDecimals } from './format'
import { buildIssuanceWarrant } from './warrantSigner'
import { parseIssuanceWarrant } from './issuanceWarrant'
import type { AttestedSale } from './cashAttestation'
import { NEVER_EXPIRES } from './merchant'

/**
 * Issuing a coupon and delivering it to a customer.
 *
 * This is `scripts/seed-merchant.mjs` moved into the app. That script is the only
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
 * PortalVoucherController, which takes the issuer from whoever it authenticated
 * and never from a request field.
 *
 * That is the PORTAL's rule and it still holds. What changed (terminals ticket
 * 02) is the issuer this app stamps on the DM payload: it used to be the
 * session pubkey, which is correct only while a stall is one durable key. A
 * terminal signs in with a disposable one, replaced at every re-enrolment, so
 * the stall now comes from the verified credential via `issuingStall` — and
 * issuance with no actor cannot be expressed at all.
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
 * A bare `song` is completed to `song@<the gateway's domain>` — see
 * `completeHandle`. A leading `@` is stripped first, because `@song` is how this
 * app prints a handle everywhere else, so it is also how people type one back.
 *
 * Returns null rather than throwing, for the camera loop.
 */
export async function toRecipientPubkey(input: string): Promise<string | null> {
  return (await resolveRecipient(input))?.pubkey ?? null
}

/**
 * The same resolution, keeping the handle it went through.
 *
 * `toRecipientPubkey` throws away the one thing that names a stranger. Someone
 * reached by typing `cocoa@staging.398ja.xyz` has, by definition, a handle
 * worth showing — and until their kind-0 arrives (or forever, if they never
 * published one) the send flow had nothing to print but a hex key. The
 * resolution is identical; only the return shape differs, so the two cannot
 * disagree about who a string points at.
 *
 * `handle` is undefined for an npub or hex input: those name nobody, and
 * inventing a handle for them would be a lie about how they were reached.
 */
export async function resolveRecipient(
  input: string,
): Promise<{ pubkey: string; handle?: string } | null> {
  const direct = toPubkeyHex(input)
  if (direct) return { pubkey: direct }

  const raw = input.trim().replace(/^nostr:/i, '').replace(/^@/, '')
  const address = raw.includes('@') ? raw : await completeHandle(raw)
  if (!address || !/^[^\s@]+@[^\s@]+$/.test(address)) return null

  const pubkey = await resolveNip05(address)
  return pubkey === null ? null : { pubkey, handle: address }
}

/**
 * `song` → `song@staging.398ja.xyz`.
 *
 * Nearly every customer a merchant serves is registered on the same gateway the
 * merchant is logged into, so making them type that domain — the one domain
 * they cannot get wrong — is keystrokes for nothing. The full `name@domain` is
 * still accepted, and is the only form that reaches a customer somewhere else.
 *
 * The charset is NIP-05's own name grammar rather than the loose test above.
 * This path runs on strings the camera decoded, and without it a scanned
 * `https://example.test/menu` — no spaces, no `@` — would look like a localpart
 * and cost a lookup that cannot succeed.
 *
 * Null when there is nothing to complete, or when the gateway cannot say what
 * its domain is: this is a resolver that answers null, not one that throws.
 */
async function completeHandle(localpart: string): Promise<string | null> {
  if (!/^[a-z0-9._-]+$/i.test(localpart)) return null
  try {
    const { nip05Domain } = await gatewayConfig()
    return `${localpart}@${nip05Domain}`
  } catch {
    return null
  }
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
  /** The CREATE response's spelling of `face_value`; the poll uses the other. */
  face_value_minor?: number
  face_unit?: string
  /** The CREATE response's spelling of `face_unit`. */
  currency?: string
  face_decimals?: number
  token_amount?: number
  backing_strategy?: string
  expires_at?: number | string | null
}

/**
 * The outcome of one sale, which may be several coupons.
 *
 * There is deliberately NO single-voucher field. An earlier version kept
 * `voucher`/`eventId` as "the first part" for convenience, but reading the
 * first item as though it were the sale is the exact bug that delivered 200 of
 * a 1000 sale — so the shape no longer offers it. Sum `vouchers` to state what
 * the customer received.
 */
export interface IssueResult {
  /** Every coupon delivered, in order. Sum `face_value` for what the customer got. */
  vouchers: IssuedVoucher[]
  /** DM event ids, index-aligned with `vouchers`. */
  eventIds: string[]
  /**
   * What the customer actually received, in minor units.
   *
   * Normally equal to the requested `faceValueMinor`. It is returned rather
   * than assumed so the confirmation screen can show the real figure: the
   * portal chooses how a large sale is split, and a shortfall must be visible
   * to the merchant while the customer is still standing there.
   */
  deliveredValue: number
}

export interface IssueParams {
  /**
   * Optionally collect the customer's own signature that they PAID.
   *
   * A warrant proves the stall authorised issuing a value; on cash nothing
   * else says money arrived, because there is no third party to ask. This is
   * the hook for asking the customer to say so themselves — see
   * `cashAttestation.ts`.
   *
   * **Optional, and its absence must never block a sale.** It is called with
   * the sale the warrant covers, and whatever it returns is filed alongside.
   * Returning undefined, throwing, or taking too long all mean "no
   * attestation", which is the ordinary case: most cash sales will not have
   * one, and a queue at a counter is a worse cost than an uncorroborated sale.
   */
  collectCashAttestation?: (sale: AttestedSale) => Promise<string | undefined>
  /** Minor units — cents. The amount the merchant typed, already canonicalised. */
  faceValueMinor: number
  currency: string
  expiryDays: number
  memo?: string
  /** Hex pubkey of the customer receiving the coupon. */
  recipientPubkey: string
  /**
   * WHO this coupon is issued for, not what to stamp on it.
   *
   * Terminals ticket 02. This was `issuerPubkey: string` — a key the caller
   * handed over — and a caller supplying the issuer is exactly what the ticket
   * removes: "A caller cannot supply the issuer directly; it is read from the
   * verified credential only."
   *
   * The difference is not cosmetic. A terminal signs in with a disposable key
   * that is replaced at every re-enrolment, so a screen passing its own session
   * pubkey would stamp coupons with an issuer that stops existing. The actor
   * names the STALL — from the credential for a terminal, from the session for
   * an owner's own device — and `issuingStall` is the only way to read it.
   */
  actor: Actor
  /**
   * The terminal's current session, if it is a terminal.
   *
   * Optional because an owner has none and never will: "a stall on its own
   * device sees no change" (terminals ticket 07) holds because the owner path
   * never acquires a session to lapse.
   *
   * For a TERMINAL, omitting it is refused. The role saying "may issue" is not
   * enough — a terminal whose day has rolled over, or which opened on reduced
   * authority because the mint was unreachable, still passes `mayIssue` and
   * must still be stopped. Defaulting a missing session to "fine" would make
   * this a check any caller could skip by forgetting it.
   */
  session?: TerminalSession | null
}

/** Where the caller has got to, for the progress screen. */
export type IssueStage = 'issuing' | 'minting' | 'delivering'

/**
 * Epoch SECONDS, from whatever the gateway returned.
 *
 * Straight from seed-merchant.mjs, and the reason is worth keeping: a voucher's
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

/**
 * Ask the portal to mint this sale. Returns as soon as the records exist.
 *
 * Returns a LIST, because one sale is not always one coupon. The portal splits a
 * face value whose Cashu token would exceed the transport ceiling into several
 * smaller coupons (`portal_voucher_auto_split`) and returns all of them. A token
 * carries one ~1840-char proof per set bit of its amount, so this triggers on
 * ordinary round numbers, not just extreme ones.
 *
 * This used to read `items[0]` and drop the rest. That lost real customer money:
 * a 1000-unit sale split into 5 parts of 200, the caller polled and delivered
 * part 1, and parts 2-5 were left minted-but-PENDING and never delivered. The
 * customer got 200 of their 1000. Every caller must handle N.
 */
async function createVouchers(
  params: IssueParams,
): Promise<{
  vouchers: IssuedVoucher[]
  warrant: string | undefined
  /** The sale the warrant covers, for anything binding to it. */
  sale: AttestedSale | undefined
}> {
  const warrant = await buildIssuanceWarrant(
    params.actor,
    params.faceValueMinor,
    currencyDecimals(params.currency),
    params.currency,
  )

  const response = await signedFetch(
    '/api/v1/portal/vouchers',
    'POST',
    {
      face_value_minor: params.faceValueMinor,
      currency: params.currency,
      quantity: 1,
      // Omitted, not sent as 0: no expiry field at all is what the portal reads
      // as a coupon that never expires, and `expiry_days` still has a @Min(1).
      ...(params.expiryDays === NEVER_EXPIRES ? {} : { expiry_days: params.expiryDays }),
      memo: params.memo,
      // The merchant's own authorisation for this sale, signed on THIS device
      // before the request leaves it. Without it a coupon says only that the
      // issuing service claims this stall issued it, which is a claim nobody
      // can check against the stall.
      //
      // `faceValueMinor` is the whole sale here because `quantity` is 1 above.
      // If that ever becomes variable, this must become the PRODUCT - a warrant
      // over one coupon's value would leave the rest riding free under the
      // ceiling. The portal computes the same product in `saleTotalMinor()` and
      // refuses a mismatch, so a divergence is a 400 rather than a bad coupon.
      //
      // Omitted entirely when undefined: an absent field is "this coupon
      // predates warrants", which is a different claim from a signed `none`,
      // and JSON.stringify would drop the key anyway.
      ...(warrant === undefined ? {} : { issuance_warrant: warrant }),
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

  if (!response.ok) throw new Error(await detail(response, 'Could not issue the voucher'))

  const body = (await response.json()) as { items?: IssuedVoucher[] } | IssuedVoucher[]
  const items = Array.isArray(body) ? body : (body.items ?? [])
  const vouchers = items.filter((item) => item?.voucher_id)
  if (vouchers.length === 0) throw new Error('The portal issued no voucher.')
  // Parsed back out rather than threaded separately, so the sale described
  // here is exactly the one the signature covers - including the nonce, which
  // is generated inside buildIssuanceWarrant and exists nowhere else.
  const parsed = parseIssuanceWarrant(warrant)
  const sale =
    parsed.state === 'present'
      ? {
          stallPubkey: issuingStall(params.actor),
          saleTotalMinor: parsed.saleTotalMinor,
          faceDecimals: parsed.faceDecimals,
          unit: parsed.unit,
          saleNonce: parsed.saleNonce,
        }
      : undefined

  return { vouchers, warrant, sale }
}

/**
 * A coupon that already carries its token and needs no polling.
 *
 * The token is the signal, not the status: the portal reports `ISSUED` for every
 * create item, quote-backed ones included, and only a present `token` means the
 * coupon was minted (imani-gateway-portal#48). A portal that predates #48 sends
 * no token at all, so every part falls through to polling.
 */
export function isMinted(voucher: IssuedVoucher): boolean {
  return Boolean(voucher.token) && voucher.status === 'ISSUED'
}

/**
 * Give a minted create item the fields delivery reads.
 *
 * The portal's `CreatedVoucherItem` spells the amount `face_value_minor` and the
 * unit `currency`, while the polled voucher (and the DM payload) use
 * `face_value` / `face_unit`. Without this a coupon delivered straight from the
 * create response would reach the customer with no face value.
 */
export function fromCreatedItem(item: IssuedVoucher, currency: string): IssuedVoucher {
  const unit = item.face_unit ?? item.currency ?? currency
  return {
    ...item,
    face_value: item.face_value ?? item.face_value_minor,
    face_unit: unit,
    face_decimals: item.face_decimals ?? currencyDecimals(unit),
  }
}

/**
 * Wait until the coupon actually carries a Cashu token.
 *
 * Issuance returns PENDING behind a bolt11 top-up invoice — the merchant starts at
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
    `The voucher never finished minting (status ${last.status ?? 'unknown'}, ` +
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
 * The DM is signed with the gateway's own identity rather than the merchant's, but
 * merchant attribution rides on `issuer_id` inside the payload — which is also
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
    // The STALL, whichever kind of device is running this. A terminal's own
    // key never appears on a coupon: customers must hold coupons from a stall
    // they can look up, not from a till that may not exist next week.
    issuer_id: issuingStall(params.actor),
    sender_pubkey: issuingStall(params.actor),
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
      `${await detail(response, 'The voucher was issued but could not be delivered')} ` +
        `It is held under voucher ${voucher.voucher_id.slice(0, 8)}.`,
    )
  }
  return (await response.json()) as { event_id?: string; eventId?: string }
}

/**
 * Issue a sale as one or more coupons, and deliver them. The whole Sell flow.
 *
 * ONE SALE IS NOT ALWAYS ONE COUPON. The portal splits a face value whose Cashu
 * token would exceed the transport ceiling, and returns every part; this
 * function mints and delivers each in turn. The result carries `vouchers` and
 * nothing that looks like a single coupon, because offering one is what let a
 * caller read the first part as the whole sale.
 *
 * Partial delivery is possible and is reported as a THROW carrying what landed:
 * once a coupon is DM'd it cannot be recalled, so a later part failing does not
 * undo an earlier one. The alternative — resolving successfully with a subset —
 * is what silently cost a customer 800 of a 1000 sale.
 *
 * The caller is held for the full run because confirming earlier would mean
 * confirming a delivery that has not happened, and on a market stall the
 * customer has already walked away by the time a background failure surfaces.
 *
 * `onStage` drives the progress screen. It fires per part, so a split sale
 * cycles through minting/delivering once for each coupon.
 */
export async function issueAndDeliver(
  params: IssueParams,
  onStage?: (stage: IssueStage) => void,
): Promise<IssueResult> {
  /**
   * Refused BEFORE anything is minted, not after.
   *
   * Terminals ticket 02: "Issuance with no credential is refused, and does not
   * fall back to the session." A caller with no actor cannot reach this line at
   * all — the type demands one — and a terminal whose role does not carry
   * issuance is stopped here rather than at delivery, so no voucher is minted
   * and abandoned.
   *
   * Ticket 07 adds the SESSION to this. "The same request made around the UI is
   * refused too" is the criterion, and it is only true if the enforcement point
   * asks the same question the screen asked. `canIssueNow` is that question:
   * role AND a live session AND not reduced authority. Calling `mayIssue` here
   * while the screen called `canIssueNow` would make hiding the control the
   * only thing standing between a lapsed terminal and minting money.
   *
   * This is affordance, not the boundary. The gateway's `coupon:issue` is what
   * actually counts, and a page that lied to itself here would still get a 403
   * from the check that matters. It is here so the failure is a sentence rather
   * than a 403 the merchant cannot read.
   */
  if (!canIssueNow(params.actor, params.session ?? null)) {
    // The lapse is reported ahead of the role, because it is the recoverable
    // one: "sign in again" is something staff can act on, while "this till was
    // never allowed to sell" is not. Reporting the role first would send them
    // to the owner with the wrong question.
    if (params.actor.kind === 'terminal') {
      const state = sessionState(params.session ?? null)
      if (!state.live) throw new Error(state.message)
      if (!mayIssue(params.actor)) {
        throw new Error(
          'This terminal is not set up to sell. Ask the stall owner to enrol it as a full till.',
        )
      }
      // Live, permitted by role, and still refused: reduced authority. Named
      // as a network problem, because that is what it is and it will pass.
      throw new Error(
        'This terminal cannot sell until it reaches the network again. Redeeming still works.',
      )
    }

    throw new Error(
      'This terminal is not set up to sell. Ask the stall owner to enrol it as a full till.',
    )
  }

  onStage?.('issuing')
  // Destructured so everything below keeps working on a plain list. The
  // warrant travels separately because it describes the SALE, not any one
  // coupon, and recordSale needs it to file what the stall actually signed.
  const { vouchers: created, warrant: saleWarrant, sale } = await createVouchers(params)

  // Asked for AFTER the coupons exist and before the sale is filed. The
  // customer is still at the counter either way, and doing it here means a
  // slow or refused attestation cannot delay the thing they came for.
  const cashAttestation = await collectAttestation(params, sale)

  // One sale, possibly several coupons — see `createVouchers`. Each part is
  // minted and delivered in turn, and the parts are INDEPENDENT: part 2 failing
  // says nothing about part 1, which is already in the customer's wallet and
  // cannot be recalled.
  //
  // SEQUENTIAL, not Promise.all. Each part's mint draws on the same merchant
  // float, and the backing settles through a Lightning top-up per part; firing
  // them together makes the order they draw in a race, and a partial failure
  // then leaves an unpredictable subset delivered. In sequence, a failure at
  // part k means exactly parts 1..k-1 landed, which is a fact worth reporting.
  const delivered: IssuedVoucher[] = []
  const eventIds: string[] = []

  for (const part of created) {
    let ready: IssuedVoucher
    try {
      onStage?.('minting')
      // Issued from the merchant's float, the create response already carries
      // the token (gateway-customer#126, imani-gateway-portal#48), so use it. Re-reading it by id is a
      // server-side read-after-create the gateway need not honour, and when it
      // 404'd the sale failed AFTER the proofs were spent. Only quote-backed
      // (PENDING) coupons still need polling for their token.
      const minted = isMinted(part)
        ? fromCreatedItem(part, params.currency)
        : await waitForToken(part.voucher_id)
      // Nothing to wait for when none was asked for: polling a coupon that never
      // expires spends the whole 15s grace period to confirm a field that is
      // correctly absent, on every sale.
      ready = params.expiryDays === NEVER_EXPIRES ? minted : await waitForExpiry(minted)

      onStage?.('delivering')
      const result = await deliver(ready, params)
      eventIds.push(result.event_id ?? result.eventId ?? '')
    } catch (error) {
      // Report what DID land before failing — for a mint failure as well as a
      // delivery one, because from the merchant's side both leave the same
      // question: how much of this sale is already gone? Without this the
      // merchant is told the sale failed while the customer holds part of it,
      // and the two accounts of the same sale disagree. That is exactly the
      // confusion the lost 800 caused.
      await recordSale(delivered, params, created.length, saleWarrant, cashAttestation)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}` +
          (delivered.length > 0
            ? ` ${describePartial(delivered, created.length, params)}`
            : ''),
      )
    }
    delivered.push(ready)
  }

  await recordSale(delivered, params, created.length, saleWarrant, cashAttestation)

  /**
   * Did the customer actually receive what the merchant sold?
   *
   * Every part reported success individually, which is not the same claim. The
   * portal chooses the split, and this code has never checked that the pieces
   * add up to the whole — so a gateway that returned four parts of a five-part
   * split, or mislabelled one, would read as a completed sale and the shortfall
   * would surface at the stall rather than here.
   *
   * A WARNING, not a throw. Every coupon counted here is already in the
   * customer's wallet and cannot be recalled, so failing the sale now would
   * report delivered money as undelivered — the mirror of the original bug.
   * The merchant is told the real figure and can make it up.
   */
  const deliveredValue = delivered.reduce(
    (sum, v) => sum + partValue(v, params, created.length),
    0,
  )
  if (deliveredValue !== params.faceValueMinor) {
    console.error('[issue] the parts do not add up to the sale', {
      requested: params.faceValueMinor,
      delivered: deliveredValue,
      parts: delivered.length,
    })
  }

  return { vouchers: delivered, eventIds, deliveredValue }
}

/** What one coupon is worth, for history and for reporting a partial sale.
 *
 * The POLLED voucher carries `face_value` (confirmed in production:
 * `voucher_finalized ... face_value=20000`), while the CREATE response spells
 * the same thing `face_value_minor` — so both are read, rather than trusting
 * whichever endpoint the value happened to come from.
 *
 * The last resort divides the sale by its part count instead of falling back to
 * the whole `faceValueMinor`. A missing field on a 5-part split would otherwise
 * file five rows of 1000 for a 1000 sale and report five times the money as
 * delivered, which is a worse lie than a rounded share.
 */
function partValue(voucher: IssuedVoucher, params: IssueParams, parts: number): number {
  return (
    voucher.face_value ??
    voucher.face_value_minor ??
    Math.round(params.faceValueMinor / Math.max(parts, 1))
  )
}

/**
 * What the merchant needs to hear when a sale lands in pieces.
 *
 * States the amount that reached the customer, because that is the number they
 * must reconcile against — not the number of coupons, which means nothing to
 * either party.
 */
function describePartial(
  delivered: IssuedVoucher[],
  total: number,
  params: IssueParams,
): string {
  const sent = delivered.reduce((sum, v) => sum + partValue(v, params, total), 0)
  const decimals = currencyDecimals(params.currency)
  const amount = (sent / 10 ** decimals).toFixed(decimals)
  return (
    `WARNING: this sale was split into ${total} coupons and ${delivered.length} ` +
    `already reached the customer, worth ${amount} ${params.currency}. ` +
    `Those cannot be recalled. Sell only the remainder.`
  )
}

/**
 * The merchant's own record of the sale — one row per coupon delivered.
 *
 * Written here for the same reason payRequest writes its row: nothing else
 * will. See buildIssueTransaction on why gateway-portal's voucher list is not
 * this history.
 *
 * Non-fatal but never silent, again matching payRequest: the coupons ARE with
 * the customer at this point, so throwing would report a delivered sale as a
 * failed one. A missing history entry beats a phantom failure.
 */
/**
 * Asks the caller to collect a cash attestation, and never lets that fail a sale.
 *
 * Every failure mode collapses to "no attestation": no collector configured, no
 * sale to bind one to, a collector that returns nothing, and a collector that
 * throws. That is deliberate and is the whole policy of this feature — the
 * coupons are already with the customer by the time this runs, so an exception
 * here would report a completed sale as a failed one over evidence that was
 * optional in the first place.
 */
async function collectAttestation(
  params: IssueParams,
  sale: AttestedSale | undefined,
): Promise<string | undefined> {
  if (!params.collectCashAttestation || !sale) return undefined
  try {
    return await params.collectCashAttestation(sale)
  } catch (error) {
    console.warn('[issue] cash attestation not collected; the sale stands', error)
    return undefined
  }
}

async function recordSale(
  delivered: IssuedVoucher[],
  params: IssueParams,
  parts: number,
  /**
   * The warrant this stall signed for the sale, if it signed one.
   *
   * Passed down rather than rebuilt here, and that is not merely tidier: the
   * nonce is fresh per call, so recomputing would file a DIFFERENT warrant
   * from the one the coupons actually carry, and a merchant reconciling the
   * two would find they disagree.
   *
   * The SAME warrant is filed against every part of a split sale, matching
   * what the coupons carry. Each part is verified against it as a ceiling.
   */
  saleWarrant?: string,
  /** The customer's own signature that they paid, if they gave one. */
  cashAttestation?: string,
): Promise<void> {
  if (delivered.length === 0) return
  try {
    for (const ready of delivered) {
      const row = buildIssueTransaction({
        voucherId: ready.voucher_id,
        // The PART's face value, not the whole sale's. Falling back to the
        // requested total would file each part at the full amount and inflate a
        // split sale by its part count in the merchant's own history.
        amount: partValue(ready, params, parts),
        unit: ready.face_unit ?? params.currency,
        // The CURRENCY's decimals, not the voucher's `face_decimals`. The
        // gateway stamps 2 on everything (probed: `face_value_minor: 1000`
        // returns `JPY 10.00` and `XOF 10.00` as readily as `€10.00`), so
        // trusting it would file a 2,500 XAF sale in the merchant's own history
        // as 25.00 — disagreeing with the confirmation they just read.
        //
        // Both ends now agree. The gateway derives face_decimals from the
        // currency at issuance (DEV-238), and coupons minted before that fix
        // are corrected at render time by `displayDecimals`, so a customer no
        // longer sees 25.00 for a 2,500 XAF coupon.
        //
        // Still do not "fix" anything here by scaling the amount — see
        // `currencyDecimals` in format.ts for what that costs.
        decimals: currencyDecimals(ready.face_unit ?? params.currency),
        recipientPubkey: params.recipientPubkey,
        memo: params.memo,
        expiresAt: toEpochSeconds(ready.expires_at),
        at: Date.now(),
        // Terminals ticket 09. The STALL's row only: this is written to the
        // merchant's own encrypted history, while `deliver` above builds what
        // the customer receives. Attribution deliberately does not appear there.
        terminalPubkey: attributionFor(params.actor)?.terminalPubkey,
        issuanceWarrant: saleWarrant,
        // The stall this sale was signed FOR, so the row can later check an
        // attestation naming it. Without this the only stall available at
        // verification time is the attestation's own claim, which is no check
        // at all - it would be compared against itself.
        merchantId: issuingStall(params.actor),
        // Every part of THIS sale, on every part's row. Taken from `delivered`
        // rather than from the original request, so it records what actually
        // reached the customer rather than what was asked for.
        saleVoucherIds: delivered.map((v) => v.voucher_id),
        cashAttestation,
      })

      // The relay copy rides along with the write: `openWallet` wraps
      // `addTransaction` so every row is published, encrypted to this merchant's
      // own key, and the sale survives this device (lib/txRecords.ts). Publishing
      // from here as well would write the same sale twice.
      await getWallet().addTransaction(row)
    }
    notifyWalletChanged()
  } catch (error) {
    console.error('[issue] delivered, but not recorded in local history', error)
  }
}
