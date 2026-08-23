import { useState } from 'react'

import { Button, Screen, BackLink, PageHeader, Alert, Switch, Panel } from '../components/ui'
import { MerchantFieldset } from '../components/MerchantFieldset'
import { getOfflineCap, setOfflineCap, validOfflineCap } from '../lib/offlineCap'
import { getSigner } from '../lib/nap'
import { publish } from '../lib/relay'
import {
  buildMerchantEvent,
  DEFAULT_VALIDITY_DAYS,
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
      categories: base.categories,
      location: base.location,
      issuanceCurrency: base.issuanceCurrency,
      voucherValidityDays: base.voucherValidityDays,
    }
  })
  /**
   * Kept OUT of `fields`, and that separation is the point.
   *
   * `fields` becomes the kind-30078 stall record, which is published and
   * readable by anyone. A cap in there would tell every attacker exactly how
   * much can be taken from this stall offline — and the relay copy is
   * attacker-controllable (`mergeMerchantEvent` clamps it because "anyone can
   * publish a kind-30078 claiming to be you"), so a ceiling someone else could
   * raise would fail in the worst direction. It is a risk setting, not stall
   * metadata: it stays on the device.
   */
  const [offlineCap, setOfflineCapField] = useState<number | null>(() => getOfflineCap(pubkey))
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
      // The answer given once. The fieldset stops showing it as a control after
      // creation, but "fixed" is an invariant of the record and not of one
      // component's render, so it is enforced where the record is written: every
      // coupon already issued carries this unit, and a later save that quietly
      // re-denominated the stall would misdescribe all of them.
      issuanceCurrency: merchant?.issuanceCurrency ?? fields.issuanceCurrency,
      // The validity is NOT pinned — it is the default for coupons issued from
      // here on, and issued coupons carry the expiry they were granted. The `??`
      // is narrowing, not policy: `merchantFieldsValid` above has already
      // refused a null, which only occurs mid-typing.
      voucherValidityDays: fields.voucherValidityDays ?? DEFAULT_VALIDITY_DAYS,
      updatedAt: Date.now(),
    }

    // Device-local, and never part of `next` — see the field's declaration.
    // Written before the record so a relay failure below cannot lose it.
    setOfflineCap(pubkey, validOfflineCap(offlineCap))

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

      {/* 'create' for a customer opening a stall, 'edit' once it exists. */}
      <MerchantFieldset
        value={fields}
        onChange={setFields}
        disabled={busy}
        mode={existing ? 'edit' : 'create'}
      />

      {/* Only for an existing stall. Asking someone opening their first shop how
          much fraud they will absorb is a question they cannot answer yet, and
          the default of 0 is the safe one to leave them on. */}
      {existing && (
        <label className="mt-6 block">
          <span className="text-sm font-medium text-mono-900 dark:text-mono-50">
            Offline limit
          </span>
          <span className="mt-1 block text-sm text-mono-500">
            When you have no signal, coupons can be checked for a valid issuer but not
            for whether they have already been spent. This is the most you will accept
            that way before waiting for a connection. Leave it empty to accept none.
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            className="input mt-2 w-full"
            disabled={busy}
            value={offlineCap ?? ''}
            onChange={(e) => setOfflineCapField(validOfflineCap(e.target.value))}
            placeholder="0"
          />
        </label>
      )}

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
    </Screen>
  )
}
