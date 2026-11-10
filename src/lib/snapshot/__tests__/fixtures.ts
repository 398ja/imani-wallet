import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import type { TransactionRow, VoucherRow } from '@imani/wallet-storage'

import type { SnapshotSigner, SnapshotSources } from '../types'

/**
 * A wallet seeded with every kind of secret and personal value the snapshot must
 * never let out (criteria 1, 11, 21). Each value is distinctive so a substring
 * search for it, or its hex/base64/bech32 form, cannot be satisfied by accident.
 */
export const selfKey = generateSecretKey()
export const SELF = getPublicKey(selfKey)
export const SELF_NSEC = nip19.nsecEncode(selfKey)
export const SELF_NPUB = nip19.npubEncode(SELF)

const stallKey = generateSecretKey()
export const STALL = getPublicKey(stallKey)
export const STALL_NPUB = nip19.npubEncode(STALL)
export const FRIEND = getPublicKey(generateSecretKey())
export const FRIEND_NPUB = nip19.npubEncode(FRIEND)
export const TERMINAL = getPublicKey(generateSecretKey())
export const SUPPORT = getPublicKey(generateSecretKey())

export const CANARY = {
  token: 'cashuBo2FteCJodHRwOi8vbG9jYWxob3N0OjI3Nzc3YXVjc2F0YXSBomFpSABZr2ZKCANARYTOKENSECRET',
  proofSecret: '["P2PK",{"nonce":"canaryproofnonce0001","data":"02canaryproofdata"}]',
  proofC: '02' + 'c4'.repeat(32),
  nsec: SELF_NSEC,
  napEnvelope: '{"v":2,"kdf":"scrypt","ct":"CANARYNAPENVELOPECIPHERTEXTxyz=="}',
  cashlinkSecret: 'cashlink-secret-CANARY-9f8e7d6c5b4a',
  checkoutCode: 'IMANI-7KQ4-M2XD-9WPC',
  giftRefundKey: 'aa'.repeat(16) + 'canaryrefundkey' + 'bb'.repeat(8),
  email: 'alice.canary@example.org',
  memo: 'canary memo for the corner shop, call +31 6 12345678',
  fcmToken: 'fcm-CANARY-push-token-123456789',
  issuerDelegation: '{"delegation":"CANARYDELEGATIONSIG"}',
  driveToken: 'ya29.CANARYDRIVEOAUTHTOKEN',
}

export const PII = {
  sendId: 'as_26efe83f47c8438e',
  purchaseId: 'pur_canary_8812',
  voucherId: 'v_canary_42aa',
  eventId: 'e1'.repeat(32),
  stripePi: 'pi_3CANARYstripeIntent9',
  phone: '+31612345678',
  iban: 'NL91ABNA0417164300',
  street: '221 Baker Street',
  ip: '203.0.113.77',
  urlWithQuery: 'https://shop.example.org/order?id=8812&email=bob@example.org',
  displayName: 'Zebedee Quistwright',
  memoWithPii: 'pay back zebedee.q@example.net, card 4111 1111 1111 1111, 221 Baker Street',
}

export function seededLocalStorage(): Array<[string, string]> {
  return [
    ['imani-wallet-key', CANARY.napEnvelope],
    ['imani-wallet:onboarding-nsec', CANARY.nsec],
    ['imani:issuer-delegation', CANARY.issuerDelegation],
    ['imani-wallet:fcm-token', CANARY.fcmToken],
    ['imani-wallet:profile:' + SELF, JSON.stringify({
      pubkey: SELF, npub: SELF_NPUB, name: PII.displayName, display_name: PII.displayName,
      nip05: 'zebedee@imani.casa', about: 'call me ' + PII.phone, picture: 'https://cdn.example.org/a.png',
      backups: [{ kind: 'drive', at: 1762700000000 }],
    })],
    ['imani-wallet:pending-sends:' + SELF, JSON.stringify([{
      sendId: PII.sendId, tokenId: 'tok-' + CANARY.cashlinkSecret, amount: 500, unit: 'eur', decimals: 2,
      merchantPubkey: STALL, merchantName: 'Corner Shop', recipientPubkey: FRIEND, recipientName: PII.displayName,
      keepToken: CANARY.token, state: 'pending', attempts: 2, createdAt: 1762700100000,
    }])],
    ['imani:cashback-stash', JSON.stringify([{ token: CANARY.token, amount: 100, createdAt: 1762700200000 }])],
    ['imani-wallet:cashlink-claims:' + SELF, JSON.stringify([{ id: 'cl1', secret: CANARY.cashlinkSecret, amount: 300, state: 'claiming' }])],
    ['imani-wallet:checkout-codes:' + SELF, JSON.stringify([{ code: CANARY.checkoutCode, amount: 700, state: 'open' }])],
    ['imani:checkout-codes', JSON.stringify([CANARY.checkoutCode])],
    ['imani-wallet:gift-link-next:' + SELF, JSON.stringify({ refundKey: CANARY.giftRefundKey, email: CANARY.email })],
    ['imani-wallet:payment-requests:' + STALL, JSON.stringify([{ id: 'req-1', amount: 1200, state: 'paid', memo: CANARY.memo, buyerEmail: CANARY.email, stripe: PII.stripePi }])],
    ['imani-wallet:notifications:' + SELF, JSON.stringify([{ type: 'received', at: 1762700300000, read: false, body: 'From ' + PII.displayName + ' ' + CANARY.email, eventId: PII.eventId }])],
    ['imani-wallet:terminals:' + SELF, JSON.stringify([{ terminalPubkey: TERMINAL, name: 'Till by the window ' + PII.street, role: 'till', enrolledAt: 1762600000000, lastUsedAt: 1762700000000, token: CANARY.token, voucherId: 'cred-' + PII.voucherId }])],
    ['imani:settings', JSON.stringify({ currency: 'EUR', haptics: true, lastSupportEmail: CANARY.email, debugUrl: PII.urlWithQuery, lastIp: PII.ip, iban: PII.iban })],
    ['imani-wallet:merchant:' + SELF, JSON.stringify({ pubkey: SELF, name: 'Corner Shop', picture: 'x', location: PII.street, redeemKey: CANARY.giftRefundKey, open: true, acceptsCards: true, categories: ['food', 'drink'] })],
    ['imani-wallet:dm-poll:processed', JSON.stringify([PII.eventId, 'ab'.repeat(32)])],
    ['some-third-party-key', 'opaque value ' + CANARY.email],
    ['imani-wallet:brand-new-feature:' + SELF, JSON.stringify({ secretish: CANARY.cashlinkSecret })],
  ]
}

export function seededVouchers(): VoucherRow[] {
  return [
    {
      token_id: 'tid-' + CANARY.cashlinkSecret,
      voucher_id: PII.voucherId,
      token: CANARY.token,
      amount: 500,
      face_value: 500,
      face_unit: 'eur',
      face_decimals: 2,
      token_amount: 500,
      backing_strategy: 'ledger',
      issuer_id: STALL,
      merchant_template_id: 'tpl-canary-1',
      bundle_id: 'bun-canary-1',
      status: 'active',
      created_at: '2026-11-08T10:00:00.000Z',
      updated_at: '2026-11-08T10:00:00.000Z',
      received_via_event_id: PII.eventId,
      swap_proof_ids: ['02' + 'd5'.repeat(32)],
      purchase_id: PII.purchaseId,
    } as VoucherRow,
    {
      token_id: 'tid-own-1',
      voucher_id: 'v_own_1',
      token: CANARY.token + 'X',
      amount: 1000,
      face_unit: 'eur',
      issuer_id: SELF,
      status: 'active',
      created_at: '2026-11-09T10:00:00.000Z',
      updated_at: '2026-11-09T10:00:00.000Z',
    } as VoucherRow,
  ]
}

export function seededTransactions(memo = PII.memoWithPii): TransactionRow[] {
  return [
    { id: 'tx-' + PII.sendId, voucher_id: PII.voucherId, type: 'sent', direction: 'out', timestamp: 1762700100, amount: 500, face_unit: 'eur', counterparty: FRIEND, memo, send_id: PII.sendId } as TransactionRow,
    { id: 'tx-pay-1', type: 'payment', direction: 'in', timestamp: 1762700200, amount: 1200, face_unit: 'eur', counterparty: FRIEND_NPUB, memo: CANARY.memo, payment_request_id: 'req-1' } as TransactionRow,
    { id: 'tx-recv-1', voucher_id: PII.voucherId, type: 'received', direction: 'in', timestamp: 1762700300, amount: 500, face_unit: 'eur', counterparty: STALL, bundle_id: 'bun-canary-1' } as TransactionRow,
  ]
}

export function seededSources(opts: { stall?: boolean; memo?: string } = {}): SnapshotSources {
  return {
    selfPubkey: SELF,
    stall: opts.stall ?? true,
    vouchers: seededVouchers(),
    transactions: seededTransactions(opts.memo),
    storage: seededLocalStorage().filter(([k]) => opts.stall !== false || !k.includes(':terminals:')),
    errors: [{ at: 1762700400000, name: 'TypeError', code: 'mint_fetch', template: 'Failed to fetch keysets', frames: ['mintTransport.ts:88'] }],
    idbStores: ['wallet_vouchers', 'wallet_transactions', 'vouchers', 'sync_metadata'],
    environment: {
      appVersion: '0.41.0',
      buildRef: 'abc1234',
      gatewayUrl: 'http://localhost:5176',
      mintUrls: ['http://localhost:27777'],
      relayUrls: ['ws://localhost:27778'],
      blossomUrl: 'http://localhost:28090',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36',
      language: 'nl-NL',
      standalone: false,
      storageUsage: 12_345_678,
      storageQuota: 987_654_321,
    },
  }
}

export const testSigner: SnapshotSigner = {
  pubkey: SELF,
  async signEvent(t) {
    return finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]) }, selfKey)
  },
}

export const FIXED = {
  now: Date.parse('2026-11-09T22:04:40Z'),
  kCorr: new Uint8Array(32).fill(7),
  salt: new Uint8Array(16).fill(9),
}

export function baseOptions() {
  return {
    ticket: 'T1042',
    codeRef: 'ab'.repeat(32),
    supportPubkey: SUPPORT,
    ttlSeconds: 7 * 86400,
    includeMemos: false,
    signer: testSigner,
    now: FIXED.now,
    kCorr: FIXED.kCorr,
    salt: FIXED.salt,
  }
}

export const hex = bytesToHex
