# Try Imani on staging

The staging environment is open to everyone: **<https://wallet.staging.398ja.xyz>**.
Nothing there is real money. Card payments run on Stripe test mode, so use the
test card `4242 4242 4242 4242` with any future expiry and any CVC.

New to Imani? Start with [How Imani works in 50 seconds](https://www.youtube.com/shorts/5X_hBQ4ke7E).

| Site | What it is for |
| --- | --- |
| <https://wallet.staging.398ja.xyz> | The wallet, for customers and shops |
| <https://faucet.staging.398ja.xyz> | Free test vouchers, straight into your wallet |
| <https://shop.staging.398ja.xyz> | A demo WooCommerce store that takes `IMANI-` coupon codes |

- [As a customer](#as-a-customer)
- [As a merchant](#as-a-merchant)
- [Free test vouchers (the faucet)](#free-test-vouchers-the-faucet)
- [Online checkout](#online-checkout)

## As a customer

1. Open the wallet, tap **Register**, pick a handle and a passphrase, and write
   down your backup key when it is shown.
   Video: [How to set up your Imani wallet](https://www.youtube.com/shorts/VoG05jwDn-w)
2. Get a voucher: tap **Receive** and show your code to a shop, buy one by card,
   or claim one from the [faucet](#free-test-vouchers-the-faucet).
3. Spend it back at that shop with **Scan**, in full or in part, and watch the
   change come back as a smaller voucher.
4. Give some away. Videos: [Send a voucher to a friend](https://www.youtube.com/shorts/PkT1ouKFofk),
   [Send a voucher as a link (Cashlink)](https://www.youtube.com/shorts/2OpN8y_NR6M)

## As a merchant

1. Register a second account (another browser or a private window works) and
   set up your shop.
   Video: [How to set up your shop on Imani](https://www.youtube.com/shorts/9pSnOkwOmeE)
2. Use **Sell** to issue a voucher to your customer account's code, and
   **Redeem** to take it back at the till.
   Video: [Sell a voucher and get paid: Redeem vs Pay](https://www.youtube.com/shorts/O3CjYDqJCzA)
3. Let customers buy by card (Stripe test mode on staging).
   Video: [Stripe setup](https://www.youtube.com/shorts/zGAFJiVr7oQ)
4. Add a second device for staff.
   Video: [Terminals](https://www.youtube.com/shorts/oH3RL5uwrvI)
5. Check your records.
   Video: [Dashboard, Vouchers and Transactions](https://www.youtube.com/shorts/zTAHj3bUsgo)

## Free test vouchers (the faucet)

Need vouchers to try spending, splitting or gifting without setting up a shop?
The faucet at **<https://faucet.staging.398ja.xyz>** issues them from test shops
straight into your wallet. It is staging only, and its vouchers are as unreal as
everything else here.

**Sign in with your staging Imani customer account.** The faucet has no accounts
of its own: you log in with the **nsec** (backup key) of the customer account you
registered at <https://wallet.staging.398ja.xyz>, and vouchers go to that wallet.
If you have no staging account yet, register one first (step 1 under
[As a customer](#as-a-customer)).

1. In the staging wallet, signed in as your customer account, open
   **Settings > Backup**, enter your passphrase and tap **Show my backup key**,
   then **Copy backup key**. That is your nsec: it starts with `nsec1`.
2. Open the faucet and paste the nsec under **Sign in**. It is checked in your
   browser, and only your public key is sent to the faucet.
3. Pick a shop. The **Starter**, **Essentials** and **Pro** filter shows shops on
   each plan.
4. Enter an amount (or tap a suggested one) and tap **Send to my wallet**. The
   voucher arrives in your wallet as a message within a few seconds, and
   **Your requests** shows it as delivered.

Limits: up to the shop's maximum per voucher (2,000 minor units by default, so
20.00 in the shop's currency) and 20 requests per account per day.

Use your **customer** account's nsec, never a shop's. A key that already runs a
shop is refused, so a shop cannot fund itself. Faucet admins and the super
admin cannot request vouchers either: they create the test shops under
**Admin**, and can read the audit log there. Ask on a GitHub issue if you need
a shop added.

Your nsec controls your account. Paste it only into the faucet and the wallet,
and only for your staging account: never use a production key here.

## Online checkout

The demo WooCommerce store at <https://shop.staging.398ja.xyz> takes `IMANI-`
coupon codes made in the wallet.

## Good to know

Staging is reset from time to time, and feedback is welcome as
[GitHub issues](https://github.com/398ja/imani-wallet/issues).
