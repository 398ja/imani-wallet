/**
 * The relay half of gift delivery (#532). The gateway's `POST /api/v1/nostr/events` stores into its
 * nostrdb cache only and never forwards to strfry, so an email gift or a buyer's copy published only
 * there lived in a cache: any reader that goes to the relay never saw it. Delivered now means the
 * RELAY holds the wrap: it answered `OK true` and a REQ by id finds it there.
 *
 * nostr-tools reaches relays through a global `WebSocket`, which Node 20 does not have, so `ws` is
 * installed as its implementation (as subscription's statusNotifier does).
 */
// Both from `nostr-tools/relay`: `nostr-tools` and its subpaths are separate module instances,
// each with its own `_WebSocket` (audit-api/server.ts measured it).
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import { verifyEvent, type Event } from 'nostr-tools'
import WebSocketImpl from 'ws'

import { classifyRelayError } from '../../src/lib/relayRefusal'

useWebSocketImplementation(WebSocketImpl)

export type RelayPublishOutcome = 'ok' | 'too_large' | 'refused' | 'unreachable'

export interface RelayPort {
  /** Publish a signed event. Never throws. */
  publish(event: Event): Promise<RelayPublishOutcome>
  /** True the relay holds `id`, false it answered without it, null it could not be asked. Never throws. */
  has(id: string): Promise<boolean | null>
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))])

export function wsRelayPort(url: string, timeoutMs = 8_000): RelayPort {
  return {
    async publish(event) {
      let relay: Relay
      try {
        relay = await withTimeout(Relay.connect(url), timeoutMs, 'connect')
      } catch {
        return 'unreachable'
      }
      try {
        await withTimeout(relay.publish(event), timeoutMs, 'publish')
        return 'ok'
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const kind = classifyRelayError(reason).kind
        if (kind === 'too_large') console.error(`[gift] the relay refused a ${new TextEncoder().encode(JSON.stringify(event)).length}-byte kind ${event.kind} as too large (#532)`)
        return kind === 'too_large' ? 'too_large' : kind === 'unreachable' || /timed out/.test(reason) ? 'unreachable' : 'refused'
      } finally {
        relay.close()
      }
    },
    async has(id) {
      let relay: Relay
      try {
        relay = await withTimeout(Relay.connect(url), timeoutMs, 'connect')
      } catch {
        return null
      }
      try {
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), timeoutMs)
          const sub = relay.subscribe([{ ids: [id], limit: 1 }], {
            onevent: (e: Event) => {
              if (e.id === id && verifyEvent({ ...e })) {
                clearTimeout(timer)
                sub.close()
                resolve(true)
              }
            },
            oneose: () => {
              clearTimeout(timer)
              sub.close()
              resolve(false)
            },
          })
        })
      } catch {
        return null
      } finally {
        relay.close()
      }
    },
  }
}
