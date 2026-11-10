import { HEX64_RE, isIdLike } from './ids'
import { CONSOLE_MESSAGES } from './enums'

/**
 * Console capture for the support snapshot (#589, owner decision 2026-11-10: on by default).
 *
 * The wallet logs a lot that helps support (`[pay] ...`, `[dmPoll] ...`), but logged VALUES carry
 * voucher ids, keys, amounts and raw errors. So nothing raw is ever kept, in memory or on disk: each
 * entry is reduced on the way in, the same way errorRing.ts reduces errors.
 *
 * - message: kept only if it is a message the code itself writes, read from the source at build
 *   time (`__SNAPSHOT_CONSOLE__`, vite.config.ts). A string literal must match exactly; a template
 *   literal matches with each `${...}` as one value, and those values are replaced with `<n>` or
 *   `<value>`. Anything else is `<message>`.
 * - tag: the `[pay]` prefix, kept only when that tag appears in a message the code writes.
 * - args: typed placeholders. Numbers and booleans are kept; anything shaped like an identifier
 *   (64-hex, bech32, `as_…`, `v_…`, `pi_…`, UUIDs) is kept as `{ t: 'id', ref }` where `ref` is the
 *   value ITSELF only in memory, so the builder can turn it into a pseudonym; it is never persisted
 *   raw (localStorage holds `{ t: 'id' }` only). Errors keep their class name. Everything else is
 *   its type.
 */

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'
const LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug']

export type ConsoleArg =
  | { t: 'number'; v: number }
  | { t: 'boolean'; v: boolean }
  | { t: 'null' }
  | { t: 'undefined' }
  | { t: 'error'; name: string }
  | { t: 'id'; ref?: string }
  | { t: 'string' }
  | { t: 'object' }
  | { t: 'array'; n: number }
  | { t: 'other' }

export interface ConsoleEntry {
  at: number
  level: ConsoleLevel
  tag: string
  message: string
  args: ConsoleArg[]
}

const KEY = 'imani-wallet:console-ring'
const MAX = 500
const MAX_AGE_MS = 24 * 3600_000
const MAX_ARGS = 8

const known = CONSOLE_MESSAGES
const LITERALS = new Set(known.literals)
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Each template as a regex; `${...}` matches one value. Kept with the template for rewriting. */
const TEMPLATES = known.templates.map((t) => {
  const parts = t.split(/\$\{[^}]*\}/)
  return { re: new RegExp('^' + parts.map(escape).join('(.{0,200}?)') + '$', 's'), parts }
})
const TAGS = new Set(
  [...known.literals, ...known.templates].map((m) => /^\[([a-zA-Z0-9_-]{1,40})\]/.exec(m)?.[1]).filter((t): t is string => !!t),
)

/** The message as the code wrote it, with filled-in values as placeholders; '<message>' otherwise. */
export function knownMessage(text: string): string {
  if (LITERALS.has(text)) return text
  for (const { re, parts } of TEMPLATES) {
    const m = re.exec(text)
    if (!m) continue
    return parts.reduce((out, part, i) => out + part + (i < parts.length - 1 ? (/^-?\d+(\.\d+)?$/.test(m[i + 1]) ? '<n>' : '<value>') : ''), '')
  }
  return '<message>'
}

function tagOf(text: unknown): string {
  if (typeof text !== 'string') return 'untagged'
  const t = /^\[([a-zA-Z0-9_-]{1,40})\]/.exec(text)?.[1]
  if (!t) return 'untagged'
  return TAGS.has(t) ? t : 'other'
}

function argOf(v: unknown): ConsoleArg {
  if (v === null) return { t: 'null' }
  if (v === undefined) return { t: 'undefined' }
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) < 1e10 ? { t: 'number', v } : { t: 'other' }
  if (typeof v === 'boolean') return { t: 'boolean', v }
  if (v instanceof Error) return { t: 'error', name: /^[A-Za-z]{1,40}$/.test(v.name) ? v.name : 'Error' }
  if (typeof v === 'string') return isIdLike(v) ? { t: 'id', ref: HEX64_RE.test(v) ? v.toLowerCase() : v } : { t: 'string' }
  if (Array.isArray(v)) return { t: 'array', n: v.length }
  if (typeof v === 'object') return { t: 'object' }
  return { t: 'other' }
}

/** Reduce one console call. The first argument is the message when it is a string. */
export function reduceConsole(level: ConsoleLevel, args: unknown[], at: number): ConsoleEntry {
  const [first, ...rest] = args
  const message = typeof first === 'string' ? knownMessage(first) : '<message>'
  const values = typeof first === 'string' ? rest : args
  return { at, level, tag: tagOf(first), message, args: values.slice(0, MAX_ARGS).map(argOf) }
}

let ring: ConsoleEntry[] | null = null

function load(): ConsoleEntry[] {
  if (ring) return ring
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]')
    ring = Array.isArray(v) ? (v as ConsoleEntry[]).slice(-MAX) : []
  } catch {
    ring = []
  }
  return ring
}

/** What is written to disk: id refs dropped, so a raw id never touches localStorage. */
const persisted = (e: ConsoleEntry): ConsoleEntry => ({ ...e, args: e.args.map((a) => (a.t === 'id' ? { t: 'id' } : a)) })

let saveTimer: ReturnType<typeof setTimeout> | null = null
function save(): void {
  if (saveTimer) return
  // Coalesced: a burst of logs is one write, not one per call.
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(load().map(persisted)))
    } catch {
      /* quota: the in-memory ring still has it */
    }
  }, 0)
}

function prune(r: ConsoleEntry[], now: number): void {
  const cutoff = now - MAX_AGE_MS
  let drop = 0
  while (drop < r.length && r[drop].at < cutoff) drop++
  if (r.length - drop > MAX) drop = r.length - MAX
  if (drop > 0) r.splice(0, drop)
}

export function recordConsole(level: ConsoleLevel, args: unknown[], at = Date.now()): void {
  try {
    const r = load()
    r.push(reduceConsole(level, args, at))
    prune(r, Math.max(at, Date.now()))
    save()
    if (typeof process !== 'undefined' && process.env?.VITEST) flushConsole()
  } catch {
    /* capture must never break logging */
  }
}

/** Write the ring now (tests, and before a snapshot is built). */
export function flushConsole(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(load().map(persisted)))
  } catch {
    /* quota */
  }
}

/** Entries from the last 24 hours, newest last. In-memory entries keep id refs for pseudonyms. */
export function recentConsole(now = Date.now()): ConsoleEntry[] {
  const r = load()
  prune(r, now)
  return r.map((e) => ({ ...e, args: [...e.args] }))
}

export function clearConsole(): void {
  ring = []
  try {
    globalThis.localStorage?.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}

let installed: { target: Console; originals: Partial<Record<ConsoleLevel, (...a: unknown[]) => void>> } | null = null

/**
 * Wrap the console so each call is also recorded (reduced). The original is always called first and
 * with the original arguments, so what a developer sees in devtools does not change.
 */
export function installConsoleRing(target: Console = console): void {
  if (installed) return
  const originals: Partial<Record<ConsoleLevel, (...a: unknown[]) => void>> = {}
  for (const level of LEVELS) {
    const original = target[level] as (...a: unknown[]) => void
    if (typeof original !== 'function') continue
    originals[level] = original
    ;(target as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
      original.apply(target, args)
      recordConsole(level, args)
    }
  }
  installed = { target, originals }
}

export function uninstallConsoleRing(): void {
  if (!installed) return
  for (const [level, fn] of Object.entries(installed.originals)) {
    ;(installed.target as unknown as Record<string, unknown>)[level] = fn
  }
  installed = null
}
