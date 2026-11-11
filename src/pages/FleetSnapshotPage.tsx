import { useEffect, useMemo, useState } from 'react'

import { Alert, BackLink, Button, PageHeader, Panel, Screen } from '../components/ui'
import { fleetController } from '../lib/fleet/app'
import { fleetHistoryLines, type FleetController } from '../lib/fleet/controller'
import type { FleetState } from '../lib/fleet/state'

/**
 * Settings > Help > Help improve Imani (#591 section 3). Off by default. One consent screen:
 * the fleet-specific text below (not the #589 ticket text). Turning it off deregisters and forgets at once.
 */
export const FLEET_CONSENT_TEXT =
  'Help improve Imani by sharing an anonymised health check now and then. Your wallet may be picked at random, at most twice a month. It then sends, on Wi-Fi only, a snapshot of your vouchers\u2019 amounts and dates, your transaction history, your settings, recent errors and the app\u2019s recent technical log (and, for a stall, your takings and terminals). It never contains your key, your vouchers themselves, gift links, coupon codes, your email, your messages or your memos. Nobody can spend your money with it. It is encrypted so only Imani support can open it, and it is deleted from the upload server within 7 days (sooner once support collects it). Imani\u2019s support assistant (an AI) reads it, and a support person may too. Before the AI sees anything, every name, address, key and id in it is replaced by a placeholder on your phone, so the AI services Imani uses (Anthropic, and possibly OpenAI) never see who you are. Support keeps it for 14 days, then deletes it. Health checks are sent under a separate key made only for this, so they do not carry your wallet\u2019s identity. Each one appears in your snapshot history. You can turn this off at any time, and the server then forgets this device.'

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
