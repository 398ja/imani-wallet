import { useNavigate } from 'react-router-dom'

import { Avatar, Screen, BackLink, Button } from '../components/ui'
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
  const handle = profileHandle(profile)

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
        <div>
          <h1 className="text-xl font-semibold text-mono-900 dark:text-mono-50">
            {profileName(profile)}
          </h1>
          {/* Not monospaced — a handle is a word, not a key. In the primary ink
              and `@song` rather than the full address, the same as both home
              screens: this pair of lines is one answer to "who is this", and it
              should read identically wherever it appears. */}
          {handle && <p className="text-sm text-mono-900 dark:text-mono-50">{handle}</p>}
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

        <Button variant="secondary" className="mt-2" onClick={() => navigate('/settings/profile')}>
          Edit profile
        </Button>
      </div>
    </Screen>
  )
}
