import { VOUCHER_REDEEM_PREFIX } from '../detector/patterns';
import type { QrHandler } from '../types/handlers';

export interface VoucherRedeemData {
  /** The issuance id the merchant resolves against their own records. */
  voucherId: string;
}

/**
 * DEV-131 — the barcode printed on a voucher pass: `voucher:<uuid>`.
 *
 * **This is an IDENTIFIER, not value.** Nothing here is bearer: the payload
 * names a coupon so the issuing merchant can look it up, and holding it confers
 * no ability to spend anything.
 *
 * That distinction is the whole reason this is a separate type, and the card
 * says so in as many words. `voucher/js/vouchers.js::renderShareQr` emits a
 * TRANSFER code carrying the raw Cashu token as an animated NUT-16 sequence —
 * scanning that hands over the money itself, and it routes to
 * `UR_FRAGMENT`/`CASHU_TOKEN`. If one handler served both, scanning a
 * customer's printed card at the till would receive the whole token instead of
 * resolving a redemption against it. There is no collision by construction —
 * a NUT-16 fragment starts `ur:bytes/` and a token starts `cashuA`/`cashuB` —
 * but the routing has to stay distinct on purpose, not by accident.
 *
 * The `voucher:` prefix is why this works at all. `pass.ts` (`BARCODE_PREFIX`)
 * puts it there deliberately: a bare UUID would have matched nothing and
 * collided with nothing, so there would be no way to tell one from any other
 * opaque string a camera happens to see.
 */
export class VoucherRedeemHandler implements QrHandler<VoucherRedeemData> {
  validate(text: string): boolean {
    if (!text) return false;
    return this.voucherId(text) !== null;
  }

  async parse(text: string): Promise<VoucherRedeemData> {
    const voucherId = this.voucherId(text);
    if (voucherId === null) {
      throw new Error('Not a voucher redemption code');
    }
    return { voucherId };
  }

  getParams(parsed: VoucherRedeemData): Record<string, unknown> {
    return { voucherId: parsed.voucherId };
  }

  /**
   * The id, or null when this is not one of ours.
   *
   * The prefix is matched case-insensitively because a QR encoder is free to
   * upper-case for a denser alphanumeric encoding; the id after it is NOT
   * lower-cased, since it is an opaque identifier that gets compared verbatim
   * against stored records.
   */
  private voucherId(text: string): string | null {
    const trimmed = text?.trim() ?? '';
    if (!trimmed.toLowerCase().startsWith(VOUCHER_REDEEM_PREFIX)) return null;
    const id = trimmed.slice(VOUCHER_REDEEM_PREFIX.length).trim();
    // A bare `voucher:` names nothing. Accepting it would route the merchant to
    // a lookup that cannot succeed, which reads as a broken scanner rather than
    // an unrecognised code.
    return id.length > 0 ? id : null;
  }
}
