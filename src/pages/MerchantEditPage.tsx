import { useState } from 'react'
import { StepUpDialog } from '../components/ui/StepUpDialog'
import { stepUp } from '../lib/reauth'

import { Button, Screen, BackLink, PageHeader, Alert, Switch, Panel } from '../components/ui'
import { MerchantFieldset } from '../components/MerchantFieldset'
import { getSigner } from '../lib/nap'
import { publish } from '../lib/relay'
import { userMessage } from '../lib/userMessage'
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
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // #434: closing the stall needs the passphrase. Reopening does not.
  const [confirmClose, setConfirmClose] = useState(false)
  const closing = existing && merchant.active && !fields.active

  const save = async () => {
    if (!merchantFieldsValid(fields)) return
    if (closing && !confirmClose) {
      setConfirmClose(true)
      return
    }
    await commit()
  }

  const commit = async () => {
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

      // No server counts in the copy (#324), same as the profile editor.
      const { ok } = await publish(signed)
      setStatus(
        ok === 0
          ? 'Saved on this device, but not sent yet. Customers may not see the change for a while.'
          : 'Saved.',
      )
    } catch (e) {
      setError(userMessage(e))
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
            hint="Turn this off to pause selling and redeeming here and on your terminals. Your menus, vouchers and history stay."
            checked={fields.active}
            disabled={busy}
            onChange={(active) => setFields({ ...fields, active })}
          />
        </div>
      )}

      {/* #434: what closing does, said before Save. The wallet stays a merchant wallet. */}
      {existing && !fields.active && (
        <div className="mb-4">
          <Panel>
            <p className="text-sm text-mono-500">
              {merchant.active
                ? "Once you save, Sell, Redeem and Cashback are paused on this device and all your terminals, and customers can't pay you or buy your vouchers by card. Everything else stays. You'll be asked for your passphrase."
                : 'Your stall is closed. Turn the switch on and save to open again.'}
            </p>
          </Panel>
        </div>
      )}

      {confirmClose && (
        <StepUpDialog
          title="Confirm it's you to close your stall"
          body="Closing your stall pauses selling and redeeming on this device and all your terminals, and customers won't be able to pay you. Enter your passphrase to complete this. Your stall stays open until you do."
          confirmLabel="Close stall"
          onCancel={() => {
            setConfirmClose(false)
            setFields({ ...fields, active: true })
          }}
          onConfirm={async (passphrase) => {
            await stepUp(passphrase)
            setConfirmClose(false)
            await commit()
          }}
        />
      )}

      {/* 'create' for a customer opening a stall, 'edit' once it exists. */}
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
    </Screen>
  )
}
