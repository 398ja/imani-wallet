# Running the card flows locally

Everything a stall does with Stripe — connecting an account, taking a card
payment, minting the coupon — can be exercised on a laptop with no Stripe
account at all. This is what that gets you, where it stops, and what to do when
you want to go past it.

## The default: stripe-mock, no account, no key

`imani-deploy/docker-compose.test.yml` runs `stripe-mock`, Stripe's own fake API
server, and points `payment-adapter` at it. Nothing to configure and no signup:

```bash
./deploy/up.sh
```

Settings → Payments → **Connect Stripe** then works end to end. A connected
account is created, requirements come back, and the screen renders them.

### Where it stops, and why that is not a bug

`stripe-mock` is **stateless**. Every response is a fixture, so:

- `charges_enabled` is always `false` and never advances, whatever you POST;
- the onboarding URL points at `*.dev.stripe.me`, an internal Stripe host that
  no browser can reach.

So **"Not finished yet — Stripe still needs something from you" is the permanent
end state**, and those six requirements never clear. Pressing "Finish setting
up" says so rather than doing nothing:

> This stack is running the Stripe mock, which cannot host the setup page.
> Account creation worked; finishing setup needs a real Stripe test key.

The wallet refuses to navigate to `*.stripe.me` on purpose. That URL becomes
`window.location.href`, so it is restricted to `*.stripe.com` — see
`stripeUrlRejection` in `src/lib/stripeAccount.ts`.

What the mock **does** prove: routing, edge authentication, the adapter, account
creation, requirement parsing, and the wallet's rendering of all of it. Every
hop up to Stripe itself.

## Going further: a real test key

Free, about two minutes, and no business details. Test mode hosts the genuine
onboarding pages, so the flow completes for real.

1. Sign up or sign in at <https://dashboard.stripe.com>.
2. Make sure you are in a **sandbox** (the toggle at the top). Sandbox keys are
   visible any time; live keys are shown once.
3. Go to <https://dashboard.stripe.com/test/apikeys>.
4. Copy the **Secret key**, starting `sk_test_`.

Then put both lines in `imani-deploy/.env.local`, which is gitignored:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_API_BASE=
```

and run `./deploy/up.sh` as usual. See `.env.local.example` in that repo.

**Not `.env.test`** — that file is tracked, so a key there is a key committed.

**Both lines are needed.** `STRIPE_API_BASE=` (empty) is what disables the
override; blank means "no override", so the SDK talks to Stripe. Deleting the
line does the opposite of what it looks like, because an unset variable falls
back to the compose default, which is the mock.

For a one-off without touching any file:

```bash
STRIPE_API_BASE= STRIPE_SECRET_KEY=sk_test_... ./deploy/up.sh
```

### If Connect is not enabled yet

Creating *connected accounts* may need Connect enabled on your sandbox, a
one-time form about your platform at
<https://dashboard.stripe.com/test/connect/accounts/overview>. Newer sandboxes
have it on already — try first, and only go looking if account creation fails.
It fails with a Stripe error naming the reason, and `StripeSdkConnectClient`
logs Stripe's own message, so the adapter log will say exactly what it wants.

Nothing else changes. The same code path serves both, which is the point of
having an api-base at all.

## Safety rails you cannot switch off

`STRIPE_API_BASE` is the most dangerous setting here, and it is dangerous in the
quiet direction: pointed at a fake, every charge, refund and payout **succeeds**
while no money moves. Nothing errors, health stays green, and the first symptom
is a merchant asking where their payout is.

So `payment-adapter` **refuses to boot** unless the api-base names a known local
mock (`localhost`, `127.0.0.1`, `host.docker.internal`, `stripe-mock`). A real
hostname fails startup with a message naming the value and the fix. An
unstartable service is noticed in minutes; a silently fake one is not.

The check is on the **host**, deliberately, not on the key. "Only allow an
override with an `sk_test_` key" sounds stricter and misses the only case that
matters: the disaster is a *live* key aimed at a fake, and a rule keyed on the
test prefix never fires on a live key.

## When something fails

- **The adapter log names the cause, including which Stripe it reached.**
  `docker logs payment-adapter-test | grep stripe_connect_failed`. Verified with
  a deliberately bad key against real Stripe:

  ```
  stripe_connect_failed operation=create_connected_account status=401
    code=null api_base=stripe message=Invalid API Key provided: sk_test_****only
  ```

  `api_base=stripe` means the real API; a URL there means the mock. The key
  itself is never logged, and Stripe masks it in its own message.
- **`stripe-mock` rejects underscores after the prefix.** `sk_test_a_b` is a
  401; `sk_test_ab` is fine. It arrives as "Failed to create Stripe connected
  account", which reads like a connectivity problem and is not.
- **A 502 from `/api/v1/merchant/stripe/*`** now carries the reason in the body
  (`server.error.include-message: always` in merchant-service), so the wallet
  shows what actually happened rather than guessing at the network.
