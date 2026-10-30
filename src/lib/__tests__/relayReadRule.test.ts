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
      readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => !/^\s*(\/\/|\*)/.test(line) && READ.test(line)),
    )
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([])
  })
})
