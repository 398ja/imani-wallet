import { decodeSignedField, encodeSignedField } from './receipt'
import { bytesToHex } from './bytes'
import { fieldHex, fieldUtf8, fieldVarint, readTlv, TlvWriter } from './tlv'
import type { EvidenceLocator, SignedReceipt } from './receipt'
import { makeLocator } from './receipt'

/**
 * Port of Java `StoredReceiptCodec` (R_* / G_* tags), so a backup written by either
 * implementation restores in the other. The output holds the evidence and its key: only ever
 * write it encrypted to the owner, never log it (FR-009, FR-048).
 */

export type ReceiptRole = 'PAYER' | 'PAYEE'

export interface StoredReceipt {
  role: ReceiptRole
  receipt: SignedReceipt
  /** Canonical evidence bytes (`encodeEvidence`). */
  evidence: Uint8Array
  /** 32-byte AES key, one per receipt. */
  evidenceKey: Uint8Array
  locator: EvidenceLocator | null
  refunds: SignedReceipt[]
  notes: string[]
  /** False for an unlocked payment not yet countersigned (FR-008). */
  showable: boolean
}

const R_VERSION = 1, R_ROLE = 2, R_SIGNED = 3, R_EVIDENCE = 4, R_EVIDENCE_KEY = 5
const R_LOCATOR_ID = 6, R_LOCATOR_RELAY = 7, R_REFUND = 8, R_NOTE = 9, R_SHOWABLE = 10

export function encodeStoredReceipt(r: StoredReceipt): Uint8Array {
  const w = new TlvWriter()
    .varint(R_VERSION, 1)
    .utf8(R_ROLE, r.role)
    .bytes(R_SIGNED, encodeSignedField(r.receipt))
    .bytes(R_EVIDENCE, r.evidence)
    .bytes(R_EVIDENCE_KEY, r.evidenceKey)
  if (r.locator) w.hex(R_LOCATOR_ID, r.locator.eventId).utf8(R_LOCATOR_RELAY, r.locator.relayHint)
  for (const refund of r.refunds) w.bytes(R_REFUND, encodeSignedField(refund))
  for (const note of r.notes) w.utf8(R_NOTE, note)
  return w.varint(R_SHOWABLE, r.showable ? 1 : 0).toBytes()
}

export function decodeStoredReceipt(bytes: Uint8Array): StoredReceipt {
  let role: ReceiptRole | null = null
  let receipt: SignedReceipt | null = null
  let evidence: Uint8Array | null = null
  let key: Uint8Array | null = null
  let locId: string | null = null
  let locRelay: string | null = null
  const refunds: SignedReceipt[] = []
  const notes: string[] = []
  let showable = false
  for (const f of readTlv(bytes)) {
    switch (f.tag) {
      case R_ROLE: {
        const v = fieldUtf8(f)
        if (v !== 'PAYER' && v !== 'PAYEE') throw new Error('unknown receipt role')
        role = v
        break
      }
      case R_SIGNED: receipt = decodeSignedField(f.value); break
      case R_EVIDENCE: evidence = f.value; break
      case R_EVIDENCE_KEY: key = f.value; break
      case R_LOCATOR_ID: locId = fieldHex(f); break
      case R_LOCATOR_RELAY: locRelay = fieldUtf8(f); break
      case R_REFUND: refunds.push(decodeSignedField(f.value)); break
      case R_NOTE: notes.push(fieldUtf8(f)); break
      case R_SHOWABLE: showable = fieldVarint(f) !== 0; break
      default: break
    }
  }
  if (!role || !receipt || !evidence || !key) throw new Error('stored receipt is missing a required field')
  if (key.length !== 32) throw new Error('evidence key must be 32 bytes')
  return {
    role, receipt, evidence, evidenceKey: key,
    locator: locId == null ? null : makeLocator(locId, locRelay),
    refunds, notes, showable,
  }
}

/** Hex helper re-exported for callers that key by digest. */
export const storedReceiptHex = (r: StoredReceipt): string => bytesToHex(encodeStoredReceipt(r))
