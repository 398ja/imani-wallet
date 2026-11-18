import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Owner rule (2026-10-30, #428): the wallet never READS from the relay directly. Every read goes
 * through the gateway's nostrdb-backed `POST /api/v1/nostr/query`. Publishing to the relay is fine.
 *
 * A read over a socket is `querySync`, `subscribeMany`/`subscribe` on a pool, or a raw
 * `new WebSocket`. None may appear in app source (tests excluded).
 */
const ROOT = join(__dirname, '..', '..')
const READ = /\.(querySync|subscribeMany|subscribeManyEose)\s*\(|new\s+WebSocket\s*\(/

/**
 * Kept relay reads, each because correctness depends on it. terminalDeliveryNet.giftWraps: the
 * gateway answers wraps with one capped page, and a wrap past that page was hidden (#402).
 * relay.relayHasEvent: a read of ONE id after a publish, the only proof the relay holds it; the
 * gateway's cache keeps events strfry refused (#532).
 */
const ALLOWED = new Set(['lib/terminalDeliveryNet.ts', 'lib/relay.ts'])

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...sources(path))
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

describe('the relay is never read directly (owner rule, #428)', () => {
  it('no app source reads the relay over a socket', () => {
    const offenders = sources(ROOT).filter((file) =>
      !ALLOWED.has(file.slice(ROOT.length + 1)) &&
      readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => !/^\s*(\/\/|\*)/.test(line) && READ.test(line)),
    )
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([])
  })
})
