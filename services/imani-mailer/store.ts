/**
 * What must survive a restart: which idempotency keys were already sent, and which recipients are
 * suppressed after a hard bounce or complaint.
 *
 * Neither holds an address. Suppressions are keyed by the keyed HMAC of the address (config
 * `tagKey`), and idempotency entries by the caller's key plus a fingerprint of the request, so a
 * stolen state file names no one.
 *
 * One JSON file, written atomically (temp file, fsync, rename) with mode 0600. Small by design:
 * idempotency entries expire after MAILER_IDEMPOTENCY_TTL_HOURS. A deployment that outgrows a file
 * swaps this module for a database behind the same interface.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SentRecord {
  fingerprint: string
  messageId: string
  at: number
}

export interface Suppression {
  reason: 'hard-bounce' | 'complaint' | 'manual'
  at: number
}

export interface Store {
  getSent(key: string): SentRecord | undefined
  putSent(key: string, record: SentRecord): void
  getSuppression(tag: string): Suppression | undefined
  suppress(tag: string, s: Suppression): void
  unsuppress(tag: string): boolean
  /** Drop idempotency entries older than the TTL. */
  prune(now: number): void
  counts(): { sent: number; suppressed: number }
}

interface Shape {
  version: 1
  sent: Record<string, SentRecord>
  suppressed: Record<string, Suppression>
}

export function createStore(opts: { file: string | null; ttlMs: number }): Store {
  let data: Shape = { version: 1, sent: {}, suppressed: {} }
  if (opts.file) {
    try {
      const parsed = JSON.parse(readFileSync(opts.file, 'utf8')) as Shape
      if (parsed?.version !== 1 || typeof parsed.sent !== 'object' || typeof parsed.suppressed !== 'object') {
        throw new Error('unrecognised state file')
      }
      data = parsed
    } catch (e) {
      // Missing is a first boot. Anything else (corrupt, unreadable) refuses: starting empty would
      // forget every suppression and resend every recent email.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`MAILER_STATE_FILE ${opts.file} cannot be used: ${(e as Error).message}`)
      }
    }
  }
  const persist = () => {
    if (!opts.file) return
    mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 })
    const tmp = `${opts.file}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(data))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, opts.file)
  }
  return {
    getSent: (key) => (Object.hasOwn(data.sent, key) ? data.sent[key] : undefined),
    putSent(key, record) {
      data.sent[key] = record
      persist()
    },
    getSuppression: (tag) => (Object.hasOwn(data.suppressed, tag) ? data.suppressed[tag] : undefined),
    suppress(tag, s) {
      data.suppressed[tag] = s
      persist()
    },
    unsuppress(tag) {
      if (!Object.hasOwn(data.suppressed, tag)) return false
      delete data.suppressed[tag]
      persist()
      return true
    },
    prune(now) {
      let changed = false
      for (const [k, v] of Object.entries(data.sent)) {
        if (now - v.at > opts.ttlMs) {
          delete data.sent[k]
          changed = true
        }
      }
      if (changed) persist()
    },
    counts: () => ({ sent: Object.keys(data.sent).length, suppressed: Object.keys(data.suppressed).length }),
  }
}
