# End-to-end checks

These drive the **real app in a real browser** against the live `imani-test`
stack. Everything else in this repo mounts components in jsdom, which proves
the component and not the product: jsdom cannot catch a broken route, a page
that throws on mount, an import only the bundler resolves, or CSS that does
not apply.

## Running

```sh
docker compose -f ../imani-deploy/docker-compose.test.yml up -d   # the stack
npm run dev -- --port 5177                                        # NOT preview
npm run e2e                                                       # terminals
npm run e2e:purchase                                              # card purchase
```

The **dev server, not `vite preview`**: the API proxy that registration needs
is defined in `vite.config.ts` and preview does not apply it. Hitting preview
gets you a redirect to `/onboarding` and nothing else.

## What it covers

A merchant registers for real against the gateway, then the terminal screens
are driven by clicking. 51 checks, spanning terminals 05-10 and subscriptions
07-08.

The suite was written partway through the work, so it was afterwards extended
BACKWARDS over the tickets that predated it — role gating, the dashboard
guard, decommissioning, and the subscription diagnostics screen. Ticket 07's
gating in particular had never run in a browser before that: it was
unreachable until ticket 10 wired the login, and the wiring is exactly what a
component test cannot check.

Notably it checks things unit tests structurally cannot:

- clicking a `<label>` focuses its input (the `htmlFor` fix)
- `prefers-reduced-motion` actually suppresses the confirmation animation,
  **and** that it animates without the preference — so the check cannot pass
  by the class never being applied
- no uncaught page errors at any point
- that a terminal cannot reach `/merchant/dashboard` by TYPING the URL, which
  is the control rather than the courtesy — verified separately from the menu
  being hidden, because those are two different guards and either could rot
- that the owner's own device is unaffected by every terminal rule, checked
  after each one

## What this found

Running it for the first time immediately surfaced a real defect that every
unit test had missed: registration failed with HTTP 500 because
`application.yml` in imani-gateway-core spelled the password fallback
`MERCHANT_IDENTITY_BOTTIN_PASS` instead of `..._PASSWORD`. The username
resolved and the password did not, and a Bottin client with one and not the
other disables itself. That is the class of bug only the real path finds.

## The mint probes

`e2e/probe-spend.mts` answers a question no mock can: does NUT-07 checkstate
SPEND a credential? Ticket 10 requires that verification never spends, and
`credentialRevocation.test.ts` only proves our code does not *call* receive.

```sh
MINT_URL=http://localhost:27777 npx tsx e2e/probe-spend.mts
```

Observed 2026-09-04 against cashu-mint 0.35.0: three consecutive checkstate
calls on a real gateway-minted credential all returned `UNSPENT`. Checking is
non-destructive at the mint, not merely in our client.

The other half is gated, because it destroys what it spends:

```sh
# Mint a throwaway first — never point this at a committed fixture.
node scripts/mint-terminal-credential.mjs --stall-name imani-terminals \
  --device $(openssl rand -hex 32) --role redeem-only --out doomed.token
MINT_URL=http://localhost:27777 PROBE_SPEND=1 \
  PROBE_TOKEN=src/lib/__tests__/fixtures/doomed.token npx tsx e2e/probe-spend.mts
```

Observed: `receive` returned 200, and the following checkstate returned
`SPENT`. So revocation really is irreversible and global — the pair matters,
because "checking never spends" would also pass against a mint that ignored us
entirely.

## Locked (P2PK) coupons — issue #58

`probe-gateway-locked-redeem.mts` and `probe-receive-atomicity.mts` cover
self-custody end to end against the live stack: a coupon locked to the
customer's key, refused unsigned by the mint, spendable with their signature,
and the proofs it mints spendable again afterwards.

**What is wired, and what is not.** Locking works on issuance
(`recipient_pubkey` → `merchant_metadata.lock_key`) and the client signs on
`api.receive`, which covers redemption, burn and credential revocation. The
voucher *split* endpoint accepts witnesses too.

The gap is gateway-core's atomic-send saga, the client's ordinary pay path. It
forwards to the split endpoint from an `@Async` worker, so the originating
request's headers are gone; it persists the source token but has no witness
column and no customer key. Carrying signatures across that hop needs a schema
change and a decision about holding customer signatures server-side.

That gap is currently latent rather than live: nothing in production sets
`recipient_pubkey` on voucher creation, and `terminalMetadataJson` — the other
producer of a `lock_key` — is called only from tests. So no locked coupon
reaches the saga today. It becomes a real defect the moment either is switched
on, which is why the probes exist now rather than later.

## `purchase.e2e.ts` — the card purchase

Written after a shopper's card was refused inside Stripe's hosted checkout
(400 on `/v1/payment_pages/.../confirm`) because the stall's connected account
had never been asked for the `card_payments` capability. `transfers` alone set
`charges_enabled`, so every flag we stored said the stall could sell.

`BuyPage` and `purchase.ts` both promise, in prose, that everything refusable
is decided BEFORE the customer sees a card form. That promise was false and
nothing held it, because holding it needs the real screen, the real proxy, the
real controller and the real account state at once.

So it asserts the REFUSAL LANDS ON OUR SCREEN — a stall that cannot take a card
fails on the Buy page, in our words, with no navigation to `checkout.stripe.com`
— rather than asserting a payment completes. That needs no fully-onboarded
Stripe account, so it still runs in CI; and completing Stripe's own form would
require a bank account and TOS acceptance no script can supply, besides testing
Stripe's DOM rather than ours.

Verified by mutation: flipping `charges_enabled` back to true in the test
database reproduced the incident exactly, landing the browser on a real
`checkout.stripe.com` session that would 400 at confirm. 4 of 11 checks red.
