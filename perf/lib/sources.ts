/**
 * Knowing when a recording has gone stale.
 *
 * A snapshot is only honest while the code that produced it is unchanged. Once
 * the writing path moves, a restored snapshot describes a shape the wallet no
 * longer produces, and every measurement taken against it is a confident lie.
 *
 * This is the quietest failure in the whole suite: a stale snapshot does not
 * crash, it produces plausible numbers that pass. So staleness is detected
 * mechanically rather than remembered.
 *
 * Deliberately a hash over sources, not the IndexedDB schema version. A
 * version bump only catches a change in the *shape* of the store. A change to
 * *what gets written* into an unchanged schema is exactly the drift that makes
 * a measurement lie, and a version check sails straight past it.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

/**
 * The code whose output a snapshot records.
 *
 * Each entry earns its place by being able to change what ends up in storage:
 *
 * - `wallet-storage` defines the stores and writes to them.
 * - `nostr-vouchers` owns the shared database the wallet's stores live beside.
 * - `issue.ts` is the path that turns an issuing into stored coupons.
 * - `voucherRecords.ts` and `txRecords.ts` write the records a wallet holds.
 * - `wallet.ts` opens the database and decides its name and version.
 *
 * Add to this list when something new starts writing wallet state. Leaving it
 * out does not fail loudly; it fails silently, which is the whole problem.
 */
export const WATCHED = [
  'packages/wallet-storage/src',
  'packages/nostr-vouchers/src',
  'src/lib/issue.ts',
  'src/lib/voucherRecords.ts',
  'src/lib/txRecords.ts',
  'src/lib/wallet.ts',
]

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

function filesUnder(path: string): string[] {
  const stats = statSync(path, { throwIfNoEntry: false })
  if (!stats) return []
  if (stats.isFile()) return SOURCE_EXTENSIONS.has(extname(path)) ? [path] : []

  const found: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    // Tests do not write wallet state, so a change to one does not invalidate
    // a recording. Including them would invalidate snapshots constantly and
    // train people to regenerate without thinking, which defeats the purpose.
    if (entry.name === '__tests__' || entry.name === 'tests') continue
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    found.push(...filesUnder(child))
  }
  return found
}

/**
 * Fingerprint the code that decides what a wallet stores.
 *
 * Content-based rather than timestamp-based: a checkout or a rebuild changes
 * timestamps without changing behaviour, and a snapshot invalidated by noise
 * is one people learn to regenerate reflexively.
 */
export function sourceHash(root: string, watched: string[] = WATCHED): string {
  const hash = createHash('sha256')
  const files = watched
    .flatMap((w) => filesUnder(join(root, w)))
    .sort()

  if (files.length === 0) {
    throw new Error(
      'the watched source list matched no files, so a snapshot could never go stale. ' +
        'Check WATCHED against the current layout before trusting any measurement.',
    )
  }

  for (const file of files) {
    // Path as well as content: moving a file changes what the wallet writes
    // often enough that a pure content hash would miss real drift.
    hash.update(file.slice(root.length))
    hash.update(readFileSync(file))
  }
  return hash.digest('hex').slice(0, 16)
}

export class StaleSnapshotError extends Error {
  constructor(recorded: string, actual: string) {
    super(
      `This snapshot was recorded from different code (${recorded}, now ${actual}).\n` +
        'Something that decides what the wallet stores has changed since it was ' +
        'recorded, so restoring it would measure a shape the wallet no longer ' +
        'produces. Re-record it with:\n\n  npm run perf:record\n',
    )
    this.name = 'StaleSnapshotError'
  }
}

/**
 * Refuse a snapshot whose sources have moved.
 *
 * Throwing rather than warning is the point. A warning in a passing run is
 * read by nobody, and the failure this guards against is one where every
 * number still looks reasonable.
 */
export function assertFresh(recorded: string, actual: string): void {
  if (recorded !== actual) throw new StaleSnapshotError(recorded, actual)
}
