import { QrType } from '../detector/types';
import type { RouteConfigMap } from '../types/routing';

export const defaultRoutes: RouteConfigMap = {
  [QrType.PAYMENT_REQUEST]: {
    type: 'navigate',
    target: '/customer/send.html',
    paramKey: 'paymentRequest'
  },
  [QrType.CASHU_TOKEN]: {
    // Spec 035 US1 (FR-001/004) — the default route is intentionally a
    // 'callback' (not a 'navigate' with paramKey:'token'). The navigating
    // controller MUST store a single-use ScanPayloadHandoff and navigate to
    // /customer/receive.html?scan=<id> itself; the package router never
    // embeds the raw token in the URL. (See contracts/scan-payload-handoff.md.)
    type: 'callback',
    target: 'handleCashuToken',
    paramKey: 'token'
  },
  [QrType.NPUB]: {
    type: 'modal',
    target: 'ProfileModal',
    paramKey: 'identifier'
  },
  [QrType.NIP05]: {
    type: 'modal',
    target: 'ProfileModal',
    paramKey: 'identifier'
  },
  [QrType.VOUCHER_REDEEM]: {
    // DEV-131. A 'navigate' with the id in the URL, unlike CASHU_TOKEN's
    // handoff: the voucher id is an identifier and not bearer value, so it is
    // safe in a URL, and it is already visible in the merchant's own UI.
    type: 'navigate',
    target: '/customer/vouchers.html',
    paramKey: 'voucherId'
  },
  [QrType.UNKNOWN]: {
    type: 'callback',
    target: 'handleUnknown',
    paramKey: 'content'
  }
};
