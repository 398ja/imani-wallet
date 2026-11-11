import { bytesToHex } from '@noble/hashes/utils'

import type { FleetConfig, SupportSnapshotConfig } from '../config'
import { deregister, heartbeat, register, type FleetHttp, type Platform, type Timing } from './client'
import { canLendKey, fleetSigner, type FleetSigner, type KeyLender } from './key'
import { FleetScheduler } from './scheduler'
import { THIRTY_DAYS_MS, readFleet, updateFleet, writeFleet, type FleetState, type FleetUploadState } from './state'
import type { UploadOutcome } from './upload'

/**
 * The fleet controller (#591 contract C6): opt-in, opt-out, the heartbeat loop and held requests.
 *
 * Nothing here sends anything unless ALL of: the gateway config has `fleet_enabled: true` and a
 * support npub, this wallet holds a current opt-in record, and the wallet is unlocked (the fleet
 * key is derived from the wallet key on each use). Without them, zero fleet requests (criterion 1).
 *
 * The only exception is a pending deregister: after an opt-out whose DELETE failed, the old nonce
 * is kept for exactly one purpose, retrying that DELETE on the next unlock.
 */

/** Bump when the consent text changes: an opt-in under an older version is not used (re-asked). */
export const CONSENT_VERSION = 1

export interface ControllerDeps {
  walletPubkey: string
  lender: KeyLender
  config: () => Promise<FleetConfig>
  fetch: typeof fetch
  storage: Storage
  appVersion: string
  platform: Platform
  now: () => number
  random: () => number
  visible: () => boolean
  onVisibility: (cb: () => void) => () => void
  setTimeout: (f: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
  /** Try the held request (upload.ts `runFleetUpload` in the app). Never throws. */
  upload: (ctx: { signer: FleetSigner; support: SupportSnapshotConfig }) => Promise<UploadOutcome>
  randomBytes?: (n: number) => Uint8Array
}

export class FleetController {
  private readonly scheduler: FleetScheduler
  private support: SupportSnapshotConfig | null = null

  constructor(private readonly deps: ControllerDeps) {
    this.scheduler = new FleetScheduler({
      beat: () => this.beat(),
      random: deps.random,
      visible: deps.visible,
      onVisibility: deps.onVisibility,
      now: deps.now,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout,
    })
  }

  private state(): FleetState {
    return readFleet(this.deps.walletPubkey, this.deps.storage)
  }

  private current(s = this.state()) {
    return s.optIn && s.optIn.consent_version === CONSENT_VERSION ? s.optIn : null
  }

  /** Whether to offer the feature at all: fleet on, and a signer that can lend its key. */
  async available(): Promise<boolean> {
    const c = await this.deps.config().catch(() => ({ enabled: false, support: null }) as FleetConfig)
    return c.enabled && c.support !== null && canLendKey(this.deps.lender)
  }

  status(): { optedIn: boolean; state: FleetState } {
    const s = this.state()
    return { optedIn: this.current(s) !== null, state: s }
  }

  /** On unlock: finish a pending deregister, then run the loop if opted in. */
  async unlock(): Promise<void> {
    // FLEET_FORGET_AFTER: past 30 days the server has dropped the row; the old nonce has no use left.
    const st = this.state()
    if (st.deregisterNonce && (st.optedOutAt === undefined || this.deps.now() - st.optedOutAt > THIRTY_DAYS_MS)) {
      writeFleet(this.deps.walletPubkey, { ...st, deregisterNonce: null, optedOutAt: undefined }, this.deps.storage)
    }
    const c = await this.deps.config().catch(() => ({ enabled: false, support: null }) as FleetConfig)
    if (!c.enabled || !c.support) return
    this.support = c.support
    const pending = this.state().deregisterNonce
    if (pending) {
      const ok = await this.deregisterWith(pending)
      if (ok) updateFleet(this.deps.walletPubkey, (s) => ({ ...s, deregisterNonce: s.deregisterNonce === pending ? null : s.deregisterNonce, optedOutAt: s.deregisterNonce === pending ? undefined : s.optedOutAt }), this.deps.storage)
    }
    if (!this.current()) return
    this.scheduler.start()
    this.scheduler.poke()
    await this.scheduler.idle()
  }

  /** Lock, logout, or leaving the wallet: stop everything. */
  lock(): void {
    this.scheduler.stop()
  }

  private setRegistered(v: boolean): void {
    updateFleet(this.deps.walletPubkey, (s) => ({ ...s, registered: v && s.optIn !== null }), this.deps.storage)
  }

  /** Turn it on, after the consent screen. Registers once, then heartbeats. */
  async optIn(): Promise<void> {
    const c = await this.deps.config()
    if (!c.enabled || !c.support) throw new Error('Fleet snapshots are not available on this service.')
    if (!canLendKey(this.deps.lender)) throw new Error('This signer cannot take part.')
    this.support = c.support
    const nonce = bytesToHex((this.deps.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32))
    // Derive once now, so an invalid scalar (vanishingly rare) aborts before anything is stored.
    fleetSigner(this.deps.lender, nonce)
    updateFleet(this.deps.walletPubkey, (s) => ({ ...s, optIn: { consent_version: CONSENT_VERSION, install_nonce: nonce, opted_in_at: this.deps.now() }, held: null, registered: false }), this.deps.storage)
    this.scheduler.stop()
    this.scheduler.start()
    await this.scheduler.idle()
  }

  /**
   * Turn it off. Local fleet state is deleted at once (nonce, held request, history). The DELETE is
   * sent with the old key; if it fails, the old nonce alone is kept to retry it on the next unlock.
   */
  async optOut(): Promise<void> {
    this.scheduler.stop()
    const nonce = this.state().optIn?.install_nonce ?? this.state().deregisterNonce
    writeFleet(this.deps.walletPubkey, { optIn: null, held: null, uploads: [], deregisterNonce: nonce ?? null, optedOutAt: nonce ? this.deps.now() : undefined }, this.deps.storage)
    // A beat already in flight could register AFTER our DELETE and bring the row back: let it end.
    await this.scheduler.idle().catch(() => undefined)
    if (!nonce) return
    const ok = await this.deregisterWith(nonce)
    if (ok) updateFleet(this.deps.walletPubkey, (s) => ({ ...s, deregisterNonce: s.deregisterNonce === nonce ? null : s.deregisterNonce, optedOutAt: s.deregisterNonce === nonce ? undefined : s.optedOutAt }), this.deps.storage)
  }

  private async deregisterWith(nonce: string): Promise<boolean> {
    try {
      return await deregister({ fetch: this.deps.fetch, signer: fleetSigner(this.deps.lender, nonce), now: this.deps.now })
    } catch {
      return false
    }
  }

  private async beat(): Promise<Timing> {
    const optIn = this.current()
    if (!optIn || !this.support) {
      this.scheduler.stop()
      throw new Error('not opted in')
    }
    const signer = fleetSigner(this.deps.lender, optIn.install_nonce)
    const http: FleetHttp = { fetch: this.deps.fetch, signer, now: this.deps.now }
    const still = () => {
      if (this.current()?.install_nonce !== optIn.install_nonce) throw new Error('opted out')
    }
    const reg = async () => {
      still()
      return register(http, { consent_version: optIn.consent_version, app_version: this.deps.appVersion, platform: this.deps.platform })
    }
    const hb = async () => {
      still()
      return heartbeat(http, { app_version: this.deps.appVersion, platform: this.deps.platform })
    }
    if (!this.state().registered) {
      await reg()
      this.setRegistered(true)
    }
    let r = await hb()
    if (r.kind === 'gone') {
      // 410: the server forgot us while we are still opted in. One re-register, never a loop.
      this.setRegistered(false)
      await reg()
      this.setRegistered(true)
      r = await hb()
      if (r.kind === 'gone') {
        this.setRegistered(false)
        throw new Error('unknown client')
      }
    }
    // The user may have opted out while the beat was in flight: write nothing back then.
    if (this.current()?.install_nonce !== optIn.install_nonce) return r
    const { request, lastUpload } = r
    const s = updateFleet(this.deps.walletPubkey, (st) => {
      let next = st
      if (lastUpload) {
        next = { ...next, uploads: next.uploads.map((u) => (u.round === lastUpload.round && (u.state === 'sent' || u.state === 'received') ? { ...u, state: lastUpload.state as FleetUploadState } : u)) }
      }
      if (request && !next.uploads.some((u) => u.round === request.round) && next.held?.round !== request.round) {
        next = { ...next, held: request }
      }
      return next
    }, this.deps.storage)
    if (s.held) void this.deps.upload({ signer, support: this.support }).catch(() => undefined)
    return r
  }
}

const LABEL: Record<FleetUploadState, string> = {
  sent: 'sent',
  received: 'received',
  deleted: 'deleted from server',
  not_sent: 'not sent',
}

/** Snapshot history lines for fleet uploads (criterion 12). */
export function fleetHistoryLines(s: FleetState, locale?: string, timeZone?: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', ...(timeZone ? { timeZone } : {}) })
  return s.uploads.map((u) => `Health check on ${fmt.format(new Date(u.at))}: ${LABEL[u.state]}`)
}
