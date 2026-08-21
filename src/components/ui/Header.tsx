import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { Menu } from 'lucide-react'

import { Avatar } from './Avatar'
import { profileHandle, profileName, type Profile } from '../../lib/profile'

/**
 * The app header: who you are on the left, everything else on the right.
 *
 * The avatar goes straight to the profile. It used to open the account menu,
 * which put the one control that looks like a person in front of Settings and
 * Log out; a picture of you should lead to you. The menu it hid is now a
 * hamburger, which is what people already read as "everything else".
 *
 * The name and handle beside it come from the LOCAL profile record rather than
 * `IdentityInline`, which looks the same: that component fetches kind-0 for a
 * stranger's pubkey, and this is the one person whose profile we already hold.
 *
 * `pt-[env(safe-area-inset-top)]` is load-bearing, not padding taste. targetSdk
 * 35 is Android 15, which enforces edge-to-edge and ignores
 * `StatusBar.setOverlaysWebView({ overlay: false })` — so on a Pixel the WebView
 * starts at y=0, and the avatar rendered behind the clock where it could not be
 * tapped. The inset is 0 in every browser and on any Android where that call is
 * still honoured, so it costs nothing where it is not needed. It belongs on the
 * header rather than on `#root` because the header is sticky: padding the page
 * would slide back under the status bar on the first scroll.
 *
 * The menu is built on <details>/<summary> rather than useState. That is not
 * cleverness for its own sake: the element gives open/close, Escape, focus
 * handling and keyboard activation for free, all of which bottin hand-rolled
 * and only partially got (its dropdown needs a document-level click listener
 * and still cannot be closed with a key). The one thing <details> does not do is
 * close on an outside click, which is the blur handler below. It also cannot
 * animate its own close, so the menu materialises on open and closes instantly.
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

  const name = profileName(profile)
  const handle = profileHandle(profile)

  return (
    <header className="material sticky top-0 z-10 pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex max-w-md items-center gap-3 p-4">
        <Link
          to="/profile"
          className="pressable flex min-w-0 flex-1 items-center gap-3 rounded-full outline-none ring-mono-400 focus-visible:ring-2"
        >
          <Avatar
            src={profile.picture}
            name={name}
            pubkey={profile.pubkey}
            size="sm"
            className="shrink-0"
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-mono-900 dark:text-mono-50">
              {name}
            </span>
            {/* Absent when the name above IS the handle — see `profileHandle`. */}
            {handle ? <span className="block truncate text-xs text-mono-500">{handle}</span> : null}
          </span>
        </Link>

        {/* The imani lockup, same construction as imani-www: mark.svg's one
            evenodd path plus live text, both currentColor so the theme carries
            them. Inlined rather than <img src>, which would not inherit colour. */}
        <Link
          to="/"
          aria-label="Imani home"
          className="pressable flex shrink-0 items-center gap-2 font-semibold tracking-tight text-mono-900 dark:text-mono-50"
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

        <details
          ref={menu}
          className="relative shrink-0"
          // Focus leaving the subtree closes the menu — the outside-click case,
          // handled without a document listener. relatedTarget is null when
          // focus goes nowhere (a click on empty space), which should also close.
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close()
          }}
        >
          {/* 44px of touch target around a 24px glyph, pulled right so the icon
              still lines up with the container's own padding. Android's minimum
              is 48dp; the icon alone would be half that. */}
          <summary
            className="pressable -mr-2.5 flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-full outline-none ring-mono-400 focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
            aria-label="Menu"
          >
            <Menu className="h-6 w-6" aria-hidden="true" />
          </summary>

          <nav className="materialize absolute right-0 top-full mt-2 min-w-44 origin-top-right overflow-hidden rounded-2xl border border-mono-200 bg-white shadow-lg dark:border-mono-800 dark:bg-mono-900">
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
