import { useEffect, useMemo, useState } from 'react'

import { Alert, BackLink, Button, PageHeader, Panel, Screen } from '../components/ui'
import { fleetController } from '../lib/fleet/app'
import { fleetHistoryLines, type FleetController } from '../lib/fleet/controller'
import type { FleetState } from '../lib/fleet/state'
import { CONSENT_TEXT } from './SupportSnapshotPage'

/**
 * Settings > Help > Help improve Imani (#591 section 3). Off by default. One consent screen:
 * the fleet text below plus the #589 consent text. Turning it off deregisters and forgets at once.
 */
export const FLEET_CONSENT_TEXT =
  'Help improve Imani: share an anonymised snapshot now and then. Your wallet may be picked at random a few times a month. It then sends a snapshot like the one described below, on Wi-Fi only. You can turn this off at any time, and you will see each time it happens. Health check snapshots never include memos, and they are sent under a separate key made for this alone, so they are not linked to your wallet.'

type Controller = Pick<FleetController, 'available' | 'status' | 'optIn' | 'optOut'>

export function FleetSnapshotView({ controller }: { controller: Controller }) {
  const [available, setAvailable] = useState<boolean | undefined>(undefined)
  const [state, setState] = useState<{ optedIn: boolean; state: FleetState }>(() => controller.status())
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    controller.available().then((a) => live && setAvailable(a), () => live && setAvailable(false))
    return () => {
      live = false
    }
  }, [controller])

  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch {
      setError('That did not work. Try again in a moment.')
    } finally {
      setBusy(false)
      setState(controller.status())
    }
  }

  if (available === undefined) return <Screen><BackLink to="/settings" label="Settings" /><p className="text-mono-500">Loading…</p></Screen>
  if (!available) {
    return (
      <Screen>
        <BackLink to="/settings" label="Settings" />
        <PageHeader title="Help improve Imani" />
        <Panel><p data-testid="fleet-unavailable">This is not available on this service.</p></Panel>
      </Screen>
    )
  }

  const lines = fleetHistoryLines(state.state)
  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Help improve Imani" />
      {error && <Alert>{error}</Alert>}

      {!asking && (
        <Panel>
          <p className="text-sm" data-testid="fleet-status">
            {state.optedIn ? 'Sharing anonymised health checks is on.' : 'Sharing anonymised health checks is off.'}
          </p>
          <Button
            className="mt-3 w-full"
            variant={state.optedIn ? 'secondary' : 'primary'}
            data-testid="fleet-toggle"
            disabled={busy}
            onClick={() => (state.optedIn ? run(() => controller.optOut()) : setAsking(true))}
          >
            {state.optedIn ? 'Turn off' : 'Turn on'}
          </Button>
        </Panel>
      )}

      {asking && (
        <Panel>
          <div data-testid="fleet-consent" className="space-y-3 text-sm">
            <p>{FLEET_CONSENT_TEXT}</p>
            <p>{CONSENT_TEXT}</p>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" data-testid="fleet-cancel" onClick={() => setAsking(false)}>Not now</Button>
            <Button
              data-testid="fleet-agree"
              disabled={busy}
              onClick={() => run(async () => {
                await controller.optIn()
                setAsking(false)
              })}
            >
              Turn on
            </Button>
          </div>
        </Panel>
      )}

      {lines.length > 0 && (
        <Panel className="mt-4">
          <p className="mb-2 font-medium">Snapshot history</p>
          <ul className="text-sm" data-testid="fleet-history">
            {lines.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </Panel>
      )}
    </Screen>
  )
}

export function FleetSnapshotPage({ pubkey, stall }: { pubkey: string; stall: boolean }) {
  const controller = useMemo(() => fleetController(pubkey, stall), [pubkey, stall])
  return <FleetSnapshotView controller={controller} />
}
