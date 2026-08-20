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
 * an outside click, which is the blur handler below. It also cannot animate
 * its own close, so the menu materialises on open and closes instantly.
 */
export function Header({
  profile,
  merchant,
  onLogout,
}: {
  profile: Profile
  /** Trading as a merchant — adds the Stats entry; the rest of the menu is the same. */
  merchant?: boolean
  onLogout: () => void
}) {
  const menu = useRef<HTMLDetailsElement>(null)

  const close = () => menu.current?.removeAttribute('open')

  return (
    <header className="material sticky top-0 z-10">
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
            className="pressable flex cursor-pointer list-none items-center rounded-full outline-none ring-mono-400 focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
            aria-label="Account menu"
          >
            <Avatar src={profile.picture} name={profileName(profile)} pubkey={profile.pubkey} size="sm" />
          </summary>

          <nav className="materialize absolute left-0 top-full mt-2 min-w-44 origin-top-left overflow-hidden rounded-2xl border border-mono-200 bg-white shadow-lg dark:border-mono-800 dark:bg-mono-900">
            <MenuLink to="/profile" onClick={close}>
              Profile
            </MenuLink>
            {/* Merchants only: there is nothing to count for a customer, whose
                own history already lives on the merchant screens. */}
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
              className="press-row block w-full px-4 py-3 text-left text-sm text-red-600 dark:text-red-400"
            >
              Log out
            </button>
          </nav>
        </details>

        {/* The imani lockup, same construction as imani-www: mark.svg's one
            evenodd path plus live text, both currentColor so the theme carries
            them. Inlined rather than <img src>, which would not inherit colour. */}
        <Link
          to="/"
          aria-label="Imani home"
          className="pressable flex min-w-0 flex-1 items-center justify-end gap-2 font-semibold tracking-tight text-mono-900 dark:text-mono-50"
        >
          <svg viewBox="0 0 48 48" className="h-5 w-5 shrink-0" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M10 2 H24 A8 8 0 0 1 32 10 V24 A8 8 0 0 1 24 32 H10 A8 8 0 0 1 2 24 V10 A8 8 0 0 1 10 2 Z M24 16 H38 A8 8 0 0 1 46 24 V38 A8 8 0 0 1 38 46 H24 A8 8 0 0 1 16 38 V24 A8 8 0 0 1 24 16 Z"
            />
          </svg>
          imani
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
      className="press-row block px-4 py-3 text-sm text-mono-900 dark:text-mono-50"
    >
      {children}
    </Link>
  )
}
