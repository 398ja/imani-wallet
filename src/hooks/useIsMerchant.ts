import { useEffect, useState } from 'react';

import { isMerchantPubkey } from '../lib/merchant';

/**
 * Does this pubkey have a stall? False until the answer arrives.
 *
 * Lives here rather than beside `Avatar`, which is where it started: exporting
 * a hook from a component file breaks React Fast Refresh, and eslint says so.
 * Two components need it now — the avatar draws a merchant badge, and
 * `IdentityInline` links a stall's row to its profile — so the shared answer
 * needs a shared home.
 *
 * ONE source for both, deliberately. A row that shows the merchant badge is
 * exactly a row that links; two lookups could disagree and produce a badge with
 * no link, or a link on someone with no stall.
 *
 * The pubkey is stored WITH the answer and compared on the way out, for the same
 * reason `useIdentity` does it: these components are reused across rows, and a
 * badge left over from the previous person is a claim about the wrong person.
 */
export function useIsMerchant(pubkey: string | undefined): boolean {
  const [resolved, setResolved] = useState<{ pubkey: string; merchant: boolean }>();

  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    void isMerchantPubkey(pubkey).then((merchant) => {
      if (!cancelled) setResolved({ pubkey, merchant });
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  return resolved !== undefined && resolved.pubkey === pubkey && resolved.merchant;
}
