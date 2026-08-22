import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Pencil, QrCode } from 'lucide-react'
import QRCode from 'qrcode'

import { Avatar, Screen, BackLink } from '../components/ui'
import { handleLabel } from '../lib/format'
import { profileHandle, profileName, type Profile } from '../lib/profile'

/**
 * Your own profile, as others see it.
 *
 * Rendered straight from the local record with no fetch — the copy is refreshed
 * from the relay on login and after every save, so re-fetching here would only
 * add a spinner to a screen that already has the answer. (bottin does the same
 * for one's own profile, and fetches only when viewing someone else's.)
 *
 * Only the current user's profile. Looking at a merchant is MerchantPage's job.
 */
export function ProfilePage({ profile }: { profile: Profile }) {
  const navigate = useNavigate()
  const [qrOpen, setQrOpen] = useState(false)
  const handle = profileHandle(profile)

  /*
   * Edit and address sit ON the identity line rather than under it: proximity
   * is the mapping. A full-width "Edit profile" button was the loudest thing on
   * a read-only screen, which is the wrong hierarchy — you come here to look,
   * not to type.
   *
   * 44px targets around 16px glyphs (Android's floor is 48dp); the icons alone
   * would be half a target.
   */
  const actions = (
    <>
      <button
        type="button"
        onClick={() => navigate('/settings/profile')}
        aria-label="Edit profile"
        className="pressable -my-3 flex h-11 w-11 items-center justify-center rounded-full text-mono-500 outline-none ring-mono-400 hover:text-mono-900 focus-visible:ring-2 dark:hover:text-mono-50"
      >
        <Pencil className="h-4 w-4" aria-hidden="true" />
      </button>
      {profile.nip05 && (
        <button
          type="button"
          onClick={() => setQrOpen(true)}
          aria-label="Show address QR code"
          className="pressable -my-3 flex h-11 w-11 items-center justify-center rounded-full text-mono-500 outline-none ring-mono-400 hover:text-mono-900 focus-visible:ring-2 dark:hover:text-mono-50"
        >
          <QrCode className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </>
  )

  return (
    <Screen>
      <BackLink to="/" label="Wallet" />

      {profile.banner && (
        <div
          className="mb-4 h-28 rounded-2xl bg-mono-200 bg-cover bg-center dark:bg-mono-800"
          style={{ backgroundImage: `url(${profile.banner})` }}
        />
      )}

      <div className="flex flex-col items-center gap-3 text-center">
        <Avatar src={profile.picture} name={profileName(profile)} pubkey={profile.pubkey} size="xl" />
        <div className="flex flex-col items-center">
          {/* The controls hang off the identity line, and `profileHandle`
              returns nothing when the name IS the handle — so they follow the
              last line that actually names the account, never a blank one. */}
          <div className="flex items-center gap-1">
            {/* Large text tracks tighter, per the type rules. */}
            <h1 className="text-xl font-semibold tracking-tight text-mono-900 dark:text-mono-50">
              {profileName(profile)}
            </h1>
            {!handle && actions}
          </div>
          {/* Not monospaced — a handle is a word, not a key. In the primary ink
              and `@song` rather than the full address, the same as both home
              screens: this pair of lines is one answer to "who is this", and it
              should read identically wherever it appears. */}
          {handle && (
            <div className="flex items-center gap-1">
              <p className="text-sm text-mono-900 dark:text-mono-50">{handle}</p>
              {actions}
            </div>
          )}
        </div>

        {profile.about && (
          <p className="max-w-xs whitespace-pre-wrap text-sm text-mono-600 dark:text-mono-300">
            {profile.about}
          </p>
        )}

        {profile.website && (
          <a
            href={profile.website}
            target="_blank"
            // noreferrer as well as noopener: the target must not be handed
            // window.opener, nor the URL of the wallet screen it came from.
            rel="noopener noreferrer"
            className="pressable break-all text-sm text-mono-500 underline hover:text-mono-900 dark:hover:text-mono-50"
          >
            {profile.website}
          </a>
        )}
      </div>

      {profile.nip05 && qrOpen && (
        <AddressDialog nip05={profile.nip05} onClose={() => setQrOpen(false)} />
      )}
    </Screen>
  )
}

/**
 * The address, big enough to scan, without leaving the profile.
 *
 * A native `<dialog>`: the top layer, the backdrop, focus containment, Escape
 * and the returned focus all come from the platform. A hand-rolled overlay
 * would be three of those wrong.
 *
 * The QR carries the full `song@domain`, the same payload Receive shows — a
 * merchant's scanner resolves that through `/api/v1/resolve` — while the caption
 * spells it out for anyone typing it in by eye.
 */
function AddressDialog({ nip05, onClose }: { nip05: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  useEffect(() => {
    QRCode.toDataURL(nip05, { width: 512, margin: 1 }).then(setDataUrl, () => setDataUrl(null))
  }, [nip05])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Dim to focus (§12): a modal task pushes everything else back.
      className="materialize m-auto w-[calc(100%-2.5rem)] max-w-xs rounded-[20px] bg-transparent p-0 backdrop:bg-mono-950/40 backdrop:backdrop-blur-sm"
      // The backdrop is the dialog's own padding-box; a click that lands on the
      // element itself rather than the card is a click outside the card.
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      <div className="material flex flex-col items-center gap-4 rounded-[20px] p-5 shadow-xl shadow-mono-950/20 ring-1 ring-mono-900/5 dark:ring-mono-50/10">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={`QR code for ${nip05}`}
            className="w-full rounded-2xl bg-white p-4"
          />
        ) : (
          <p className="p-8 text-sm text-mono-500">Could not draw the code.</p>
        )}
        <div>
          <p className="text-lg font-semibold tracking-tight text-mono-900 dark:text-mono-50">
            {handleLabel(nip05)}
          </p>
          <p className="break-all text-sm text-mono-500">{nip05}</p>
        </div>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="pressable min-h-11 w-full rounded-2xl bg-mono-900 px-4 text-sm font-medium text-mono-50 dark:bg-mono-50 dark:text-mono-900"
        >
          Done
        </button>
      </div>
    </dialog>
  )
}
