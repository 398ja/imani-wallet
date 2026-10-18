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
import { beforeEach, describe, expect, it } from 'vitest'

import { FileCredentialStore } from '../adapters'
import { CredentialConfirmer, confirmAll } from '../confirmation'
import { discharge, type Ports } from '../discharge'
import { renderMetrics, resetMetricsForTest } from '../metrics'
import { CredentialVault } from '../vault'
import { nip98Refusal } from '../../../src/lib/__tests__/nip98ServerCheck'
import { delegatedCredential, STALL } from './stallFixture'

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
