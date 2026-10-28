import { useState } from 'react'

import { Button } from '@wallet/components/ui/Button'
import { Input } from '@wallet/components/ui/Input'
import { Alert, Notice, Panel, PageHeader, Screen } from '@wallet/components/ui/layout'
import { api, toPubkeyHex } from '../lib/api'

/**
 * Hand grants (#407 §7): lift any stall's limits for a while, e.g. "raise this free stall to 200
 * for a month". Every grant needs a reason and is recorded with who issued it.
 */
export function AdminPage() {
  const [stall, setStall] = useState('')
  const [currency, setCurrency] = useState('GBP')
  const [sales, setSales] = useState('200')
  const [unlimitedSales, setUnlimitedSales] = useState(false)
  const [tills, setTills] = useState('')
  const [days, setDays] = useState('30')
  const [reason, setReason] = useState('')
  const [pilot, setPilot] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [revokeId, setRevokeId] = useState('')
  const [revokeReason, setRevokeReason] = useState('')

  const submit = async () => {
    setError(null)
    setResult(null)
    const pubkey = toPubkeyHex(stall)
    if (!pubkey) return setError('Enter the stall’s npub.')
    const limits: Record<string, unknown> = {}
    if (unlimitedSales) limits.sales = null
    else if (sales.trim()) {
      const minor = Math.round(Number(sales) * 100)
      if (!Number.isSafeInteger(minor) || minor < 0) return setError('The sales limit must be an amount, e.g. 200.')
      limits.sales = { amounts: { [currency.toUpperCase()]: minor } }
    }
    if (tills.trim()) limits.terminals = tills.trim() === 'unlimited' ? null : Number(tills)
    setBusy(true)
    try {
      const out = await api.grant({
        stall_pubkey: pubkey,
        limits: Object.keys(limits).length ? limits : undefined,
        days: Number(days),
        reason,
        currency: currency.toUpperCase(),
        pilot,
      })
      setResult(`Granted ${out.subscription_id}, ${out.state === 'delivered' ? 'delivered to the stall' : `state ${out.state}`}.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <PageHeader title="Grant a plan" subtitle="Lift a stall’s limits for a set time. It arrives in their wallet like a bought plan." />
      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      {result ? <Notice tone="success">{result}</Notice> : null}

      <Panel className="mb-8 space-y-4 p-4">
        <Input label="Stall (npub)" value={stall} onChange={(e) => setStall(e.target.value)} placeholder="npub1…" />
        <div className="flex gap-3">
          <Input label="Sales limit" inputMode="decimal" value={sales} disabled={unlimitedSales} onChange={(e) => setSales(e.target.value)} />
          <Input label="Currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={unlimitedSales} onChange={(e) => setUnlimitedSales(e.target.checked)} /> No sales limit
        </label>
        <Input label="Tills (blank keeps theirs, or 'unlimited')" value={tills} onChange={(e) => setTills(e.target.value)} />
        <Input label="For how many days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        <Input label="Reason (kept for the audit trail)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={pilot} onChange={(e) => setPilot(e.target.checked)} /> Pilot
        </label>
        <Button className="w-full" disabled={busy || !reason.trim()} onClick={() => void submit()}>
          {busy ? 'Granting…' : 'Grant'}
        </Button>
      </Panel>

      <PageHeader title="End a subscription" subtitle="For a refund. Every licence of it stops counting. This cannot be undone here." />
      <Panel className="space-y-4 p-4">
        <Input label="Subscription id" placeholder="sub_…" value={revokeId} onChange={(e) => setRevokeId(e.target.value)} />
        <Input label="Reason" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
        <Button
          variant="outline"
          className="w-full"
          disabled={busy || !revokeId.trim() || !revokeReason.trim()}
          onClick={() => {
            if (!window.confirm(`End ${revokeId} permanently?`)) return
            setBusy(true)
            api
              .revoke(revokeId.trim(), revokeReason.trim())
              .then((r) => setResult(`Ended ${r.revoked}.`), (e: Error) => setError(e.message))
              .finally(() => setBusy(false))
          }}
        >
          End subscription
        </Button>
      </Panel>
    </Screen>
  )
}
