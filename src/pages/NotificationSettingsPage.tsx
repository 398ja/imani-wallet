import { useCallback, useEffect, useState } from 'react'
import { Bell, BellOff, Loader2, TriangleAlert } from 'lucide-react'

import { Screen, BackLink, PageHeader, Switch } from '../components/ui'
import {
  disableNotifications,
  enableNotifications,
  readStatus,
  setPreferences,
  type NotificationStatus,
} from '../lib/notifications/manager'
import type { NotificationPreferences } from '../lib/notifications/types'

/**
 * Notification settings.
 *
 * ## One switch that prompts, three that do not
 *
 * The master switch is the only control that can trigger an OS permission
 * prompt, and it only ever fires from this deliberate tap. An unsolicited
 * prompt is the fastest route to a permanent denial, and a denial cannot be
 * undone from inside the app — which is why the refusal text below tells the
 * user where in their browser or system settings to fix it, rather than just
 * reporting failure.
 *
 * The three event switches are only shown once notifications are actually on.
 * Offering them beforehand would be offering controls that change nothing:
 * they are filters on a subscription that does not exist yet.
 *
 * ## Why an unavailable transport still renders a screen
 *
 * A device that cannot do this — an iPhone in a Safari tab, a browser with no
 * push support, a server with no VAPID keys — gets the reason in words it can
 * act on ("add Imani to your Home Screen first"), not a hidden section. Hiding
 * it would leave the user unable to tell a missing feature from a broken one.
 */
export function NotificationSettingsPage({ pubkey }: { pubkey: string }) {
  const [status, setStatus] = useState<NotificationStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await readStatus(pubkey))
  }, [pubkey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggleMaster = async (next: boolean) => {
    setBusy(true)
    setError(null)
    try {
      if (next) {
        const result = await enableNotifications(pubkey)
        setStatus(result.status)
        if (!result.ok) setError(result.reason)
      } else {
        setStatus(await disableNotifications(pubkey))
      }
    } finally {
      setBusy(false)
    }
  }

  const toggleEvent = async (key: keyof NotificationPreferences, next: boolean) => {
    if (!status) return
    // Optimistic: the switch moves under the finger and reconciles after. The
    // alternative is a control that visibly lags a tap, which reads as broken
    // even when it works.
    const optimistic = { ...status.preferences, [key]: next }
    setStatus({ ...status, preferences: optimistic })
    setStatus(await setPreferences(pubkey, optimistic))
  }

  if (!status) {
    return (
      <Screen>
        <BackLink to="/settings" label="Settings" />
        <PageHeader title="Notifications" />
        <div className="flex justify-center py-12 text-mono-400">
          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">Checking notification settings</span>
        </div>
      </Screen>
    )
  }

  const { availability, permission, preferences, subscribed } = status
  const on = subscribed && preferences.enabled
  const blocked = permission === 'denied'

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader
        title="Notifications"
        subtitle="Be told when a coupon arrives, even when Imani is closed."
      />

      {!availability.usable ? (
        <p className="flex items-start gap-3 rounded-2xl border border-mono-200 p-4 text-[15px] leading-snug text-mono-500 dark:border-mono-800">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          {availability.reason}
        </p>
      ) : (
        <>
          {/* When permission is blocked the switch is disabled, because
              tapping it cannot do anything: a browser will not re-prompt once
              denied. The hint has to change with it — "Your device will ask
              for permission" over a dead control is a lie, and it is the exact
              state a headless browser and a real blocked user both land in. */}
          <Switch
            label={on ? 'Notifications are on' : 'Turn on notifications'}
            hint={
              blocked
                ? 'Blocked in your browser or system settings. Allow them for Imani there, then come back.'
                : on
                  ? 'This device will be told about the events below.'
                  : 'Your device will ask for permission.'
            }
            checked={on}
            disabled={busy || blocked}
            onChange={(next) => void toggleMaster(next)}
          />

          {error && (
            <p className="mt-3 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50/50 p-4 text-[15px] leading-snug text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
              <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          {/* Only once there is a subscription for them to filter. */}
          {on && (
            <section className="mt-8">
              <h2 className="mb-3 px-1 text-[13px] font-medium uppercase tracking-wide text-mono-500">
                Tell me about
              </h2>
              <div className="space-y-3">
                <Switch
                  label="Coupons I receive"
                  hint="Someone sends you a coupon."
                  checked={preferences.couponReceived}
                  disabled={busy}
                  onChange={(next) => void toggleEvent('couponReceived', next)}
                />
                <Switch
                  label="Coupons I sent being claimed"
                  hint="The person you sent one to redeems it."
                  checked={preferences.couponClaimed}
                  disabled={busy}
                  onChange={(next) => void toggleEvent('couponClaimed', next)}
                />
                <Switch
                  label="Coupons about to expire"
                  hint="A coupon you hold runs out soon."
                  checked={preferences.couponExpiring}
                  disabled={busy}
                  onChange={(next) => void toggleEvent('couponExpiring', next)}
                />
              </div>
            </section>
          )}

          {/* The one state in-app UI genuinely cannot recover from: the
              browser will not re-prompt once denied, so the only honest thing
              is to say where the switch actually lives. */}
          {blocked && (
            <p className="mt-6 flex items-start gap-3 text-[13px] leading-snug text-mono-500">
              <BellOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Imani is blocked from sending notifications. Allow them in your
              browser or system settings for this site, then come back.
            </p>
          )}
        </>
      )}

      {/* Nothing here is a substitute for the in-app toast: the wallet still
          announces arrivals while you are looking at it, whatever this says. */}
      <p className="mt-8 flex items-start gap-3 text-[13px] leading-snug text-mono-400">
        <Bell className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Whatever you choose here, Imani still shows arrivals while the app is
        open, and keeps them under the bell.
      </p>
    </Screen>
  )
}
