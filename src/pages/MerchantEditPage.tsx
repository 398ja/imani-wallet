import { useState } from 'react'

import { Button, Screen, BackLink, PageHeader, Alert, Switch, Panel } from '../components/ui'
import { MerchantFieldset } from '../components/MerchantFieldset'
import { getSigner } from '../lib/nap'
import { publish } from '../lib/relay'
import {
  buildMerchantEvent,
  emptyMerchant,
  merchantFieldsValid,
  saveMerchant,
  type MerchantFields,
  type MerchantProfile,
} from '../lib/merchant'

/**
 * The merchant section of settings.
 *
 * Does double duty, because the two jobs are the same form: editing an existing
 * stall, and opening one for the first time. A customer who starts selling is
 * just a pubkey publishing its first `imani:merchant` record — there is no
 * separate account to create, which is the whole point of deriving the role from
 * the record rather than storing a flag beside it.
 *
 * Reachable whether or not the user is currently trading, deliberately. Gating
 * this route on `isMerchant()` — which is false once the stall is closed — would
 * mean the switch below could be turned off but never back on.
 */
export function MerchantEditPage({
  pubkey,
  merchant,
  onSaved,
}: {
  pubkey: string
  /** Null for a customer who has never sold anything. */
  merchant: MerchantProfile | null
  onSaved: (merchant: MerchantProfile) => void
}) {
  const existing = merchant !== null

  const [fields, setFields] = useState<MerchantFields>(() => {
    const base = merchant ?? emptyMerchant(pubkey)
    return {
      active: base.active,
      businessType: base.businessType,
      categories: base.categories,
      location: base.location,
      storeDescription: base.storeDescription,
      issuanceCurrency: base.issuanceCurrency,
      voucherValidityDays: base.voucherValidityDays,
    }
  })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!merchantFieldsValid(fields)) return
    setBusy(true)
    setError(null)
    setStatus(null)

    const next: MerchantProfile = {
      ...(merchant ?? emptyMerchant(pubkey)),
      ...fields,
      updatedAt: Date.now(),
    }

    // Local first. Everything after this point can fail without losing the edit.
    saveMerchant(next)
    onSaved(next)

    try {
      const signed = await getSigner().signEvent(buildMerchantEvent(next))
      // Stamp what we published BEFORE the publish can fail, exactly as
      // ProfileEditPage does — otherwise a later read of an older event looks
      // newer than an unset eventAt and reverts the edit on screen.
      const published: MerchantProfile = { ...next, eventAt: signed.created_at }
      saveMerchant(published)
      onSaved(published)

      const { ok, total } = await publish(signed)
      setStatus(
        ok === 0
          ? 'Saved on this device, but no relay accepted it. Customers may not see the change yet.'
          : `Saved and published to ${ok}/${total} relay${total === 1 ? '' : 's'}.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader
        title={existing ? 'Your business' : 'Start selling'}
        subtitle={
          existing ? undefined : 'Set up as a merchant and you can issue vouchers and take them as payment.'
        }
      />

      {existing && (
        <div className="mb-4">
          <Switch
            label="Open for business"
            hint="Turn this off to hide Sell and Redeem. Your vouchers and history stay."
            checked={fields.active}
            disabled={busy}
            onChange={(active) => setFields({ ...fields, active })}
          />
        </div>
      )}

      {/* Closing the stall makes the wallet look like a customer's again, which
          is a big enough change to say out loud before they hit Save. */}
      {existing && !fields.active && (
        <div className="mb-4">
          <Panel>
            <p className="text-sm text-mono-500">
              Once you save, your home screen goes back to Pay and Receive. Come back here to open
              again — this page stays where it is.
            </p>
          </Panel>
        </div>
      )}

      {/* 'create' for a customer opening a stall — they still choose the
          validity that is fixed from then on. 'edit' once it exists. */}
      <MerchantFieldset
        value={fields}
        onChange={setFields}
        disabled={busy}
        mode={existing ? 'edit' : 'create'}
      />

      <Button
        size="lg"
        className="mt-6 w-full"
        disabled={busy || !merchantFieldsValid(fields)}
        onClick={save}
      >
        {busy ? 'Saving…' : existing ? 'Save' : 'Start selling'}
      </Button>

      {status && (
        <p className="mt-3 text-center text-sm text-mono-500" role="status" aria-live="polite">
          {status}
        </p>
      )}
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}

      {/* Edit only — there is no currency field while creating. Changing it does
          not touch coupons already issued, which carry their own unit; saying so
          avoids a merchant assuming a switch re-denominates what customers are
          already holding. */}
      {existing && (
        <p className="mt-4 text-center text-xs text-mono-400">
          Vouchers you have already issued keep the currency they were issued in.
        </p>
      )}
    </Screen>
  )
}
