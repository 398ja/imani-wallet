import { Button } from './ui'
import { LOGOUT_BLOCKED_COPY } from '../lib/logout'
import { KEY_BACKUP_COPY } from '../lib/keyBackups'
import { blockedMessage, type BlockedLogout } from '../lib/logoutBlockedCopy'

/**
 * What logout says when it REFUSES (owner rule 2026-10-18 17:52Z, review of
 * #326): the count and value of the vouchers not confirmed as backed up, and
 * a Retry. There is no "log out anyway" here or anywhere: the only ways out of
 * this dialog are Retry and Not now, and neither erases anything.
 */
export function LogoutBlockedDialog({
  outcome,
  busy,
  onRetry,
  onClose,
}: {
  outcome: BlockedLogout
  busy: boolean
  onRetry: () => void
  onClose: () => void
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="logout-blocked-title"
      aria-describedby="logout-blocked-body"
      className="fixed inset-0 z-[110] flex items-center justify-center p-5"
    >
      <div aria-hidden="true" className="modal-scrim absolute inset-0 bg-mono-950/40 backdrop-blur-md dark:bg-mono-950/60" />
      <div className="modal-surface material relative w-full max-w-sm rounded-3xl border border-mono-900/5 p-6 shadow-2xl shadow-mono-950/25 dark:border-mono-50/10 dark:shadow-black/50">
        <h2
          id="logout-blocked-title"
          className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-mono-900 dark:text-mono-50"
        >
          {LOGOUT_BLOCKED_COPY.title}
        </h2>
        <p id="logout-blocked-body" className="mt-2 text-[13px] leading-snug text-mono-600 dark:text-mono-300">
          {blockedMessage(outcome)}
        </p>
        {(outcome.reason === 'checkout-code' || outcome.reason === 'checkout-code-unconfirmed') && outcome.code && (
          <a
            href={`/online/code/${encodeURIComponent(outcome.code.id)}`}
            className="mt-2 inline-block text-[13px] font-medium text-mono-900 underline underline-offset-4 dark:text-mono-50"
            data-testid="logout-code-link"
          >
            See your code
          </a>
        )}
        <div className="mt-5 space-y-2">
          {/* #348: guided to the backup, never past it. There is still no "log out anyway". */}
          {outcome.reason === 'key-not-backed-up' && (
            <a
              href="/settings/backup"
              data-testid="logout-backup-link"
              className="flex h-12 w-full items-center justify-center rounded-xl bg-mono-900 text-[15px] font-medium text-white dark:bg-mono-50 dark:text-mono-900"
            >
              {KEY_BACKUP_COPY.backUp}
            </a>
          )}
          <Button size="lg" className="w-full" disabled={busy} onClick={onRetry}>
            {busy ? 'Checking your vouchers…' : LOGOUT_BLOCKED_COPY.retry}
          </Button>
          <Button size="lg" variant="outline" className="w-full" disabled={busy} onClick={onClose}>
            {LOGOUT_BLOCKED_COPY.close}
          </Button>
        </div>
      </div>
    </div>
  )
}
