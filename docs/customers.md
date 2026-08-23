# Shopper's guide

Imani Wallet holds **coupons** from the local businesses you buy from. A coupon
is like a gift card: a merchant gives it a value, sends it to you, and you spend
it with them later, all or part at a time. This guide walks you through it.

- [Setting up](#setting-up)
- [Your wallet at a glance](#your-wallet-at-a-glance)
- [Receiving a coupon](#receiving-a-coupon)
- [Paying with a coupon](#paying-with-a-coupon)
- [Getting change](#getting-change)
- [Keeping your account safe](#keeping-your-account-safe)
- [Common questions](#common-questions)

## Setting up

1. Open the app. Choose **Create an account**.
2. Pick a **handle**, like `alice@imani.casa`. This is the name merchants use to
   send you coupons, so pick something you don't mind sharing. It works like an
   email address for your wallet.
3. Choose a **passphrase**. You'll type it to unlock the wallet on this device.
4. **Save your backup key.** The app shows it once, on a screen you can't skip.
   Write it down and keep it somewhere safe. This is covered in detail
   [below](#keeping-your-account-safe), and it matters more than anything else here.

Already have a key from before? Choose **enrol an existing key** instead and
paste it in.

## Your wallet at a glance

The home screen shows:

- **Your total balance**, added up across all your coupons.
- A **deck of cards**, one per merchant you hold coupons from. Swipe through them.
  Each card is that merchant's identity and their running total with you. Tap one
  to see their coupons and your history together.
- Two buttons: **Scan** (to pay) and **Receive** (to be paid).

Tap a merchant's card to open it, then tap through to a single coupon to see its
value, when it expires, and a QR code for it.

## Receiving a coupon

You don't have to do anything to receive. When a merchant sends you a coupon:

1. A little message pops up: **"[Merchant] sent you €5 — on its way."**
   This appears the instant they send, before the coupon has fully arrived.
2. A few seconds later the coupon lands in your wallet, filed under that
   merchant. Your balance goes up.

To let a merchant send to you, show them your code:

- Tap **Receive**. The app shows a QR code of your handle.
- The merchant scans it, types the amount, and sends.

That's the whole flow. If a coupon seems slow to arrive, give it a moment: the
"on its way" message means it's already been sent to you.

## Paying with a coupon

To pay a merchant back with the coupons you hold from them:

1. The merchant shows you a **payment request QR** (they create it on their till).
2. Tap **Scan** and point your camera at it. No camera? Use **paste** to drop in
   a code they've sent you.
3. A confirmation screen shows who you're paying, how much, and any note. Check it.
4. Tap **confirm**. The coupon value transfers to the merchant, and you get a
   receipt.

The app only lets you pay a merchant with coupons **from that same merchant**.
If the confirmation screen warns about an expired coupon, not enough balance, or
no matching coupon, it will say so plainly rather than fail silently.

## Getting change

You don't need an exact-value coupon to pay a smaller amount.

- Pay €2 with a €5 coupon, and the €5 coupon is replaced by a new **€3 coupon**
  from the same merchant. Your total drops by exactly what you spent.
- Pay the full value, and the coupon is used up and leaves your wallet.

There is a tiny floor on how small a split can be (it depends on the coupon), but
for everyday amounts you'll never hit it. Paying a coupon in full is always
allowed.

## Keeping your account safe

Imani Wallet is **self-custodial**. That's a fancy way of saying: your coupons
live on your phone, and only your key can spend them. There is no company holding
your balance, which is good for your privacy and control, but it means the
responsibility for the key is yours.

**Your backup key is the master key to your wallet.**

- It's shown once, when you sign up. Write it down. Store it somewhere safe and
  private, not in a photo on the same phone.
- You can also download an **encrypted backup file** from **Settings → Backup**.
  It's protected by your passphrase, so it's safe to keep in cloud storage.
- Anyone who has your key can spend your coupons. Treat it like cash.

**There is no password reset.** Nobody, not even the people who run the service,
can recover your account for you. If you lose both your key and your backup file,
the coupons in that wallet are gone. This is the trade-off for holding your own
value.

To move to a new phone: install the app, choose **restore from backup**, open
your backup file, and unlock it with your passphrase.

**Logging out wipes this device.** It erases your key from this phone (the
coupons stay in place but become unusable without the key). Only log out if you
have your backup. The app warns you before it does this.

## Common questions

**Is this cryptocurrency?**
Under the hood it uses the same kind of technology, but you never see it. To you
it's coupons with a value, sent and spent. No exchanges, no wallets full of
coins, no prices going up and down.

**Do coupons expire?**
They can. A coupon shows its expiry date if it has one. Merchants set this when
they issue.

**Can I use one merchant's coupon at another shop?**
No. A coupon is tied to the merchant who issued it. You spend it back with them.

**What if I get a new phone?**
Restore from your backup file and passphrase. Your coupons come back from the
network. (Any coupon you'd already spent stays spent, which is correct.)

**Someone sent me a coupon but it hasn't shown up.**
You'll have seen the "on its way" message if it was sent. Settlement takes a few
seconds. If it's much longer, check your connection and reopen the app.

---

Want to understand what's really happening when you send and receive?
Read **[How it works](how-it-works.md)**.
