# Merchant's guide

Imani Wallet lets you **sell coupons** to your customers and **take them back as
payment** later. It's built for market stalls, farm gates, and small shops: sell
a coupon today, redeem it for goods tomorrow, and always know what you've issued
and what's still out there.

- [Why sell coupons](#why-sell-coupons)
- [Setting up your stall](#setting-up-your-stall)
- [Your till at a glance](#your-till-at-a-glance)
- [Selling a coupon](#selling-a-coupon)
- [Taking payment (Redeem)](#taking-payment-redeem)
- [History, stats, and what's expiring](#history-stats-and-whats-expiring)
- [Opening and closing your stall](#opening-and-closing-your-stall)
- [Running more than one till](#running-more-than-one-till)
- [Proving you honoured a coupon](#proving-you-honoured-a-coupon)
- [Keeping your account safe](#keeping-your-account-safe)
- [Common questions](#common-questions)

## Why sell coupons

Selling coupons up front is an old market trick with real benefits:

- **You know your sales sooner.** Money comes in when the coupon is bought, not
  only when goods leave the stall.
- **Regulars come back.** A coupon in a customer's wallet is a reason to return.
- **No card fees or card reader.** Customers pay you back from coupons they
  already hold, phone to phone.
- **No forgeries.** Every coupon is a unique digital token. It can't be copied,
  and once it's spent back to you it can't be spent again.

## Setting up your stall

1. Open the app and choose **Create an account**.
2. Turn on the **"I am a merchant"** switch during sign-up. (Already a shopper?
   You can start selling later, see [below](#opening-and-closing-your-stall).)
3. Fill in your **stall details**: business name, a short description, categories,
   and how long the coupons you issue stay valid.

   > **Choose validity carefully.** How long your coupons last is set once and
   > can't be changed afterwards. The app tells you this before you pick.
4. Pick a **passphrase** and **save your backup key** (the app shows it once,
   see [Keeping your account safe](#keeping-your-account-safe)).

Your business name and description are what customers see on the coupon card in
their wallet, so make them recognisable.

## Your till at a glance

A merchant's home screen is the **till**:

- **Sell** — issue a coupon to a customer.
- **Redeem** — take a coupon back as payment.
- Recent movements, with links to your full history.
- **Expiring soon** — coupons you've issued that are within a week of expiry (only
  shown when there are some).

**Stats** live in the account menu (top-right): coupons issued, value issued, how
many came back, and daily activity over the last 7, 30, or 90 days.

## Selling a coupon

```mermaid
flowchart LR
    A[Tap Sell] --> B["Scan the customer's Receive QR"]
    B --> C[Type the amount]
    C --> D[Send]
    D --> E["Customer's phone: on its way"]
    E --> F[Coupon settles in their wallet]
```

1. Tap **Sell**.
2. Ask the customer to open **Receive** on their phone, then scan their QR code.
3. Type the **amount** in your currency.
4. Tap send. Hold on a moment while it completes: the coupon is created, signed,
   and delivered to the customer.
5. The customer's phone shows *"on its way"* immediately, and the coupon lands in
   their wallet a few seconds later.

Keep the customer there until it confirms. If a delivery fails, it's better to
know while they're still at the stall.

## Taking payment (Redeem)

When a customer pays you back with a coupon they hold from you:

1. Tap **Redeem**. The app creates a **payment request** and shows a QR code with
   the amount you're asking for.
2. The customer taps **Scan**, points at your QR, and confirms.
3. The coupon (or part of it) transfers to you. The screen updates from
   *"Waiting for payment"* to **paid** on its own.

You don't need to press anything to detect the payment: your till is already
listening, and the coupon arrives through the same channel any coupon does. If
the customer pays less than a whole coupon, they keep the change automatically.

## History, stats, and what's expiring

- **Transactions** lists every movement: coupons you issued and coupons that came
  back. Tap one to see its detail.
- **Vouchers** lists what you've issued. It shows the ones still valid by default,
  with a switch to bring in the ones that have run out — useful when a customer
  turns up holding a lapsed coupon and you want to see what it was worth.
- **Expiring soon** on the till surfaces coupons about to lapse, soonest first, so
  you can nudge customers to spend them.
- **Stats** gives you the totals: issued, returned, and a simple day-by-day chart.

### When a customer claims your cashback

When a customer types in a cashback code you gave them, your till hears about it
within seconds: a notification (if you allowed them) and a bell entry such as
"€5.00 cashback claimed (CB-ABCDE-FGHIJ)". The cashback on your Vouchers list and
its own screen switch to "Claimed" at the same moment, with no need to open it.

If notifications are off in your browser, the bell still gets the entry the next
time the app is open. Either way you get one entry per cashback, not two. The
"a coupon you sent was claimed" switch in notification settings covers this too.

### What a voucher's own screen tells you

Tap a voucher, or scan a customer's pass, and you get its record:

- **How much has been claimed** against it so far, and how much is still out
  there. A coupon can be spent in parts, so these are running totals rather than
  a yes or no, and the transactions that claimed it are listed underneath.
- **How it was paid for**: by card, at the counter, or not recorded. That last one
  is normal — it covers every sale you made before signing was added, and every
  sale made on one of your terminals.
- **Whether it was authorised**: whether the signature your stall put on the sale
  still matches the sale beside it. If it ever says the two don't match, that is
  worth looking at.
- **Whether the customer signed for it.** Most sales have none, and that is not a
  fault — it's evidence a customer can offer, never something a sale requires.

Worth keeping straight: *authorised* means you meant to issue that value. It does
not mean you were paid. Only the customer's own signature says money arrived, and
on a counter sale there is nobody else to ask.

A note on honesty: these figures are **your device's own record** of what you've
issued and what's returned. The app tells you so on the Stats screen. Whether a
customer has spent a coupon you gave them isn't something you can see, it's value
in their wallet until it comes back to you.

If you take coupons on more than one device, each device counts the claims that
reached it. The others' catch up when that device next restores your history, so
for a short while a voucher can read as having more left than it does. The mint
still refuses any coupon that has already been spent. Coupons redeemed before
claimed figures existed are matched up when you next log in, as long as the
coupon itself is still on this device.

If you sell in a currency without cents (like XAF or JPY), amounts show correctly
on your till and on your customer's screen.

## Opening and closing your stall

- **Open for business** is a switch in **Settings → your stall**. Turn it off when
  you stop trading, and your home screen goes back to the shopper view (Pay /
  Receive). Your settings and history stay put; turn it back on to sell again.
- **Starting to sell as a shopper:** go to **Settings → Start selling** and fill in
  your stall details. No new account, your coupons and identity come with you.

## Running more than one till

A device at the door, a till at the counter, the phone in your pocket: each
extra device is a **terminal**. You name it, choose whether it may sell or only
take coupons back, and revoke it whenever you like — including when the device
is lost or stolen. A terminal never holds your money and never sees your
figures, and your own phone keeps working exactly as it does now.

Full walkthrough: **[Terminals guide](terminals.md)**.

## Proving you honoured a coupon

Every time you redeem a coupon, the wallet publishes a small public record
saying a coupon was honoured. It carries no amount, no customer, and not your
stall name, so it proves you kept your side of the bargain without showing
anyone your takings.

You mostly never need to think about it. When you do — an auditor asks, or a
coupon issuer wants to check your record — it lives at **Settings → Redemption
ledger**, and the [redemption ledger guide](redemption-ledger-user-guide.md)
covers your ledger ID, checking for gaps, and proving your totals.

## Keeping your account safe

Everything in the [shopper's guide on safety](customers.md#keeping-your-account-safe)
applies to you too, and your history matters as much as your coupons:

- **Your backup key is the master key.** Shown once at sign-up. Write it down and
  keep it private. Anyone with it can act as your business.
- **Your sales history follows your key, not this phone.** It's stored securely on
  the network, encrypted to you. Log in on a new phone with your key and your
  stall, sales, and stats come back.
- **Download a backup file** from **Settings → Backup** as well. It's encrypted
  with your passphrase.
- **There is no password reset**, and **logging out wipes this device.** Only log
  out when you have your backup.

## Common questions

**Where does the value come from?**
From you. A coupon is your own promise to honour it for goods, exactly like a
paper voucher. What the app adds is that the promise can't be forged, copied, or
spent twice. There's no separate pot of money behind a coupon, which is also why
it's only ever worth something at your stall.

**Can a customer spend my coupon somewhere else?**
No. Coupons are tied to you. They can only be redeemed back with your stall.

**Can a coupon be spent twice?**
No. Once a coupon comes back to you it's used up. Partial payments leave the
customer a smaller coupon and take the rest, with no way to double-spend.

**A customer says their 2,500 coupon shows as 25.00.**
This was a display bug affecting currencies without cents — XAF, XOF, FCFA,
JPY, KRW and the rest — and it's fixed: amounts show correctly on the
customer's coupon screen, in their notifications, and on your till, including
for coupons issued before the fix. There's no longer a reason to prefer EUR or
USD over your own currency. If you still see a figure that's 100x out, that's
worth reporting, as it's a bug rather than expected behaviour.

**Do I need a card reader or a merchant bank account?**
No. Everything happens phone to phone through the app.

---

Curious about what a coupon really is and why it's secure?
Read **[How it works](how-it-works.md)**.
