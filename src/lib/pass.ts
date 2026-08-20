import type { VoucherRow } from '@imani/wallet-storage'

import { toEpochMs } from './format'
import { totalFaceValue, type Merchant } from './merchants'

/**
 * A coupon as a wallet pass.
 *
 * This is a TypeScript port of cashu-voucher 0.10.0's `VoucherPassMapper` and
 * `PassJson` (module `cashu-voucher-pass`), which adopts Apple's `pass.json`
 * schema — and ONLY the schema. There is no certificate, no `.pkpass`
 * container, and no pass update web service on either side; the record is a
 * layout vocabulary for imani's own wallet, which is exactly how we use it.
 *
 * **Why a port and not a call.** The Java mapper takes a `SignedVoucher` and is
 * pure, but nothing serves it over HTTP, and adding an endpoint would mean
 * posting client-held voucher state to a tier that refuses to hold it:
 * `JdbcWalletPort` rejects voucher operations outright because "the
 * customer-wallet is self-custodial — the backend MUST NOT persist vouchers,
 * proofs, or balances". So the pass is built here, from the row the wallet
 * already owns.
 *
 * **The pass is a derived view.** The voucher is the only source of truth and
 * nothing parses a pass back into one. Rendering is a pure function, so a
 * balance change after a partial redemption needs no synchronisation — the card
 * is simply re-rendered.
 */

/** Matches `VoucherPassMapper.FORMAT_VERSION`. */
export const FORMAT_VERSION = 1
/** Schema-required and semantically meaningless — we target no Apple infrastructure. */
export const PASS_TYPE_IDENTIFIER = 'xyz.tcheeric.voucher'
/** Schema-required and semantically meaningless — we target no Apple infrastructure. */
export const TEAM_IDENTIFIER = 'imani'
export const DEFAULT_DESCRIPTION = 'Gift Card'
export const DEFAULT_BACKGROUND_COLOR = 'rgb(20,20,20)'
export const DEFAULT_FOREGROUND_COLOR = 'rgb(255,255,255)'
export const TERMS = 'Redeemable only at the issuing merchant. Not redeemable at the mint.'
export const BARCODE_PREFIX = 'voucher:'
export const BARCODE_FORMAT_QR = 'PKBarcodeFormatQR'
export const DATE_STYLE_MEDIUM = 'PKDateStyleMedium'

/**
 * One displayed field.
 *
 * `currencyCode` and `dateStyle` are mutually exclusive — a field is a currency
 * or a date, never both.
 *
 * `unit` and `decimals` are OURS, not Apple's. The Java mapper can put a
 * `BigDecimal` in `value` under an ISO-4217 code and let the renderer format it;
 * a browser has no such type, and this stack issues in units ISO 4217 does not
 * define. Carrying both lets `formatFace` do the rendering it already does
 * everywhere else in the app.
 */
export interface PassField {
  key: string
  label: string
  value: string | number
  currencyCode?: string
  dateStyle?: string
  unit?: string
  decimals?: number
}

/** A machine-readable code. `altText` is the human-readable fallback. */
export interface Barcode {
  format: string
  message: string
  messageEncoding: string
  altText: string
}

/** Field groups for a store card. Absent groups stay undefined rather than empty. */
export interface StoreCard {
  primaryFields?: PassField[]
  auxiliaryFields?: PassField[]
  backFields?: PassField[]
}

export interface PassJson {
  formatVersion: number
  passTypeIdentifier: string
  teamIdentifier: string
  serialNumber: string
  description: string
  organizationName: string
  logoText?: string
  backgroundColor: string
  foregroundColor: string
  labelColor: string
  /** ISO-8601 instant, or undefined. */
  expirationDate?: string
  voided: boolean
  storeCard: StoreCard
  barcodes?: Barcode[]
  userInfo: Record<string, string>
}

/**
 * Merchant branding, as `MerchantBranding` in the Java module.
 *
 * Its javadoc names the source: the merchant's Nostr identity —
 * `organizationName` from kind-0 `name`, `logoUrl` from kind-0 `picture`,
 * `bannerUrl` from kind-0 `banner`. See `./branding.ts`.
 */
export interface MerchantBranding {
  organizationName?: string
  /**
   * Their NIP-05 handle (`name@domain`), from kind-0 `nip05`.
   *
   * Not in the Java `MerchantBranding` — ours, like `userInfo.issuer`. It is
   * here rather than in a second lookup because every screen that wants to name
   * someone already resolves them through `merchantBranding`, and a separate
   * fetch would double the requests for a string that arrives in the same event.
   *
   * UNVERIFIED, deliberately. NIP-05 verification means fetching the domain's
   * `.well-known/nostr.json` and checking it maps back to this pubkey; we
   * display what the profile claims. It is a label, not an authorisation — the
   * pubkey is what money is addressed to — but a handle shown here is a handle
   * anyone can put in their own kind-0.
   */
  nip05?: string
  logoUrl?: string
  bannerUrl?: string
  storeDescription?: string
  backgroundColor?: string
  foregroundColor?: string
}

export const EMPTY_BRANDING: MerchantBranding = {}

/**
 * Takes `unknown`, not `string | undefined`: several VoucherRow fields the pass
 * reads (`memo` among them) are not declared on the interface and arrive through
 * its index signature, so they reach here untyped.
 */
function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function orDefault(value: string | undefined, fallback: string): string {
  return present(value) ? value : fallback
}

/**
 * `pass.json` has no image fields at all — Apple carries images as files inside
 * the `.pkpass` bundle, referenced by filename convention. We emit JSON only, so
 * branding URLs live in the app-private `userInfo` dictionary, under the same
 * keys the Java mapper writes. Absent URLs are omitted rather than stored null.
 *
 * `voucherId` links the card to whichever proofs the wallet already holds. No
 * bearer secret is ever placed in a pass.
 *
 * `issuer` is ours, not the Java mapper's. `organizationName` is a name the
 * issuer declares about themselves — kind-0 is self-published and unverified, so
 * two pubkeys can claim the same name and picture. The pubkey is the only
 * unforgeable thing on the card, and the renderer needs it separately because
 * once branding supplies a name the pubkey is nowhere else on screen.
 */
function userInfo(
  branding: MerchantBranding,
  voucherId: string,
  issuer: string | undefined,
): Record<string, string> {
  const info: Record<string, string> = { voucherId }
  if (present(issuer)) info.issuer = issuer
  // The handle the card shows under the name. `issuer` stays in the dictionary
  // regardless: it is the unforgeable identifier, and it is what the card falls
  // back to for an issuer who has published no handle.
  if (present(branding.nip05)) info.issuerNip05 = branding.nip05
  if (present(branding.logoUrl)) info.logoUrl = branding.logoUrl
  if (present(branding.bannerUrl)) info.stripUrl = branding.bannerUrl
  return info
}

/**
 * A redemption code, not a transfer code.
 *
 * The wallet's share QR carries the raw token as an animated NUT-16 sequence and
 * hands over bearer value. This one carries an identifier the merchant resolves
 * against the ledger. Conflating them would let a merchant scanning a customer's
 * card receive the whole token instead of redeeming against it.
 *
 * `altText` is the bare id — it exists for a cashier to key in when a scanner
 * fails, so it carries no prefix.
 */
function barcode(voucherId: string): Barcode {
  return {
    format: BARCODE_FORMAT_QR,
    message: BARCODE_PREFIX + voucherId,
    messageEncoding: 'UTF-8',
    altText: voucherId,
  }
}

/**
 * Resolves `organizationName`, a schema-required top-level key. Branding wins
 * when present; otherwise the issuer id stands in, exactly as the Java mapper
 * falls back. Unlike the Java, an absent issuer does not throw — a DM-received
 * coupon can reach the wallet without one, and a screen that throws is worse
 * than a card that says "Unknown merchant".
 */
function organizationName(row: VoucherRow, branding: MerchantBranding): string {
  if (present(branding.organizationName)) return branding.organizationName
  if (present(row.issuer_id)) return row.issuer_id
  return 'Unknown merchant'
}

/**
 * The line under the merchant's name on a COUPON, which describes the coupon —
 * the memo they sent it with.
 *
 * The merchant's kind-0 `about` is deliberately NOT a fallback here, though the
 * Java mapper allows it: a shop's standing blurb ("Organic veg, Tue & Sat") is
 * about the shop, not about this voucher, and on the coupon card it sat in the
 * one line the holder reads to tell one coupon from another. It still carries
 * the merchant card on the home deck, where it is about the right thing.
 */
function description(row: VoucherRow): string {
  return present(row.memo) ? row.memo : DEFAULT_DESCRIPTION
}

/**
 * `voided` covers redeemed and revoked — NOT expired, because `expirationDate`
 * already conveys that. Same rule as `VoucherPassMapper.isVoided`.
 */
function isVoided(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase()
  return s === 'redeemed' || s === 'revoked'
}

function balanceField(minorUnits: number, unit: string, decimals: number): PassField {
  return {
    key: 'balance',
    label: 'BALANCE',
    value: minorUnits,
    currencyCode: unit,
    unit,
    decimals,
  }
}

function expiryField(iso: string): PassField {
  return { key: 'expires', label: 'EXPIRES', value: iso, dateStyle: DATE_STYLE_MEDIUM }
}

/**
 * Provenance shown on the back of the card.
 *
 * Deliberately excludes the issuer signature: surfacing one in a UI invites
 * treatment as a credential. Backing strategy, issuance ratio and merchant
 * metadata are excluded too — none has display meaning.
 */
function backFields(row: VoucherRow, voucherId: string): PassField[] {
  const fields: PassField[] = [{ key: 'voucherId', label: 'Voucher ID', value: voucherId }]
  if (present(row.issuer_id)) {
    fields.push({ key: 'issuer', label: 'Issuer', value: row.issuer_id })
  }
  fields.push({ key: 'terms', label: 'Terms', value: TERMS })
  return fields
}

/**
 * The id a merchant redeems against.
 *
 * `voucher_id` is the right field — it is what the Java mapper puts in the
 * barcode, and it is the merchant-side identifier. It falls back to `token_id`
 * only so a row that reached us without one still renders.
 *
 * ponytail: `voucher_id` is a merchant TEMPLATE id, shared between coupons
 * issued in one batch, so two coupons from the same issuance can carry the same
 * barcode. That is upstream's model, not something to paper over here — but it
 * is why the wallet still addresses coupons by `token_id` everywhere else.
 */
function voucherIdOf(row: VoucherRow): string {
  return present(row.voucher_id) ? row.voucher_id : row.token_id
}

/** Epoch seconds or an ISO string in, ISO-8601 instant out, undefined for no expiry. */
function expirationDate(row: VoucherRow): string | undefined {
  const ms = toEpochMs(row.expires_at)
  return ms === undefined ? undefined : new Date(ms).toISOString()
}

/**
 * One coupon as a pass. The faithful port.
 *
 * Unlike the Java, this NEVER throws. `VoucherPassMapper` validates that the
 * unit is ISO 4217, that a voucher id is a UUID and that a face value exists —
 * correct for a server mapper, wrong on a render path, where the cost of a
 * malformed row is a blank screen instead of a slightly wrong card. Every such
 * check degrades here instead.
 */
export function toCouponPass(row: VoucherRow, branding: MerchantBranding = EMPTY_BRANDING): PassJson {
  const voucherId = voucherIdOf(row)
  const expires = expirationDate(row)
  const foreground = orDefault(branding.foregroundColor, DEFAULT_FOREGROUND_COLOR)

  return {
    formatVersion: FORMAT_VERSION,
    passTypeIdentifier: PASS_TYPE_IDENTIFIER,
    teamIdentifier: TEAM_IDENTIFIER,
    serialNumber: voucherId,
    description: description(row),
    organizationName: organizationName(row, branding),
    // Branding-only, matching the Java: absent when there is no branding, while
    // organizationName still falls back to the issuer id.
    logoText: present(branding.organizationName) ? branding.organizationName : undefined,
    backgroundColor: orDefault(branding.backgroundColor, DEFAULT_BACKGROUND_COLOR),
    foregroundColor: foreground,
    labelColor: foreground,
    expirationDate: expires,
    voided: isVoided(row.status),
    storeCard: {
      primaryFields: [
        balanceField(row.face_value ?? 0, row.face_unit ?? '', row.face_decimals ?? 0),
      ],
      auxiliaryFields: expires === undefined ? undefined : [expiryField(expires)],
      backFields: backFields(row, voucherId),
    },
    // A voided coupon carries NO redemption code. Its proofs are burnt, so a
    // cashier scanning it would be reading a code for a sale that already
    // happened — the one thing this screen must not invite twice.
    barcodes: isVoided(row.status) ? undefined : [barcode(voucherId)],
    userInfo: userInfo(branding, voucherId, row.issuer_id),
  }
}

/**
 * A merchant as a pass, carrying everything held from them.
 *
 * **No barcode and no back fields, deliberately.** A barcode is a redemption
 * identifier for ONE voucher; a merchant-level card has no single voucher to
 * redeem, and emitting one would point a cashier's scanner at an arbitrary
 * coupon from the pile. Back fields are per-voucher provenance for the same
 * reason. This card is a summary and a way in to the coupon list — the coupon's
 * own pass is where a redemption code belongs.
 *
 * The total is `totalFaceValue`, which sums naively across the merchant's groups;
 * a merchant selling in two currencies gets a meaningless figure, exactly as the
 * merchant screen's balance did before. Unchanged here so the pass and the rest of
 * the app agree.
 */
export function toMerchantPass(
  merchant: Merchant,
  branding: MerchantBranding = EMPTY_BRANDING,
): PassJson {
  const group = merchant.groups[0]
  const foreground = orDefault(branding.foregroundColor, DEFAULT_FOREGROUND_COLOR)

  return {
    formatVersion: FORMAT_VERSION,
    passTypeIdentifier: PASS_TYPE_IDENTIFIER,
    teamIdentifier: TEAM_IDENTIFIER,
    serialNumber: merchant.pubkey,
    description: present(branding.storeDescription)
      ? branding.storeDescription
      : DEFAULT_DESCRIPTION,
    organizationName: present(branding.organizationName)
      ? branding.organizationName
      : merchant.name || merchant.pubkey,
    logoText: present(branding.organizationName) ? branding.organizationName : undefined,
    backgroundColor: orDefault(branding.backgroundColor, DEFAULT_BACKGROUND_COLOR),
    foregroundColor: foreground,
    labelColor: foreground,
    voided: false,
    storeCard: {
      primaryFields: [
        balanceField(totalFaceValue(merchant), group?.unit ?? '', group?.decimals ?? 0),
      ],
    },
    userInfo: userInfo(branding, merchant.pubkey, merchant.pubkey),
  }
}
