import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Alert, BackLink, Button, Input, Notice, PageHeader, Panel, Screen, Switch } from '../components/ui'
import { supportSnapshotConfig, type SupportSnapshotConfig } from '../lib/config'
import { SnapshotFlow } from '../lib/snapshot/flow'
import { appDeps, dropCiphertext, pollAcks } from '../lib/snapshot/collect'
import {
  connectionAdvice, detectConnection, expireKept, formatBytes, readRecords,
  type ConnectionInfo, type SnapshotRecord,
} from '../lib/snapshot/service'
import { normaliseSnapshotCode } from '../lib/snapshot/code'
import type { SnapshotSummary } from '../lib/snapshot/types'

/**
 * Settings > Help > Share a support snapshot (#589 section 11).
 *
 * Three screens, in order, none reachable without the one before: the code (validated online),
 * consent and preview, then the size and connection screen with Upload now / Not now. Nothing
 * leaves the device until Upload now.
 */
export const CONSENT_TEXT =
  'Share a support snapshot? It contains your vouchers\u2019 amounts and dates, your transaction history, your settings and recent errors (and, for a stall, your takings and terminals), so Imani support can see what went wrong. It never contains your key, your vouchers themselves, gift links, coupon codes, your email or your messages. Nobody can spend your money with it. It is encrypted so only Imani support can open it, and it is deleted from the upload server within 7 days (sooner once support collects it). Imani\u2019s support assistant (an AI) and a support person may read it. Before the AI sees anything, every name, address, key and id in it is replaced by a placeholder on your phone, so the AI services Imani uses (Anthropic, and possibly OpenAI) never see who you are. If you include memos, they are shown only to a support person, never to the AI. Support keeps it until 30 days after your ticket is closed, and deletes it sooner if you ask.'

type Step =
  | { kind: 'code' }
  | { kind: 'consent' }
  | { kind: 'building' }
  | { kind: 'size'; size: number; summary: SnapshotSummary }
  | { kind: 'uploading' }
  | { kind: 'sent'; ticket: string }
  | { kind: 'kept' }

export function SupportSnapshotPage({ pubkey, stall }: { pubkey: string; stall: boolean }) {
  const [params] = useSearchParams()
  const [config, setConfig] = useState<SupportSnapshotConfig | null | undefined>(undefined)
  const [code, setCode] = useState(params.get('code') ?? '')
  const [step, setStep] = useState<Step>({ kind: 'code' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [memos, setMemos] = useState(false)
  const [conn, setConn] = useState<ConnectionInfo>({ kind: 'unknown', saveData: false })
  const [records, setRecords] = useState<SnapshotRecord[]>(() => readRecords(pubkey))

  useEffect(() => {
    supportSnapshotConfig().then(setConfig, () => setConfig(null))
    for (const sha of expireKept(pubkey, Math.floor(Date.now() / 1000))) void dropCiphertext(sha)
    setRecords(readRecords(pubkey))
  }, [pubkey])

  useEffect(() => {
    if (!config) return
    const open = readRecords(pubkey).filter((r) => r.state === 'shared' || r.state === 'received')
    if (open.length === 0) return
    const since = Math.floor(Math.min(...open.map((r) => r.createdAt)) / 1000)
    pollAcks(pubkey, config.supportPubkey, since).then(() => setRecords(readRecords(pubkey)), () => undefined)
  }, [config, pubkey])

  const flow = useMemo(() => (config ? new SnapshotFlow(appDeps(config, stall)) : null), [config, stall])

  if (config === undefined) return <Screen><BackLink to="/settings" label="Settings" /><p className="text-mono-500">Loading…</p></Screen>
  if (config === null || !flow) {
    return (
      <Screen>
        <BackLink to="/settings" label="Settings" />
        <PageHeader title="Support snapshot" />
        <Panel><p data-testid="snapshot-unavailable">Support snapshots are not available on this service.</p></Panel>
      </Screen>
    )
  }

  const typed = normaliseSnapshotCode(code)
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setRecords(readRecords(pubkey))
    }
  }

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Share a support snapshot" />
      {error && <Alert>{error}</Alert>}

      {step.kind === 'code' && (
        <Panel>
          <p className="mb-3 text-sm text-mono-500">Only when Imani support asks. They will give you a snapshot code.</p>
          <Input
            label="Snapshot code from Imani support"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="SNAP-XXX-XXX-XXX"
            autoComplete="off"
            data-testid="snapshot-code"
            error={code.length >= 12 && !typed.ok && typed.problem === 'check' ? 'That code looks mistyped' : undefined}
          />
          <Button
            className="mt-3 w-full"
            disabled={busy || !typed.ok}
            data-testid="snapshot-continue"
            onClick={() => run(async () => {
              await flow.validate(code)
              setStep({ kind: 'consent' })
            })}
          >
            {busy ? 'Checking\u2026' : 'Continue'}
          </Button>
        </Panel>
      )}

      {step.kind === 'consent' && (
        <Panel>
          <p className="text-sm" data-testid="snapshot-consent">{CONSENT_TEXT}</p>
          <div className="mt-3">
            <Switch label="Include memos" hint="Off unless you turn it on. Memos are shown only to a support person, never to the AI." checked={memos} onChange={setMemos} />
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" onClick={() => setStep({ kind: 'code' })}>Cancel</Button>
            <Button
              data-testid="snapshot-build"
              disabled={busy}
              onClick={() => run(async () => {
                setStep({ kind: 'building' })
                try {
                  const [{ built, size }, c] = await Promise.all([flow.prepare(memos), detectConnection()])
                  setConn(c)
                  setStep({ kind: 'size', size, summary: built.summary })
                } catch (e) {
                  setStep({ kind: 'consent' })
                  throw e
                }
              })}
            >
              Create snapshot
            </Button>
          </div>
        </Panel>
      )}

      {step.kind === 'building' && <Panel><p>Creating the snapshot on this device…</p></Panel>}

      {step.kind === 'size' && (
        <Panel>
          <p data-testid="snapshot-summary" className="text-sm text-mono-500">
            {step.summary.vouchers} vouchers, {step.summary.transactions} transactions, {step.summary.pendingSends} pending sends, {step.summary.errors} recent errors
            {step.summary.terminals !== null ? `, plus takings for ${step.summary.terminals} terminals` : ''}.
            {step.summary.truncatedSince ? ` Includes history since ${step.summary.truncatedSince} (older history left out to fit).` : ''}
          </p>
          <p className="mt-3 text-lg font-medium" data-testid="snapshot-size">This snapshot is {formatBytes(step.size)}.</p>
          {(() => {
            const a = connectionAdvice(step.size, conn)
            return a.tone === 'ok' ? <p data-testid="snapshot-wifi" className="text-sm">{a.text}</p> : <Notice tone="warning"><span data-testid="snapshot-wifi">{a.text}</span></Notice>
          })()}
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" data-testid="snapshot-not-now" disabled={busy} onClick={() => run(async () => {
              await flow.notNow()
              setStep({ kind: 'kept' })
            })}>Not now</Button>
            <Button data-testid="snapshot-upload" disabled={busy} onClick={() => run(async () => {
              setStep({ kind: 'uploading' })
              const dm = await flow.upload()
              setStep({ kind: 'sent', ticket: dm.ticket })
            })}>Upload now</Button>
          </div>
        </Panel>
      )}

      {step.kind === 'uploading' && <Panel><p>Uploading, then sending to support…</p></Panel>}
      {step.kind === 'sent' && <Notice tone="success"><span data-testid="snapshot-sent">Sent to support for ticket {step.ticket}.</span></Notice>}
      {step.kind === 'kept' && <Notice tone="success">Kept on this device until the code expires. Nothing was sent.</Notice>}

      {records.length > 0 && (
        <Panel className="mt-4">
          <p className="mb-2 font-medium">Your snapshots</p>
          <ul className="text-sm" data-testid="snapshot-records">
            {records.map((r) => (
              <li key={r.sha256}>Ticket {r.ticket}: {stateLabel(r.state)} ({formatBytes(r.size)})</li>
            ))}
          </ul>
        </Panel>
      )}
    </Screen>
  )
}

function stateLabel(s: SnapshotRecord['state']): string {
  return {
    kept: 'kept on this device, not sent',
    uploaded: 'uploaded, telling support',
    shared: 'shared with support',
    received: 'received by support',
    deleted: 'received by support, deleted from server',
    expired: 'expired and deleted',
    failed: 'not delivered',
  }[s]
}
