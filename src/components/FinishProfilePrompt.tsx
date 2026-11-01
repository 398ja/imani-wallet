import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { UserRound, X } from 'lucide-react'

import { profileUnknown, type Profile } from '../lib/profile'

/**
 * Per account, so a second person on the same device still sees their own
 * reminder. Under `imani-wallet:` so logout's sweep clears it with the rest.
 */
const dismissKey = (pubkey: string) => `imani-wallet:finish-profile-dismissed:${pubkey}`

function isDismissed(pubkey: string): boolean {
  try {
    return localStorage.getItem(dismissKey(pubkey)) === '1'
  } catch {
    return false
  }
}

/**
 * A quiet line on Home for a logged-in account with no handle (#332, #339).
 *
 * Every account must have a profile, and accounts made before handles existed
 * do not. This points them at their own profile card, where Finish your
 * profile lives. It is a link in the flow of the page, not a dialog, and it
 * shows on Home only (#339): the money screens stay free of it.
 *
 * The person can hide it (#339). Hiding it is remembered for that account
 * only, and never touches the card: Finish your profile stays on the own
 * profile, so every account can still get a handle.
 *
 * Hidden while the record is still loading (a loading record is not a
 * handle-less one), and gone by itself the moment the handle is claimed.
 */
export function FinishProfilePrompt({ profile }: { profile: Profile }) {
  const { pathname } = useLocation()
  const [dismissed, setDismissed] = useState(() => isDismissed(profile.pubkey))
  const [dismissedFor, setDismissedFor] = useState(profile.pubkey)
  // A different account on the same mounted prompt reads its own choice.
  if (dismissedFor !== profile.pubkey) {
    setDismissedFor(profile.pubkey)
    setDismissed(isDismissed(profile.pubkey))
  }

  if (pathname !== '/' || dismissed || profile.nip05 || profileUnknown(profile)) return null

  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(profile.pubkey), '1')
    } catch {
      // Storage full or blocked: hide it for now anyway.
    }
    setDismissed(true)
  }

  return (
    <div className="mx-auto mt-2 flex max-w-md items-center rounded-xl bg-mono-100 text-sm text-mono-700 dark:bg-mono-900 dark:text-mono-200">
      <Link
        to="/profile"
        className="pressable flex min-h-11 flex-1 items-center gap-2 rounded-xl py-2.5 pl-3 outline-none ring-mono-400 focus-visible:ring-2"
      >
        <UserRound className="h-4 w-4 shrink-0 text-mono-500" aria-hidden />
        <span className="flex-1">Finish your profile so people can find and pay you.</span>
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Hide this reminder"
        className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mono-500 outline-none ring-mono-400 focus-visible:ring-2"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
