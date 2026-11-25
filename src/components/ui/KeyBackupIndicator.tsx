import { KeyRound } from 'lucide-react'
import { Link } from 'react-router-dom'

import { BACKUP_RECOMMEND_PARAM, useKeyBackupState, type KeyBackupState } from '../../lib/keyBackupState'

/** The blink pace per state, a class in index.css. Steady green has none. */
const BLINK: Record<KeyBackupState, string | null> = {
  verified: null,
  local: 'key-blink-green',
  missing: 'key-blink-orange',
  none: 'key-blink-red',
}

const LOOK: Record<KeyBackupState, { colour: string; label: string }> = {
  verified: { colour: 'text-green-600 dark:text-green-400', label: 'Key backed up and checked' },
  local: {
    colour: 'text-green-600 dark:text-green-400',
    label: 'Key backed up to a file on this device. Add a Google Drive backup',
  },
  missing: {
    colour: 'text-orange-500 dark:text-orange-400',
    label: 'Key backup could not be confirmed. Back up your key',
  },
  none: { colour: 'text-red-600 dark:text-red-400', label: 'Key not backed up. Back up your key' },
}

/**
 * A small upright key left of the signed-in user's own avatar: steady green, blinking green, orange or red by `KeyBackupState`.
 * Render it only for the current user. It reads this device's key and backup list, so it says
 * nothing true about anyone else.
 */
export function KeyBackupIndicator({ pubkey, className = '' }: { pubkey: string; className?: string }) {
  const state = useKeyBackupState(pubkey)
  return <KeyBackupIcon state={state} className={className} />
}

/**
 * Steady green (a remote backup) is a quiet glyph. Blinking green (a local file only), orange and red blink (`key-blink`, still under prefers-reduced-motion)
 * and are a link of their own to the backup page, with the reason in the query so the page can
 * say why it was opened. A sibling of the profile link, never inside it: a link in a link is
 * invalid and the tap would go to whichever the browser picks.
 */
export function KeyBackupIcon({ state, className = '' }: { state: KeyBackupState; className?: string }) {
  const { colour, label } = LOOK[state]
  // KeyRound is drawn on the diagonal (bow top right, blade bottom left). A quarter turn of 45
  // degrees stands it upright: bow on top, blade pointing down.
  const icon = <KeyRound aria-hidden="true" className="h-3.5 w-3.5 -rotate-45" strokeWidth={2.25} />

  if (state === 'verified') {
    return (
      <span role="img" aria-label={label} title={label} data-state={state} className={`inline-flex ${colour} ${className}`}>
        {icon}
      </span>
    )
  }
  return (
    <Link
      to={`/settings/backup?${BACKUP_RECOMMEND_PARAM}=${state}`}
      aria-label={label}
      title={label}
      data-state={state}
      // 32px of target around a 14px glyph, pulled in so it still sits close to the avatar.
      className={`key-blink ${BLINK[state] ?? ''} -m-2 inline-flex rounded-full p-2 outline-none ring-mono-400 focus-visible:ring-2 ${colour} ${className}`}
    >
      {icon}
    </Link>
  )
}
