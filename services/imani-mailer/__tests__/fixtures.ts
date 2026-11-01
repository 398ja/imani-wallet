/**
 * Shared test fixtures for imani-mailer. Not a test file itself.
 */
import { createHash } from 'node:crypto'

import { loadConfig, type ClientConfig, type MailerConfig } from '../config.ts'
import type { OutgoingMessage, Transport } from '../transport.ts'

export const ISSUER_TOKEN = 'issuer-token-0123456789abcdefghijklmnop'
export const OPS_TOKEN = 'ops-token-0123456789abcdefghijklmnopqrstu'
export const RECEIPTS_TOKEN = 'receipts-token-0123456789abcdefghijklmno'

export const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export const CLIENTS = [
  { id: 'purchase-issuer', tokenSha256: sha(ISSUER_TOKEN), templates: ['gift-claim', 'gift-receipt', 'gift-return-link'], perMinute: 1000 },
  { id: 'receipts', tokenSha256: sha(RECEIPTS_TOKEN), templates: ['gift-receipt'], perMinute: 1000 },
  { id: 'ops', tokenSha256: sha(OPS_TOKEN), templates: [], bounce: true },
]

/** A development config that passes loadConfig; override any variable. */
export function devEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MAILER_ENV: 'development',
    MAILER_TRANSPORT: 'log',
    MAILER_FROM_ADDRESS: 'gifts@imani.test',
    MAILER_FROM_NAME: 'Imani',
    MAILER_LINK_HOSTS: 'imani.test,wallet.imani.test',
    MAILER_CLIENTS: JSON.stringify(CLIENTS),
    MAILER_TAG_KEY: 'ab'.repeat(32),
    ...overrides,
  }
}

export function devConfig(overrides: Record<string, string | undefined> = {}): MailerConfig {
  return loadConfig(devEnv(overrides), () => {
    throw new Error('no files in this test')
  })
}

export const client = (config: MailerConfig, id: string): ClientConfig => {
  const c = config.clients.find((k) => k.id === id)
  if (!c) throw new Error(`no client ${id}`)
  return c
}

export interface MemoryTransport extends Transport {
  sent: OutgoingMessage[]
  failNext(error: Error): void
}

export function memoryTransport(): MemoryTransport {
  const sent: OutgoingMessage[] = []
  let pending: Error | null = null
  return {
    kind: 'memory',
    sent,
    failNext(e) {
      pending = e
    },
    async send(m) {
      if (pending) {
        const e = pending
        pending = null
        throw e
      }
      sent.push(m)
      return { accepted: true, response: '250 ok' }
    },
    async verify() {
      return true
    },
    close() {},
  }
}

export const CLAIM_SECRET = 'cd'.repeat(32)
export const claimFields = {
  from: 'Alice',
  stall: 'Card Test Bakery',
  amount: '£5.00',
  claimBy: '27 Nov 2026',
  claimUrl: `https://wallet.imani.test/claim#${CLAIM_SECRET}`,
  message: 'Happy birthday!',
}
