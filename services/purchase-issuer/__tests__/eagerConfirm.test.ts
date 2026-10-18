/**
 * @vitest-environment node
 *
 * Eager, race-safe confirmation of the stall credentials this service holds (imani-wallet#296).
 *
 * gateway-customer keeps a minted terminal credential confirmable for 24 h only. This service used
 * to confirm lazily, at the first card sale, so a stall enrolled more than a day before its first
 * sale got 410 EXPIRED, then 403 on the mint, and the paid purchase was BLOCKED as "burnt".
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileCredentialStore } from '../adapters'
import {
  CONFIRM_CONCURRENCY,
  CredentialConfirmer,
  confirmAll,
  RECONFIRM_INTERVAL_MS,
  RECONFIRM_MAX_ROUNDS,
  retryUnconfirmed,
} from '../confirmation'
import { discharge, type Ports } from '../discharge'
import { renderMetrics, resetMetricsForTest } from '../metrics'
import { CredentialVault, type CredentialStore } from '../vault'
import { nip98Refusal } from '../../../src/lib/__tests__/nip98ServerCheck'
import { delegatedCredential, STALL, ninetyDayTerm } from './stallFixture'

const GATEWAY = 'http://gateway:8082'
const KEY = 'a'.repeat(64)

interface Sent {
  url: string
  authorization: string
  body: string
}

function gateway(status: number | (() => Promise<number>)) {
  const sent: Sent[] = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    sent.push({
      url,
      authorization: headers.get('Authorization') ?? '',
      body: typeof init.body === 'string' ? init.body : '',
    })
    const code = typeof status === 'number' ? status : await status()
    return new Response(code === 204 ? null : '{}', { status: code })
  }) as unknown as typeof fetch
  return { sent, fetchImpl }
}

function eventId(authorization: string): string {
  return (JSON.parse(atob(authorization.slice('Nostr '.length))) as { id: string }).id
}

/** As `vaultWith`, in memory: no file I/O, so fake timers alone drive a retry round. */
async function memoryVaultWith(...credentialIds: string[]): Promise<CredentialVault> {
  let records: Parameters<CredentialStore['write']>[0] = []
  const store: CredentialStore = {
    read: async () => records,
    write: async (next) => {
      records = next
    },
  }
  const vault = new CredentialVault(KEY, store)
  for (const [i, id] of credentialIds.entries()) {
    await vault.put({ ...delegatedCredential({ credentialId: id }), stallPubkey: String(i).repeat(64) })
  }
  return vault
}

async function vaultWith(...credentialIds: string[]): Promise<CredentialVault> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-confirm-'))
  const vault = new CredentialVault(KEY, new FileCredentialStore(join(dir, 'c.json')))
  for (const [i, id] of credentialIds.entries()) {
    await vault.put({ ...delegatedCredential({ credentialId: id }), stallPubkey: String(i).repeat(64) })
  }
  return vault
}

beforeEach(() => resetMetricsForTest())

describe('confirmation at startup', () => {
  // A credential enrolled but never confirmed is confirmed when the service starts, before any sale.
  it('confirms every vault record that is not yet confirmed', async () => {
    const vault = await vaultWith('cred-a', 'cred-b')
    const { sent, fetchImpl } = gateway(204)
    const confirmer = new CredentialConfirmer(GATEWAY, fetchImpl)

    const summary = await confirmAll(vault, confirmer)

    expect(summary).toEqual({ confirmed: 2, expired: 0, unconfirmed: 0 })
    expect(sent.map((s) => s.url).sort()).toEqual([
      `${GATEWAY}/api/v1/wallet/terminal-credentials/cred-a/confirm`,
      `${GATEWAY}/api/v1/wallet/terminal-credentials/cred-b/confirm`,
    ])
    for (const s of sent) expect(nip98Refusal({ ...s, method: 'POST' })).toBeNull()
    expect(renderMetrics()).toContain('imani_purchase_issuer_credentials{standing="confirmed"} 2')
    // Already confirmed: a sale does not confirm again.
    expect(await confirmer.confirm(delegatedCredential({ credentialId: 'cred-a' }))).toBe('confirmed')
    expect(sent).toHaveLength(2)
  })
})

describe('an expired credential', () => {
  // 410 EXPIRED is reported as needing re-enrolment, exported as a metric, and a sale for that stall
  // stays owed with that reason instead of being BLOCKED as "burnt or replaced".
  it('gets a clear reason and a metric, and its sale is not blocked as burnt', async () => {
    const vault = await vaultWith('cred-x')
    const { sent, fetchImpl } = gateway(410)
    const confirmer = new CredentialConfirmer(GATEWAY, fetchImpl)

    const summary = await confirmAll(vault, confirmer)
    expect(summary).toEqual({ confirmed: 0, expired: 1, unconfirmed: 0 })
    expect(renderMetrics()).toContain('imani_purchase_issuer_credentials{standing="expired"} 1')

    const credential = delegatedCredential({ credentialId: 'cred-x' })
    const ports: Ports = {
      validityFor: ninetyDayTerm,
      credentialFor: async () => confirmer.annotate(credential),
      tokenFor: async () => {
        throw new Error('must not mint')
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    }
    const outcome = await discharge(
      GATEWAY,
      {
        id: 'evt_1',
        paymentRequestId: 'pr_1',
        stallPubkey: STALL,
        faceValue: 625,
        faceUnit: 'GBP',
        faceDecimals: 2,
        memo: 'card',
        recipient: { kind: 'pubkey', pubkey: 'f'.repeat(64) },
        attempts: 0,
        processorReference: 'pi_1',
      },
      ports,
    )

    expect(outcome.kind).toBe('owed')
    const reason = (outcome as { reason: string }).reason
    expect(reason).toMatch(/re-enrol/)
    expect(reason).not.toMatch(/burnt/)
    // Fails fast: no second confirm, no mint.
    expect(sent).toHaveLength(1)
  })
})

describe('concurrent confirms', () => {
  // Two sales reading one credential at once send ONE confirm, and a later retry signs a fresh
  // event, so the gateway never sees a replayed NIP-98 event id.
  it('produce one request, and a retry never replays the event', async () => {
    let answer = 500
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { sent, fetchImpl } = gateway(async () => {
      await gate
      return answer
    })
    const confirmer = new CredentialConfirmer(GATEWAY, fetchImpl)
    const credential = delegatedCredential({ credentialId: 'cred-r' })

    const both = Promise.all([confirmer.confirm(credential), confirmer.confirm(credential)])
    release()
    expect(await both).toEqual(['unconfirmed', 'unconfirmed'])
    expect(sent).toHaveLength(1)

    // Retried in the same second: a new event id, so not a replay.
    answer = 204
    expect(await confirmer.confirm(credential)).toBe('confirmed')
    expect(sent).toHaveLength(2)
    expect(eventId(sent[1].authorization)).not.toBe(eventId(sent[0].authorization))
    expect(nip98Refusal({ ...sent[1], method: 'POST' })).toBeNull()
  })
})

describe('review of #299', () => {
  // Hundreds of stalls at startup: never more than CONFIRM_CONCURRENCY confirms at once, and all
  // of them are confirmed.
  it('bounds startup confirms in flight', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `cred-${i}`)
    const vault = await vaultWith(...ids)
    let live = 0
    let peak = 0
    const { sent, fetchImpl } = gateway(async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 1))
      live -= 1
      return 204
    })
    const summary = await confirmAll(vault, new CredentialConfirmer(GATEWAY, fetchImpl))
    expect(summary).toEqual({ confirmed: 40, expired: 0, unconfirmed: 0 })
    expect(sent).toHaveLength(40)
    expect(peak).toBeLessThanOrEqual(CONFIRM_CONCURRENCY)
  })

  // A gateway that is down at startup leaves records unconfirmed and does not throw, so the
  // service still starts and serves every other stall.
  it('survives a gateway that is down at startup', async () => {
    const vault = await vaultWith('cred-a')
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const summary = await confirmAll(vault, new CredentialConfirmer(GATEWAY, fetchImpl))
    expect(summary).toEqual({ confirmed: 0, expired: 0, unconfirmed: 1 })
  })

  // A confirm is bounded in time, so a gateway that never answers cannot hold the first pass.
  it('sends every confirm with an abort signal', async () => {
    let signal: AbortSignal | null | undefined
    const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
      signal = init.signal
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    await new CredentialConfirmer(GATEWAY, fetchImpl).confirm(delegatedCredential())
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  // A stall that re-enrols after its credential expired: the gauge counts the stall's current
  // credential, so `expired` goes back to 0 instead of staying up until a restart.
  it('stops counting a replaced expired credential', async () => {
    let status = 410
    const { fetchImpl } = gateway(async () => status)
    const confirmer = new CredentialConfirmer(GATEWAY, fetchImpl)
    expect(await confirmer.confirm(delegatedCredential({ credentialId: 'old' }))).toBe('expired')
    expect(renderMetrics()).toContain('imani_purchase_issuer_credentials{standing="expired"} 1')
    status = 204
    expect(await confirmer.confirm(delegatedCredential({ credentialId: 'new' }))).toBe('confirmed')
    expect(renderMetrics()).toContain('imani_purchase_issuer_credentials{standing="expired"} 0')
    expect(renderMetrics()).toContain('imani_purchase_issuer_credentials{standing="confirmed"} 1')
  })
})

describe('retry of credentials left unconfirmed at startup (review of #299)', () => {
  afterEach(() => vi.useRealTimers())

  // gc down at boot, back later: confirmed on a later round, then the timer is gone.
  it('confirms once the gateway is back, then stops', async () => {
    vi.useFakeTimers()
    const vault = await memoryVaultWith('cred-a')
    let status = 503
    const { sent, fetchImpl } = gateway(async () => status)
    const confirmer = new CredentialConfirmer(GATEWAY, fetchImpl)
    expect(await confirmAll(vault, confirmer)).toEqual({ confirmed: 0, expired: 0, unconfirmed: 1 })
    retryUnconfirmed(vault, confirmer, () => true, 1000, 10)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(2)
    status = 204
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(3)
    expect(renderMetrics()).toContain('imani_purchase_issuer_credentials{standing="confirmed"} 1')
    expect(vi.getTimerCount()).toBe(0)
  })

  // A pre-V27 legacy credential answers 404 for ever. It is asked at most maxRounds times, not
  // every 5 minutes for the life of the process.
  it('gives up after maxRounds on a credential that can never confirm', async () => {
    vi.useFakeTimers()
    const vault = await memoryVaultWith('legacy')
    const { sent, fetchImpl } = gateway(404)
    const confirmer = new CredentialConfirmer(GATEWAY, fetchImpl)
    await confirmAll(vault, confirmer)
    retryUnconfirmed(vault, confirmer, () => true, 1000, 3)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sent).toHaveLength(1 + 3)
    expect(vi.getTimerCount()).toBe(0)
  })

  // The real bound: one day of 5-minute rounds, the gateway's whole confirm window.
  it('is bounded by the 24 h confirm window by default', () => {
    expect(RECONFIRM_MAX_ROUNDS * RECONFIRM_INTERVAL_MS).toBe(24 * 60 * 60_000)
  })

  // Shutdown (SIGTERM sets running=false) ends it on the next tick, with no request sent.
  it('stops on shutdown and leaves no timer', async () => {
    vi.useFakeTimers()
    const vault = await memoryVaultWith('cred-a')
    const { sent, fetchImpl } = gateway(503)
    const confirmer = new CredentialConfirmer(GATEWAY, fetchImpl)
    await confirmAll(vault, confirmer)
    let running = true
    retryUnconfirmed(vault, confirmer, () => running, 1000, 100)
    running = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)

    const stop = retryUnconfirmed(vault, confirmer, () => true, 1000, 100)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
