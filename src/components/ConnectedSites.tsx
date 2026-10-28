import { useState } from 'react'

import { Button, ListSection } from './ui'
import { walletConsentStore } from '../lib/napSignerPage'
import { siteDescription, siteName } from '../lib/napSignerPolicy'

/**
 * Settings › Security › Connected sites (#411): the sister sites this wallet has said "yes" to,
 * for this key, and a way to take that back.
 *
 * A "yes" holds no secret (an origin, a pubkey and a scope), and what it buys is only that the
 * signer popup does not ask the question again: the passphrase is still asked every time, and each
 * grant still lasts minutes. Removing one makes the popup ask again next time; it does not sign
 * the site out of a session it already has.
 */
export function ConnectedSites({ pubkey }: { pubkey: string }) {
  const store = walletConsentStore()
  const read = () => {
    const all = store.list()
    return (Array.isArray(all) ? all : []).filter((r) => r.pubkey === pubkey)
  }
  const [sites, setSites] = useState(read)

  return (
    <ListSection title="Connected sites">
      {sites.length === 0 ? (
        <p className="p-4 text-sm text-mono-500">No site can sign you in without asking first.</p>
      ) : (
        <ul className="divide-y divide-mono-200 dark:divide-mono-800">
          {sites.map((s) => (
            <li key={s.origin} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="truncate font-medium">{siteName(s.origin)}</p>
                <p className="text-sm text-mono-500">May sign you in to {siteDescription(s.origin)}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void Promise.resolve(store.forget(s.origin, pubkey)).then(() => setSites(read()))
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </ListSection>
  )
}
