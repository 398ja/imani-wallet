/**
 * Loading a recorded snapshot, and refusing a stale one.
 *
 * The refusal lives here rather than in each caller, so that no scenario can
 * quietly skip it. A stale snapshot is the quietest failure in the suite: it
 * does not crash, it produces plausible numbers that pass, and every
 * measurement taken against it is a confident lie.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { assertFresh, sourceHash, WATCHED } from './sources'
import type { Snapshot } from './snapshot'

export class MissingSnapshotError extends Error {
  constructor(coupons: number, dir: string) {
    super(
      `No snapshot recorded for ${coupons} coupons in ${dir}.\n` +
        'Snapshots are recordings of the real issuing flow, not invented state, ' +
        'so they have to be produced against a running stack:\n\n' +
        `  ./deploy/up.sh\n  npm run perf:record -- --coupons ${coupons}\n`,
    )
    this.name = 'MissingSnapshotError'
  }
}

/**
 * Read a snapshot, and refuse it unless the code that produced it is unchanged.
 *
 * `assertFresh` throws rather than warning. A warning printed during an
 * otherwise-passing run is read by nobody, and this is exactly the failure
 * where every number still looks reasonable.
 */
export function load(
  dir: string,
  coupons: number,
  root: string,
  watched: string[] = WATCHED,
): Snapshot {
  const file = join(dir, `coupons-${coupons}.json`)
  if (!existsSync(file)) throw new MissingSnapshotError(coupons, dir)

  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
  assertFresh(snapshot.sourceHash, sourceHash(root, watched))
  return snapshot
}

/** Which ladder rungs have been recorded, for a scenario to measure across. */
export function available(dir: string): number[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => /^coupons-(\d+)\.json$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
}
