import { Capacitor } from '@capacitor/core'
import { SimplePool, type Event } from 'nostr-tools'

import { fleetConfig } from '../config'
import { appVersion } from '../about'
import { getSigner } from '../nap'
import { RELAY_URL } from '../relay'
import { moneyInFlight } from '../inFlightMoney'
import { collectSources } from '../snapshot/collect'
import { detectConnection } from '../snapshot/service'
import { FleetController } from './controller'
import type { Platform } from './client'
import { runFleetUpload, type BatteryInfo } from './upload'

/**
 * The fleet feature wired to the running app. Kept apart from the modules it wires so those never
 * import a store, a signer or the network, and their tests never need them.
 */

/** Screens where money moves (#591 section 7: never during a payment, send or receive). */
const MONEY_PATHS = /^\/(send|pay|sell|receive|scan|redeem|online|buy|c|g|gift-return|terminal)(\/|$)/

function platform(): Platform {
  try {
    if (Capacitor.isNativePlatform()) return Capacitor.getPlatform() === 'ios' ? 'ios' : 'android'
  } catch {
    /* not native */
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches ? 'pwa' : 'web'
}

async function battery(): Promise<BatteryInfo | null> {
  const nav = navigator as unknown as { getBattery?: () => Promise<{ charging: boolean; level: number }> }
  if (typeof nav.getBattery !== 'function') return null
  const b = await nav.getBattery()
  return { charging: !!b.charging, level: Number(b.level) }
}

/**
 * Publish the handoff wrap to the relay only. NOT `relay.publish` or `ownerPublisher`: both mirror
 * into the gateway cache with a NIP-98 header signed by the WALLET key and the session cookie,
 * which would tie this wallet to the fleet DM (#591 C1).
 */
async function relayOnly(wrap: Event): Promise<boolean> {
  const pool = new SimplePool()
  try {
    const results = await Promise.allSettled(pool.publish([RELAY_URL], wrap))
    return results.some((r) => r.status === 'fulfilled' && !(typeof r.value === 'string' && r.value.startsWith('connection failure')))
  } finally {
    pool.close([RELAY_URL])
  }
}

function moneyBusy(pubkey: string): boolean {
  if (MONEY_PATHS.test(window.location.pathname)) return true
  const m = moneyInFlight(pubkey)
  return m.sends + m.swaps + m.cashlinks + m.codes > 0
}

/**
 * The wallet key, lent only while the session signer IS this wallet. A controller cached across an
 * account switch must never derive a fleet key from another wallet's key.
 */
export function appLender(walletPubkey: string) {
  return {
    withPrivkey<T>(f: (k: Uint8Array) => T): T {
      const s = getSigner()
      if (s.pubkey !== walletPubkey) throw new Error('fleet: signer is not this wallet')
      return s.withPrivkey(f)
    },
  }
}

const controllers = new Map<string, FleetController>()

export function fleetController(pubkey: string, stall: boolean): FleetController {
  const id = `${pubkey}:${stall}`
  let c = controllers.get(id)
  if (c) return c
  const lender = appLender(pubkey)
  c = new FleetController({
    walletPubkey: pubkey,
    lender,
    config: fleetConfig,
    fetch: (...a) => fetch(...a),
    storage: localStorage,
    appVersion: appVersion(),
    platform: platform(),
    now: Date.now,
    random: Math.random,
    visible: () => document.visibilityState === 'visible',
    onVisibility: (cb) => {
      document.addEventListener('visibilitychange', cb)
      return () => document.removeEventListener('visibilitychange', cb)
    },
    setTimeout: (f, ms) => window.setTimeout(f, ms),
    clearTimeout: (t) => window.clearTimeout(t as number),
    upload: ({ signer, support }) =>
      runFleetUpload({
        walletPubkey: pubkey,
        signer,
        support,
        storage: localStorage,
        fetch: (...a) => fetch(...a),
        publish: relayOnly,
        collect: () => collectSources(pubkey, stall),
        connection: detectConnection,
        battery,
        visible: () => document.visibilityState === 'visible',
        moneyBusy: () => moneyBusy(pubkey),
        now: Date.now,
      }),
  })
  controllers.set(id, c)
  return c
}

/** Stop every running loop: logout, or the app unmounting. */
export function stopAllFleet(): void {
  for (const c of controllers.values()) c.lock()
  controllers.clear()
}
