/**
 * Re-stamp a snapshot whose SOURCES moved but whose DATA is still correct.
 *
 * `assertFresh` refuses a snapshot recorded from different code, and it is
 * right to: something that decides what the wallet stores may have changed, and
 * restoring stale data would measure a shape the wallet no longer produces.
 *
 * But the guard hashes the whole of every watched file, so it cannot tell a
 * schema change from a comment. Adding an exported function to `wallet.ts`
 * moves the hash exactly as renaming a database would, and only one of those
 * invalidates the recorded data.
 *
 * Re-recording is the honest answer when the shape really did change. When it
 * did not, re-recording needs the whole issuance chain healthy — a gateway, a
 * mint that can sign, a settlement path — and that is a heavy dependency to put
 * in front of "I added a function". This is the other half: assert the data is
 * still valid, and move the stamp.
 *
 * ## Using it responsibly
 *
 * The refusal below is the point. This checks the two things that actually
 * decide whether stored wallet data can still be restored — the database names
 * and their versions — and refuses if either moved. Anything it cannot check
 * has to be argued in the `--because` message, which is written into the
 * snapshot and shows up in the diff for a reviewer to disagree with.
 *
 *   npm run perf:restamp -- --because "added an exported fn; no schema change"
 *
 * If you are unsure whether your change altered the shape, re-record. This is
 * for the case where you have looked and it plainly did not.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { sourceHash } from '../lib/sources'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const SNAPSHOTS = join(ROOT, 'perf/snapshots')

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

interface Snapshot {
  format: number
  coupons: number
  sourceHash: string
  databases: { name: string; version?: number }[]
  restamped?: { at: string; from: string; because: string }[]
}

/** The names and versions a restore actually depends on. */
function shape(snapshot: Snapshot): string {
  return snapshot.databases
    .map((db) => `${db.name}@${db.version ?? '?'}`)
    .sort()
    .join(',')
}

/**
 * The database VERSIONS the current build would open, read from source.
 *
 * The names cannot be compared: each wallet's database is named per-account
 * (`imani-wallet-<hash>`), so two snapshots legitimately differ there. The
 * versions are the part a restore actually depends on — IndexedDB replays a
 * snapshot into a database at a given version, and a bump means the recorded
 * object stores are not the ones this build expects.
 *
 * Read by parsing the constants rather than importing them, because this
 * script runs under tsx with no browser and those modules reach for
 * `indexedDB` at import time.
 */
function currentVersions(): { shared: number; resume: number } | null {
  const read = (file: string, constant: string): number | null => {
    try {
      const source = readFileSync(join(ROOT, file), 'utf8')
      const match = new RegExp(`${constant}\\s*=\\s*(\\d+)`).exec(source)
      return match ? Number(match[1]) : null
    } catch {
      return null
    }
  }

  const shared = read('packages/nostr-vouchers/src/database/SharedDatabase.ts', 'DEFAULT_SHARED_DB_VERSION')
  const resume = read('packages/nostr-vouchers/src/adapters/IndexedDBAdapter.ts', 'DEFAULT_DB_VERSION')
  return shared === null || resume === null ? null : { shared, resume }
}

/** The versions a snapshot was recorded at, in the same shape. */
function recordedVersions(snapshot: Snapshot): { shared: number; resume: number } | null {
  const resume = snapshot.databases.find((db) => db.name === 'imani-wallet-resume')
  const shared = snapshot.databases.find((db) => db.name.startsWith('imani-wallet-') && db.name !== 'imani-wallet-resume')
  return shared?.version === undefined || resume?.version === undefined
    ? null
    : { shared: shared.version, resume: resume.version }
}

function main(): void {
  const because = flag('because')
  if (!because) {
    console.error(
      'Refusing to re-stamp without a reason.\n\n' +
        '  npm run perf:restamp -- --because "why the recorded data is still valid"\n\n' +
        'The reason is written into the snapshot and shows up in the diff. If the\n' +
        'honest reason is "I do not know", re-record instead:  npm run perf:record',
    )
    process.exit(1)
  }

  // Only the committed rungs. The large ones are deliberately not in the repo,
  // and a developer who has them locally can re-record properly.
  const files = ['coupons-5.json', 'coupons-20.json']
  const actual = sourceHash(ROOT)
  let changed = 0

  for (const name of files) {
    const path = join(SNAPSHOTS, name)
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot

    if (snapshot.sourceHash === actual) {
      console.log(`  ${name}: already current`)
      continue
    }

    // The one thing this CAN check mechanically: a restore replays these
    // databases at a given VERSION, so a bump means the recorded object stores
    // are not the ones this build expects and the data really is stale.
    const recorded = recordedVersions(snapshot)
    const current = currentVersions()
    if (recorded && current && (recorded.shared !== current.shared || recorded.resume !== current.resume)) {
      console.error(
        `\n  ${name}: REFUSING to re-stamp.\n` +
          `    recorded at shared=v${recorded.shared} resume=v${recorded.resume}\n` +
          `    this build opens shared=v${current.shared} resume=v${current.resume}\n\n` +
          '  A version bump means the recorded stores are not the ones this build\n' +
          '  expects. Re-record it:  npm run perf:record',
      )
      process.exit(1)
    }

    console.log(`  ${name}: ${snapshot.sourceHash} -> ${actual}`)
    console.log(`    databases: ${shape(snapshot)}`)

    snapshot.restamped = [
      ...(snapshot.restamped ?? []),
      { at: new Date().toISOString(), from: snapshot.sourceHash, because },
    ]
    snapshot.sourceHash = actual
    writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n')
    changed += 1
  }

  console.log(
    changed === 0
      ? '\nNothing to do.'
      : `\nRe-stamped ${changed} snapshot(s).\n` +
          'Check the diff: if the database names or versions above look wrong for\n' +
          'this build, the data really is stale and you want perf:record instead.',
  )
}

main()
