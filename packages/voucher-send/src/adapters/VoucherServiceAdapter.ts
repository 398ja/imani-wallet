/**
 * VoucherServiceAdapter
 *
 * Built-in adapter that wraps @imani/nostr-vouchers VoucherStore.
 * This is the recommended way to integrate with the Imani ecosystem.
 */

import type { StorageAdapter, VoucherFilter } from './StorageAdapter';
import type { Voucher, TransactionInput } from '../types';

/**
 * VoucherStore interface (from @imani/nostr-vouchers)
 * Defined here to avoid hard dependency
 */
export interface VoucherStoreInterface {
  query(filter?: Record<string, unknown>): Promise<{ vouchers: ServiceVoucher[] }>;
  get(id: string): Promise<ServiceVoucher | null>;
  add(voucher: ServiceVoucherInput): Promise<ServiceVoucher>;
  update(id: string, updates: Partial<ServiceVoucher>): Promise<ServiceVoucher | null>;
  delete(id: string): Promise<boolean>;
}

/**
 * TransactionStore interface (from @imani/nostr-transactions)
 */
export interface TransactionStoreInterface {
  add(transaction: Record<string, unknown>): Promise<unknown>;
}

/**
 * Service voucher format (from @imani/nostr-vouchers)
 */
export interface ServiceVoucher {
  id: string;
  token: string;
  faceValue: number;
  faceUnit: string;
  faceDecimals: number;
  tokenAmount: number;
  tokenUnit?: string;
  backingStrategy: string;
  issuanceRatio?: number;
  issuerId?: string;
  issuerName?: string;
  merchantMetadata?: Record<string, unknown>;
  status: string;
  expiresAt?: string;
  createdAt?: string;
  mintUrl?: string;
  memo?: string;
}

/**
 * Service voucher input
 */
export type ServiceVoucherInput = Omit<ServiceVoucher, 'id' | 'createdAt'> & {
  id?: string;
};

/**
 * VoucherServiceAdapter
 *
 * Adapts @imani/nostr-vouchers VoucherStore to the StorageAdapter interface.
 */
export class VoucherServiceAdapter implements StorageAdapter {
  private voucherStore: VoucherStoreInterface;
  private transactionStore?: TransactionStoreInterface;

  constructor(
    voucherStore: VoucherStoreInterface,
    transactionStore?: TransactionStoreInterface
  ) {
    this.voucherStore = voucherStore;
    this.transactionStore = transactionStore;
  }

  async getVouchers(filter?: VoucherFilter): Promise<Voucher[]> {
    const queryFilter: Record<string, unknown> = {};

    if (filter?.status) {
      queryFilter.status = filter.status;
    }
    if (filter?.merchantId) {
      queryFilter.issuerId = filter.merchantId;
    }
    if (filter?.unit) {
      queryFilter.faceUnit = filter.unit;
    }

    const result = await this.voucherStore.query(queryFilter);
    let vouchers = result.vouchers.map((v) => this.mapFromServiceVoucher(v));

    // Apply additional filters not supported by query
    if (filter?.minFaceValue !== undefined) {
      vouchers = vouchers.filter((v) => v.face_value >= filter.minFaceValue!);
    }
    if (filter?.maxFaceValue !== undefined) {
      vouchers = vouchers.filter((v) => v.face_value <= filter.maxFaceValue!);
    }

    return vouchers;
  }

  async getVoucher(id: string): Promise<Voucher | null> {
    const voucher = await this.voucherStore.get(id);
    return voucher ? this.mapFromServiceVoucher(voucher) : null;
  }

  async saveVoucher(voucher: Voucher): Promise<void> {
    const serviceVoucher = this.mapToServiceVoucher(voucher);
    const existing = await this.voucherStore.get(voucher.voucher_id);

    if (existing) {
      await this.voucherStore.update(voucher.voucher_id, serviceVoucher);
    } else {
      await this.voucherStore.add(serviceVoucher);
    }
  }

  async removeVoucher(id: string): Promise<void> {
    await this.voucherStore.delete(id);
  }

  async updateVoucher(id: string, updates: Partial<Voucher>): Promise<void> {
    const serviceUpdates: Partial<ServiceVoucher> = {};

    if (updates.face_value !== undefined) serviceUpdates.faceValue = updates.face_value;
    if (updates.face_unit !== undefined) serviceUpdates.faceUnit = updates.face_unit;
    if (updates.face_decimals !== undefined) serviceUpdates.faceDecimals = updates.face_decimals;
    if (updates.token_amount !== undefined) serviceUpdates.tokenAmount = updates.token_amount;
    if (updates.token !== undefined) serviceUpdates.token = updates.token;
    if (updates.status !== undefined) serviceUpdates.status = updates.status;
    if (updates.memo !== undefined) serviceUpdates.memo = updates.memo;

    await this.voucherStore.update(id, serviceUpdates);
  }

  async addTransaction(transaction: TransactionInput): Promise<void> {
    if (!this.transactionStore) {
      console.warn('[VoucherServiceAdapter] No transaction store configured');
      return;
    }

    await this.transactionStore.add({
      type: transaction.type,
      direction: transaction.direction,
      faceValue: transaction.faceValue,
      faceUnit: transaction.faceUnit,
      faceDecimals: transaction.faceDecimals,
      tokenAmount: transaction.tokenAmount,
      voucherId: transaction.voucherId,
      issuerId: transaction.issuerId,
      issuerName: transaction.issuerName,
      counterparty: transaction.counterparty,
      counterpartyName: transaction.counterpartyName,
      memo: transaction.memo,
    });
  }

  /**
   * Map from service voucher format to library format
   */
  private mapFromServiceVoucher(v: ServiceVoucher): Voucher {
    return {
      voucher_id: v.id,
      token: v.token,
      face_value: v.faceValue,
      face_unit: v.faceUnit,
      face_decimals: v.faceDecimals,
      token_amount: v.tokenAmount,
      token_unit: v.tokenUnit,
      backing_strategy: v.backingStrategy as Voucher['backing_strategy'],
      issuance_ratio: v.issuanceRatio,
      issuer_id: v.issuerId,
      merchant_metadata: v.merchantMetadata
        ? {
            merchant_name: v.issuerName,
            ...v.merchantMetadata,
          }
        : v.issuerName
          ? { merchant_name: v.issuerName }
          : undefined,
      status: v.status as Voucher['status'],
      expires_at: v.expiresAt,
      created_at: v.createdAt,
      mint_url: v.mintUrl,
      memo: v.memo,
    };
  }

  /**
   * Map from library format to service voucher format
   */
  private mapToServiceVoucher(v: Voucher): ServiceVoucherInput {
    return {
      id: v.voucher_id,
      token: v.token,
      faceValue: v.face_value,
      faceUnit: v.face_unit,
      faceDecimals: v.face_decimals,
      tokenAmount: v.token_amount,
      tokenUnit: v.token_unit,
      backingStrategy: v.backing_strategy,
      issuanceRatio: v.issuance_ratio,
      issuerId: v.issuer_id,
      issuerName: v.merchant_metadata?.merchant_name as string | undefined,
      merchantMetadata: v.merchant_metadata as Record<string, unknown> | undefined,
      status: v.status,
      expiresAt: v.expires_at,
      mintUrl: v.mint_url,
      memo: v.memo,
    };
  }
}
