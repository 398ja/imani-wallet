// Stopping a run whose data is already invalid.
//
// Two different things can invalidate a run, and confusing them wastes a lot
// of time:
//
//   A subsystem failed        -> the deployment is unwell. The run found
//                                something, and it should stop before burying
//                                that moment under its consequences.
//
//   The load generator saturated -> this machine ran out of capacity before
//                                the gateway did. Nothing was learned about
//                                the deployment, and the numbers describe the
//                                laptop. Not a gateway failure.
//
// The second is the one people misread as a capacity finding. A laptop's limit
// quoted as a gateway's limit is the same error as quoting a local number as
// production capacity, and it is easy to make because the graphs look alike.

import http from 'k6/http'
import exec from 'k6/execution'

const WATCHER_URL = __ENV.ABORT_WATCHER_URL || ''

/**
 * Ask the watcher whether a subsystem has failed.
 *
 * k6 has no filesystem access, so the sentinel is read over HTTP rather than
 * from disk. When no watcher is configured this is a no-op, so a run without
 * one behaves exactly as before rather than failing to start.
 */
export function subsystemFailed() {
  if (!WATCHER_URL) return null
  const res = http.get(WATCHER_URL, { timeout: '2s', tags: { name: 'abort-watch' } })
  if (res.status !== 200) return null
  try {
    const report = JSON.parse(res.body)
    return report.breaches && report.breaches.length > 0 ? report : null
  } catch {
    return null
  }
}

/**
 * Whether this machine, rather than the gateway, is the constraint.
 *
 * Judged on the load generator's own dropped iterations and on how far behind
 * schedule it is running: k6 reports both, and either one means the numbers
 * describe the client.
 */
export function generatorSaturated(thresholds = {}) {
  const { maxDroppedIterations = 100 } = thresholds
  const dropped = exec.instance.iterationsInterrupted || 0
  return dropped > maxDroppedIterations
}

/**
 * Stop the run, saying which kind of invalid it is.
 *
 * Aborting rather than failing a threshold, because a threshold breach still
 * runs to completion and keeps gathering data that is already worthless.
 */
export function abortIfInvalid() {
  const failure = subsystemFailed()
  if (failure) {
    const names = failure.breaches.map((b) => `${b.name} (${b.confidence})`).join(', ')
    exec.test.abort(
      `SUBSYSTEM FAILED: ${names}. The deployment is unwell; this run's data ` +
        'ends here rather than recording the consequences.',
    )
  }

  if (generatorSaturated()) {
    exec.test.abort(
      'LOAD GENERATOR SATURATED: this machine ran out of capacity before the ' +
        'gateway did, so the run measured the client. INVALID, and not a ' +
        'gateway capacity finding.',
    )
  }
}
