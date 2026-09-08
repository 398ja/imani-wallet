# A stall's profile is public, and card capability is self-asserted

`MerchantPage` was built from the customer's own coupons and history, and turned
away anyone holding neither with "No vouchers from this merchant." That reads as
an edge case and is the **default**: every stall a customer has not bought from
yet, including the one whose QR they just scanned. The page a purchase needs
refused the person who needs it.

**The relationship is now a section, not a precondition, and the route is
public.**

## What made this possible without new infrastructure

The stall's own record is already a plaintext kind-30078 `imani:merchant` event,
readable over an unauthenticated relay query, carrying location, description,
categories and validity. The kind-0 profile carries name and picture the same
way. A stranger's page needed no new public API because the data was already
public.

## Card capability could not come from the same place

`imani-merchant` holds the authoritative `charges_enabled`, and every one of its
endpoints sits behind `MerchantAuth.requirePubkey()` and is **self-scoped**:
there is no pubkey parameter, so a merchant can read only their own. That is a
good property and not one to weaken for a button.

So **`acceptsCards` is published on the stall's own record**, by the stall, and
is therefore self-asserted. Two things make that safe:

- **It is checked where it counts.** Creating a Checkout Session goes through
  `payment-adapter`, which knows the real `chargesEnabled` and refuses. A wrong
  flag costs a stranger one failed tap. It can never take a payment that should
  not have happened.
- **It fails closed in every direction.** Absent means false rather than "keep
  what we had", so a stall that disconnects Stripe and republishes stops
  offering cards. Only a literal `true` counts, because the record is plaintext
  JSON on a public relay and anything can appear in it. An unreachable relay
  means no record, which means no Buy button.

Deliberately **not** `active`'s rule. `active` describes an intent the stall
declared; `acceptsCards` tracks a live external fact, and a record that stops
asserting a fact has stopped being evidence for it.

The alternative — a new unauthenticated endpoint answering "can this stall be
paid" for any pubkey — buys one saved tap for a hole in the self-scoping that
protects every merchant. A bad trade.

## Consequences

- **The route is in both trees.** An unauthenticated visitor gets the relay leg
  of `merchantBranding` and `fetchMerchantRecord`; the gateway leg needs a
  session and is allowed to fail. Every branded field is optional in fact, not
  merely in type.
- **`walletIsOpen()` is new.** `listVouchers` throws without a store, and a
  visitor with no wallet is now an expected caller. Asked rather than caught,
  because catching would swallow a genuine storage failure too.
- **There is still no directory, and the reason is curation rather than
  infrastructure.** The wallet's queries all pass `authors:[pubkey]`, so nothing
  enumerates stalls today. That is a client choice, not a protocol limit: a relay
  will answer `{kinds:[30078], '#d':['imani:merchant']}` with no `authors`
  filter, and since the stall record is plaintext that single query IS a
  directory, carrying categories, location and `acceptsCards` with it.

  **This paragraph originally said a browse tab "would need a new author-less
  index, which is a much larger decision than a page". That was wrong**, and
  wrong in the expensive direction: it named infrastructure as the blocker when
  the index already exists. Corrected here rather than left to mislead someone
  into building what they already have.

  What actually stops a browse tab is that such a query returns **every** stall
  record ever published — abandoned, test, and inactive alike — with no ranking
  and no moderation, and `active` is self-asserted with nothing verifying a stall
  is real. A directory of junk is worse than none. So the decision to make is
  about curation, and it is a product decision rather than a technical one.

- **Bottin is the addressing layer, not the directory.** It maps name to pubkey
  and holds no room for anything else: `Nip05RecordEntity` carries domain,
  username, pubkey, relays, enabled and timestamps, with no metadata column. A
  flag saying "this pubkey is a live Imani stall" would mean a schema migration
  putting one product's domain concepts into a general-purpose Nostr service,
  to answer a question the relay answers better and with richer data.

  What bottin is genuinely good for here is the human-readable address a stall
  prints on a sign, since `imani.casa/@marlowbooks` beats 64 hex characters.
  Note that Imani handles now come from the gateway's `POST /api/v1/nip05`
  rather than bottin, and the two have already drifted — bottin's form allows a
  hyphen the gateway rejects (`src/lib/validate.ts`).

- **Handle lists are public, by NIP-05 design.** `GET /.well-known/nostr.json`
  with no `?name=` returns every enabled record for a domain, unauthenticated.
  That is the spec behaving correctly rather than a leak, and it applies to
  customers as much as to stalls. Recorded because it is easy to assume
  otherwise: a handle is enumerable, and it maps to a pubkey whose stall record
  and relay activity are public too.
- **A deployment prerequisite, not a detail.** `newestAddressable` reads the
  relay and the gateway, and its own comment records that a deployment which
  does not publish strfry's port loses the merchant record. An unauthenticated
  visitor has only the relay leg, so on such a deployment a stranger's page
  degrades to a bare address. It degrades closed, but it degrades.
