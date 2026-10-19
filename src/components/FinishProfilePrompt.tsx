import { Link, useLocation } from 'react-router-dom'
import { UserRound } from 'lucide-react'

import { profileUnknown, type Profile } from '../lib/profile'

/**
 * A quiet line at app start for a logged-in account with no handle (#332).
 *
 * Every account must have a profile, and accounts made before handles existed
 * do not. This points them at their own profile card, where Finish your
 * profile lives. It is a link in the flow of the page, not a dialog: it never
 * stands between anyone and a payment, a receive or their coupons, and it
 * goes away by itself the moment the handle is claimed.
 *
 * Hidden while the record is still loading (a loading record is not a
 * handle-less one) and on `/profile`, where the card already offers it.
 */
export function FinishProfilePrompt({ profile }: { profile: Profile }) {
  const { pathname } = useLocation()
  if (profile.nip05 || profileUnknown(profile) || pathname === '/profile') return null

  return (
    <Link
      to="/profile"
      className="pressable mx-auto mt-2 flex max-w-md items-center gap-2 rounded-xl bg-mono-100 px-3 py-2.5 text-sm text-mono-700 outline-none ring-mono-400 focus-visible:ring-2 dark:bg-mono-900 dark:text-mono-200"
    >
      <UserRound className="h-4 w-4 shrink-0 text-mono-500" aria-hidden />
      <span className="flex-1">Finish your profile so people can find and pay you.</span>
    </Link>
  )
}
