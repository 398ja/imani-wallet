/**
 * Support snapshot (#589): shared types.
 *
 * A snapshot is a point-in-time copy of what this wallet knows about its own state, with every
 * secret removed and every identifier replaced by a pseudonym ON THE DEVICE, so that neither the
 * file nor a model reading it can spend money or learn who the user is. See the issue body for
 * the full spec; the wire details are pinned in docs/support-snapshot.md.
 */
import type { TransactionRow, VoucherRow } from '@imani/wallet-storage'

/** One redacted, templated error from the ring buffer (errorRing.ts). */
export interface ErrorEntry {
  at: number
  name: string
  code?: string
  template: string
  frames: string[]
}

export interface EnvironmentFacts {
  appVersion: string
  buildRef: string
  gatewayUrl: string
  mintUrls: string[]
  relayUrls: string[]
  blossomUrl: string | null
  userAgent: string
  language: string
  standalone: boolean
  storageUsage?: number
  storageQuota?: number
}

/** Everything the builder reads. Collected by `collect.ts` in the app, seeded directly in tests. */
export interface SnapshotSources {
  selfPubkey: string
  stall: boolean
  vouchers: VoucherRow[]
  transactions: TransactionRow[]
  /** localStorage, as [key, value] pairs. */
  storage: Array<[string, string]>
  errors: ErrorEntry[]
  /** Console capture (consoleRing.ts), already reduced on the way in. Absent in older callers. */
  console?: import('./consoleRing').ConsoleEntry[]
  idbStores: string[]
  environment: EnvironmentFacts
  /**
   * The shape of each Voucher's token, computed from the token by the collector so the builder
   * never sees a proof: per-proof amounts, keyset ids, whether DLEQ proofs are present.
   * Keyed by `token_id`.
   */
  proofShapes?: Record<string, { amounts: number[]; keysets: string[]; hasDleq: boolean }>
}

export interface UnsignedEvent {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export interface SignedNostrEvent extends UnsignedEvent {
  id: string
  pubkey: string
  sig: string
}

/** Just enough of the wallet signer: a pubkey and Schnorr signing (nap's signer in the app). */
export interface SnapshotSigner {
  pubkey: string
  signEvent(template: UnsignedEvent): Promise<SignedNostrEvent>
}

export interface BuildOptions {
  ticket: string
  codeRef: string
  supportPubkey: string
  ttlSeconds: number
  includeMemos: boolean
  signer: SnapshotSigner
  /** Epoch ms. */
  now?: number
  /** 32 bytes; random per snapshot unless a test pins it. */
  kCorr?: Uint8Array
  /** 16 bytes; random per snapshot unless a test pins it. Never stored. */
  salt?: Uint8Array
  /** Zip size cap in bytes, default 20 MB. */
  maxBytes?: number
  /** Test seam: mutate the serialised data/ files just before the final scan (criterion 22). */
  afterData?: (files: Record<string, string>) => void
}

export interface Manifest {
  format: 'imani-support-snapshot'
  schema_version: 1
  app_version: string
  build_ref: string
  created_at: string
  expires_at: number
  wallet_pubkey: string
  ticket_id: string
  code_ref: string
  support_pubkey: string
  stall: boolean
  counts: { vouchers: number; transactions: number; storage_keys: number }
  files: Record<string, string>
  truncated: { since: string; rows_omitted: number } | null
  redaction: {
    ruleset_version: 1
    memos_included: boolean
    unknown_keys: Array<{ key: string; bytes: number }>
    pseudonymised: true
    pii_scrubber_version: 1
    final_scan: 'passed'
  }
}

export interface BuiltSnapshot {
  zip: Uint8Array
  manifest: Manifest
  kCorr: Uint8Array
  /** Human summary for the preview screen. */
  summary: SnapshotSummary
}

export interface SnapshotSummary {
  vouchers: number
  transactions: number
  pendingSends: number
  errors: number
  /** Console entries in the snapshot. */
  consoleEntries?: number
  terminals: number | null
  truncatedSince: string | null
}
