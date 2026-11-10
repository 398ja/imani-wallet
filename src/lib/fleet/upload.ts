import type { Event } from 'nostr-tools'

import type { SupportSnapshotConfig } from '../config'
import { buildSnapshot } from '../snapshot/build'
import { encryptSnapshot } from '../snapshot/crypto'
import {
  COMPLETE_PATH, handoffBody, snapshotFileName, uploadSnapshot, validateSnapshotCode,
  type ConnectionInfo, type SignedPost,
} from '../snapshot/service'
import type { SnapshotSources } from '../snapshot/types'
import { verifyArchive } from '../snapshot/verify'
import { nip98Header } from '../nip98'
import { MAX_FLEET_BYTES } from './client'
import type { FleetSigner } from './key'
import { FLEET_CLIENT_MAX_PER_30D, readFleet, recordUpload, updateFleet, uploadsIn30d, type FleetUploadState, type HeldRequest } from './state'

/**
 * Whether and how a held fleet request is uploaded (#591 contract C6, criteria 6 to 8).
 *
 * The pipeline is #589's, step for step, with the FLEET key as the only identity (C1): validate
 * (NIP-98 by the fleet key), build with the fleet profile, verify our own output, encrypt, upload
 * (Blossom auth by the fleet key), the NIP-17 handoff sealed by the fleet key, then complete.
 * Every request goes with `credentials: 'omit'`. Failures are never shown: they are history lines
 * reading "not sent".
 */

export interface BatteryInfo {
  charging: boolean
  level: number
}

export interface UploadConditions {
  connection: ConnectionInfo
  /** null when the Battery API is absent: treated as OK. */
  battery: BatteryInfo | null
  visible: boolean
  /** A send, pay, sell, receive or scan screen is open, or money is in flight. */
  moneyBusy: boolean
  uploadsIn30d: number
}

export type Decision = 'go' | 'hold' | 'refuse'

export function decideUpload(c: UploadConditions): Decision {
  if (c.uploadsIn30d >= FLEET_CLIENT_MAX_PER_30D) return 'refuse'
  // Wi-Fi or ethernet with Data Saver off. `unknown` or `cellular` holds.
  if (c.connection.kind !== 'wifi' || c.connection.saveData) return 'hold'
  if (c.battery && !c.battery.charging && !(c.battery.level >= 0.2)) return 'hold'
  if (!c.visible || c.moneyBusy) return 'hold'
  return 'go'
}

export interface UploadEnv {
  walletPubkey: string
  signer: FleetSigner
  support: SupportSnapshotConfig
  storage: Storage
  fetch: typeof fetch
  /** Publish a gift wrap without any wallet identity (no session NIP-98, no cookie). */
  publish: (wrap: Event) => Promise<boolean>
  collect: () => Promise<SnapshotSources>
  connection: () => Promise<ConnectionInfo>
  battery: () => Promise<BatteryInfo | null>
  visible: () => boolean
  moneyBusy: () => boolean
  now: () => number
}

export type UploadOutcome = 'none' | 'held' | 'expired' | 'refused' | 'sent' | 'not_sent'

/** Every fleet fetch, whatever the caller passes: no cookies, no referrer. */
export function omitCredentials(f: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init: RequestInit = {}) => f(input, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' })) as typeof fetch
}

/** The #589 `post` seam, NIP-98 signed by the fleet key instead of the session signer. */
export function fleetPost(signer: FleetSigner, doFetch: typeof fetch): SignedPost {
  return async (path, payload) => {
    const body = JSON.stringify(payload)
    return doFetch(path, {
      method: 'POST',
      headers: { Authorization: await nip98Header(path, 'POST', body, signer), 'Content-Type': 'application/json' },
      body,
      credentials: 'omit',
    })
  }
}

let running: Promise<UploadOutcome> | null = null

/** Try the held request once. Never throws. One run at a time. */
export function runFleetUpload(env: UploadEnv): Promise<UploadOutcome> {
  if (running) return running
  running = attempt(env).catch(() => 'not_sent' as const).finally(() => {
    running = null
  })
  return running
}

function finish(env: UploadEnv, req: HeldRequest, state: FleetUploadState, counted: boolean): void {
  updateFleet(env.walletPubkey, (s) => recordUpload({ ...s, held: null }, { round: req.round, at: env.now(), state, counted }), env.storage)
}

async function attempt(env: UploadEnv): Promise<UploadOutcome> {
  const st = readFleet(env.walletPubkey, env.storage)
  const req = st.held
  if (!req || !st.optIn) return 'none'
  const nowMs = env.now()
  if (req.expiresAt * 1000 <= nowMs) {
    finish(env, req, 'not_sent', false)
    return 'expired'
  }
  if (uploadsIn30d(st, nowMs) >= FLEET_CLIENT_MAX_PER_30D) {
    // Whatever the server asks (criterion 8): dropped without a single request.
    updateFleet(env.walletPubkey, (s) => ({ ...s, held: null }), env.storage)
    return 'refused'
  }
  const [connection, battery] = await Promise.all([env.connection().catch(() => ({ kind: 'unknown', saveData: false }) as ConnectionInfo), env.battery().catch(() => null)])
  const d = decideUpload({ connection, battery, visible: env.visible(), moneyBusy: env.moneyBusy(), uploadsIn30d: uploadsIn30d(st, nowMs) })
  if (d === 'refuse') return 'refused'
  if (d === 'hold') return 'held'

  const doFetch = omitCredentials(env.fetch)
  const post = fleetPost(env.signer, doFetch)
  let uploaded = false
  try {
    const code = await validateSnapshotCode(req.code, post)
    // A fleet code's ticket is its round (C5). Anything else is not the request we hold.
    if (code.ticket !== req.round) throw new Error('round mismatch')
    const maxBytes = Math.min(req.maxBytes, code.maxBytes, MAX_FLEET_BYTES)
    if (!env.visible() || env.moneyBusy()) {
      // The user started paying while we validated: leave the request held, try later.
      return 'held'
    }
    const sources = await env.collect()
    const built = await buildSnapshot(sources, {
      ticket: req.round,
      codeRef: code.codeRef,
      supportPubkey: env.support.supportPubkey,
      ttlSeconds: env.support.ttlSeconds,
      includeMemos: false,
      signer: env.signer,
      now: env.now(),
      maxBytes,
      fleet: { round: req.round, historyDays: req.historyDays },
    })
    const check = verifyArchive(built.zip)
    if (!check.ok || check.manifest.reason !== 'fleet' || check.manifest.wallet_pubkey !== env.signer.pubkey) throw new Error('self check')
    const sealed = await encryptSnapshot(built.zip)
    if (sealed.ciphertext.length > maxBytes) throw new Error('too large')
    if (code.grantExpiresAt * 1000 < env.now()) throw new Error('grant expired')
    const { url } = await uploadSnapshot(env.support.blossomUrl, sealed, code.grant, env.signer, doFetch, env.now())
    uploaded = true
    const body = await handoffBody({
      ticket: req.round,
      codeRef: code.codeRef,
      url,
      sealed,
      fileName: snapshotFileName(req.round, env.signer.pubkey, env.now()),
      kCorr: built.kCorr,
      signer: env.signer,
      expiresAt: built.manifest.expires_at,
      now: env.now(),
    })
    const sent = await env.publish(env.signer.wrap(env.support.supportPubkey, JSON.stringify(body)))
    if (!sent) throw new Error('dm')
    await post(COMPLETE_PATH, { upload_grant: code.grant, sha256: sealed.sha256 }).catch(() => undefined)
    finish(env, req, 'sent', true)
    return 'sent'
  } catch {
    // Silent (C6). Anything that reached the upload server counts against the 30-day cap.
    finish(env, req, 'not_sent', uploaded)
    return 'not_sent'
  }
}
