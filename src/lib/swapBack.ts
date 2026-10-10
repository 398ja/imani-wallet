import type { VoucherRow } from '@imani/wallet-storage'

import type { MintTransport, ReceiveResult } from './receiveSwap'

/** "Swap back to sats" (cashu-mint#540). Red: API surface only. */

export const SWAPPED_TO_SATS_STATUS = 'swapped_to_sats'

export interface SwapBackResult {
  token: string
  sats: number
}

export class SwapBackNotPossible extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SwapBackNotPossible'
  }
}

export async function swapBackToSats(_row: VoucherRow, _pubkey: string, _transport?: MintTransport): Promise<SwapBackResult> {
  throw new Error('not implemented')
}

export async function saveRecoveredSwapBack(_swap: ReceiveResult): Promise<boolean> {
  return false
}
