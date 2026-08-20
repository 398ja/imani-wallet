import { useEffect, useRef, useState } from 'react'
import type { BlossomServerConfig } from '@imani/blossom-upload'
import type { UploadSlot } from '@imani/blossom-upload'

import { Avatar, Screen, BackLink, PageHeader, Button, Input, Alert } from '../components/ui'
import { buildProfileEvent, profileName, saveProfile, type Profile } from '../lib/profile'
import { getSigner } from '../lib/nap'
import { publish } from '../lib/relay'
import { ACCEPT_ATTRIBUTE, blossomServer, uploadImage } from '../lib/blossom'
import { validateWebsite } from '../lib/validate'

/**
 * Edit your account details.
 *
 * Save order is deliberate and copied from bottin: write locally FIRST, then
 * publish. A relay that refuses the event must not cost the user their edit —
 * the local record is the one the app renders from, and the kind-0 is an
 * announcement of it.
 *
 * No lightning address. The field, its validator and its kind-0 key are all
 * absent by design, not oversight; see lib/profile.ts.
 */
export function ProfileEditPage({
  profile,
  onSaved,
}: {
  profile: Profile
  onSaved: (profile: Profile) => void
}) {
  const [displayName, setDisplayName] = useState(profile.displayName ?? '')
  const [about, setAbout] = useState(profile.about ?? '')
  const [website, setWebsite] = useState(profile.website ?? '')
  const [picture, setPicture] = useState(profile.picture)
  const [banner, setBanner] = useState(profile.banner)

  const [server, setServer] = useState<BlossomServerConfig | null>(null)
  const [serverChecked, setServerChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    blossomServer()
      .then(setServer, () => setServer(null))
      .finally(() => setServerChecked(true))
  }, [])

  const websiteError = validateWebsite(website)

  const save = async () => {
    if (websiteError) return
    setBusy(true)
    setError(null)
    setStatus(null)

    const next: Profile = {
      ...profile,
      displayName: displayName.trim() || undefined,
      about: about.trim() || undefined,
      website: website.trim() || undefined,
      picture,
      banner,
      updatedAt: Date.now(),
    }

    // Local first. Everything after this point can fail without losing the edit.
    saveProfile(next)
    onSaved(next)

    try {
      const signed = await getSigner().signEvent(buildProfileEvent(next))
      // Record what we published as this record's event time, BEFORE the
      // publish can fail. Otherwise the next login fetches the gateway's cached
      // pre-edit kind-0, finds it "newer" than an unset eventAt, and reverts the
      // edit that is sitting right there on screen.
      const published: Profile = { ...next, eventAt: signed.created_at }
      saveProfile(published)
      onSaved(published)

      const { ok, total } = await publish(signed)
      setStatus(
        ok === 0
          ? 'Saved on this device, but no relay accepted it. Others may not see the change yet.'
          : `Saved and published to ${ok}/${total} relay${total === 1 ? '' : 's'}.`,
      )
    } catch (e) {
      setStatus('Saved on this device. Publishing failed.')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Profile" subtitle="How you appear to the merchants you buy from." />

      <div className="space-y-5">
        <ImagePicker
          label="Photo"
          slot="avatar"
          server={server}
          serverChecked={serverChecked}
          onUploaded={setPicture}
          onRemove={() => setPicture(undefined)}
          preview={
            <Avatar
              src={picture}
              name={profileName({ ...profile, displayName })}
              pubkey={profile.pubkey}
              size="lg"
            />
          }
        />

        <ImagePicker
          label="Banner"
          slot="banner"
          server={server}
          serverChecked={serverChecked}
          onUploaded={setBanner}
          onRemove={() => setBanner(undefined)}
          preview={
            <div
              className="h-14 w-24 rounded-xl bg-mono-200 bg-cover bg-center dark:bg-mono-800"
              style={banner ? { backgroundImage: `url(${banner})` } : undefined}
            />
          }
        />

        <Field label="Display name">
          <Input
            value={displayName}
            maxLength={128}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
          />
        </Field>

        <Field label="About">
          <textarea
            value={about}
            rows={3}
            maxLength={1000}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="A line about you"
            className="w-full rounded-xl border border-mono-200 bg-white px-4 py-3 text-mono-900 placeholder:text-mono-400 focus:border-mono-400 focus:outline-none dark:border-mono-700 dark:bg-mono-800 dark:text-mono-50"
          />
        </Field>

        <Field label="Website" error={website === '' ? undefined : websiteError}>
          <Input
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://"
            inputMode="url"
          />
        </Field>

        <Field label="Handle">
          <Input value={profile.nip05 ?? 'Not set'} readOnly disabled />
          <p className="mt-1 text-xs text-mono-500">
            Your handle was set when you created your account and cannot be changed here.
          </p>
        </Field>

        <Button
          size="lg"
          className="w-full"
          disabled={busy || !!websiteError}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>

        {status && <p className="text-center text-sm text-mono-500">{status}</p>}
        {error && <Alert>{error}</Alert>}
      </div>
    </Screen>
  )
}

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-mono-500">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

/**
 * Pick and upload one image.
 *
 * When no Blossom server is configured the input is disabled with a reason,
 * rather than accepting a file and failing at the PUT — bottin's behaviour, and
 * the reason `blossom_server_url` being null is a supported state rather than an
 * error.
 */
function ImagePicker({
  label,
  slot,
  server,
  serverChecked,
  preview,
  onUploaded,
  onRemove,
}: {
  label: string
  slot: UploadSlot
  server: BlossomServerConfig | null
  serverChecked: boolean
  preview: React.ReactNode
  onUploaded: (url: string) => void
  onRemove: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async (file: File | undefined) => {
    if (!file || !server) return
    setBusy(true)
    setError(null)
    try {
      onUploaded(await uploadImage(file, slot, server))
    } catch (e) {
      // The package raises typed BlossomUploadErrors whose messages name the
      // actual problem (too large, wrong type, server refused). Passing them
      // through beats "upload failed".
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      // Clear the input so re-picking the same file fires change again.
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-mono-500">{label}</label>
      <div className="flex items-center gap-3">
        {preview}
        <div className="min-w-0 flex-1">
          <input
            ref={input}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            disabled={!server || busy}
            onChange={(e) => void pick(e.target.files?.[0])}
            className="block w-full text-sm text-mono-500 file:mr-3 file:rounded-xl file:border-0 file:bg-mono-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-mono-900 disabled:opacity-50 dark:file:bg-mono-800 dark:file:text-mono-50"
          />
          {serverChecked && !server && (
            <p className="mt-1 text-xs text-mono-500">Media server not configured.</p>
          )}
          {busy && <p className="mt-1 text-xs text-mono-500">Uploading…</p>}
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="pressable shrink-0 text-sm text-mono-500 underline hover:text-mono-900 dark:hover:text-mono-50"
        >
          Remove
        </button>
      </div>
    </div>
  )
}
