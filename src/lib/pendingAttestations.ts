import { createAccountStore } from './accountStore'

/**
 * Customer attestations that arrived before the sale row they belong to.
 *
 * A cash sale's `issued:<voucher>` row is written on this device at the moment of sale, so
 * the receipt that carries the customer's attestation always finds it. A CARD sale's row is
 * not: the purchase issuer mints the coupon and sends the stall a sealed sale record, which
 * the stall files whenever it next reads its inbox. The customer redeems within seconds, so
 * their receipt routinely reaches the stall's drain first. `recordCashAttestation` found no
 * row, returned quietly, and the drain acknowledged the receipt anyway: the attestation was
 * gone from the gateway queue and from this device, and the sale read "Not collected"
 * forever.
 *
 * So an attestation with no row yet is kept here and tried again once sale rows are filed
 * (and on every drain pass). Kept per account, bounded, and aged out after RETAIN_MS: a sale
 * record that has not arrived in that time is not coming to this device.
 */
export interface PendingAttestation {
  voucherId: string
  attestation: string
  /** Epoch ms first stashed. */
  at: number
}

export type FileOutcome = 'filed' | 'no-row' | 'refused' | 'error'

export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000

const store = createAccountStore<PendingAttestation>({
  name: 'pending-attestations',
  limit: 200,
  // Keyed on the pair, not the voucher alone: anyone who learns a voucher id can post a receipt
  // with a junk attestation, and a first-wins slot per voucher would let that junk evict the
  // customer's genuine one before either could be checked against the row.
  idOf: (p) => p.voucherId + '\n' + p.attestation,
  ageOf: (p) => p.at,
  isValid: (p): p is PendingAttestation =>
    !!p &&
    typeof p === 'object' &&
    typeof (p as PendingAttestation).voucherId === 'string' &&
    typeof (p as PendingAttestation).attestation === 'string' &&
    typeof (p as PendingAttestation).at === 'number',
})

/** Keep an attestation whose sale row has not been filed yet. A redelivery keeps its first time. */
export function stashAttestation(pubkey: string, voucherId: string, attestation: string, now = Date.now()): void {
  if (store.get(pubkey, voucherId + '\n' + attestation)) return
  store.put(pubkey, { voucherId, attestation, at: now })
}

export function pendingAttestations(pubkey: string): PendingAttestation[] {
  return store.list(pubkey)
}

/** Forget one kept attestation: it filed, or got a definite refusal. */
export function settleAttestation(pubkey: string, voucherId: string, attestation: string): void {
  store.remove(pubkey, voucherId + '\n' + attestation)
}

/**
 * Try every kept attestation again. Drops the ones that filed, were refused (a definite
 * answer that a retry will not change) or aged out; keeps the rest. Never throws.
 *
 * @returns how many filed
 */
export async function retryPendingAttestations(
  pubkey: string,
  file: (voucherId: string, attestation: string) => Promise<FileOutcome>,
  now = Date.now(),
): Promise<number> {
  let filed = 0
  for (const pending of store.list(pubkey)) {
    if (now - pending.at > RETAIN_MS) {
      store.remove(pubkey, pending.voucherId + '\n' + pending.attestation)
      continue
    }
    let outcome: FileOutcome
    try {
      outcome = await file(pending.voucherId, pending.attestation)
    } catch {
      outcome = 'error'
    }
    if (outcome === 'filed') filed += 1
    if (outcome === 'filed' || outcome === 'refused') store.remove(pubkey, pending.voucherId + '\n' + pending.attestation)
  }
  return filed
}
