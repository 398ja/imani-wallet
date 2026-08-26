# How it works

This guide explains the ideas behind Imani Wallet in plain language, for shoppers
and merchants who want to understand what's happening under the hood. You don't
need any of this to use the app, but it explains why the wallet behaves the way
it does, especially around safety.

- [What a coupon really is](#what-a-coupon-really-is)
- [Why it can't be forged or copied](#why-it-cant-be-forged-or-copied)
- [Your key, and self-custody](#your-key-and-self-custody)
- [Handles: your address](#handles-your-address)
- [The instant "on its way" message](#the-instant-on-its-way-message)
- [Splitting a coupon and getting change](#splitting-a-coupon-and-getting-change)
- [Where your things are stored](#where-your-things-are-stored)
- [The building blocks](#the-building-blocks)

## What a coupon really is

When you hold a coupon, you're not holding a number in a company's database that
says "Alice has €5." You're holding an actual **digital token**, a unique piece of
data that carries value, sitting on your phone.

Think of a physical banknote. The value is *in the note itself*, in your pocket.
You don't need to ask a bank's permission to hand it over. A coupon in Imani
Wallet works the same way: the value is the token, and the token is on your
device. This is what people mean by **digital cash**.

Each coupon also remembers who issued it (the merchant) and what it's worth, and
it can carry an expiry date.

## Why it can't be forged or copied

Two things make a coupon trustworthy:

1. **It's cryptographically unique.** The token is minted with a digital
   signature that can be checked but not faked. You can't photocopy it into two
   working coupons, the way you could a paper voucher.
2. **Spending it destroys it.** When you pay a merchant, your coupon's token is
   swapped for a fresh one at the point of payment. The old token becomes
   worthless the instant it's used. This is why the same coupon can't be spent
   twice, by you or anyone who somehow got a copy.

The merchant who issued a coupon backs it with real value when they create it, so
a €5 coupon is genuinely worth €5, not a promise that might bounce.

## Your key, and self-custody

Everything in your wallet is controlled by one secret: **your key.**

- Your key proves the coupons are yours and lets you spend them.
- It's stored on your device, encrypted with your passphrase. It never leaves in
  plain form.
- **Self-custody** means *you* hold this key, not a company. There's no central
  account holding your balance.

The upside is real: privacy, control, no one freezing your funds. The
responsibility is equally real:

- **Anyone with your key can spend your coupons.** Guard it like cash.
- **There's no password reset.** No support line can recover your account. If you
  lose your key *and* your backup file, the coupons are gone.
- That's why the app makes such a point of your **backup key** at sign-up, and why
  logging out deliberately **wipes the key from the device** (the encrypted backup
  is how you come back).

This is the single most important thing to understand about the wallet. Make a
backup, keep it safe.

## Handles: your address

Typing a long string of random characters to send someone a coupon would be a
nightmare. So the wallet gives you a **handle** like `alice@imani.casa`, which
works like an email address: it's short, it's yours, and it points to your key.

- Shoppers show their handle (as a QR code, via **Receive**) so a merchant can
  send them a coupon.
- Merchants have a handle too, and it's how their coupons are attributed to them.

Behind the handle is your real cryptographic identity. The handle is just the
friendly name on the front.

## The instant "on its way" message

There's a small delay between a merchant sending a coupon and it fully **settling**
into your wallet, because the value has to be minted and delivered behind the
scenes. That can take a few seconds.

To avoid a confusing wait, the moment a merchant sends, the network fires off a
tiny, instant notification, and your phone shows **"[Merchant] sent you €5 — on
its way."** It carries no actual value, it's just the heads-up. The real coupon
follows seconds later and updates your balance.

So: the toast means *it's been sent and is coming*. The balance change means
*it's arrived.*

## Splitting a coupon and getting change

You don't need exact change. If you pay €2 with a €5 coupon:

1. At the moment of payment, your €5 token is split.
2. €2 of value goes to the merchant.
3. The remaining €3 comes back to you as a **new €3 coupon** from the same
   merchant, and your old €5 coupon is gone.

Your total only ever drops by exactly what you spent. There's a small technical
floor on how tiny a split can be, but everyday amounts are always fine, and paying
a coupon in full never requires a split at all.

## Where your things are stored

Different things live in different places, chosen for privacy and recovery:

- **Your coupons** live on your device (in the app's local storage), because
  they're bearer value, like cash in your pocket.
- **Your key** lives on your device too, encrypted with your passphrase.
- **Your profile and, for merchants, your sales history** are published to the
  network in a form only your key can read (encrypted to you), so a new phone can
  restore them. Your stall's public details (name, description) are readable by
  design, so customers can recognise you; your takings are not.

This is why logging in on a new phone with your key brings your identity and
history back, while a coupon you'd already spent stays spent.

## The building blocks

For the curious, the open technologies this is built on:

- **Cashu** — the digital-cash system that makes coupons unforgeable bearer
  tokens, backed by a "mint." This is what makes a coupon behave like cash.
- **Nostr** — the messaging network that delivers coupons (as private,
  encrypted messages) and carries profiles and history. Your handle and key are
  Nostr identities.
- **Lightning / Bitcoin** — the value layer the mint uses to back coupons behind
  the scenes. You never touch it directly.
- **NAP** — the login system that unlocks your key and keeps your session,
  without ever copying the key out of its secure store.

You never see any of these names in the app. They're the plumbing that lets a
coupon arrive in seconds, cost nothing to send, and be impossible to forge.

---

Back to the guides: **[Shoppers](customers.md)** · **[Merchants](merchants.md)** ·
**[README](../README.md)**

For the philosophy behind these choices, and why there is no central database to
breach, see **[The decentralised posture](decentralised-posture.md)**.
