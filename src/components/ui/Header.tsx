import { useRef } from 'react'
import { Link } from 'react-router-dom'

import { Avatar } from './Avatar'
import { profileName, type Profile } from '../../lib/profile'

/**
 * The app header: who you are, top left.
 *
 * The avatar doubles as the account menu, which is bottin's nav pattern — one
 * affordance for identity and account actions rather than a separate settings
 * icon competing for the same corner.
 *
 * Built on <details>/<summary> rather than useState. That is not cleverness for
 * its own sake: the element gives open/close, Escape, focus handling and
 * keyboard activation for free, all of which bottin hand-rolled and only
 * partially got (its dropdown needs a document-level click listener and still
 * cannot be closed with a key). The one thing <details> does not do is close on
 * an outside click, which is the blur handler below.
 */
export function Header({
  profile,
  merchant,
  onLogout,
}: {
  profile: Profile
  /** Trading as a merchant — changes the title only; the menu is the same. */
  merchant?: boolean
  onLogout: () => void
}) {
  const menu = useRef<HTMLDetailsElement>(null)

  const close = () => menu.current?.removeAttribute('open')

  return (
    <header className="sticky top-0 z-10 border-b border-mono-200 bg-mono-50/90 backdrop-blur dark:border-mono-800 dark:bg-mono-950/90">
      <div className="mx-auto flex max-w-md items-center gap-3 p-4">
        <details
          ref={menu}
          className="relative"
          // Focus leaving the subtree closes the menu — the outside-click case,
          // handled without a document listener. relatedTarget is null when
          // focus goes nowhere (a click on empty space), which should also close.
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close()
          }}
        >
          <summary
            className="flex cursor-pointer list-none items-center rounded-full outline-none ring-mono-400 focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
            aria-label="Account menu"
          >
            <Avatar src={profile.picture} name={profileName(profile)} pubkey={profile.pubkey} size="sm" />
          </summary>

          <nav className="absolute left-0 top-full mt-2 min-w-44 overflow-hidden rounded-2xl border border-mono-200 bg-white shadow-lg dark:border-mono-800 dark:bg-mono-900">
            <MenuLink to="/profile" onClick={close}>
              Profile
            </MenuLink>
            {/* Merchants only: there is nothing to count for a customer, whose
                own history already lives on the farmer screens. */}
            {merchant && (
              <MenuLink to="/merchant/stats" onClick={close}>
                Stats
              </MenuLink>
            )}
            <MenuLink to="/settings" onClick={close}>
              Settings
            </MenuLink>
            <button
              type="button"
              onClick={() => {
                close()
                onLogout()
              }}
              className="block w-full px-4 py-3 text-left text-sm text-red-600 transition-colors hover:bg-mono-100 dark:text-red-400 dark:hover:bg-mono-800"
            >
              Log out
            </button>
          </nav>
        </details>

        <Link to="/" className="min-w-0 flex-1 truncate font-medium text-mono-900 dark:text-mono-50">
          {merchant ? 'Coupon till' : 'Coupon wallet'}
        </Link>
      </div>
    </header>
  )
}

function MenuLink({
  to,
  onClick,
  children,
}: {
  to: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className="block px-4 py-3 text-sm text-mono-900 transition-colors hover:bg-mono-100 dark:text-mono-50 dark:hover:bg-mono-800"
    >
      {children}
    </Link>
  )
}
