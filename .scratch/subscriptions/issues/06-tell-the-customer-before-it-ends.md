# 06: Say it is ending, before it ends

**What to build:** Expiry notice. An in-app banner from seven days out, and a DM at
seven days and again on the last day.

Two channels because they reach different moments: the DM reaches an owner who is
not looking at the app, on the delivery path already trusted for everything else,
and the banner reaches them at the till. One missed message should not be a lapse.

Neither blocks anything. This is information, not a gate, and a notice that
interrupts trade to talk about billing would be the same mistake the lapse design
exists to avoid.

**Blocked by:** 03

**Status:** done

- [x] A banner appears from seven days out and names the date.
- [x] A DM goes at seven days and on the last day.
- [x] Neither blocks, modals over, or interrupts anything in progress.
- [x] Renewing clears the notice without the customer dismissing it.
- [x] A customer who never renews is told twice and then simply lapses, with no
      further nagging.

## What it took

`src/lib/expiryNotice.ts` decides whether there is anything to say,
`src/components/SubscriptionNotice.tsx` says it at the till, and
`scripts/notify-expiring.mjs` sends the two DMs.

Decisions worth keeping:

- **Derived, never stored.** There is no "dismissed" flag anywhere. The notice
  is a function of the signed expiry and the clock, which makes "renewing clears
  the notice" true for free — a renewal has a later expiry, so the banner
  evaluates to nothing on the next render. A flag would also hide the one
  warning before a lapse from whoever dismissed it on day seven.
- **The banner is on the DASHBOARD, not the till.** The ticket says "reaches
  them at the till", but the till was deliberately emptied of everything else
  because it is held facing outward — "your subscription ends in 5 days" is the
  stall's private business, not something to show the customer being served. The
  Dashboard is where the owner already reads what they owe, away from the
  counter. The DM covers the owner who is not looking at the app at all.
- **Nothing under grace.** Under the grace window the expiry is the one last
  read, and a renewal is exactly what could not be read — so warning from it
  risks telling a merchant who renewed yesterday that they are about to lapse.
- **The sale records itself.** `sell-subscription.mjs` now writes
  `.sold-subscriptions.json`, because a notice job cannot warn about a
  subscription nobody wrote down, and hand-maintaining that file means the one
  customer who is missed is the one who lapses silently. Gitignored: it is a
  list of paying customers by pubkey, which is the thing this design avoids
  holding server-side.
- **The DM is wrapped and published here.** There is no general-purpose DM
  endpoint on the gateway — `/api/v1/dm/tokens/send` is the COUPON path and
  builds a `cashu_token_transfer` payload, so a plain sentence sent that way
  would arrive as a transfer with no token. Verified by reading
  TokenDmController.

## Evidence

22 tests. The mutation controls bite: warning under grace fails 1, dropping the
lapse guard fails 1, and making the banner a fixed overlay fails 1.

The lapse-guard control is worth noting. It first SURVIVED, because
`licenceStatus` refuses an expired licence before this module sees it, so the
guard is unreachable by the normal path. Rather than delete it as dead code —
it is the only thing between a caller holding a minute-old status and a banner
announcing a dead subscription is "ending soon" — a test now passes that stale
status directly, and removing the guard fails it.

A drift guard also compares the script's DM schedule against `dmDueOn` day by
day across the final fortnight, so the two channels cannot disagree about when a
customer is warned.
