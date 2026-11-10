import { strFromU8, unzipSync } from 'fflate'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { verifyEvent, type Event } from 'nostr-tools'

import type { Manifest } from './types'

/**
 * Check a decrypted snapshot the way support does (#589 section 6, steps 2 and 4), so the wallet
 * can assert its own output before sharing it and tests can prove tampering is caught.
 */
export const ALLOWED_PATHS = new Set([
  'envelope/manifest.json',
  'envelope/manifest.sig.json',
  'envelope/correlation.json',
  'envelope/operator_only/memos.json',
  'data/environment.json',
  'data/vouchers.json',
  'data/transactions.json',
  'data/storage.json',
  'data/derived.json',
  'data/errors.json',
  'data/console.json',
  'README.txt',
])

export type VerifyResult = { ok: true; manifest: Manifest } | { ok: false; reason: string }

export function verifyArchive(zip: Uint8Array): VerifyResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zip)
  } catch {
    return { ok: false, reason: 'not_a_zip' }
  }
  for (const p of Object.keys(files)) if (!ALLOWED_PATHS.has(p)) return { ok: false, reason: 'unexpected_path' }
  const m = files['envelope/manifest.json']
  const s = files['envelope/manifest.sig.json']
  if (!m || !s) return { ok: false, reason: 'missing_envelope' }
  let manifest: Manifest
  let sig: Event
  try {
    manifest = JSON.parse(strFromU8(m)) as Manifest
    sig = JSON.parse(strFromU8(s)) as Event
  } catch {
    return { ok: false, reason: 'unparseable_envelope' }
  }
  if (!verifyEvent(sig)) return { ok: false, reason: 'bad_signature' }
  if (sig.pubkey !== manifest.wallet_pubkey) return { ok: false, reason: 'wrong_signer' }
  if (sig.content !== bytesToHex(sha256(m))) return { ok: false, reason: 'manifest_hash' }
  const tag = (n: string) => sig.tags.find((t) => t[0] === n)?.[1]
  if (tag('ticket') !== manifest.ticket_id || tag('code') !== manifest.code_ref) return { ok: false, reason: 'tag_mismatch' }
  for (const p of Object.keys(files)) {
    if (p === 'envelope/manifest.json' || p === 'envelope/manifest.sig.json') continue
    if (manifest.files[p] !== bytesToHex(sha256(files[p]))) return { ok: false, reason: 'file_hash' }
  }
  for (const p of Object.keys(manifest.files)) if (!files[p]) return { ok: false, reason: 'missing_file' }
  // A fleet snapshot (#591 C5): its round is its ticket, and it carries no memos and no K values.
  if (manifest.reason !== undefined) {
    if (manifest.reason !== 'fleet' || typeof manifest.round !== 'string' || manifest.round !== manifest.ticket_id) return { ok: false, reason: 'fleet_round' }
    if (files['envelope/operator_only/memos.json'] || manifest.redaction?.memos_included !== false) return { ok: false, reason: 'fleet_memos' }
    let corr: unknown
    try {
      corr = JSON.parse(strFromU8(files['envelope/correlation.json'] ?? new Uint8Array()))
    } catch {
      return { ok: false, reason: 'fleet_correlation' }
    }
    const entries = (corr as { entries?: unknown } | null)?.entries
    if (!entries || typeof entries !== 'object' || Object.keys(entries).length > 0) return { ok: false, reason: 'fleet_correlation' }
  } else if (manifest.round !== undefined) return { ok: false, reason: 'fleet_round' }
  return { ok: true, manifest }
}
