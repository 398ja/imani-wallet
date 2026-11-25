import { useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Bell, HeartPulse } from 'lucide-react'

import { FLEET_CONSENT_TEXT } from '../pages/FleetSnapshotPage'
import {
  appFirstRunPorts,
  firstRunAnswer,
  onFirstRunAnswered,
  recordFirstRunAnswer,
  type FirstRunPorts,
  type FirstRunQuestion,
} from '../lib/firstRunPrompts'

/**
 * The two first-run questions, asked once each the way "Confirm payments you receive?" is (spec 049
 * FR-017): "Turn on notifications?" and "Help improve Imani?". Either answer is kept and applied to
 * the setting, so the owner is not asked again on the next visit, and Settings keeps it changeable.
 *
 * Home only, one card at a time (notifications first), in the flow of the page and never a dialog:
 * nothing waits on the answer. A question is skipped, never asked, when it could change nothing:
 * notifications already on, blocked or unavailable on this device; health checks already on or not
 * offered by this service. "Turn on" is the deliberate tap the OS permission prompt needs.
 */
export function FirstRunPrompts({ pubkey, stall, ports }: { pubkey: string; stall: boolean; ports?: FirstRunPorts }) {
  const { pathname } = useLocation()
  const [io] = useState(() => ports ?? appFirstRunPorts(pubkey, stall))
  const [question, setQuestion] = useState<FirstRunQuestion | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ question: FirstRunQuestion; message: string } | null>(null)

  useEffect(() => {
    let live = true
    const pick = async () => {
      if (firstRunAnswer('notifications', pubkey) === null && (await io.notificationsAskable().catch(() => false))) return 'notifications' as const
      if (firstRunAnswer('health', pubkey) === null && (await io.healthAskable().catch(() => false))) return 'health' as const
      return null
    }
    const load = () => void pick().then((q) => live && setQuestion(q))
    load()
    const off = onFirstRunAnswered(load)
    return () => {
      live = false
      off()
    }
  }, [io, pubkey])

  if (pathname !== '/') return null

  if (error) {
    const notifications = error.question === 'notifications'
    return (
      <Card
        icon={notifications ? <Bell className="mt-0.5 h-5 w-5 shrink-0 text-mono-500" aria-hidden /> : <HeartPulse className="mt-0.5 h-5 w-5 shrink-0 text-mono-500" aria-hidden />}
        title={notifications ? 'Notifications are not on' : 'Health checks are not on'}
        id="first-run-error"
      >
        <p className="mt-1 leading-snug">
          {error.message} You can try again in Settings, {notifications ? 'Notifications' : 'Help improve Imani'}.
        </p>
        <div className="mt-3 flex gap-2">
          <Choice primary onClick={() => setError(null)}>OK</Choice>
        </div>
      </Card>
    )
  }

  if (question === null) return null

  const answer = async (yes: boolean) => {
    setBusy(true)
    try {
      if (question === 'notifications' && yes) {
        const r = await io.enableNotifications().catch(() => ({ ok: false, reason: null }))
        if (!r.ok) setError({ question, message: r.reason ?? 'That did not work.' })
      }
      if (question === 'health' && yes) {
        await io.enableHealth().catch(() => setError({ question, message: 'That did not work.' }))
      }
      // Kept whatever the outcome: the owner decided, and Settings is where to change it.
      recordFirstRunAnswer(question, pubkey, yes)
    } finally {
      setBusy(false)
    }
  }

  if (question === 'notifications') {
    return (
      <Card icon={<Bell className="mt-0.5 h-5 w-5 shrink-0 text-mono-500" aria-hidden />} title="Turn on notifications?" id="first-run-notifications">
        <p className="mt-1 leading-snug">
          Be told when a coupon arrives, even when Imani is closed. Your device will ask for permission. You can change this in Settings.
        </p>
        <Buttons busy={busy} onAnswer={answer} />
      </Card>
    )
  }

  return (
    <Card icon={<HeartPulse className="mt-0.5 h-5 w-5 shrink-0 text-mono-500" aria-hidden />} title="Help improve Imani?" id="first-run-health">
      <div className="mt-1 space-y-2 leading-snug">
        {FLEET_CONSENT_TEXT.split('\n').map((l) => <p key={l}>{l}</p>)}
      </div>
      <Buttons busy={busy} onAnswer={answer} />
    </Card>
  )
}

function Card({ icon, title, id, children }: { icon: ReactNode; title: string; id: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="mx-auto mt-2 max-w-md rounded-xl bg-mono-100 p-4 text-sm text-mono-700 dark:bg-mono-900 dark:text-mono-200"
    >
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <h2 id={id} className="font-medium text-mono-900 dark:text-mono-50">{title}</h2>
          {children}
        </div>
      </div>
    </section>
  )
}

function Buttons({ busy, onAnswer }: { busy: boolean; onAnswer: (yes: boolean) => Promise<void> }) {
  return (
    <div className="mt-3 flex gap-2">
      <Choice primary disabled={busy} onClick={() => void onAnswer(true)}>Turn on</Choice>
      <Choice disabled={busy} onClick={() => void onAnswer(false)}>Not now</Choice>
    </div>
  )
}

function Choice({ primary, disabled, onClick, children }: { primary?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        primary
          ? 'pressable min-h-11 flex-1 rounded-xl bg-mono-900 font-medium text-mono-50 outline-none ring-mono-400 focus-visible:ring-2 disabled:opacity-50 dark:bg-mono-50 dark:text-mono-900'
          : 'pressable min-h-11 flex-1 rounded-xl font-medium text-mono-700 outline-none ring-mono-400 focus-visible:ring-2 disabled:opacity-50 dark:text-mono-200'
      }
    >
      {children}
    </button>
  )
}
