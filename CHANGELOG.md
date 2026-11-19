# Changelog

All notable changes to the Imani wallet are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Logout is refused until your key is backed up somewhere Imani knows of** (#348). One Google Drive backup (read back right after the upload) or one downloaded backup file is enough, and the check works offline. There is no override: the refusal leads to Backup. A backup made before a passphrase change does not count.
- **Imani tells you where your key went, and not to delete it** (#348). After a backup, the screen names your Google Drive (private app storage) or the file in your Downloads. Settings has a new "Your key backup" section listing every known backup across your devices, with a "Check a backup file" step, and the logout screen shows the same before you confirm.
- **Each install has a device id and a friendly name** (#348), and the backup locations travel between your devices in one record encrypted to your own key, read from the relay and the gateway.

### Fixed

- **Turning on card sales no longer locks a stall out for a day after two failures** (#306). The enrol step is retried on a 502 or a lost answer with the SAME minted credential, instead of minting a new one each attempt (the gateway holds at most two unconfirmed per stall for 24 hours). If it never lands, the phone cancels its own unconfirmed credential so the slot comes back at once. A lost answer that did land is recognised from the stall's status and counted as on.
- **Re-enrolling cancels the card-sales credential it replaced** (#306). It used to stay live at the gateway for a year.
- **purchase-issuer: the begin map can no longer be filled to lock stalls out** (#306). A stall that begins again within a minute gets the same lock key back, and when 1000 enrolments are in progress the oldest is dropped instead of refusing the newcomer.
- **A Cashlink is "delivered" only once the relay holds it** (#532). `deliver` and the direct-send `publishWrap` count a wrap only when strfry said OK and a read by id from the relay finds it. The gateway mirror kept wraps strfry refused, so a 66 KB wrap could read as delivered while no relay held it.
- **`relay.ts` tells a size refusal apart** (#532): `publish` returns `refusals` (`too_large` with the byte count, `unreachable`, `refused`), logs a `too_large` loudly, and a size refusal is never retried as it is.
- **purchase-issuer email gifts and the buyer's copy go to the relay, fit its budget, and are read back** (#532). A large token is cut into self-contained parts of the same voucher (one wrap each, at most 55,121 bytes); each wrap is published to strfry (`PURCHASE_RELAY_URL`) and read back by id before the gateway copy. A size refusal is permanent. The return page merges a copy handed over in parts.
- **NIP-60 kind 7375 token events share the 55,121-byte budget** (#532), down from 60,000: the largest stored on staging was 65,381 bytes, 155 under the limit.

### Added

- **Renew card sales** (#306). While card sales are on, Settings shows until when, and a Renew button that renews the credential and delegation early.
- The stall's own card-sales status names its credential (`credentialId`); the public `/ready` answer does not.
- `src/lib/wrapSize.ts`: the one relay size model (gateway-customer's `GiftWrapSizeModel`, ported), checked byte for byte against real NIP-17 wraps, with `OversizeEventError` (#532).
- **Missed card sales are pulled on login** (#275 item 3, card atomicity U9). After the till
  sales, the owner's login lists the stall's card sales from payment-adapter
  (`GET /api/v1/purchases?stall=<self>`, NIP-98 as the stall) and, for any sale with no
  `issued:<voucher>` row, asks purchase-issuer to re-send its sale record
  (`POST /api/v1/card-sales/sales/resend`, NIP-98 as the stall). The issuer rebuilds each record
  from payment-adapter's own list (read with its token, the wallet's ids are only a filter) with
  the deterministic warrant, via the existing `resendSaleRecords`, and the stall files it through
  the same checks as any sale record. At most 50 per login. Never throws.
- **A card sale's time is checked against the payment** (#275, review residual R1). A card row
  dated more than an hour from when payment-adapter recorded its payment is re-dated to the
  payment time; the sender's time is kept as `senderSaleAt` and the mismatch is logged. A re-sent
  record is dated by the payment from the start.
- **`e2e/card-purchase.e2e.mts`** (#267 item 1): a card purchase against the local stack with a
  real Stripe test key and the Stripe CLI (seed a `charges_enabled` account, pay 4242, assert one
  `stripe_purchase` row, one coupon, a delegated warrant with the `pi_`; decline 0002, replayed
  event, delayed webhook). Reads `STRIPE_SECRET_KEY` from the environment only and skips cleanly
  (exit 0) without a test key, the CLI, the stack or an enrolled stall.

### Changed

- The "no key material leaves the phone" test for card-sales enrolment is now an allowlist of every field and header each request may carry, with the shape of each value (#306), so a key split in two or written as a decimal is caught too.

**Deploy:** the edge must route `GET /api/v1/purchases` (that exact path) on the wallet origin to
payment-adapter, which needs payment-adapter with the stall purchases list.

## [0.62.2] - 2026-11-18

### Changed

- **Help improve Imani: the consent text is four short lines instead of one long paragraph** (#591, owner review). It still says how often (at most twice a month, Wi-Fi only), what is in a health check and what never is, who reads it (support's AI, after names and ids are replaced on the phone), that it is deleted after 14 days, and that turning it off makes the server forget the device. 87 words, down from 211.

## [0.62.1] - 2026-11-17

### Fixed

- **The production build compiles again.** Two type errors from the fleet client (#591) failed `tsc -b`, so v0.62.0 could not be built into an image.

## [0.62.0] - 2026-11-17

### Fixed

- **Sends and payments spend the soonest-expiring vouchers first** (owner report 2026-11-17). Any
  one voucher big enough to cover the amount used to win, so a smaller voucher expiring sooner was
  never spent and lapsed. A send, a payment request, a gift link and the pay screen's estimate now
  share one rule, `chooseSpend` in `@imani/wallet-core`: one voucher only when no usable voucher of
  the same stall and currency expires sooner, otherwise a bundle drawn in expiry order. A voucher
  with no expiry goes last. Ties: exact match, then smallest face, then voucher id.

### Added

- **The wallet pulls bundle parts the gateway holds for it** (imani-gateway-core#220, decision B).
  A part of a multi-coupon payment past its decision is the recipient's money, and a relay outage
  could keep it away. At login, on resume, and every minute while a payment is "on its way", the
  wallet calls `GET /api/v1/atomic-send/incoming` (NIP-98, at most once a minute, doubling backoff
  after a failure) and feeds each row through the same receive path as a token DM: the same parser,
  the same received-coupon set and the same arrival counting (`DmPollService.processPulledToken`).
  A part that comes by DM and by pull is credited once. After the mint swap it calls
  `POST /api/v1/atomic-send/incoming/{sendId}/ack`. A failed ack is kept (across reloads) and
  retried on the next pull, and never swaps again. A row for another key is ignored. A gateway
  without the route (404 or 405) is skipped silently for the session.
- **"Payment on its way" notification for the sender** (imani-gateway-core#220). New notification
  type `send_retrying`, sent when an operator resumes delivery of a payment you sent. Plain words
  ("We are retrying a payment you sent. You don't need to do anything."). Server text carrying
  anything key-shaped is replaced by those words. Uses the "coupon claimed" switch.
- **`scripts/operator.mjs stuck-sends list | show <sendId> | resume <sendId> --note "..."`**
  (imani-gateway-core#220), the break-glass CLI for stuck bundle parts. `resume` is a NIP-98 signed
  POST bound to the note (1 to 500 characters). There is no reclaim or refund command: a part past
  the decision can only go forward.

- **Cashlink lock and bearer split send `predecessor_document` for a by-reference coupon**
  (cashu-voucher#64 phase B). A v2 predecessor names its voucher only by hash, so the gateway
  (imani-gateway-customer#321) needs the document beside it. Inline and locked predecessors send
  the same body as before. This is the last wallet prerequisite for turning on
  `gateway.voucher.by-reference.enabled`.

- **Refunded card vouchers are labelled and not offered for sending** (#277). A card voucher whose
  payment the stall refunded, partly refunded or that is disputed shows an amber badge with text and
  an icon ("Refunded", "Partly refunded £3.00 of £10.00", "Disputed", plus the date):
  - on the stall's voucher record (`/merchant/coupon/:id`, with what can still be redeemed) and its
    sales list, from payment-adapter `GET /api/v1/purchase-state/stall/{pubkey}` (NIP-98 as the stall);
  - on the holder's voucher card and detail ("Can’t be spent: the card payment for this voucher was
    refunded."), from `GET /api/v1/purchase-state/holder/{pi_}` (the `pi_` in the signed warrant).
  Send and pay skip such a voucher, and a partly refunded one is only offered up to what is still
  backed (UX only: gateway-customer's receive refuses it 422 `VOUCHER_PAYMENT_REFUNDED`, which dm-poll
  now reads as a terminal `payment-refunded` refusal). A lookup that fails shows nothing, never
  "Refunded". New Vite proxy rule `/api/v1/purchase-state` to payment-adapter. Needs payment-adapter
  with `/purchase-state` and `PURCHASE_STATE_PUBLIC_ORIGINS` naming the wallet origin.
- **Gift expiry reminders (#410 §6d).** purchase-issuer's gift tracker emails the recipient of an
  unclaimed email gift `gift-expiring` 7 days and 1 day before its claim date
  (`PURCHASE_GIFT_REMINDER_OFFSETS_HOURS`, default `168,24`, `none` turns them off). Only the latest
  due reminder is sent, once per offset (idempotency `<draftId>:expiring:<offset>`), never within
  1 h of the claim date, never for a claimed, bounced or unsubscribed gift. An untouched shop code
  gets `gift-code-expiring` (new template). The reminder names the claim email by date, subject and
  From (`PURCHASE_GIFT_MAIL_FROM`, default `gifts@imani.casa`). The recipient's address is sealed
  in the tracker like the buyer's.
- **One-click unsubscribe (RFC 8058).** Each reminder carries `List-Unsubscribe` and
  `List-Unsubscribe-Post` to `PURCHASE_PUBLIC_ORIGIN/api/v1/gifts/unsubscribe/<draft>?t=<token>`,
  a per-gift HMAC token. POST stops that gift's reminders. GET shows a button only, so a link
  scanner unsubscribes nobody. With no `PURCHASE_PUBLIC_ORIGIN`, no reminders are sent.
  imani-mailer takes `unsubscribeUrl` on `/v1/send` (checked against `MAILER_LINK_HOSTS`).
- **Hard bounce reaches the buyer.** The tracker asks imani-mailer `POST /v1/suppressions/check`
  (new `check` client scope) about the recipient. On a hard bounce the buyer gets `gift-bounced`
  once and reminders stop. **Operators:** give purchase-issuer's mailer client `"check": true` and
  the templates `gift-expiring`, `gift-code-expiring` and `gift-bounced`, and add the issuer's public
  host to `MAILER_LINK_HOSTS`.

### Changed

- **A payment drawn from several vouchers is now one atomic send (#552).** The wallet sends the whole
  plan in one `POST /api/v1/atomic-send/bundles` and follows `GET /api/v1/atomic-send/bundles/{id}`,
  instead of one send per voucher. It ends Sent (every part reached the recipient), Not sent
  (nothing left the wallet and every voucher is back), or Still sending. "Partly sent" and "Partly
  paid" no longer happen against a gateway that has the endpoint. A pending-bundle record is written
  before the request and dropped only once DELIVERED or ABORTED is applied. While it is open, its
  vouchers are held and logout is refused, and the next login finishes it.
- One payment uses at most the gateway's `atomic_send_bundle_max_parts` vouchers (10 by default). Over
  it, the wallet plans fewer, larger parts, and refuses before anything is spent if that is still too
  many.
- A gateway without the bundle endpoint (404 or 405) keeps the old per-voucher sends, so an older
  gateway still works. Single-voucher sends are unchanged.
- Recipient: a multi-voucher payment counts as received only once every part is in. Until then it
  reads "on its way", never "has not arrived".
- **Gift data is deleted when the gift is done (#570).** A finished tracker row is dropped only
  after payment-adapter's `POST /purchases/{id}/scrub?all=true` succeeds, retried on every sweep.
  Self gifts, and gifts with no tracker row, are scrubbed straight after delivery. Needs
  payment-adapter with #570 (it also clears the Purchase Draft).
- The gifting site's thank-you page no longer mentions a signed-in wallet.

- **The free (Starter) tier no longer includes an extra terminal.** Additional terminals are now an
  Essentials-and-above feature (Essentials 3, Pro unlimited). The free tier's `terminals` limit is 0
  in both the bundled catalog and the published `services/subscription/catalog.json` (version 5 → 6;
  redeploy the subscription service so wallets adopt it). `FREE_TERMINALS` is 0, so `mayEnrol`
  refuses even a first terminal without a subscription, and a lapse or seller revocation now stops
  every enrolled terminal. The stall's own device is unaffected.
- Settings › Terminals is disabled for a stall that has never subscribed: it explains that
  terminals start at Essentials, links to Settings › Subscription, turns off "Add a terminal", and
  offers no Renew or setup code. Terminals enrolled before stay listed and revocable, marked as
  needing a plan. A lapsed, revoked or offline subscriber keeps the ordinary page (renew, not buy). Settings › Subscription shows "This device only", and the
  subscription site's plan cards read "Your device only, no extra tills" for Starter.
- Publish catalog 6 (redeploy the subscription service) before or with gateway-portal: a device that
  cached catalog 5 keeps the free tier's 1 terminal until it fetches 6.
- Consumers: a free stall's existing terminal stops serving once its device adopts catalog 6, and
  stops selling as soon as gateway-portal ships its matching change (`TerminalLicenceGate` no longer
  honours `terminal:free`).
### Added

- **Settings › Online shop (#402).** Connecting a website now has its own screen instead of a
  paste box under Add a terminal: what an online shop is, the platform (WooCommerce, WordPress,
  Magento, Shopify) with its steps, the shop's code, and a confirmation naming the address. The
  same screen shows the connected shop (outstanding codes, whether customers can see it, expiry
  and Renew) and disconnects it. Terminals lists a connected shop as one line pointing there, and
  a shop's code scanned in Add a terminal is handed to it.
- **Online shops follow the plan (`ecommerce`, Pro).** The row is listed for every merchant and
  locked below Pro, with the way to plans. A shop's first credential mint is marked
  `X-Imani-Online-Shop: 1`, and gateway-customer refuses it (`422 FEATURE_NOT_IN_PLAN`) and any new
  checkout-code lock for a stall without the feature. When a plan lapses, codes already made still
  finish; only new ones are refused, and the customer is told the shop is not taking new codes
  before anything is burnt. Needs the matching gateway-customer release; against an older gateway
  nothing is refused and the screen works as before.

- **The stall publishes voucher ledger v2 REDEEMED by default** (imani-gateway-customer#310).
  `VITE_VOUCHER_LEDGER_V2` used to default to off; it is now on unless set to exactly `false`
  (rollback only). The platform publishes ISSUED in v2 and the gateway no longer publishes
  REDEEMED, so a stall left on the old default would record no redemptions at all.
  **Deploy:** set `VITE_VOUCHER_ISSUER_PUBKEYS` to the gateway's voucher-signing key(s); left
  empty, every platform-published ISSUED reads as "no record" in the wallet.
- **The merchant's voucher record shows what the public ledger says** (imani-gateway-customer#310).
  A "Public ledger" row under "What stands behind this" reads "Recorded as issued", "Recorded as
  redeemed", "No public record yet" or "Could not check right now". A gateway that did not answer
  is never shown as "no record". Hidden when `VITE_VOUCHER_LEDGER_V2=false`.
- **New subscription prices.** Essentials is £10/month or £100/year (was £8 or £70) and Pro is
  £35/month or £350/year (was £25 or £250), all in GBP, VAT inclusive. Stripe prices are immutable,
  so `deploy/subscription-local/stripe-prices.sh` creates new ones under new lookup keys; point
  `SUBSCRIPTION_PRICES` at the new price ids. Starter and the Town / BID Partner plan are unchanged.

### Fixed

- **A stall that has used its Free plan's issuance allowance can no longer sell, and Sell takes
  the owner to upgrade (gateway-customer#317).** On pressing Sell (or Cashlink), the wallet asks the
  gateway for the stall's standing (`GET /api/v1/wallet/vouchers/sales-allowance`). At the
  allowance, the owner is sent to Settings > Subscription with a banner explaining that the Free
  plan's voucher allowance is used up and inviting an upgrade; a till is stopped with "ask the stall
  owner to upgrade". A sale refused at the mint (`SALES_LIMIT_REACHED`) also sends the owner there.
  An unreadable answer lets the sale go ahead: the gateway still refuses at the mint. The card
  purchase issuer parks a paid sale the Free plan refuses for a person to refund, instead of
  retrying it.

- **An NGN send says, and records, what really leaves the balance.** A sat of an NGN coupon is
  worth about 128 kobo, so 1500.00 cannot be sent exactly: the gateway sends the fewest sats worth
  it, up to a sat more. The history recorded 1500.00 while the balance fell by up to NGN 1.35 more.
  The Pay and Send confirmation screens now show "Taken from your balance" with the real figure
  before the tap (`debitFor`, `sendFace.ts`, which mirrors gateway-core's split), and the history
  records it once the gateway's `keep_face_value` confirms it (`recordedAmount`); a gateway that
  has not been upgraded is recorded as before. The transfer signature now commits to the sats the
  gateway really sends on a PROPORTIONAL coupon (it assumed FLOOR, the gateway rounds up), so it
  no longer falls a sat short of what the receiver credits. EUR, USD and XAF sends are unchanged.
- **A Cashlink taken back at its expiry has a History row of its own, whichever way it was sent.**
  A link that was never locked to its link (the legacy send, or an arm that did not take) comes
  back through the ordinary receive, whose row read "Received via DM", in no bundle, with nothing
  tying it to the link. The sender got "Your Cashlink expired, so its voucher came back to you" and
  found no take-back in History. That row, and the one written by Take it back on such a link, now
  reads "Taken back from Cashlink" in the link's bundle, as a locked link's take-back has since
  0.55.3. App only, no configuration.
- **A Cashlink take-back links to the Cashlink it came from.** Every take-back row, locked link or
  not, at expiry or by Take it back, now names the row that made the Cashlink (`returnOf`, a row
  id, never the link key). Its record page has "See the Cashlink you sent", and the Cashlink's
  record page lists what "Came back" from it. The link travels in the encrypted history backup
  (`return_of`), so a restored device keeps it. Rows written before this have no link.
- **A send the gateway is retrying is no longer called failed, and a bundle no longer stops
  part-paid because one part's relay publish failed once (#552).** The wallet took `DM_ERROR`,
  `SPLIT_ERROR` and `RECLAIM_READY` as the end of a send, gave up after 20 s, asked the gateway to
  reclaim (which always answered 422) and forgot the send, while the gateway went on to deliver it.
  On 2026-11-07 that left a stall with €21 of €31. Now:
  - a send in `DM_ERROR`, `DM_RETRY_PENDING` or `SPLIT_ERROR` is waited out for up to 150 s, read
    every 2 s, so the bundle goes on once the gateway's retry delivers it; past that it is "still
    going through", kept in the pending ledger and finished at the next login, never reclaimed;
  - the wallet never calls reclaim. A send the gateway gives up on (`RECLAIM_READY`, then
    `RECLAIMED`) has its change applied and acked, and the gateway returns the voucher by DM;
  - the screens no longer say "your remaining vouchers are untouched" of a part on its way back;
  - while a send or payment is in flight, the screen says which voucher of a bundle is going and,
    once the gateway is retrying one, that it can take a few minutes and nothing is lost, instead
    of "This takes a few seconds" for the whole wait.

## [0.61.1] - 2026-11-08

### Fixed

- **Delete my account works** (#558, #577). The signed `DELETE /api/v1/nip05` carried no NIP-98
  `payload` tag because it has no body, and the gateway refuses any write without one (401). Every
  state-changing request now signs a payload tag, the SHA-256 of the empty string when there is no
  body, without sending a body. With imani-gateway-core 0.38.1 the full deletion now works on
  staging. A refused signature or an unavailable server get their own plain messages instead of
  "We could not reach Imani".
- The postdeploy harness sells a setup voucher again only when the customer's balance did not rise
  (#566, #576). A slow "sent" screen no longer issues a second voucher.

## [0.61.0] - 2026-11-08

### Added

- **Delete my account** (#558, #573), in Settings > Security > Danger zone, never on a terminal.
  The key belongs to the user, so deleting removes what Imani holds for the account: the handle,
  which the server retires so nobody can claim it again, and the push registration. Then the app
  logs out as usual. The user types their handle to confirm. Every logout safety check runs first,
  and a blocked logout blocks the deletion with the same message. The signed `DELETE
  /api/v1/nip05` runs at the last moment before the wipe. If logout still refuses after it, the app
  says "Your account is deleted" and a Finish button logs out without deleting again. Needs
  imani-gateway-core 0.38.0 (owner-only delete, retired handles).
- **A merchant with vouchers still out cannot delete** (#558). The app shows the amount and the
  date the last one expires, and offers **Close my stall** instead: selling stops (Sell, card sales,
  terminals), redeeming and receiving go on, and the stall's public record says it no longer sells.
  On a new device, the check waits until the sales history is restored.
- **Google Play store listing** (#558, #572): `play-listing/` holds the store icon, the feature
  graphic, 8 phone screenshots, the texts and a script that rebuilds them.

### Changed

- **The app icon is the Imani mark** (#558, #572). The Android launcher icon was still the app
  template's. It is now the rounded mark on #fafafa: a vector adaptive icon with a monochrome layer
  for themed icons, and images for Android 7.
- **A passphrase change updates only the backups that exist** (#574). Google Drive is rewritten
  only when this account has a Drive backup. For a backup made before the app kept this record, it
  asks Drive and rewrites only a copy that is there. It never creates one, and it says when it could
  not check. A downloaded file cannot be rewritten, so the app offers "Save new backup file". The
  record of where backups were made survives logout and travels in the backup file.
- The Drive backup note no longer mentions older app versions (#574).

## [0.60.0] - 2026-11-07

### Changed

- **The Android app targets Android 16 (API 36) and runs on Capacitor 8** (#558, #561). Google
  Play has required target API 36 for new apps and updates since 31 August 2026. compileSdk and
  targetSdk are 36, and minSdk is 24 (Capacitor 8's minimum, so Android 6 is no longer supported).
  AGP is 8.13, Gradle 8.14. Every Capacitor plugin is on 8.
- **Edge to edge on every Android version.** At API 36 the app always draws under the status and
  navigation bars. `@capacitor/status-bar` is gone: core `SystemBars` sets the icon style, and
  `insetsHandling: 'css'` keeps `env(safe-area-inset-*)` right on WebViews older than Chromium 140.
  `MainActivity` enables edge to edge on older Android too, so there is one inset model
  everywhere. The header and the toasts keep their existing safe-area padding.
- The build image (imani-deploy) is on Node 22 and SDK 36, and also produces the signed app bundle
  (`.aab`) for Google Play, kept privately next to the APK build.

## [0.59.0] - 2026-11-07

### Added

- **Checkout codes are backed up on the relay** (#557, #565). A checkout code ("Coupon code") was
  kept only on the device, so logout stayed off for up to 7 days while one was unused, and after a
  logout and login a code's History details no longer opened. Every code now goes into one
  encrypted record (kind 30078, `d=imani:checkout-codes`, NIP-44 sealed to the account's own key,
  chunked, on the relay and mirrored to the gateway) together with the refund counter. Unused codes
  are always in it, and the newest 200 finished ones too. A part's bearer token never goes in, only
  the token locked to the shop. Login merges the record back (a record on the device always wins)
  and moves the refund counter past every restored index.

### Changed

- **Logout with an unused checkout code** (#557). Once a read-back of the backup holds the code and
  every locked token, the code no longer blocks logout. A code still being made blocks with its own
  message, naming the shop, the amount and the date its value comes back, plus a link to the code.
  It no longer says "a payment or a Cashlink is still going through". An unconfirmed backup says
  so and asks to try again.
- **A checkout code's screen opens without its record** (#557). It shows the code's History row and
  its current status from the shop's store (`GET /mine`) instead of failing, for example after a
  restore on another device.

## [0.58.2] - 2026-11-07

### Fixed

- **No false "Voucher not saved" for a payment saved on another device** (#560, #567). When the
  wallet read an old gift wrap whose receive this account had already saved and acknowledged (on
  another device, or before a logout), the gateway's replay came back without a token and the
  wallet warned "Voucher not saved ... contact support". An account used on two devices got one such
  warning per payment the other device received. The gateway now names the escrow status on the
  replay (gateway-customer 0.48.0, `X-Receive-Status`). An `ACKNOWLEDGED` replay, or a 409
  `RECEIVE_ALREADY_SETTLED` whose details say `status=ACKNOWLEDGED`, is treated as already
  received. A replay of a receive that settled but was never acknowledged still warns. On start the
  wallet also asks the gateway (`POST /receive/statuses`) about every stored warning and drops the
  ones now acknowledged, with their bell rows. An older gateway sends no status, and nothing changes
  there.

## [0.58.1] - 2026-11-07

### Fixed

- **One Google Drive backup per account** (#559, #562). Drive used to hold a single fixed file,
  `imani-wallet-account.json`, which every Drive backup replaced, whichever Imani account wrote it.
  The web wallet and the Android app share that folder, so backing up a second account overwrote the
  first account's key, and a restore brought back the wrong account. Each account now has its own
  file, `imani-wallet-account-<pubkey>.json`, tagged with its npub and handle, and a backup only
  updates its own account's file. Restore from Google Drive lists every account it finds, with the
  date each was saved, and always asks which one, even when there is only one. The old shared file
  is never written again. It stays listed, together with its older Drive revisions, so a key that
  was overwritten there can still be restored.
- **The backup screens say what a Drive backup replaces** (#559, #563): Settings > Backup, the
  backup after creating an account, and Settings > Security > Passphrase, whose change rewrites the
  Drive copy. They also warn that an app older than this version still writes the shared file.

## [0.58.0] - 2026-11-07

### Added

- **Google Drive backup and restore work in the Android app** (#510, #513). The app gets its Drive
  token from Play services `AuthorizationClient` through a small native plugin (`DriveAuth`)
  instead of Google Identity Services, which Google refuses inside an app WebView. That refusal is
  what showed "Google Drive backup is not available in the Android app yet". The web wallet keeps
  GIS. Only the `drive.appdata` scope is asked for, and the token goes from the device to
  googleapis.com and nowhere else. A Drive 401 on Android clears the cached token and retries once.
  Needs an Android OAuth client (package `xyz.tcheeric.imani.wallet`, the release signing SHA-1) in
  the same Google Cloud project as the web client.

### Changed

- Load testing (#547, #548, #549, #550, #553, #554, #555): `loadtest/real-day.mts` drives the
  deployed wallet through every user flow with browser personas, on one clock with the k6 crowd.

## [0.57.0] - 2026-11-06

### Changed

- **A Cashlink is locked from the start** (#543, #544). On staging, "Make Cashlink" to "Cashlink
  ready" drops from 14.5 to 19.4 s to a median of 6.1 s for a whole coupon, and 9.5 s when a coupon
  is split. Nothing goes through gateway-core's atomic send.
  - The Cashlink is built like a checkout code (#402), with the link key in place of the shop key:
    1. plan the parts (carve or bearer-split);
    2. write an intent;
    3. pre-check every part with nothing burnt;
    4. arm every part with `lockPub = linkPub` and `R_i`;
    5. publish the locked wraps.
  - The publish runs beside the refund deposits. A wrap counts as delivered when the relay says OK
    and the gateway mirror answers 2xx, with no read-back. A relay that could not be reached is
    tried up to 3 times. A wrap still not on the link is republished after 5, 20 and 60 s, and
    again on the next start.
  - There is no bearer copy on the link any more, so the windows #379 and #396 worked around are
    gone.
  - Making a Cashlink is a counted spend, so logout waits for it.
  - The old path (atomic send, bearer gift, then arm) stays as the fallback. It is chosen before
    anything moves, for:
    - merchant accounts;
    - remote signers;
    - coupons without a DLEQ;
    - the relay off, or the routes unavailable;
    - lock window problems;
    - any other pre-check refusal.
  - The wallet logs `[cashlink] path=direct` or `path=legacy why=<reason>`.
  - `finishCashlinkIntents` finishes, on the next start, a Cashlink a page left part way.
- **Fewer round trips around a Cashlink** (#540, #542):
  - **One settle per Send screen.** `sendGift` does not settle again within 60 s of the screen's
    completed settle.
  - **No merchant lookup for a link key.**
  - **One NUT-07 read for the arm.** It reuses the preflight's.
  - **The arm reuses the tokens the delivery check read.**
  - **Spent coupons are tombstoned by `#d`.** This replaces reading every kind 7375 event, which
    was 1.5 MB per spend on a large account.
  - **The spent set stays warm.** It learns local tombstones and is topped up with a `since` read.
  - **The restore scan runs less often.** It runs only on a fresh device or once a day, probing 4
    indices at a time.

### Added

- `e2e/profile-cashlink.mts` (#541): phase times and a per-request timeline of Cashlink creation
  against staging. `PROFILE_BUNDLE_DIR` serves a local build on the staging origin, and
  `PROFILE_AMOUNT` sets the amount.

## [0.56.0] - 2026-11-06

### Added

- **Nostr event size measurement** (#532). Every event the wallet publishes through
  `relay.ts` `publish()` is measured (UTF-8 bytes of its JSON, once per publish, before sending)
  and batched to gateway-customer's `POST /api/v1/telemetry/event-sizes` as `{kind, bytes, path}`
  only, NIP-98 signed, flushed every 30 s, at 50 queued and when the page is hidden. Nothing is
  sent while signed out or locked, and a failed batch is dropped. The gateway mirror
  (`POST /api/v1/nostr/events`) is not measured here: the gateway records it. The subscription
  service measures what it publishes to the relay and adds `imani_nostr_event_bytes`,
  `imani_nostr_event_over_limit_total` and `imani_nostr_event_limit_bytes` to its `/metrics`,
  with thresholds from `NOSTR_EVENT_SIZE_LIMITS` (default
  `strfry_max_event=65536,wrap_budget=55121`). The shared recorder is
  `src/lib/nostrEventSizeMetrics.ts`, copied into the subscription image.
- **Subscription business metrics** (business-metrics contract, 2026-11-05). The subscription
  service's `/metrics` now re-derives from the ledger on each scrape
  `imani_subscriptions{tier,term,grant_kind,status}`,
  `imani_subscription_paid_value{currency,tier,term,status}` (latest paid invoice per subscription,
  major units), `imani_subscription_licences{state}`, and the housekeeping
  `imani_business_metrics_poll_failures_total{source="subscription"}` and
  `imani_business_metrics_last_poll_seconds{source="subscription"}`. `imani_subscriptions` gains the
  `term` and `grant_kind` labels (it was `{tier,status}`). A ledger that cannot be read keeps the
  last values and counts a failure instead of reporting zero.
- **Gift claim outcomes reach payment-adapter** (business metrics). The purchase issuer's gift
  tracker reports what it sees (CLAIMED, PARTLY_USED with the remaining balance, EXPIRED, RETURNED)
  to `POST /api/v1/purchases/gifts/{draftId}/outcome`, so payment-adapter is the single owner of
  `imani_product_*{product="gift"}` and no gift is counted twice. A report that cannot be delivered
  is kept on the tracker row and retried on the next sweep.

- **The stall hears when a customer claims its cashback** (#158, with
  imani-gateway-portal#59). The portal sends a `cashback_claimed` Web Push and keeps a
  drainable notice; `src/lib/cashbackClaimDrain.ts` collects the notice
  (`POST /api/v1/portal/cashback/claim-notices/drain` then `/ack`) on the receipt drain's
  cadence (boot, every 10s while visible, on becoming visible) and never throws. Push and
  drain both file through one function, keyed `cashback-claimed:<cashbackId>`, so a claim
  that arrives both ways is one bell row and one toast: "€5.00 cashback claimed
  (CB-…)", formatted with `formatFace`. The code comes from the stall's own row, never
  from the portal. Filing also stamps the row `cashbackStatus = Claimed` and `claimedAt`, so
  the Vouchers list and the voucher detail (#155) are right without a status fetch; the
  stamp happens even when the bell entry is switched off. A customer wallet's drain gets
  403 and stops for the session. `cashback_claimed` is a known notification type in the
  app and the service worker, governed by the existing "coupon claimed" switch.
- `e2e/probe-cashback-spend.mts` checks the till's bell entry and the stamped row after the
  claim.

### Fixed

- **The cashback claim drain no longer hammers a failing portal** (#158, with
  imani-gateway-portal#59). It still stops for the session on 403/404/405/410, but 429, 5xx
  and network errors now back off exponentially from 10s to a 5-minute cap, with +/-20%
  jitter, and a successful drain resets it. It warns once per backoff level instead of every
  tick, and a tab becoming visible does not jump the queue. A portal older than #59 answered
  the missing route with 500, so a wallet shipped first logged "drain refused 500" every 10s
  forever. Ship the portal first; a wallet that ships first is now quiet either way.
  `paymentReceiptDrain.ts` has the same every-tick retry and warning on 5xx; left as is here.

## [0.55.4] - 2026-11-05

### Fixed

- **The purchase-issuer image builds again** (#534). 0.55.3 gave `voucherToken.ts` an import of
  `plainToken.ts`, which the purchase-issuer, subscription and wallet-api images do not copy, so the
  purchase-issuer image failed its own load check and 0.55.3 never deployed. The split moves to
  `tokenSplit.ts`. A new test fails when a wallet file a service image copies imports one it does not.
  0.55.3's Cashlink fixes ship in this release.

## [0.55.3] - 2026-11-05

### Fixed

- **A Cashlink of several coupons can be claimed and taken back** (#533, part of #532). The arm
  locked every coupon into ONE token, which `parseVoucherToken` refuses ("mixes proofs from more
  than one voucher"). Both the claimer and the issuer dropped it, so the link could be neither
  claimed nor taken back. The arm now puts one locked token per voucher on the link, cut into
  wraps of at most 55,121 bytes measured on the real event (strfry refuses over 65,536). The
  reader splits a token already on a link this way, so links armed by 0.55.2 or older recover:
  open the app and use Take it back, or claim the link. Take-back, settle and the claim recheck
  now cover every locked token, not just the first. An arm that stops between wraps is resumed
  until every part is on the link. Checkout code parts are not cut: the code store gets each
  part as one token.
- **A Cashlink take-back is in History** (#533). Taking a Cashlink back now writes an incoming
  "Taken back from Cashlink" row in the link's bundle, beside the sent row's "Taken back".

## [0.55.2] - 2026-11-05

### Fixed

- **History groups a several-voucher Cashlink again** (#530). 0.55.1's claim row had no bundle id,
  so each coupon claimed off one Cashlink became its own History line. Every coupon off one link now
  shares a bundle id derived from the link's public key, so a retry gets the same id. That covers
  locked and unlocked claims, and sends recovered from the relay. Sent rows already stored without a
  bundle id fold by their link. Ordinary multi-voucher sends were not affected.

## [0.55.1] - 2026-11-05

### Fixed

- **A claimed Cashlink shows in History** (#528). Claiming a link-locked Cashlink kept the coupon
  but wrote no transaction, because that path never ran the legacy receive's atomic write. It now
  writes a `received` row with the same id the legacy path uses, so a retry overwrites it.

### Added

- **The issuer hears when their Cashlink is claimed** (#528). The claimer's wallet sends a payment
  receipt to the link's issuer. gateway-core fires the `voucher_claimed` push from it server-side
  (so the issuer's app need not be open), and the issuer's receipt drain files the bell entry and
  toast. Locked links now carry the issuer's public key in the wrap. Links made before this release
  name no issuer, so they still show as claimed on the sender's next settle, with no push. Nothing
  secret goes in the receipt, and its id is stable, so a retry sends no second push.

## [0.55.0] - 2026-11-05

### Changed

- **The gifting site is public: nobody signs in** (#410, owner decision 2026-11-05). The "Sign in
  with your wallet" button, the session lookup and the signed-in branches are gone. Every buyer is
  a guest, so every gift's refund key is a fresh key made in the browser and comes back to the buyer
  as the return link in their email, the same for vouchers and shop codes. The home page now says
  "Send a gift". payment-adapter still accepts guest drafts unchanged.

## [0.54.1] - 2026-11-05

### Fixed

- **The wallet image can turn shop-code gift returns on.** The Dockerfile now declares
  `VITE_GIFTING_CODE_GIFTS`, so a deploy's build arg reaches the gift return page. Before, it was
  silently ignored and the return page always read a code gift as a plain gift.

## [0.54.0] - 2026-11-05

### Changed

- **The gifting site sends gifts to an email address only** (#410, #515). Sending to an Imani handle,
  and to yourself, is gone: the field, the live handle lookup, its validation and the draft path.
  A form kept from the old page comes back as an email gift with the address left blank. Drafts and
  return links already issued for a handle are still read and honoured.

### Added

- **Shop-code gifts** (#410, #515, #520, #521, #522). When the stall has an online shop that takes
  checkout codes, the buyer chooses what to send with a segmented control: a voucher, or a code for
  the shop. Behind `VITE_GIFTING_CODE_GIFTS=on` (site) and `PURCHASE_CODE_GIFTS=true` (issuer), both
  off by default.
  - purchase-issuer mints the gift locked to the shop key S, refundable to a fresh buyer key R after
    the code's expiry x, deposits it at imani-checkout-codes (`<draftId>:code`), and mails the
    recipient the code (`gift-code`: amount, shop, `IMANI-XXXX-XXXX-XXXX`, expiry and a balance
    link). Nothing is armed at a relay and R's secret never reaches the server.
  - The buyer hears when the code is used and when it expires (`gift-code-used`,
    `gift-code-expired`). Their return link shows what is left and, only after x, receives it into
    a wallet, including balance successors after a partial spend. A code gift never offers an early
    take-back.
  - The shop link goes into the mail as plain text, because shop hosts cannot be on the mailer's link
    allowlist. The issuer accepts only a clean https shop url, checked before anything is minted.

## [0.53.3] - 2026-11-05

### Fixed

- **The wallet image builds again.** 0.53.2's `xrateRates.test.ts` imported
  `scripts/xrate-rates.mts` statically, and the image leaves `scripts/` out (`.dockerignore`), so
  the image's `tsc -b` failed. The test now loads the script dynamically, as the other script tests
  do. No app change.

## [0.53.2] - 2026-11-05

### Changed

- **The free-tier thresholds come from imani-xrate** (#519, #506, owner decision "Option A"). The
  generator reads a committed export of xrate's `GET /v1/rates`
  (`services/subscription/xrate-rates.json`, version 154) instead of open.er-api.com, and the
  workflow is manual only. No threshold changed (catalog stays v5).

### Fixed

- **Android: a backup saved through the share sheet is no longer empty** (#517). The file was
  deleted the moment the share sheet returned, but Drive or Gmail read it after that. It now stays
  in a private `share/` folder in the app's cache for 10 minutes, and that folder is cleared before
  the next save and at app start.
- **Every issuing script sends the stall's merchant issuance warrant** (#518, #516): the k6 load
  test, `seed-merchant.mjs`, `loadtest/stalls.mjs` and the new checkout-code load test. The portal
  refuses coupons without one since 0.18.0. #516 also adds the checkout-code load test (generation,
  validation and the redeem race).

## [0.53.1] - 2026-11-04

### Fixed

- **Android: a backup file can be picked to log in** (#511, #512). The login picker asked for
  `application/json,.json`. Capacitor turns that into `EXTRA_MIME_TYPES`, so the system picker
  greyed out every file not labelled `application/json`, which on Android is nearly all of them.
  In the app it now asks for `*/*`, and `parseBackup` still turns away anything that is not a
  backup. An empty picker result says "No file was opened…" instead of doing nothing.
- **Android: the backup file, backup key and nsec export can be saved** (#511, #512). A `blob:`
  download does nothing in the app's WebView, which has no download handler. In the app the text
  is written to the app's private cache, handed to the share sheet, and the cache copy is deleted
  afterwards. A failure says so. Adds `@capacitor/filesystem` 7, so the app needs the new APK.
- `.json` exports are labelled `application/json`, not `text/plain`.
- **Android: Google Drive backup no longer hangs** (#509). Google refuses its sign-in inside an app
  WebView and the consent window can't report back, so the token wait never ended. In the app the
  wallet now says straight away that Drive is not available yet, and every platform stops waiting
  for Google after 3 minutes. Native Drive support is #510.

## [0.53.0] - 2026-11-04

### Added

- **The free tier has a sales threshold in every merchant currency** (#506, #507). Before, it
  priced only AUD, CAD, CHF, EUR, GBP and USD, so a free stall created in NGN, KES, JPY, XOF or
  any other currency the onboarding picker offered was allowed to sell nothing (and its currency
  is locked once chosen). `packages/licence/src/freeTierAmounts.ts` now lists 154 currencies in
  minor units. Each is about 100 USD at the 2026-11-04 rates, rounded down to 2 significant
  figures: 100 face in the six majors, 65,000 XOF/XAF (100 EUR at the fixed 655.957), and for
  example 130,000 NGN, 12,000 KES, 1,100 GHS, 1,600 ZAR, 4,000 MRU, 15,000 JPY. The bundled
  catalog uses it, and `services/subscription/catalog.json` publishes it as **v5**, with the
  `fx` table removed. No exchange rate is read at runtime. Tier limits are still off by default
  (`VITE_TIER_LIMITS`).
- **The wallet fetches the signed catalog at startup and then daily** (`startCatalogRefresh`),
  not only when Settings › Subscription is opened.
- **Quarterly refresh by PR** (`.github/workflows/free-tier-amounts.yml`). On 2 Jan, Apr, Jul
  and Oct (or on demand) it re-runs `scripts/free-tier-amounts.mts` on that day's rates and opens
  a `chore/free-tier-amounts` PR listing every changed threshold. It opens nothing when no amount
  changed, keeps a currency's last amount when the feed stops quoting it, and fails rather than
  proposing a threshold that moved more than 50% (re-run with `force` after checking).

### Changed

- **The onboarding currency picker offers only currencies with a free-tier threshold.** It no
  longer lists XDR, XSU (units of account), CUC, KPW, SVC (withdrawn or no usable rate), or HRK,
  SLL, ZWL (replaced by EUR, SLE, ZWG).

## [0.52.0] - 2026-11-03

### Added

- **Get the Android app from Settings → About** (#504). A "Download for Android" row (version and
  size from the `android.json` the deploy publishes beside the APK) when the build sets
  `VITE_ANDROID_APK_URL`. Not shown inside the app itself or on iPhone/iPad.
- **The Android app is built by the deploy** (#504, imani-deploy#376). `android/app/build.gradle`
  takes its version (`IMANI_VERSION_NAME`, `IMANI_VERSION_CODE`) and release signing key
  (`IMANI_KEYSTORE*`) from the environment, and `capacitor.config.ts` its origin from
  `IMANI_APP_URL` (an https origin only). A local build is unchanged: version 0.0.0-dev, unsigned
  release, staging origin.

### Changed

- `google-services.json` is gitignored (#502). The public code check contract is documented (#503).

## [0.51.3] - 2026-11-03

### Fixed

- **Pay, Send and Send by link show the same balance as Home** (#499, follow-up to #494). They added
  up each coupon's own rounding, so a voucher held as several coupons (a checkout code's change)
  read a cent low: 8.98 EUR where Home said 8.99. They now round once per voucher, like Home. A
  send still draws coupon by coupon, so an amount between what can be drawn and the balance (8.99
  there) is refused before the tap with "You can use up to €8.98 of your €8.99…", not offered and
  then refused by the gateway.

## [0.51.2] - 2026-11-03

### Fixed

- **Settings → About's Support writes to support@imani.casa** (#498), not the website's general
  hello@imani.casa.

## [0.51.1] - 2026-11-03

### Changed

- **Settings → About is its own page** (#496; `/settings/about`, every role, terminals included).
  Settings keeps one About row. The page leads with the imani mark, the name and the wallet
  version, then the Imani release and build date, the legal pages (new tab, announced to screen
  readers) and Support (`mailto:`; was "Contact us"). The mint is no longer shown. The release
  drops the `imani-deploy-` tag prefix the label already says, and a long value moves under its
  label instead of truncating.

## [0.51.0] - 2026-11-03

### Added

- **Settings → About, for every role** (#493, with imani-deploy#358). Shows the Imani release
  (imani-deploy `git describe`), the wallet's release tag, the build date and the mint in use, and
  links to the Terms and Conditions, Privacy and Cookie policies on the public website (new tab),
  plus a contact address. A build given no versions shows "dev" rather than guessing; the legal
  links are hidden when the build names no website.

### Changed

- **The Use online coupon-code screens are redesigned** (#492). Both the amount screen and the code
  (which is also the code's History record) show the stall's profile (avatar, name, handle) and
  link to the shop's site in a new tab. The code page leads with the code and one Copy action, with
  amount, expiry and status in aligned rows and partial uses in their own list. Missing shop URL or
  profile, long names and long URLs are handled.

### Fixed

- **The balance rounds a voucher's coupons once, not each coupon** (#494). A voucher held as several
  coupon rows (the change of a checkout code comes back one row per proof) showed less than it is
  worth: 6 rows worth 8.9943 EUR read 8.98 EUR, now 8.99 EUR. The total is the exact sum rounded
  down once, so it never shows more than the coupons cover. The checkout code's maximum and the Use
  online available amount are capped at what can actually be spent; spending still takes the rows
  one by one, so a cent of rounding can remain unspendable until the rows are merged (follow-up).

## [0.50.0] - 2026-11-03

### Changed

- **A checkout code part's refund deposits go to the gateway in one call** (#477,
  gateway-customer#288, #490). Each answer is read as the single `/refunds` answer was; the ones
  answered `KEYSET_INACTIVE` are rebuilt in the fresh keyset and sent again once, together. A
  gateway without the route (404/405) is remembered and asked one deposit at a time, as before.
  A batch that could not be read as a whole leaves the part "not armed", never anything worse:
  this wallet then posts the same refund itself at `x`. Needs gateway-customer 0.40.0 for the
  speed-up.

## [0.49.1] - 2026-11-02

### Changed

- **One slow burn no longer holds back a checkout code's other locks** (#477, #488). The lock
  batch goes 300 ms after the last proof is ready instead of waiting for the slowest burn; a late
  proof follows in a call of its own. Up to 16 proofs of a coupon now run at once (8 before), so a
  9-to-14-proof coupon burns in one round. The arm reuses its own run's pre-check instead of a
  second mint state check (about 1 s); a proof spent in between is still caught by the burn.
  Staging, EUR 7.85: 7.0-7.8 s for 9-10 proofs (9.4-10.1 s on 0.49.0).

## [0.49.0] - 2026-11-02

### Changed

- **A checkout code's locks go to the gateway in one call** (#477, gateway-customer#287, #486).
  The pre-check's dry runs of every coupon proof are one `/cashlink/lock-batch` call, and so are
  the real locks: the proofs still burn side by side, and their locks go together once each has
  burnt. Each answer is read as the single `/lock` answer was; a "not spent yet" or rate-limited
  lock inside a batch is asked again, and a batch the gateway could not judge as a whole is "not
  now" for every lock, never a refusal (so no burn is ever kept as sats for it). A gateway
  without the route (404) is asked one lock at a time, as in 0.48.0. Needs gateway-customer
  0.39.0 for the speed-up.

## [0.48.0] - 2026-11-02

### Changed

- **A checkout code is made in about 8 s instead of 26-32 s** (#477, #484). The coupon proofs
  and the code's parts are armed side by side; the pre-check checks every proof at once and
  retries a 429; one NUT-07 check per gift, and none per proof after a fresh burn. Mint keys are
  cached per keyset and the active keyset for 60 s, re-read fresh after a 12002 or
  KEYSET_INACTIVE. Refunds run side by side, and the code store deposit overlaps the refund
  deposits. Use online warms the mint. On staging a EUR coupon code went from 32 s to ~7-8 s.

### Fixed

- A part refused while another is part way leaves the code pending (recoverable) rather than
  failed.

## [0.47.3] - 2026-11-02

### Fixed

- **A tab left open across a deploy reloads itself** (#478). When a lazy chunk of the running
  build is gone from the server (`vite:preloadError`), the app reloads once per build, keyed on
  the entry chunk's URL. On staging an Android tab still on a pre-0.46.5 bundle ran the old
  self-lock sweep and burnt corda's re-granted licence.

## [0.47.2] - 2026-11-02

### Fixed

- 0.47.1 did not build (`tsc -b`: an unused parameter in `adoptIssuedElsewhere`). Same code.

## [0.47.1] - 2026-11-02

### Fixed

- **A checkout code the shop used is never shown as "No code was made"** (#479). The page
  making a code and dm-poll's catch-up ran the same record at once; the store issued the code
  to one and refused the other `DUPLICATE_PART`, and that refusal was saved over the issued
  record. Runs, notices and reconcile steps of one code now queue (`withCheckoutCodeLock`,
  in-tab and across tabs), `DUPLICATE_PART` is pending rather than "no code", and a record
  already saved that way finds its code again on the next pass (the same deposit replayed, or
  the code on `/mine` by its idempotency key or its exact terms, only when one fits).
- **A shop sale names its order on the stall's books** (#479). The shop's order (`source`)
  was dropped when the bridge rebuilt the row, so every online sale read "Received via DM";
  it now reads "Order 59 at shop.example".

## [0.47.0] - 2026-11-02

### Changed

- **A checkout code keeps what an order did not use** (#472, option A; contract §2, §3, §6).
  Whoever holds the code can use the rest at the same shop until it expires, and whatever is
  left then comes back to the maker. The record keeps `remaining` and a `redemptions` list. A
  `rebalanced` notice (and `GET /mine` showing less left, for a lost notice) makes the wallet
  read `GET /{code}/parts`. A part that is gone is settled only once the mint says SPENT. A
  part with a new token is adopted only if that token is this part's balance successor: locked
  to `S` until the same `x`, refund to the part's own `R`, the same voucher, gateway-signed, and
  worth what the store says and less than before. Its refunds are then re-armed at the relay as
  for a fresh part, and re-armed again on a later pass if the relay was down. The old token is
  kept for audit. At `x` the current token comes back, through the relay or by this wallet.
  Below the store's dust threshold the shop uses today's flow, so `change` still arrives.
- **No Cancel on checkout codes.** A code is a bearer instrument now. The code screen says
  "Anyone with this code can use the rest until <date>; whatever is left then comes back to
  you.", shows "£17.00 left of £25.00", and lists each use. Codes already cancelling still
  finish.
- History: each partial use is its own outgoing "Code used" row ("€8.00 used at shop.example,
  €17.00 left on the code"), with no change row. The code's own row shows what is left.
- `e2e/checkout-codes-staging.e2e.mts`: step 6, a balance order, runs only with
  `E2E_BALANCE=on` and needs the #472 store, gateway and coupon-core.

## [0.46.5] - 2026-11-02

### Fixed
- A stall's subscription licence (or a terminal credential) was burnt by the sweep that turns a
  split's self-locked change back into ordinary coupons (0.46.1, #402). A licence is locked to the
  stall's own key exactly as that change is, so the sweep swapped it at the mint, gateway-customer
  refused to re-sign it (`NOT_REISSUABLE`), and the licence register then found it SPENT and revoked
  it (staging 2026-11-02: corda lost its Essentials licence while the subscription service still
  showed the plan). The sweep now skips any row that is a licence or credential, and never burns a
  proof whose metadata names a `subscription_id` or `terminal` (the gateway's own rule).

## [0.46.4] - 2026-11-01

### Fixed
- The change a shop gives back after a checkout code (the order cost less than the code) arrived as
  coupons but had no history row (#402). It now has its own incoming "Change" row ("Change from
  <shop>: €x back in your wallet"), once per code, and the code's own row says what the shop really
  spent (the store's redeemed notice carries the code's whole amount).

## [0.46.3] - 2026-11-01

### Fixed
- The balance showed more than the shop could take (5.19 vs 5.10 for one stall) after a checkout code
  carved whole proofs off a coupon (#402): the row left behind kept the coupon's whole face value. The
  carve now restates the row to what its token is credited for, and rows a past carve overstated are
  restated on the next catch-up (only down, and never within one minor unit of rounding).

## [0.46.2] - 2026-11-01

### Fixed
- Use online offered more than the balance showed for the same stall (#402). It read every coupon row,
  including ones the balance leaves out: a coupon kept as sats after a refused lock (`swapped_to_sats`,
  whose token is the spent coupon proof) and one the mint refused as redeemed in full. It now counts
  exactly the balance's rows (`spendable`).

## [0.46.1] - 2026-11-01

### Fixed
- A send failed (`LOCKED_VOUCHER_SPLIT_REQUIRES_HOLDER`) when it drew on the change of a voucher split
  (#402). The split leaves its change locked to the wallet's own key, which gateway-core's send cannot
  split. Such coupons are now turned back into ordinary coupons right after the code is made, on every
  catch-up, and before a send picks its coupons; a row that cannot be unlocked yet is left out of the
  send instead of failing it. Burn, re-sign and mint are derived from the wallet key, so a page that dies
  part way resumes, and a definite refusal keeps the value as sats.

## [0.42.1] - 2026-10-31

### Fixed

- "Use online" offers only amounts it can actually make: a code's split part is carved from the
  coupon's own proofs, and when no subset makes the amount the next coupon is split instead, or the
  screen says so before Get code. Before, the code was refused after Get code (#449, #402).
- The stall's online-shop profile publish gets an 8 s relay connect window instead of 3 s. Right
  after enrolment it lost the 3 s race every time (#450, #402).

## [0.42.0] - 2026-10-31

### Changed

- **Open for business pauses trading instead of turning the wallet into a customer's (#434).** A
  closed stall keeps its merchant home, header, menus and history. Sell, Redeem and Cashback stay on
  screen, disabled, with the reason, on the owner's device and every linked terminal. Closing asks for
  the passphrase and says why first. Reopening saves at once.
- Customers cannot pay or buy by card from a closed stall, or one nobody could confirm is open: Buy
  and Pay, the payment-request Pay screen, paying a stall from Send, and card checkout all gate on
  the portal's verified status, polled every 15 s and asked again right before anything is sent.
- Terminals see a close within the 30 s target, without a reload or re-pairing.

Needs gateway-portal >= 0.16.1 (status endpoint); 0.17.0 also refuses issuance server-side.

## [0.41.6] - 2026-10-31

### Fixed

- Lint is clean again: the stall profile publisher moved out of the Terminals page, which only
  exports components (#445). No behaviour change from 0.41.5.

## [0.41.5] - 2026-10-31

### Fixed

- The stall's online-shop profile publish is retried every 5 seconds while Terminals is open,
  until the relay takes it. A connect timeout right after enrolment was never retried (#443, #402).

## [0.41.4] - 2026-10-31

### Fixed

- The stall's online-shop profile counts as published only once the relay accepts it. A copy that
  only the gateway took was pruned on the next read, and the retry had already stopped. Relay
  refusals are logged (#441, #402).

## [0.41.3] - 2026-10-31

### Fixed

- A stall's profile now names its online shop reliably. The republish is retried until the relay
  or the gateway confirms it, and it goes through the gateway's mirror too. Before, a lost publish
  was never retried and customers saw "This stall does not sell online" (#438, #402).

## [0.41.2] - 2026-10-31

### Fixed

- An online shop enrolled as a terminal now turns In service, and the stall advertises it. The
  shop's "enrolled" notice is backdated by up to two days (NIP-59), and the wallet only looked 15
  minutes back, so the row stayed Waiting (#436, #402).

## [0.41.1] - 2026-10-30

### Fixed

- The stall's gifting page link (Settings, and the guest Buy page) now points at the gifting site this
  build is configured for (`VITE_GIFTING_SITE_URL`). A staging wallet linked to the production gifting
  site. A build with no gifting site shows no link. New optional build arg `VITE_GIFTING_HANDLE_DOMAIN` (#432).

## [0.41.0] - 2026-10-30

A **minor** release: checkout codes for online shops (#402), shipped **dark**, plus fixes to
licences, the subscription site and Cashlink take-back.

### Added

- **Checkout codes for online shops** (#402). A customer makes a code (`IMANI-XXXX-XXXX-XXXX`) from
  their coupons at one stall and types it at that stall's online shop (WooCommerce, WordPress,
  Magento). Behind **"Use online"**: pick the stall, the amount and the expiry; the wallet locks 1..N
  coupons of that stall to the shop key, all or nothing, and deposits them with the code store. The
  value is shown as reserved, logout waits while a code is outstanding, and change comes back as a
  coupon locked to the customer. Store notices arrive by DM, with `GET /mine` as the fallback.
- **Online shops as redeem-only terminals** (#402). A stall enrols its shop with a setup code; the
  Terminals page shows the shop and its outstanding codes ("3 codes, €45.00 outstanding"), and
  revoking it withdraws the shop from the stall's profile.
- The flag: shown only when built with **`VITE_CHECKOUT_CODES=on`**, with
  `VITE_CHECKOUT_CODES_URL` for the exposure figure. Both are now declared in the Dockerfile.
- A staging end-to-end test (`e2e/checkout-codes-staging.e2e.mts`) and a VAT brief for an adviser
  (`docs/handoff/vat-coupons-q4.md`, #402 Q4).

### Fixed

- **Licences never verified in a built wallet.** The Dockerfile did not declare
  `VITE_LICENCE_ISSUER_PUBKEY`, so the issuer key was always empty and every delivered plan was
  ignored. It is now a build arg.
- **"Take it back" right after "Cashlink ready" left the gift claimable** under a row reading
  "Taken back": the tap took back the bearer copy the send was about to burn. A take-back now waits
  for its own link's send to finish (up to 90 s), then takes back the real gift.
- **The subscription site's header** showed "Someone", no avatar and no badge. The wallet now passes
  the stall's name, handle and https avatar to the site; the site is built with `VITE_RELAY_URL` and
  `VITE_LICENCE_SELLER_PUBKEY` so it can read profiles and verification badges itself.

## [0.40.3] - 2026-10-29

A **patch**: the wallet-api image did not build on 0.40.x (#425). No behaviour change.

### Fixed

- The wallet-api image guard checks `from '@imani/...'` imports only; a comment naming the
  caller-side `@imani/cashlink-sender` (#366) had failed the build.

## [0.40.2] - 2026-10-29

A **patch**: the purchase-issuer image did not build on 0.40.x (#423). No behaviour change.

### Fixed

- The purchase-issuer image carries the wallet readers (`voucherToken`, `cashlinkLock`) and the
  mailer client the gift path imports, and its build guard checks they are present and load.

## [0.40.1] - 2026-10-29

A **patch**: the 0.40.0 image did not build (`npm run build` runs `tsc -b`, which failed on type
errors the merged lanes introduced). No behaviour change (#421).

### Fixed

- `tsc -b` is clean: the Cashlink sender SDK has its own project (`tsconfig.sdk.json`), the
  subscription service test verifies the catalog through a pure module (`catalogSignature.ts`),
  the gifting app sees the wallet's ambient types, and the coupon page's Memo row shows only a
  non-empty string.

## [0.40.0] - 2026-10-29

A **minor**: subscription tiers, the gifting site, API-driven Cashlinks, the verification badge and
the voucher redesign. New services ship with it (the subscription site and service, the gifting site,
imani-mailer); see each one's README for its environment.

### Added

- **Subscription tiers** (#407): Starter (free), Essentials and Pro, with signed limits carried in
  the licence, a signed tier catalog the app fetches, a sales meter that refuses a sale past the
  limit (plus a 10 % overshoot), and hand grants from an admin screen. Plans are bought by card on
  the subscription site (`apps/subscription` + `services/subscription`), opened from the wallet and
  signed in by it (#411). A Stripe cancellation reaches the wallet, which says Cancelled. Prometheus
  metrics for subscriptions created and cancelled, by tier.
- **Business verification badge** (#418): a bronze (Essentials), silver (Pro) or gold check on the
  avatar for exactly the subscription's window, no grace. The subscription service publishes a
  seller-signed attestation per stall (ADR 0016); a hand grant may carry a badge. The till shows the
  stall's banner and avatar, badge included. Replaces the orange merchant badge.
- **Gifting site** (#410, `apps/gifting`): buy a stall's voucher by card for a handle or an email.
  Gifts are minted already link-locked (G14); the wallet claims them, and the buyer can take an
  unclaimed gift back after the claim window (min(half the validity, 14 days), G17). The return link
  is emailed at Pay (G15) through the new **imani-mailer** service.
- **API-driven Cashlink sending** (#366): `@imani/cashlink-sender` for automated senders.

### Changed

- **Voucher redesign** (#419): the stall's banner fills the card, its avatar sits in a white framed
  circle, the imani mark sits top right, every printed character has a shadow, and the card always
  shows its expiry ("No expiry" included). The coupon page uses the same card.
- **Plans follow www.imani.casa/pricing** (#407). The subscription site offers Starter (free),
  Essentials and Pro only. A Town / BID Partner plan is arranged with us and is never offered as an
  option: the site lists only tiers that have a card price. Essentials issues vouchers without limit
  on 3 tills. Prices are Essentials £8/month or £70/year and Pro £25/month or £250/year, all in GBP.
  The site shows each price as Stripe will charge it, and the service never lists or sells a price
  that is not in GBP.
- **Basic is now called Essentials** (#407), on the subscription site, the wallet's plan screen,
  the plan notice ("Imani Essentials plan activated") and the Stripe product. Only the name changed:
  the tier id is still `basic`, so every licence already sold keeps working and now reads as
  Essentials.

## [0.39.5] - 2026-10-26

A **patch**: the #401 fix (#403) on top of 0.39.4.

### Fixed

- **Two History checks no longer settle the same link at once** (#401). A second check now waits
  for the one already settling a link and reads the link again, so it never redeems twice. Before,
  two checks could settle an armed link together on a slow network, and the balance came up a
  cent short.
- **Cashlink "Take it back" and "Claimed" on a slow connection** (#401, staging R58). The History
  check walked every link one after another, so on a slow network a started take-back (and a claim
  on a later link) waited behind every other link. It sat at "Coming back" or "Waiting to be claimed".
  The check now settles the link on screen first, then a started take-back, then the newest links,
  two at a time, so one slow link no longer holds up the rest. A History check now leaves alone a
  link that a "Take it back" tap is still settling (before, two copies raced at the mint). "Taking it
  back…" stays visible until the tap finishes. The gift-links e2e can add network latency
  (`E2E_LATENCY_MS`), waits on the row instead of reloading it every 7 s (same 60 s deadline), and
  logs how long claim detection and the take-back take.

## [0.39.4] - 2026-10-26

A **patch**: the armed-path take-back fixes (#397, fixes #396) on top of 0.39.3 (#386 exact face
value on return, #387 one `Idempotency-Key` per send intent, #388 the logout escape for old
wrap-less rows, #394 the awaited bell notice). 0.39.3 was rolled back in Redeploy 55. Pairs with
imani-gateway-customer 0.33.2 (#185, flag off, relay ON). wallet-api is byte-identical to 0.39.1
over its image COPY paths, so it is not rebuilt. No configuration change, no migration.

### Fixed

- **An armed Cashlink taken back read "Taken back" while its value was still on the link (#396,
  severity 1).** Not a 0.39.2/0.39.3 regression: the local gate fails the same way on 0.39.1 with
  the Cashlink refund relay ON, and both pass with it OFF. R55 was the first gift e2e with arming
  live. Three causes, all on the armed (locked) path:
  - History said **Taken back** as soon as a take-back *started* (`arm.s = returning`, written
    before the swap goes to the mint). It now says **Coming back** until the swap and the re-form
    are done (`reclaimed`); only then **Taken back**.
  - A **429** from gateway-customer's per-key rate limit (20/min on the Cashlink lock and re-sign
    routes) was read as a definite refusal. On the lock it is now retried; on the re-sign and the
    claim it is "not now" (left for the next run) instead of keeping the value as plain sats. The
    sign routes also wait and ask again a few times on 429.
  - A take-back that stopped part way (some proofs back, some still on the link) was not finished
    by the next run before `x`: the proofs still locked were read as "waiting for the expiry". A
    row already `returning` now finishes the take-back on every run.
- **The gift-link e2e handles armed gifts.** It checks the coupon now on the link (the locked
  token, not the burnt bearer), waits for the arm to settle before a recipient opens the link,
  checks that "Taken back" is backed by a SPENT gift at the mint, and, for an armed CL-EXP link
  whose lock has not reached its own locktime, checks nothing is reclaimed early and then takes it
  back by hand (the refund after the real locktime is covered by unit tests).

## [0.39.3] - 2026-10-26

A **patch**: 0.39.2's fixes (#386 exact face value on return, #387 one `Idempotency-Key` per send
intent, #388 the logout escape for old wrap-less rows) plus the E13 regression fix (#394, fixes
#393). 0.39.2 never reached staging (rolled back in Redeploy 54). Pairs with
imani-gateway-customer 0.33.2 (#185, flag off). wallet-api is byte-identical to 0.39.1 over its
image COPY paths, so it is not rebuilt. No configuration change, no migration.

### Fixed

- A terminal credential DM reaching a personal wallet always says "Terminal setup request from <stall>" in the bell again (#393, E13 on staging). The unwrap fired the notice off without waiting, so dm-poll could mark the wrap processed while a page reload aborted the notice's chunk load, and the row was never written. The unwrap now waits for the notice before it returns.

## [0.39.2] - 2026-10-25

A **patch**: a Cashlink that comes back keeps its exact face value (#386, fixes #384); one
`Idempotency-Key` per send intent, kept across retries and reloads (#387, fixes #179); an old
wrap-less 0.39.0 claimed row stops blocking logout only after the coupon's own expiry plus 7 days
(#388, fixes #381). Pairs with imani-gateway-customer 0.33.2 (#185, flag off). wallet-api is
byte-identical to 0.39.1 over its image COPY paths, so it is not rebuilt. No configuration change,
no migration.

### Fixed

- An old Cashlink row from 0.39.0 (marked claimed while its return was being set up) whose gift
  wraps the relay no longer holds no longer keeps logout off for ever. It still does until nothing
  can be brought back: the relay's answer is really empty, the coupon is a week past its own expiry
  (read from the lock this device kept, never from the link's expiry), and the mint says the locked
  gift is spent. An unreachable or unreadable relay, a lock not kept here, an unspent gift or a mint
  that cannot answer all leave it held (#381).
- **A send retried after a lost answer is no longer sent twice** (#179, severity 2, money path).
  The person-to-person send's `Idempotency-Key` was rebuilt on every attempt from a 10-second
  clock window, so a retry more than ten seconds later, or after the app was reloaded, carried a
  new key and gateway-core ran the send again. The key is now one random key per send intent
  (`src/lib/sendIntent.ts`), written to localStorage before the request goes out and reused by
  every retry of that send, including after a reload, until the gateway answers. A send whose
  answer is unknown counts as money in flight, so logout is refused while one is stored. A
  different send always gets its own key. `shared/api.js` `send()` (`/api/v1/wallet/send`) takes
  an optional key too and sends it as `Idempotency-Key`.
- **Rollout:** ship this wallet first. imani-gateway-customer#185 adds a flag that makes the key
  required on `/wallet/send`; it stays off (optional) until this release is the minimum wallet in
  use. No configuration change, no migration.
- A Cashlink that comes back (take-back, relay refund, NUT-09 restore, kept as sats) or is claimed
  now shows its full value: the gift's face is shared across its proofs by largest remainder, so
  the coupons add up to what was sent. Before, each proof was rounded alone and a €0.20 gift of
  256/16/4/1 sats came back as €0.19 (#384).

## [0.39.1] - 2026-10-24

A **patch**: a Cashlink whose return could not be set up is never shown as "Claimed", its expiry
is its lock's expiry, and the sender's wallet takes it back after that expiry; older rows are
repaired on the next start (#380, fixes #379). Pairs with imani-gateway-customer 0.33.1 (#265),
which lets the return be set up on a mint with v2 keyset ids. wallet-api, purchase-issuer and
audit-api are byte-identical to 0.39.0 over their image COPY paths, so they are not rebuilt. No
configuration change, no migration.

### Fixed

- **A Cashlink whose return could not be set up is no longer shown as "Claimed", and comes back
  after its expiry** (#379, money path). On staging (0.39.0) the voucher service refused the return
  (imani-gateway-customer#265) after the gift was already locked to its link. Start-up's checks ran
  while the send was still locking it: one read the link's spent original as a claim and closed it
  as "Claimed", another added a second History row with a made-up expiry 30 days out. A closed link
  is never checked again, so the locked gift sat unspent at the mint past its expiry and never came
  back. Now:
  - a link this tab is sending or locking is left alone by every other check until it is done;
  - a gift spent by this wallet's own lock is never read as claimed;
  - a keyset id in the newer, longer form is kept, so a lock part way is resumed, not restarted;
  - a link's expiry is its lock's expiry, on every row;
  - **repair on the next start:** a link an older build closed as "Claimed" while it was being
    locked is checked again with the mint. If its locked gift is still unspent it opens again, and
    after the expiry the wallet takes it back itself with the link's own return key (derived per
    link, `imani-gift-refund/v1/i`), as for any link the service did not take. "Claimed" stays only
    when the mint says someone else spent it. No manual step.
  - logout stays off while such a link holds value only this wallet can bring back.

  App only, no configuration, no migration.

## [0.39.0] - 2026-10-23

Unclaimed Cashlinks come back on their own (#295 phase 4, #377), **dormant** until
imani-gateway-core#185 gives send tokens their mint proof: until then every Cashlink behaves as in
0.38.0. Needs imani-gateway-customer 0.33.0 for the lock and re-sign routes (the return relay can
stay off). wallet-api is rebuilt: its image copies `src/lib/voucherToken.ts`, which gained the
optional `dleq` read in `tokenProofs` and `voucherOfSecret` (additive; wallet-api's own code is
unchanged). purchase-issuer and audit-api are byte-identical to 0.38.0 over their image COPY
paths, so they are not rebuilt. No configuration change, no migration.

### Added

- **An unclaimed Cashlink comes back on its own** (#295, phase 4). When the voucher service
  supports it, Send by link now hands the gift over locked to the link: the recipient can open it
  until the expiry, and after that only the sender can, with a return the service posts for the
  sender even when this app is closed (imani-gateway-customer#255 lock and re-sign, #262 return relay). The
  sender sees "If nobody claims it in time, it comes back to you on its own." On the next open
  the link reads **Taken back** and the voucher is in the wallet. App only, no configuration.
  - **Dormant for now:** gateway-core's send tokens do not yet carry the mint proof (NUT-12 DLEQ
    with `r`, imani-gateway-core#185), so no link is locked today and every Cashlink behaves as
    before. It switches on once that lands, with no wallet change.
  - It degrades to today's behaviour: with the return relay off (as it ships), the routes missing,
    the service unreachable, a merchant account (its expired Cashlinks lapse, by owner rule), a
    remote-signer account, or a token without a mint proof, nothing is locked and the wallet takes
    the gift back itself after the expiry, as before. No value moves until every pre-check passes.
  - A lock is never made without the sender's return key (a hard rule with a test). The return key
    is derived from the account key per link (`imani-gift-refund/v1/i`), so a restored wallet can
    take back what the relay has not, by asking the mint (NUT-09) and re-forming through the service.
  - Opening a locked Cashlink re-forms it for the recipient through the service; the recipient's
    claim is saved before any value moves, and is finished on the next start if interrupted.
  - Logout stays off while a Cashlink is being locked, returned or claimed.

### Changed

- The logout hold message reads "A payment or a Cashlink is still going through" (no "swap").

## [0.38.0] - 2026-10-22

Relay reads survive a slow link (imani-deploy#235, #374), and a receive delayed past the NIP-98
window recovers in the same session (#314, #373). App only: wallet-api, purchase-issuer and
audit-api are byte-identical to 0.37.0 over their image COPY paths, so they are not rebuilt. No
configuration change, no migration.

### Fixed

- **Relay reads no longer give up on a slow link** (imani-deploy#235). Reads capped the relay
  socket open at 1200 ms, but a `wss://` open is about four round trips, so on a 350 ms phone link
  the read returned an empty list. That is what left samson's restore at a 0 balance. Those
  sockets never sent a REQ and closed 1006 a minute later. Reads now get 3000 ms to connect and
  3000 ms for EOSE, the same budget as publishing. A dead relay costs 3 s rather than 1.2 s, and
  that read runs in parallel with the gateway's.
  - `relayReadSlowLink.test.ts` reads through a proxy with a 1.6 s round trip. It failed on the
    old cap (`[]`) and passes now.

- **A receive delayed by more than a minute now goes through in the same session** (#314). The
  Stripe S5 till e2e held a receive 61 s in transit, and gateway-customer refused it as outside the
  NIP-98 time window (401 `Auth event timestamp outside acceptable window`). The till kept Paid but
  the coupon only arrived in the merchant's next session.
  - The receive's NIP-98 event is signed at send time, per call, after the receive gate and pacer
    (inside `api.receive`), never when the attempt starts. A test pins that a slow pacer cannot age
    it.
  - On that exact 401 the receive is signed again and retried **once**, through the same gate and
    per-token budget, with the **same idempotency key** (`rcv_<fingerprint>`), so gateway-customer
    still sees one receive. Any other 401 is not retried.
  - The till's "will keep trying" is now kept: a failed receive is offered again in this session on
    a bounded backoff (10 s, 30 s, 90 s, 5 min). No retry runs once logout has closed the receive
    gate or stopped the poller (#331/#340/#353); the delivery stays unprocessed for the next
    session, deferred and never lost.
- **The till no longer says "will keep trying" when it will not** (#307 review, #314). dm-poll's
  `redemption:error` now says whether the delivery will be retried (`retryable`), and a coupon the
  mint can never accept shows a different, plain message: the customer has paid, the coupons could
  not be added, check Transactions or contact support.

## [0.37.0] - 2026-10-22

Locked whole-number-ratio coupons verify again (cashu-voucher#59, #356), and honest limits for
Cashlinks nobody claims (#295 phase 0, #367), with the wallet-api `POST /v1/links/status` endpoint.
App and wallet-api. Wallet-only, no protocol change: a customer's expired Cashlink still comes back
only when the sender's wallet runs. Phases 1 to 4 make it come back on its own. **New wallet-api
configuration:** `WALLET_API_MINT_URL` (the mint `/v1/links/status` checks; no default, the
endpoint answers 503 without it). No migrations: a link record without the new `noticedAt` field
still reads. The guides and specs moved to imani-docs (#371).

> **Deploy gate (owner decision D10, cashu-mint#540):** deploy only where the mint's redemption cap
> is in ENFORCE mode (staging); not to prod while it is LOG. Pairs with cashu-voucher 0.17.1 on the
> Java side (gateway-customer 0.32.0, cashu-mint 0.45.0), whose verifier this mirrors.

### Fixed

- **Locked coupons with a whole-number issuance ratio verify again** (cashu-voucher#59). Coupons
  issued with a ratio such as 50 carry `issuance_ratio` as `"50.0"` (what cashu-lib up to 0.30.6
  wrote), and since cashu-voucher#48 the wallet refused that spelling as non-canonical, although the
  issuer's signature over it is good. The wallet now accepts exactly that spelling for
  `issuance_ratio` only (Java `Double.toString`: `"50.0"`, `"1.0E7"`), as the Java verifier does.
  Every other spelling, and `face_value`, `expires_at` and `face_decimals`, keep the strict rule.
  Replays cashu-voucher's golden vectors for ratios 2, 50 and 700.
- **Sell: the mint stage reads "Minting the voucher…"** (#343), not "Waiting for the voucher to be
  backed…", which merchants read as jargon.

### Changed

- **The guides, explanations, specs and design notes moved to imani-docs, under `wallet/`**
  (#161). Synced from this main first, including spec-claim-links, spec-terminals-in-service,
  design-226 and the two newer explanations. `docs/adr/` and `docs/research/` stay here.
  `docs/README.md` maps each old path to its new one. From now on, a PR that changes what a
  shopper or merchant sees updates `imani-docs/wallet/customers.md` (or merchants.md,
  terminals.md), not `docs/customers.md`. Code comments name the new paths; no code changed.
  Older entries below keep the paths that were true when they were written.

- **Expired Cashlinks no longer block new ones.** Making a Cashlink, and opening **Send → Anyone,
  as a Cashlink**, first takes back links that have expired and marks claimed ones
  (`reconcileGiftLinks`), then counts. Only links that can still be claimed (`outstanding` and
  before their expiry) count toward the 10. Links past their expiry that could not be taken back
  yet are capped at 10 on their own, with *"10 of your Cashlinks have expired and have not come
  back yet. Keep Imani open for a minute so it can take them back, then try again."* So a sender
  with ten expired links can make an eleventh as soon as Send opens.
- **A Cashlink ends at least 24 hours before its coupon** (owner decision Q8). The 1 / 7 / 30 day
  choices stay; a choice that would end later is shown disabled, the longest allowed one is
  picked, and the screen says why in plain words. `giftExpiry` clamps to the coupon's expiry
  minus 24 h as a backstop; `expiryChoices` is the new rule.
- **The Cashlink picker leaves out coupons it cannot send safely:** whole-number-ratio coupons
  (2, 50, 700; cashu-voucher#59, which fail the issuer check today, so a gift could be neither
  claimed nor taken back) and coupons expiring within two days. Plain words say why and what
  still works (spend them, or send them to a handle). `pay.ts` applies the same rule at the send.

### Added

- **"Your Cashlink expired. Open Imani to take it back."** in the bell when a customer's Cashlink
  expires unclaimed (or *"Your Cashlink expired, so its voucher came back to you."* when the open
  app has just taken it back). One entry per link: the inbox id is the row id (never the link
  secret), and the link's own history record gets `noticedAt`, so a restored or second device does
  not tell the sender again. A link taken back by hand gets no notice. **A stall's Cashlink (Sell,
  till) gets none:** it is not returned to the stall by design, and a merchant account is skipped.
  Runs after start-up's reconcile, then hourly and on focus with the coupon-expiry reminders.
- **wallet-api `POST /v1/links/status`:** NUT-07 `checkstate` over link records the caller keeps
  (the proofs' `Y` points, or the coupons), answering per link `claimed`, `outstanding`,
  `expired_unreturned` (a customer link, `comesBack: true`) or `expired` (a stall's Cashlink,
  `comesBack: false`), plus `pending` / `unknown`. NIP-98 and the usual guards. **It never takes a
  key:** a field named like one or a value shaped like one (nsec, 64 hex, a link secret, a link URL
  with `k=`) is refused by field before the mint is asked, without echoing it. Only the configured
  mint is asked, never one a caller names.

### Docs

- `docs/customers.md` "Sending a Cashlink" says exactly what happens today: the coupon comes back
  the next time Imani opens, the link works until then, the expiry is checked by the opener's app,
  and automatic return is coming (owner decision Q1).
- `docs/merchants.md`: a stall's Cashlink nobody claims does not come back, on purpose, and no bell
  entry is filed for it.
- wallet-api README: `POST /v1/links/status`.

### Tests

- `e2e/probe-cashback-claim-missing.mts` (#168, imani-gateway-portal#56): a cashback whose claim
  is missing is parked, not burnt. It refuses a non-local docker or portal target.

### Chores

- The local `.npm` cache directory is git-ignored (#370).

### Fixed (review of #367)

- **A Cashlink whose coupon has itself expired no longer holds the expired limit for ever.** The
  mint refuses an expired coupon to everyone, so the take-back failed on every run and the link
  stayed counted; ten of them would have blocked Cashlinks permanently. The reconcile now closes
  such a link as **Expired** (an hour's grace for a fast clock) instead of trying.
- **Settling never overwrites a newer answer.** Status and `noticedAt` writes re-read the record
  first, so two settles at once (start-up and Send) cannot turn "Taken back" into "Claimed", and
  filing the notice cannot undo a take-back that landed meanwhile.
- **Send waits at most 8 s for the settle** before counting; it carries on in the background.
- `/v1/links/status`: a key used as a field **name** is refused as a key and named by a
  placeholder (the unknown-field refusal echoed it back before).
- **Second check of the above.** A lapsed link is closed only after the take-back was tried and the
  mint refused it as expired (or a week past the coupon's expiry by this device's clock), so a
  device clock running more than an hour fast can no longer hide a coupon the mint would still
  give back. Only the coupons still on the link are read, so one that already came back cannot
  hold the link open. Link-record writes run one at a time, so two settles that finish in the
  "wrong" order still leave **Taken back**, never Claimed.
- **Third check.** The expired refusal a Cashlink coupon actually meets is the **gateway's**, made
  before the swap reaches the mint ("Voucher token expired. Reason: voucher expiry exceeded."), not
  the mint's `voucher_expired`. It is now recognised too, so such a link closes on that run, not
  only a week later. `90016` is matched as a whole number only.

## [0.36.0] - 2026-10-21

Every new account accepts the Terms and Conditions (#357, #358), and a coupon issued through
wallet-api without a named term now lasts as long as the stall says, not a fixed 30 days (#359,
#360). App and wallet-api. **New build configuration:** `VITE_WEBSITE_BASE_URL` (e.g.
`https://www.imani.casa`) is REQUIRED, and the image build fails without it. No migrations: an
older profile or backup without the new field still reads.

### Added

- **Creating an account requires accepting the Terms and Conditions** (Closes #357). The account
  step has an unticked "I accept the Terms and Conditions" box. The words link to
  `<VITE_WEBSITE_BASE_URL>/terms.html` in a new tab (`rel="noopener noreferrer"`), and the whole
  row is at least 44px tall. **Create account** (customer) and **Continue** (merchant, on the first
  step, before the business screens, which do not ask again) stay disabled until it is ticked. A
  registration that starts from a voucher or gift link goes through the same form and needs it too.
  Logging in to or restoring an existing account that already has a handle does not ask.
- **Finish your profile asks too (review of #358).** It claims the FIRST handle for a key that has
  none (a pasted key, a backup of an unfinished account, or the profile card, #332), and that claim
  is what creates the account on the service. It shows the same unticked box, its button stays
  disabled until ticked, and `claimProfile` / `claimProfileWith` now take a required acceptance
  and refuse before claiming anything. The claimed profile records it, and an acceptance the
  record already holds is never overwritten. The box is now one shared component,
  `components/TermsCheckbox.tsx`.
- **`register()` refuses without an acceptance.** Its fourth argument is now a required options
  object, `{ terms, merchant?, profileFields? }`, and `register` checks `terms` before it mints a
  key, claims a handle or stores anything, so no caller can create an account that skipped it. A
  terminal does not register: it has no account or handle of its own and works for its stall's
  account, which accepted when it was created.
- **The acceptance is recorded with the account**, as `termsAccepted: { url, acceptedAt }` on the
  profile record: the exact terms URL that was linked, and when the account was created with the
  box ticked. The page carries its own version and date, but the website does not let the app read
  them (no CORS), so the URL and time pin which text was live. The profile record is what the
  backup file and the Drive backup carry, so a restored account keeps it. The field is optional
  (older records and backups still read), local only (never published), and checked on restore: a
  malformed value in a backup file is dropped. A restore keeps the EARLIEST acceptance known for
  the account: a backup written before it accepted (or carrying a later one) no longer erases or
  replaces the one this device holds (second review of #358).
- **`VITE_WEBSITE_BASE_URL`**, the public website, as a Dockerfile build arg and in the new
  `.env.example`. `scripts/check-website-base-url-build.sh` fails the image build when it is unset
  or not a plain **https** URL (https only, review of #358; plain http is refused, as is any other
  scheme). A bundle built some other way without it shows no link and no box,
  says "New accounts can't be created in this version of the app…", and `register` refuses with
  the same words. imani-deploy passes `https://www.imani.casa` for staging and beta.

### Fixed

- **wallet-api: a headless coupon carries the stall's own validity** (Closes #359, #360). `POST
  /v1/issue/gateway-request` stamped a fixed 30 days when the request named no term, so a 90-day
  stall got 30-day coupons and a never-expiring stall got coupons that expired. A request with no
  `expiresInDays` now uses the term in the signer's own signed merchant record (the same rule the
  Sell screen and purchase-issuer use). A key with no merchant record answers **422**
  `no-merchant-record` and asks for `expiresInDays` instead of minting on a default. A record that
  cannot be read (a relay refusal or timeout) answers **503** and mints nothing. A named
  `expiresInDays` is still honoured as a per-sale choice, and must be between 1 and 730 days.
  The wallet-api image now also ships `@imani/merchant-record`.

### Tests

- wallet-api: the stall's term on every issuing path (`stallValidity`, `issue`, `server`,
  `queryRelay`: relay refusals, timeouts and dropped sockets read as unreadable), and the Sell
  screen and Cashlink for owner and till. The e2e issue probe's recordless stall names its term.
- `terms357.test.ts` (the URL from the env, refusal when unset or malformed, the acceptance record,
  the build check script), `registerTerms357.test.ts` (the real `register`, key store and backup:
  refusal before anything is claimed or stored, the record on the profile for customers and
  merchants, and through a backup and restore), `onboardingTerms357.test.tsx` (unticked, the link,
  disabled until ticked, the merchant first step, a claim-driven registration, the 44px target,
  and no link with no config). The jargon guard scans the new copy. Existing registration tests
  pass an acceptance, and the e2e registration helpers tick the box.
- Review of #358: `finishProfileTerms358.test.tsx` (`claimProfile` refuses before claiming, records
  the acceptance and keeps an existing one; the kind-0 from `register` and `claimProfile` never
  carries it; Finish your profile is unticked, links to the terms and stays disabled until ticked),
  a plain-http case for the URL rules and the build script, and onboarding cases for the link not
  ticking the box and history not skipping the account step.

## [0.35.0] - 2026-10-20

Logging back in while the wallet is open in another tab no longer hangs on "Opening wallet…"
(#352, #353). App only. No migrations, no new configuration.

### Fixed

- **Logging in again no longer sticks on "Opening wallet…" while another tab is open** (Closes
  #352). After a logout in one tab, the other wallet tabs kept the stored wallet open, so the next
  login in the first tab waited for them forever with nothing on screen. Now the other tab finishes
  any receive or send it has running, stops, and lets go of the wallet ("This wallet changed in
  another tab", with Reload), and the login carries on. If another tab still cannot let go, the
  screen says so in plain words ("Close your other wallet tabs to continue", with Try again) and
  carries on by itself once they close, and a slow open stops after a time limit with an
  explanation instead of spinning. Nothing is logged out or erased from any of these screens.
  While vouchers are restored after login the screen shows "Bringing back your vouchers…".

### Tests

- The end-to-end tests use the new handle placeholder `your_handle` (#350, selectors only).

## [0.34.0] - 2026-10-20

Logout now works safely across tabs: it pauses the other tabs, refuses new sends once it starts,
and a device holds one wallet at a time (#335, #330, #340). Handles are trimmed and lowercased as
you type, and a bad handle gets a plain field error (#342, #344). An account with no handle can
finish its profile from the No-handle card (#332, #338), and the reminder to do so shows on Home
only and can be hidden (#339, #341). The merchant dashboard shows Today, 7 days and 30 days, each
counted from local midnight (#345, #346). App only. No migrations, no new configuration.

### Changed

- **The merchant dashboard's ranges are now Today, 7 days and 30 days** (Closes #345). 90 days is
  gone. Every range starts at midnight in the merchant's own time zone, so "Today" is midnight to
  now and "7 days" is today plus the six days before, also on the days the clocks change. The daily
  bars are counted the same way (they were split at UTC midnight before). Today shows the totals
  without a chart, since a single bar adds nothing. 30 days is still the default.

### Fixed

- **A logout in one tab no longer wipes while another tab is receiving or sending** (Closes #335,
  item 4). Logout takes an exclusive Web Lock and pauses every other tab over a BroadcastChannel
  (`logoutTabs.ts`): each closes its receive and send gates, stops its writers, waits (bounded) for
  what it has running, and answers. A tab that is busy, does not answer, opened since, or cannot
  be reached at all (no BroadcastChannel) blocks the logout with plain words ("This wallet is open
  in another tab…"). Nothing is erased. The paused tabs resume on a refusal and reload once the
  logout is done. A paused tab whose logging-out tab vanished resumes if the key is still there.
- **Sends are counted, and refused once logout starts** (#335, item 4). A new spend gate beside the
  receive gate (`beginSpend`/`withSpend`) wraps every send and payment (`pay.ts` `deliver`). Logout
  closes it, waits for a send already running within the same 20 s bound, and blocks if one is
  still running.
- **A stop that throws mid-logout no longer leaves receiving paused until a reload** (#335, item 2).
  Everything after the confirmation runs in a `try/finally` that re-opens the receive and send
  gates, restarts each writer on its own (one that throws does not stop the others) and resumes
  the other tabs.
- **A spent cashback-stash token is dropped, not shown as "waiting" for ever** (#335, item 1). The
  redeem screen's replay and the restore at login ask the token's (trusted) mint (NUT-07, the same
  `tokenState` the record cleanup uses). Only a SPENT answer drops a token: unspent, pending,
  unknown, a mint that is down or untrusted, or a throw all keep it.
- **Taking a terminal out of service checks the cashback stash first** (#335, item 3). An
  unconfirmed stash now shows the plain backup-blocked words before anything is revoked, instead
  of "Could not hand back this terminal's authority" after the revoke.
- **Logging in to another account no longer orphans the wallet already on the device** (Closes
  #330). Every writer of the single key slot (opening a backup, pasting a key, registering) asks
  `refuseIfAnotherWallet` first. While the slot holds a different account's key, it is refused
  with "This device already holds another wallet. Open it and log out first…", and the device is
  left exactly as it was. Logout, with its full backed-up check, is the only way past. The same
  account logging in again is still allowed. Terminal setup already refused a taken slot.
- **Review of #340.** Three fixes:
  - A tab opened while logout was turning off push notifications (a gateway call that can take
    any time) was never asked about, so it kept receiving and sending while the key and the store
    were erased. Logout now asks the other tabs again just before the key is cleared, and refuses
    with nothing erased.
  - A paused tab whose screen was torn down (a session that lapsed mid-logout) lost its fallback,
    so its receiving and sending stayed off until a reload. The fallback now survives.
  - "Finish your profile" asks whether another wallet is on the device before the handle is
    claimed, not only after it.
- **Second check of #340.** Two more fixes:
  - A tab that logged in while logout was ending the session at the gateway (a call that can
    take any time) was never asked about. Logout now asks the other tabs once more just before
    the key is cleared, and refuses with nothing erased.
  - A screen torn down while paused kept its fallback (above), but that fallback could later
    reopen receiving and sending while a newer logout had paused the tab again. Only the latest
    pause may now resume the tab on its own.

- **A handle with a stray space no longer fails at "Create account" with "Request validation
  failed"** (Closes #342). The form checked a trimmed handle but sent the untrimmed one, so a
  keyboard's trailing space or autofill padding passed the check and was rejected by the gateway,
  two screens later on a merchant signup. Handles are now trimmed and lowercased as they are typed
  (onboarding and Finish your profile), and again inside `register`, `claimHandle`,
  `claimProfileWith` and the availability probe, so every caller sends the same string the form
  checked. Owner rule: a handle is always stored lowercase, so the profile cache (`saveProfile`,
  backup import via `sanitiseProfile`, kind-0 reads via `mergeKind0`) and the published kind-0
  (`buildProfileEvent`) lowercase and trim `nip05` too. A 400 VALIDATION_001 from the claim now
  shows its first field error in plain words ("That handle can only use lowercase letters,
  numbers and underscores. Check for spaces and try again.") instead of the bare top-level
  message. The handle placeholder is `your_handle` (a hyphen is not allowed).

- **The Finish your profile reminder shows on Home only and can be hidden** (Closes #339). The
  quiet reminder from #332 no longer appears on Pay, Send, Receive, coupons or any other screen.
  A close button ("Hide this reminder", 44px) hides it, and the choice is remembered per account
  in localStorage (`imani-wallet:finish-profile-dismissed:<pubkey>`), so another account on the
  same device still sees its own. Hiding it never hides **Finish your profile** on the own
  profile card, so every account can still get a handle. The card's Finish control now has a
  44px tap target too.

- **An account with no handle can finish its profile from its own card** (Closes #332). The
  profile card said "No handle yet" with no way forward. It now offers **Finish your profile**
  in the handle's place, which opens the same handle-only step login uses (#327) and the same
  idempotent claim (`claimProfileWith`, the signer-based core of `claimProfile`: 409
  forward-resolve, 15 s timeouts). The card shows the avatar, name and handle on success with no
  reload. A quiet, non-blocking **Finish your profile** link also shows under the header at app
  start for such an account; it is a link, not a dialog, so payments, receives and coupons are
  never held behind it. The noProtocolJargon guard reads the new copy.

## [0.33.0] - 2026-10-19

Logout no longer loses cashback. It waits for cashback, gift links and "Swap back to sats" that
are still arriving, refuses new ones once it starts, and backs up cashback that is not yet added
to your wallet so the next login brings it back. Cashback already added is not brought back
twice, and cashback from another device is never dropped from the backup unless it was really
spent (#331, #334). App only. No migrations, no new configuration.

### Fixed

- **Logout waits for cashback and gift-link receives, and refuses new ones** (Closes #331). These
  receives call the redeem coordinator directly, so logout's drain did not count them, and a coupon
  saved after the final backup check could be wiped. A new receive gate (`receiveGate.ts`) closes
  when logout starts, before the poller stops: a cashback claim, a stash replay or a gift link
  opened after that is deferred before anything is claimed or swapped. The drain now also waits for
  every receive inside the gate and for the coordinator's in-flight redeems
  (`TokenRedemption.inFlightCount()`, a new accessor), within the same 20 s bound, and a last
  synchronous check blocks if any receive is still running. A blocked logout reopens the gate.
- **The pending cashback stash is backed up before logout** (Closes #331, owner decision
  2026-10-19). `imani:cashback:pending` holds claimed cashback not yet banked. Logout now
  publishes it as an encrypted record (kind 30078, `d=imani:cashback-stash`, sealed to the
  account's own key, relay and gateway) and confirms it by reading it back, signature-checked and
  decrypted, like vouchers. Not confirmed (offline, locked, unreadable storage): logout stays
  blocked, "N cashback vouchers waiting to be added... not confirmed as backed up", nothing erased.
  Login merges the newest record back into the stash. Garbage entries are not value and never block.
- **A banked cashback token is not brought back by the next login** (review of #334). The stash
  record was only ever written when the stash held tokens, so an older record naming tokens banked
  since survived later logouts, and the restore put them back as phantom waiting cashback that
  then blocked every logout. Logout now replaces the record when it names more than the stash
  (an empty one when the stash is empty, best effort, bounded to 5 s). That never blocks: the
  tokens actually waiting are still confirmed as before.
- **Logout never drops a cashback token from the stash record unless its mint says it is spent**
  (second check of #334). The fix above dropped every token the record named and this device's
  stash did not. That could be another device's cashback that this device never restored (the
  login restore is best effort), and then the record was its only copy. Now a token leaves the
  record only when NUT-07 answers SPENT: unspent, pending, unknown or an unreachable mint all keep
  it. A clear that outlives its 5 s bound no longer publishes late, nothing is published before the
  record has been read, and each new record is stamped after the newest one seen, so a write in
  the same second is not lost to a relay's tie-break.
- **"Swap back to sats" goes through the receive gate** (review of #334). It is a mint swap whose
  sats are saved afterwards, so like the other receives it is refused once logout has started
  (nothing swapped, the coupon untouched), and one already running is waited for.

### Tests

- Third-check hardening of #326 landed (7ddfe29): the settle bound, the default ledger reader,
  swap refusal on decommission, a missing signer reads as locked.

## [0.32.0] - 2026-10-19

Log in now restores your wallet from a backup, logout refuses to erase coupons that are not
backed up, and the app no longer shows protocol jargon or raw keys (#325, #326, #327, #328, #324).
App only. No migrations, no new configuration.

### Added

- **Log in opens your backup; the Restore page is gone** (Closes #325, #327). The onboarding "Log in"
  step and `/restore` are one flow: "Where is your backup?" offers **Google Drive** and **A backup
  file** as equals, then shows whose account it is (avatar, name, handle, no keys), then asks for
  the passphrase. A wrong passphrase says so inline and writes nothing (`applyBackup` still rolls
  back); an empty Google account or an unreadable file each say so, with the choices still on
  screen. Pasting the key is now a small secondary link, "Use your backup key instead", with no
  protocol wording. `/restore` redirects to the Log in step, the Restore links on the first screen
  and on `/login` are removed, and the re-auth dialog now says to choose Log in after logging out.
  The `/login` unlock and Settings › Backup are unchanged.
- **No account without a profile** (owner rule, #325). Every way in (backup or pasted key) verifies
  the account's handle before the key is kept, by standard NIP-05: the newest kind-0 (gateway
  cache and relay, newest wins) names a handle, and `GET /api/v1/resolve/{nip05}` must resolve it
  to the same key. (The reverse lookup `/api/v1/resolve/pubkey/{hex}` is not used: it does not see
  bottin handles.) An account that fails is not let in anonymously: nothing is written, and
  "Finish your profile" claims a handle (display name defaults to the handle) before the wallet
  opens. Only an unreachable directory fails closed, with a retry message.
- **Logout will not erase coupons it cannot restore** (#326). Before logging out, the wallet checks
  that every coupon you hold is backed up, re-sends any that are missing, and checks again. If any
  coupon is still not backed up, or a payment or swap is still in progress, or the wallet's data
  cannot be read, logout is refused and nothing is erased. The message says how many coupons and
  how much money are at risk, in plain words.

### Changed

- **No protocol jargon or raw keys anywhere in the app** (Closes #324, #328). People and stalls are
  shown only by picture, name and handle. Where nothing is known yet, the app says **Someone**,
  **Unknown stall** or **Your account** with a generic avatar, never a hex or npub fragment
  (Receive, Profile, a stall's public page and share button, claim and gift links, coupon
  cards, merchant record details). The ledger ID is folded under **Show ledger ID**, beside
  **Copy ledger ID**. "relay", "nsec" and "pubkey" are gone from the copy ("Saved." / "not sent
  yet" / "network" / "backup key"), and error messages from libraries that use those words are
  replaced by a plain one. Pasting a key still accepts an nsec or hex; only the wording changed.
  A guard test fails the build if a user-facing string in `src/pages` or `src/components` says
  npub, nsec, Nostr, relay, NIP-xx or pubkey.
- **Restore names the account with its profile, not its npub** (Closes #322). The passphrase
  prompt after a Google Drive restore (and after picking a backup file) shows the identity row
  used across the app: avatar, display name and handle, built from the profile stored in the
  backup (picture included) so it works offline. No raw key is shown on the screen any more. A
  backup with no profile falls back to a short form. The restore itself is unchanged.

### Fixed

- **A restored wallet shows its coupons even when the network is flaky** (#326). Restoring used to
  read coupon backups from one source only, so a dropped connection looked like "no coupons" and the
  balance read 0 while the history came back. Coupons are now read from both sources (each record
  is signature-checked), and a coupon the mint reports as spent without a record of this wallet
  spending it is kept and flagged instead of silently dropped.
- **Checks survive a restore** (#326). A received payment that was checked no longer reads "Not
  checked" after logging out and back in.

## [0.31.0] - 2026-10-18

Card vouchers carry the stall's own validity (#312, #315). Ships purchase-issuer AND the app.
**Deploy:** purchase-issuer first (its `/ready` gains reason codes), then the app, then
payment-adapter 0.23.0 (it asks `/ready` before checkout). No migrations, no new configuration.
A stall whose record says its vouchers never expire stops being ready for card sales until it
picks a validity.

### Fixed

- **Card vouchers carry the stall's own validity, not a year** (Closes #312). purchase-issuer
  read no stall setting and minted every card voucher for 365 days. It now reads the stall's
  current `voucherValidityDays` from its signed public merchant record (kind 30078,
  `d=imani:merchant`) through gateway-core's public event query at mint time: signature checked,
  authored by the stall, newest wins, cached two minutes. The voucher, the merchant's sale record
  and its `expiresAt` all use the same term. Already-issued vouchers keep their year.
- **Fail safe when the term cannot be read** (#312): nothing is minted on a guess. The purchase
  stays OWED and is retried; after 240 passes (about an hour at the default interval) it is parked `NEEDS_ATTENTION` (`issue_blocked`,
  detail `validity_unreadable`). A stall with no record or no valid term is "never expires", as
  Sell reads it.

### Changed

- **Card sales need a voucher validity** (#312). A delegated card voucher cannot outlive its
  delegation at the till, so a never-expiring one cannot be backed. `/api/v1/card-sales/ready`
  answers not ready with `reason: "validity_never_expires"` (or `validity_outlives_delegation`,
  `validity_unknown`); Buy is disabled with *This shop sells by card only with an expiry date*,
  and Settings › Card payments says card sales need a validity and links to it. A term changed
  between checkout and mint is parked `issue_blocked` for an operator rather than minted.
- **Delegations cover the longest validity** (#312): new card-sales delegations last 365 + 730 + 7
  days, so card sales stay on for the credential's year at any term up to 730 days. Enrolment
  checks the delegation against the stall's ACTUAL term (the maximum would refuse every
  enrolment a moment after signing). Delegations signed before this (737 days) keep working while
  their remaining life exceeds the stall's term plus a week; past that, readiness answers
  `validity_outlives_delegation` and the stall sets card sales up again.
- The validity rules (`validValidityDays`, `NEVER_EXPIRES`, `MAX_VALIDITY_DAYS`, the record's kind
  and `d` tag) moved to a new source package, `@imani/merchant-record`, shared by the wallet
  (`src/lib/merchant.ts` re-exports it) and purchase-issuer.

## [0.30.1] - 2026-10-18

Google Drive key backup and restore can run (#311). App image only; purchase-issuer unchanged.
**Deploy:** build with `VITE_GOOGLE_CLIENT_ID` (imani-deploy passes it) and with imani-deploy's edge
CSP that admits Google Identity Services. Without the client id the Drive buttons say "not set up",
as before.

### Fixed

- **The wallet container's own CSP blocked Google Identity Services** (#311, #316). `deploy/nginx.conf`
  had `script-src 'self'` and `default-src 'none'`, and the edge cannot loosen it (two CSPs
  intersect), so the Drive backup could not start even with a client id. It now admits only GIS:
  `script-src https://accounts.google.com/gsi/client`, `style-src .../gsi/style`,
  `frame-src https://accounts.google.com/gsi/` (Google's GIS CSP guide). `connect-src https:` already
  reached the Drive API. Cross-Origin-Opener-Policy is `same-origin-allow-popups`, so the account
  chooser popup can report back. `csp.test.ts` pins all of it.
- `docs/customers.md` says what the Drive backup sends: the passphrase-locked file, browser to
  Google, into the app's hidden folder only; Imani never sees the file, key or Google sign-in.

## [0.30.0] - 2026-10-18

Merchants turn on card sales from the app, and purchase-issuer enrols without a restart (#298,
#290). Credentials are confirmed eagerly (#296), and the stall's own till shows Paid on
gateway-core's verdict (#300). New purchase-issuer env `PURCHASE_PUBLIC_ORIGIN`.
**Deploy order:** imani-deploy#229 (edge `/api/v1/card-sales/` route and `PURCHASE_PUBLIC_ORIGIN`)
live with or before this build, or Buy is disabled for every stall.

### Added

- **Turn on card sales, from the merchant's phone** (Closes #298). Settings › Card payments has a
  new step under the Stripe card: one tap mints the purchase issuer's terminal credential, signs
  the `coupon:issue` delegation, and enrols it. The stall key never leaves the phone: every
  signature (NIP-98, owner attestation, delegation) is made on the device, and purchase-issuer
  receives only signed artefacts and public data. The issuer's lock key is generated inside
  purchase-issuer and only its public half is sent out. The screen reads "Card sales: on", "needs
  setup" or "Couldn't check".
- **purchase-issuer enrolment API** (#298): `POST /api/v1/card-sales/enrolment/begin`,
  `POST /api/v1/card-sales/enrolment` and `GET /api/v1/card-sales/enrolment` (NIP-98 by the
  stall, single-use signatures), and the public `GET /api/v1/card-sales/ready/<stall>`. It checks
  the delegation as the mint does, confirms the credential at once (#296), and seals it. New env
  `PURCHASE_PUBLIC_ORIGIN` (required for enrolment; unset answers 503).
- **Metrics** (#298): `imani_purchase_issuer_owed_unenrolled` (paid purchases for stalls with no
  enrolled issuer, last pass), `attempts_total{outcome="no_credential"}` (was counted as
  `skipped`) and `enrolments_total{result}`.

### Fixed

- **Buy refuses a stall that cannot issue** (#298). The stall page's Buy and the Buy page's Pay by
  card ask purchase-issuer whether it can issue for the stall, and stay disabled with "Card sales
  aren't ready for this merchant yet" beside them otherwise. It fails safe: no answer is no. The
  Buy page asks again at the tap.
- **The credential vault follows its file** (Closes #290). A stall enrolled through the API, or
  sealed by the operator script, is issued for on the next pass with no restart. An externally
  added record is confirmed at once.
- **The stall's own till shows Paid on gateway-core's verdict (Closes #300).** The owner-device
  Redeem screen learned Paid only from its wallet receiving the DM'd coupon, so a receive that
  stalled held it on "Waiting for payment" after core had counted the payment (Stripe S3 run 1).
  It now registers the request's terms and watches core's fulfilment verdict through the same
  path a terminal uses (`fulfilmentOf` + `paidForStall`: fulfilled, the stall as recipient and
  issuer, the request's unit, at least its amount). Paid shows as soon as core counts it, with
  "Still receiving the coupons" until they land. The receive carries on in the background. If it
  fails (`redemption:error` / `redemption:unsaved`, which now carry the DM's `requestId`), the
  sale says the coupons have not reached this wallet, and Paid stays. Core's polling backs off
  (3 s for a minute, then up to once a minute) and stops on Paid, expiry and unmount, on
  terminals too. An arrival naming a request already paid never settles a different one, so a
  payment is counted once. If the terms cannot be registered, the owner's till still shows the
  code and relies on its wallet, as before.

- **purchase-issuer confirms stall credentials eagerly** (Closes #296). It used to confirm a
  terminal credential the first time a card sale read it, and gateway-customer lapses one left
  unconfirmed for 24 h, so a stall enrolled more than a day before its first sale had its paid
  purchase BLOCKED as "credential burnt or replaced". It now confirms at enrolment
  (`attachDelegation.ts`, with `PURCHASE_GATEWAY_URL`) and for every vault record at startup. An
  expired credential (410) is logged as `purchase_issuer_credential_expired`, exported as the new
  gauge `imani_purchase_issuer_credentials{standing}`, and its sales stay owed with a "re-enrol"
  reason instead of being blocked.
- **No NIP-98 replay on a confirm retry.** One confirm is in flight per credential, and every
  signed request carries a random `nonce` tag, so two requests in one second are two events.
- **Receive: the QR code no longer sets state after the page is gone (#285).** The async
  `QRCode.toDataURL` result is dropped once the page unmounts or the address changes. In the test
  suite it landed after jsdom teardown, so `CashbackCodeRetired.test.tsx` left an unhandled
  rejection and vitest exited 1 with every test passing.
- **Tests: `useTerminalIdentity` waits on the state, not a 10 ms sleep (#286)**, and the
  `terminalRosterSync` property tests (3000 cases each, unchanged) get a 60 s block timeout so a
  loaded full run does not time them out.
- An owner-device till could stay "Waiting for payment" after the buyer paid (#300). A redemption
  awaited `getTokenMetadata`, `inspectVoucher` and the receive pacer with no timeout, and a hung one
  also blocked every later attempt at the same token, which joined the hung in-flight promise. Each
  step is now bounded and logged: the opportunistic lookups fall through, and a stuck pacer defers
  the receive (`RECEIVE_DEFERRED`) so the next poll retries it under the same idempotency key.

## [0.29.0] - 2026-10-16

The purchase issuer's card deliveries now discharge their purchase (imani-wallet#287 E2, U3, #291),
and an Apple-design pass over the card-purchase and Cashlink screens (#283). No new configuration.
**Deploy order:** gateway-core 0.28.0, then gateway-customer 0.31.0, then this purchase-issuer, then
payment-adapter 0.22.0.

### Fixed

- **purchase-issuer: a card coupon's DM names the voucher it carries, and a delivery only counts
  once the gateway has recorded it (imani-wallet#287, E2 unit U3).** The DM send
  (`/api/v1/dm/tokens/send`) now includes `voucher_id` (snake case), so gateway-customer can tell
  the issuer's own hand-over and report it to gateway-core as an issuance receipt. A 2xx without
  `fulfilment_recorded: true` (an older gateway-customer, or one whose core did not record it) is
  no longer taken as a discharge: the coupon goes to the delivery outbox and is re-sent, with the
  same voucher and payment request, until the gateway records it or the row parks
  `delivery_exhausted`. A 502 (and 503) is retried. A permanent refusal (gc#235: HTTP 422 with
  `X-Imani-Issuance-Refused: token_refused|untrusted_issuer|proofs_not_unspent|refused`) parks the
  row `delivery_exhausted` at once, with that code in `last_failure`, and is never re-sent.
  Deploy after gateway-customer U2.
  Since F2 of the core#163 review, gateway-customer asks core BEFORE it publishes, so the 422 now
  means this attempt sent nothing (an earlier attempt may have). The park text says so: "did NOT
  send it this time; an earlier attempt may have DELIVERED it". The HTTP contract is unchanged.
- **purchase-issuer: says DELIVERED when the discharge is not confirmed (imani-wallet#289, E4).**
  The failure text names the voucher, the DM event, the time and the payment request, and a new
  `outcome="delivered_unconfirmed"` on `imani_purchase_issuer_attempts_total` counts it apart from
  `undelivered`. A discharge refused after a recorded delivery reads "issued and DELIVERED voucher
  ...".

### Changed

- **An Apple-design pass over the card-purchase and Cashlink screens.** No flow or behaviour
  changes. Stripe's return pages (`/buy/done`, `/buy/cancelled`) announce their outcome
  (`role="status"`), use the house `Button` look instead of a one-off pill, and always offer a way
  back: "Back to the stall" after a payment, "Back to my wallet" beside "Try again" after a cancel.
  The claim and gift outcome screens (`Outcome`) carry a glyph for success, waiting or unavailable,
  are announced, and their heading is no longer grey. A recovered Cashlink on `/receive/cashback`
  and a "give it a minute" on Cashlink ready use a new `Notice` (green or amber, polite) instead of
  the red error `Alert`, and Done on `/receive/cashback` is the primary action. New `text-title`
  and `text-callout` sizes (rem, with their tracking and leading) replace `text-[22px]` /
  `text-[15px]` on these screens, so they follow the reader's text size. Press feedback on the Send
  by link rows, the Send picker's voucher rows (`/send`, "Which voucher?"), the expiry banner link
  and the inline "change" / "Switch account" links, larger
  tap targets on those and on the payment reference copy, `role="alert"` on Buy, cancel and
  take-back failures, live-region announcements for "Copied", and higher-contrast small text on
  the Buy/Pay reasons, "verified stall" and the Cashlink notes. The QR and the inline Cancel /
  Take back confirmations enter with the existing `materialize` / `expand-row` motion, which
  reduced motion already turns off.

## [0.28.0] - 2026-10-16

Card atomicity waves 2-3 for the purchase issuer (U8 #274, U9 #275) and Buy/Pay on a merchant's page
(#280). Both the wallet app and `services/purchase-issuer` change. **Deploy order:** gateway-customer
0.30.0 (gc#232) and payment-adapter 0.21.0 (`/attention`) first, and switch the purchase issuer only
when no purchase is `ISSUING` (see the key-switch precondition below). New optional env
`PURCHASE_OUTBOX_PATH` (default on the existing volume), `PURCHASE_DELIVERY_BASE_BACKOFF_MS`,
`PURCHASE_DELIVERY_MAX_ATTEMPTS`.

### Added

- **Buy and Pay on a merchant's page; scanning a merchant opens it** (#280). `/merchants/:pubkey`
  and a merchant's `/profile/:pubkey` share one `MerchantActions` component: **Buy** (card icon,
  accessible name "Buy a voucher with card", gated on the stall's `acceptsCards` as before) and
  **Pay** (enabled only with at least one unspent, unexpired voucher from that stall; opens the
  existing send flow addressed to the stall, `/send?from=<stall>&to=<stall>`, which is a
  redemption). Both are always drawn and disabled with a visible, screen-reader-linked reason,
  where Buy used to be hidden. Logged out, Buy goes to login and returns to `/buy/:pubkey`
  (`lib/afterLogin.ts`, purchase paths only); Pay is disabled. A merchant's own page shows the
  own-profile note instead. Send stays as a secondary action beside Share. Scan routes an address
  that resolves to a merchant (`merchantStatus`, the lookup SendPage already makes, 1.5 s
  deadline) to its page; everyone else, or an unanswered lookup, keeps `/send?to=`.

- **A card coupon is always delivered, or parked for a person** (#274, card atomicity audit U8).
  - **Key and nonce from the payment intent.** The mint's `Idempotency-Key` is `purchase:pi:<pi_>`
    and the warrant nonce `H("imani-purchase-warrant-v2:<pi_>")`, so any re-drive of one payment
    (a second event, a lapsed claim, a reconciler) maps to one gc nonce, which gc#232 replays
    for the voucher's life. Deploy after gateway-customer with #232.
  - **Upgrade precondition (key switch).** A row that an older issuer minted under the v1 event-id
    key/nonce and that is re-claimed by this one would mint AGAIN under the pi_ key/nonce: gc
    sees a new nonce. Only rows that are `ISSUING` at the switch can be in that state
    (`OWED` never minted, `ISSUED`/`DISCHARGED`/`BLOCKED` are never re-minted). So before
    deploying: stop the old issuer, wait out the lease (10 min), and check
    `select count(*) from stripe_purchase where status = 'ISSUING'` is 0. For a non-zero
    count, check each row's voucher at gc first. Per the 2026-10-15 card audit, staging had
    none: purchase #1 BLOCKED (nothing minted, 401), #2 delivered by hand.
  - **Every gc refusal that answers every retry the same way parks the row** (review of #279):
    409 `UNRECORDED` (also the idempotency store's `IDEMPOTENCY_PREVIOUS_ATTEMPT_UNRECORDED`),
    409 `WARRANT_ALREADY_USED` (the pi_ nonce was spent by different bytes, for example after a
    delegation renewal), and 422 `IDEMPOTENCY_KEY_REUSED`. Before, the last two were
    retryable and looped forever. 409 `IDEMPOTENCY_IN_PROGRESS` is still retried.
  - **gc 409 `UNRECORDED` is never retried.** The row is parked `gateway_unrecorded` via
    payment-adapter#280 `POST /api/v1/purchases/{eventId}/attention`. A payment-adapter without
    that route (404) gets the old permanent `/failure` instead, so the row still stops looping.
  - **Durable delivery outbox** (`services/purchase-issuer/outbox.ts`,
    `PURCHASE_OUTBOX_PATH`, default `/var/lib/imani/purchase-outbox.json` on the existing volume).
    After a mint, an undelivered DM is written there before the purchases API hears anything.
    Ids only, never a token: the token is re-read from the gateway (gc#229) at retry time.
    Capped exponential backoff (`PURCHASE_DELIVERY_BASE_BACKOFF_MS`, default 60 s, doubling,
    hourly cap). After `PURCHASE_DELIVERY_MAX_ATTEMPTS` (12) it parks the row
    `delivery_exhausted`, naming the voucher. A corrupt outbox file fails the pass rather than
    reading as empty. If the outbox write itself fails, the row is not reported ISSUED. Its
    claim is left to lapse, and the re-mint replays the same voucher.
  - **The outbox owns sale-record retries** (#275 / PR #278 marked this for U8): one inline try,
    then retried with the same backoff, independently of delivery.
  - Metrics outcomes `unrecorded`, `outbox_write_failed`, `delivered_late`, `delivery_retried`,
    `delivery_exhausted`.

- **Card sales reach the stall's own ledger** (#275, card atomicity audit U9, gap D). In Stripe S1
  the merchant record of a card voucher read "No record of this voucher" until a row was seeded
  by hand. The stall's sale-record reader (`tillSales.ts`) now also files an
  `imani-terminal-sale/1` row carrying a `delegated` warrant, after checking the stall's own
  delegation inside it the way gateway-customer#231 does: NIP-01 id and sig, kind 30078
  `imani:issuer-delegation`, scope `coupon:issue`, signed by this stall, in force at the sale
  time, `p` equal to the key that sealed the record, and the delegate's signature over the sale
  and its pi_ reference. A delegated row without a reference is refused (`not-a-card-sale`), and
  the issuer is never named as a till, so it never joins the roster. The merchant record then
  reads "Card" with the pi_ reference.
- **The purchase issuer sends that record after every mint** (`services/purchase-issuer/saleRecord.ts`),
  gift-wrapped and sealed by the credential's lock key, published to the gateway's event cache
  (NIP-98). Sent whether or not delivery succeeds, never throws, never changes a discharge
  outcome. Inline for now: U8's outbox takes it over.
- **Pull fallback** `resendSaleRecords`: re-sends a missed card sale (the warrant is
  deterministic, and the stall files by `issued:<voucher>`, so a re-send files nothing twice).
  Listing a stall's discharged purchases needs a payment-adapter read endpoint; payment-adapter
  PR #278 proposes `GET /api/v1/purchases/stall/{pubkey}` (under review). Not built on it yet.

## [0.27.0] - 2026-10-15

Payments observability for the purchase issuer (imani-deploy#210). The wallet app itself is
unchanged: only `services/purchase-issuer` changes, with no new dependency.

### Added

- **`GET /metrics` on the purchase issuer** (#272), on the same internal port as `/health`.
  `imani_purchase_issuer_attempts_total{outcome}` (discharged, discharge_rejected, undelivered,
  blocked, owed, manual, skipped, claim_lost, claim_unreachable) and
  `imani_purchase_issuer_passes_total{result}`. Labels are closed sets: no pubkey, amount or
  reference. imani-deploy scrapes it as the `purchase-issuer` job.

## [0.26.0] - 2026-10-15

The stall map comes from OpenStreetMap tiles instead of a Google frame (#263), customers see and are
reminded of coupons about to expire (#265), the card buyer gets return pages and a guest can no
longer pay by card for nothing (#267), and Cashlink phase 1 retires typed cashback codes (#268).
Deploy order: imani-gateway-portal with the authenticated link lookup (#92) before this wallet;
the imani-deploy CSP change that drops the map `frame-src` with or after it.

### Added

- **Customers are told a coupon is about to expire, and can see it** (#265; owner decision
  2026-10-15: option 2, wallet-only, no server reminder list).
  - **Reminder when the app opens** (`src/lib/expiryReminders.ts`). On unlock, on every coupon change
    and hourly while open, the wallet files ONE bell entry per coupon per threshold, 7 days and
    1 day before expiry ("Your €2.50 voucher from {stall} expires in 6 days."). Tapping it opens the
    coupon. The id `coupon-expiring:<token_id>:<7d|1d>` plus a per-account filed set means an entry
    is never repeated, even after it falls off the bell's 50-row cap. A coupon first seen inside
    1 day gets the 1-day entry only. Excluded: licences, terminal credentials, spent coupons, coupons
    that never expire, coupons P2PK-locked to another key, and coupons the account issued itself.
  - **Home banner** "N vouchers expire this week", linking to a new `/coupons/expiring` list.
    Dismissed, it stays hidden until a coupon crosses a NEW threshold.
  - Both are gated by **Settings → Notifications → Coupons about to expire**. It now shows without
    push enabled, and defaults ON: the reminder is local-only, so nothing leaves the device.
  - No OS notification, no service-worker work and no server call. A wallet that is never opened is
    not reminded. gateway-core `PushNotificationService.notifyVoucherExpiring` remains without a
    caller, flagged for a later cleanup.
- **Expiry visuals** (`src/lib/couponExpiry.ts`, `ExpiryBadge`).
  - An "Expires in N days / N hours / under an hour" badge on the coupon list, the home deck card
    and the merchant page. Amber under 7 days (clock icon), red under 1 day (alarm icon). The text
    is always shown, the aria-label carries the absolute date, and counts are floored.
  - The coupon list is sorted **soonest expiry first** by default, which is the spend order of
    #157. **Newest** keeps the received-date order and is remembered.
  - Expired coupons sit in a collapsed **Expired (N)** group, rather than vanishing. The home
    balance still leaves them out, with a note "N expired vouchers are not counted."
  - Coupon detail: "Expires {date} · in N days", plus a "Use it before {date}" callout inside
    7 days.

- **Card purchase return pages** (#267). `/buy/done` and `/buy/cancelled`, in both route trees,
  are the Stripe return pages for a buyer. The `session_id` is never shown or used; the stall is
  named from this device's own memory (`sessionStorage`, accepted only as a 64-hex key).
- **The Stripe payment reference on the merchant's records** (#267): the full `pi_…` with a copy
  button, the amount and the date on the voucher record, and a compact copyable ref on the sales
  list. Card rows only; no dashboard link (Express accounts).

### Changed

- **The stall map uses OpenStreetMap tiles instead of an embedded map frame** (#263). `LocationMap`
  is now a static map: 2x2 `<img>` tiles from `https://tile.openstreetmap.org/{z}/{x}/{y}.png` at
  zoom 16, the pin drawn at the exact pixel, visible "© OpenStreetMap contributors" attribution, and
  the whole map links to "Open in Maps" (`geo:` in the Android app, openstreetmap.org on the web).
  No iframe, no library, no third-party script, so no third-party cookies are set without consent
  (PECR). Tile requests send the IP address and an origin Referer to the OpenStreetMap Foundation
  and set no cookies. The tile URL is configurable: `map_tile_url` on `/api/v1/config` at runtime,
  else `VITE_MAP_TILE_URL` at build time, else OSMF. The CSP no longer needs a `frame-src` for the
  map (the imani-deploy change ships with or after this release).

Cashlink, phase 1 of #268 (owner, 2026-10-15): typed cashback codes are retired, and "Cashlink"
is the one name for every voucher sent by link, a stall's cashback and a customer's gift link.

- **Show QR again** asks the portal's authenticated, owner-scoped
  `GET /api/v1/portal/cashback/{id}/link` (NIP-98, imani-gateway-portal#92) instead of the public
  by-code lookup. No captcha; it works for a row that never stored a code. Needs portal#92.
- The issue screen shows **no code** and no Copy code: *Cashlink ready*, the QR up front, then
  Share link. The record detail drops its Code row.
- `/receive/cashback` no longer takes a code. It says *"Codes are no longer used. Ask the shop to
  show you the Cashlink QR again."* and still banks a claimed-but-unbanked Cashlink. Receive no
  longer links to it. A `CB-` code scanned or pasted on **Scan** gets the same message and is
  looked up nowhere.
- User-facing copy says **Cashlink**: *Create Cashlink*, *Cancel Cashlink* (still *"The value is
  not returned to you."*), *Cashlink from {stall}*, *Cashlink from {sender}*, *Send a Cashlink*,
  *Anyone, as a Cashlink*, *Make Cashlink*, the **Cashlink** badge, the docs. Routes, identifiers
  and persisted values (`type: 'cashback'`, `gift_link` sources, `claim_code`, `/c/`, `/g`) are
  unchanged.

### Fixed

- **A guest could pay by card and receive nothing** (#267). The Buy page refuses a guest ("Create a
  wallet first to buy a voucher by card") and renders no amount or Pay button, and purchase-issuer
  blocks a claim-recipient debt before minting.
- **A card purchase with no processor reference minted a coupon whose rail read as unknown** (#267).
  purchase-issuer now refuses it (blocked, nothing minted) and keeps the debt for a person.
- **An expired coupon's detail page said "Status active" and showed a redemption QR code** (#265).
  It now reads **Expired**, the code is withdrawn (`toCouponPass` emits no barcode once expired), and
  the page says "This voucher expired on {date}. It can no longer be spent."

### Next phase removes

- by-code on the portal, the FCaptcha gate (imani-deploy#208), `src/lib/captcha.ts` and the code
  helpers (the #257 token code), the `/receive/cashback` route and `E2E_CAPTCHA_BYPASS`, once
  codes already handed out are past their claim window.

## [0.25.0] - 2026-10-14

The wallet sends the edge bot-check token with the cashback by-code lookup (#257), and two
claim/send copy and flow fixes from owner reports (#258, #260). No new build config: the captcha
widget is same-origin (`/fcaptcha/`), and the edge alone decides whether a missing token is refused.

### Added

- **The cashback by-code lookup carries an FCaptcha token** (#257). `src/lib/captcha.ts` loads the
  same-origin widget (`/fcaptcha/fcaptcha.js`), keeps one invisible session and gets a fresh
  single-use token per lookup (action `cashback_lookup`, header `X-Imani-Captcha`). Both by-code call
  sites send it: the customer's typed code and the merchant's **Show QR again** (tills too). The proof
  of work is prewarmed on the redeem screen and on Show QR again.
  - **Fail-open on every path, never throws:** no header when the deployment has no gate, the script
    fails to load (5 s), the solver throws, the visitor scores as a bot, or the token takes more than
    6 s. The lookup always proceeds.
  - An edge `403 {"error":"captcha_required"}` reads as `throttled` ("Too many attempts. Wait a
    moment…"): the code is still good. Other 403s are unchanged.
  - The wallet's own nginx answers `/fcaptcha/` with 404, so without an edge gate the widget fails
    open at once instead of loading the SPA shell.
  - e2e: by-code requests carry `X-Imani-Captcha-Bypass: $E2E_CAPTCHA_BYPASS` when set (e2e/ only,
    never in the bundle).

### Fixed

- **The Login screen says "Log in to redeem"** (#258, owner report 2026-10-14). With a parked claim,
  the Login banner read the onboarding copy ("Create an account…"). It now reads *"Log in to redeem the
  voucher from {stall}"* / *"Log in to redeem your voucher"* / *"{Sender} sent you a voucher from
  {stall}. Log in to add it to your wallet."* Onboarding copy is unchanged. On onboarding with a parked
  claim and a key already on the device, **I already have an account** is the primary button.
- **Send by link from a merchant's page keeps the merchant** (#260, owner report 2026-10-14). Send →
  "Anyone, by link" no longer asks "Which voucher?" again: `from` (and `unit` when settled) is carried
  to `/send/link`, which narrows to that merchant (one option goes straight to "How much?"). When
  nothing from that merchant can be sent by link it says why, with **Choose another voucher**. Without
  `from`, unchanged. The 10-link limit, own-stall exclusion, the #255 merchant rule and in-flight
  filtering are all kept.

## [0.24.0] - 2026-10-14

Two owner rules for merchant accounts (#255, #254). Ship after gateway-core 0.26.0 and
gateway-customer 0.29.0: the servers are the boundary, the wallet's checks are UX.

### Changed

- **Signing up from a claim link makes a customer account** (#254). While a cashback or gift claim
  is parked (live: at most 24 h old), onboarding hides the merchant switch and never shows the
  profile or merchant steps: *"You're redeeming a voucher, so this is a customer account."* The
  submit re-reads the parked claim, so a claim parked by another tab refuses a stale "Create
  merchant account" and shows the customer form; a `storage` event re-renders the form at once.
  With no live claim, sign-up is unchanged.

### Added

- **A merchant account takes only its own stall's vouchers** (owner rule, 2026-10-13). Before anything
  is spent, a merchant account (a stall record on this device, or one on the relay) refuses another
  stall's voucher on every receive path, with *"Merchant accounts can only take their own stall's
  vouchers. To use a voucher from another stall, use a customer account."*:
  - the `/c/` cashback prompt and the `/g` gift prompt show the refusal instead of **Add**, with
    **Switch account** (the claim stays parked for the customer account);
  - a cashback claim (link or code) is refused **before** the destructive ciphertext fetch when the
    portal names the issuer, and before the swap when only the token does (kept in the stash);
  - a gift is refused before the swap; a DM receive is refused before the swap (relay-known stalls and
    unverified vouchers too, extending `refuseIfAnotherStalls`);
  - Send by link refuses a merchant account's foreign coupon (it could never take it back).
  A role that cannot be checked refuses a foreign voucher (Retry; a DM retries on the next tick) and
  never an own one. Exempt: the account's own vouchers, plain ecash, licences (from the pinned seller
  when `VITE_LICENCE_SELLER_PUBKEY` is set) and terminal credentials. The server's 403
  `FOREIGN_VOUCHER_FOR_MERCHANT` (gateway-customer receive, gateway-core atomic send) is shown with the
  same copy. `src/lib/merchantVouchers.ts`, `src/lib/useForeignVoucherRole.ts`.

## [0.23.0] - 2026-10-13

Claim links phase 4: a customer gives a coupon to anyone by link (#247). Wallet only; no server
change is needed.

### Added (claim links, phase 4: gifts by link, [spec](docs/spec-claim-links.md) 3.3, 4.2, 4.3, 5.3, 5.4)

- **Send by link.** Send has a new option, *"Anyone, by link"*: pick a coupon and an amount, choose
  how long the link lasts (1, 7 or 30 days, default 7, Q3), confirm (*"Anyone with the link can
  claim {face} from {stall}. You can take it back until it is claimed."*), and get **Show QR**,
  **Share link** and **Copy link**. The link is `https://<wallet>/g#v=1&k=<linkSecret>&x=<expiry>`;
  the secret is only ever in the fragment.
- **Link keys.** `linkSecret_i = HMAC-SHA256(identitySecret, "imani-gift-link/v1/" || i) mod n`, retried
  on 0, with a local counter that never reuses an index (reserved before the send). An account whose
  key this wallet cannot read gets a random secret instead, carried in its encrypted history backup.
- **The gift prompt at `/g`**, in both route trees. The fragment is scrubbed in the first render;
  with no session the gift is parked (kind `gift`, keyed by the link's public key) and the visitor goes
  to Login or onboarding, where the banner reads *"{Sender} sent you a voucher from {Stall}. Create
  an account to add it to your wallet."* With a session, everything is checked from the token
  itself before Add is offered: the issuer signature, a trusted mint, not a licence or terminal
  credential or locked voucher, not past `x` nor the coupon's own expiry, and every proof UNSPENT by
  NUT-07 (otherwise *"already added"*). Only **Add to my wallet** spends, once, through
  `TokenRedemption.redeem(token, { source: 'gift_link' })`.
- **History.** A gift's `sent` row carries a **By link** badge and its status (Waiting to be claimed,
  Claimed, Taken back, Expired), shows the link again while it waits, and has **Take it back** (Q4).
  On start and on opening the row, each waiting link is checked by NUT-07: spent is Claimed, and
  past its expiry it is taken back (`source: 'gift_link_reclaim'`).
- **Restore scan.** On start, a wallet derives link keys `i = 0 … last + 20` and adopts any
  unclaimed link its history does not know (a lost phone).
- **Limit (Q5).** At most 10 links wait at once: *"You have 10 links waiting to be claimed. Take one
  back or wait for it to be claimed."* No fee.
- New receive sources `gift_link` and `gift_link_reclaim` (`shared/tokenRedemption.js`,
  `packages/wallet-storage`).

### Changed

- **No ADR 0014 transfer signature on a send to a link key** (Q7, pre-check build item 1). Its
  `recipient` would name the link key, not whoever claims it.
- The gift wrap query uses **no rolling `since`** (pre-check build item 2): NIP-59 back-dates a wrap by
  up to about two days, so dm-poll's 7-day window would lose a gift opened late. It is signed NIP-98
  by the link key, never the visitor, with credentials omitted.
- **Gift expiry is `min(chosen, the coupon's own expiry, 30 days)`** (pre-check build item 3).
- The picker excludes licences, terminal credentials, locked vouchers and the sender's own stall's
  coupons (*"To give away your own stall’s vouchers, use Cashback."*); `sendVouchers` refuses them
  as well for a link send.
- `/` resumes a parked claim on its own screen: a gift on `/g`, cashback on `/c`.

Wallet only: the core and customer verifications (spec 6.4, 6.5) and relay retention (6.6) passed
with no server change.

### Security (review hardening of #247)

- A third party's gift wrap to a link's public key no longer freezes the gift: the recipient's
  prompt, Take it back, the reclaim after expiry and the restore scan only consider coupons that pass
  their own checks (signature, allowlist, money, trusted mint).
- One coupon the mint refuses (for example a copy of a real voucher with a bad mint signature) no
  longer stops the rest: every coupon is tried, and the outcome stays "Voucher waiting" with Retry.
- A link index is never reused after this device lost its counter (logout, restore, second device):
  the next index is probed at the gateway before it is used.
- A partly claimed gift offers only what is left, at its own face.

## [0.22.0] - 2026-10-13

A terminal is only a key created as a terminal (option A, #235), the dead atomic-purchase client
is removed (#244), and claim links phase 3 adds registration (#245). Needs imani-gateway-customer
0.28.0 (it reads `X-Imani-Terminal-Enrolment`) and imani-gateway-core 0.25.0.

### Security (option A, inv-terminal-not-merchant, #235)

- **Only a key created as a terminal can be added.** The device's code is now its signed enrolment
  code, `imani-terminal-key:1:<K>:<t>:<sig>` (BIP-340 by K). An account's npub, hex key or handle
  cannot carry it. Add terminal refuses an npub or handle: *"That is a personal account, not a
  terminal."* It also refuses a key that trades as a merchant before anything is signed.
- The proof goes to gateway-customer as `X-Imani-Terminal-Enrolment` and is kept on the minting row
  for a resumed mint. The gateway's `TERMINAL_KEY_NOT_A_TERMINAL` / `TERMINAL_KEY_IS_MERCHANT` reach
  the owner in the same words. Renew sends the owner header only on a renewal, never on a first
  enrolment.

### Removed (#244)

- **The dead atomic-purchase client methods** in `shared/api.js` (imani-gateway-core 0.25.0 removes
  the atomic purchase). Nothing live called them.
- **`scripts/operator.mjs` manual-attention is list-only.** The resolve/refund subcommands refuse,
  because their routes are gone.

### Added (claim links, phase 3: registration, [spec](docs/spec-claim-links.md) 2.5, 4.4, 5.2)

- **A voucher banner on onboarding and Login.** When a claim link is parked, the start step of
  onboarding (above Register, still primary) and Login (above Unlock) read *"Create an account to
  redeem the voucher from {Stall}"*, the face value and the claim-by date, then *"Nothing is claimed
  until you add it. You can do that in a minute, right here."* It reads the portal's public metadata
  for the ref only (the key is never sent or shown), falls back to *"Create an account to redeem
  your voucher"*, never blocks, and says *"Open your voucher link again to add it."* once the parked
  claim has aged out.
- **Switch account** on the claim prompt ("Not you?"): keeps the claim parked and runs the normal
  logout, so it resumes on the next account (CL-SWITCH). The prompt names the account it adds to
  (`Adding to @handle`, spec 4.3; review of #245, F2).

### Changed

- **Parked claims are a short list keyed by ref** (review of #239, F4-1): at most 5, each with its
  own 24 h age. Opening a second link while logged out no longer overwrites the first (O4), a link
  that fails before the spend is parked beside a different parked claim rather than skipped, and
  forgetting one claim leaves the others. `/` resumes the newest one not yet shown. A value from an
  older build is read as a list of one. Entries carry `kind` (and `x`, for phase 4 gifts).
  An aged-out entry is erased, key included, once the banner has said "Open your voucher link
  again" (said once, not on every visit) or when `/` resumes; an entry stamped in the future is not
  live; the resume never revisits a ref, so a storage that refuses writes cannot hang the tab
  (review of #245, F1, F1b, F3).
- **Parked claims survive logout** (spec 2.5): logout still erases every other `imani-wallet:*` key
  and all account data.

### Tests

- Unit: `pendingClaimList`, `logoutKeepsParkedClaim`, `ParkedClaimBanner` (incl. key never in a
  request, a log line or the DOM), Switch account; single-slot assertions updated to the list.
- Gate e2e `claimLinks.e2e.ts`: L11 CL-B (two links, register, both added), L12 CL-B2 (Login with the
  banner), L13 CL-SWITCH (claim survives the switch, nothing of the old account does).

## [0.21.0] - 2026-10-12

Claim links phase 2: the merchant's link and QR (#241), plus a local-gate guard on the licence e2e (#242).

### Added (claim links, phase 2: the merchant's link and QR, [spec](docs/spec-claim-links.md) 4.1)

- **Cashback ready shows a link and a QR next to the code.** The code is unchanged and stays first
  (Q2). **Show QR** reveals a QR of `https://<wallet-origin>/c/<ref>#k=<key>` (hidden until tapped,
  against shoulder-surfing). **Share link** uses the system share sheet, or **Copy link** where there
  is none. The note reads *"Anyone with this link or QR can claim it once. It works until {date}."*
- **Live status.** While the screen is open it reads the merchant's own `/status` every 5 s and swaps
  the QR for *"Claimed just now"*. Gentle by design: failures back off to 60 s, a hidden page asks
  nothing (and asks at once when shown again), a final status stops it, and it never touches the
  public metadata limiter.
- **Cancel cashback** on that screen and on the record page: the portal's existing revoke, asked
  first with *"… The value is not returned to you."* (Q4: a cancelled or expired cashback still
  burns, no refund). A 409 (claimed first) says so.
- **Show QR again** on the record page while the code is open: rebuilds the identical link from the
  stored code through `by-code`, which spends nothing. Works after a reload because nothing about the
  key is stored: it lives only in the screen's memory (spec 4.1).
- `generateCashback` keeps the portal's `claimKey` (it used to drop it) as `IssuedCashback.claim`.
  New `lib/claimLink.ts` (`formatCashbackLink`), `lib/claimLinkShare.ts`, `lib/cashbackLiveStatus.ts`,
  `revokeCashback` and `resolveClaimLinkByCode` in `lib/cashback.ts`. No new dependency (`qrcode`).
- New `e2e/claimLinksMerchant.e2e.ts`: CL-A, CL-RACE, CL-OWN and Show QR again, paced under the
  portal's public limiter.
- **A till's Cashback ready** shows the link and QR but neither polls the owner-only `/status` nor
  offers Cancel (both are merchant-only on the portal); the owner keeps both (review of #241, F1).

### Changed (tests only, #242)

- `e2e/licenceGate.e2e.ts` runs on the local gate only: a header note, and it exits 2 when
  `E2E_BASE` is not loopback (it mints real vouchers; the staging edge refuses such bodies since
  imani-deploy#183).

## [0.20.0] - 2026-10-12

Claim links phases 0 and 1 (#238, #239), plus the terminal wrong-path fix (#236).

### Security (claim links, phase 1: the confirm prompt, [spec](docs/spec-claim-links.md) 4.3)

- **Opening a claim link never redeems it.** With a session, `/c/:ref` (and `/c`, the resume of a
  parked claim) used to call `redeemClaimRef` on load, so anything that rendered the link in a
  logged-in browser (a prefetch, a link preview, a restored tab, a mis-tap) spent the voucher. It
  now shows a confirm prompt built from the portal's public metadata, which is not destructive:
  the stall (resolved from the issuer key), the face value, the claim-by date and what could be
  verified. **Add to my wallet** redeems, exactly once however often it is tapped. **Decline**
  forgets the parked claim on this device and leaves the voucher unclaimed.
- **Verification before the tap.** `✓ verified stall` only when the issuer is a well-formed key that
  resolves to a published stall; otherwise *"We could not verify this voucher"* and *Unknown stall*.
  Add is disabled for a malformed issuer, and when the wallet trusts no mint. The voucher's own
  signature (against `VITE_VOUCHER_ISSUER_PUBKEYS`) and its mint (against the trusted-mint list) are
  still checked on Accept by the existing redeem, which holds a token at an untrusted mint.
- **States instead of Add:** already claimed (with the date), expired (including an `Unclaimed`
  record past its expiry), revoked, your stall's own cashback (a merchant opening its own link is
  refused, spec 3.2), not found, incomplete link, unreachable (with Retry: nothing was spent), and a
  deployment that cannot claim. A different logged-in account sees the prompt as its own.
- **The claim key stays in memory.** It is read from the fragment in the first render and scrubbed
  from the address bar with `history.replaceState` before any await. Tests assert it never reaches
  a request URL, a header or a log line, and that no request on the link path carries a voucher
  declaration header (D9). The typed code (`/receive/cashback`) is unchanged (Q2).
- New `fetchClaimSummary(ref)` in `lib/cashback.ts`: the non-destructive read the prompt uses.
- New `e2e/claimLinks.e2e.ts` (CL-BOT, CL-OWN, closed states, Decline, Accept once, the returning
  device, the hosted page's headers): run on the local gate with
  `E2E_SCRIPT=claimLinks.e2e.ts E2E_CLAIM_HOST_VIA=http://127.0.0.1:<edge port>`.

### Fixed (claim links, phase 0: [spec](docs/spec-claim-links.md))

- **A returning device that opens a claim link goes to Login, not to registration.** With no
  session, `/c/:ref` sent everyone to `/onboarding`, which offered Register to a customer who
  already had an account on this device. It now routes by device, as `Entry` does: a stored key
  goes to `/login` (unlock), no key goes to `/onboarding`, and a terminal goes to its till and
  parks nothing (a terminal key must never open a customer session). The claim is parked and the
  fragment is scrubbed from the address bar before the async key-store read. Nothing is redeemed
  on this path, and `/` still resumes the parked claim once the session opens.

### Fixed (terminals, #236, imani-wallet#160 owner report)

- **A terminal credential is never money.** A logged-in personal wallet that received a terminal
  credential DM (`imani-terminal-credential/1`) used to extract its 1-sat cashuB token through the
  text fallback and swap it at the mint, so it showed "Payment received" and spent the credential.
  Only the app's own message types are skipped now, a credential is never extracted from any
  envelope or text, and `spendable()` excludes a verified terminal credential from balance,
  carousel, pay and send. The bell says "Terminal setup request from <stall>" (deduped on the
  signed voucher id) instead.
- **Scan routes a terminal setup code** (`imani-terminal:1:`) to `/terminal/setup`; a device with a
  personal wallet is told it needs its own device with no account.

### Added (#234)

- `scripts/operator.mjs` for gateway-core's operator endpoints (not bundled into the app).

## [0.19.0] - 2026-10-11

Seller licence revocation (#226, #230) and the holder side of the mint's per-coupon redemption
cap (cashu-mint#540 phase 2, #231). Needs gateway-customer 0.26.0 and gateway-core 0.22.0.

### Added (#226)

- **The seller revokes a subscription** (refund): `scripts/sell-subscription.mjs --revoke sub_…
  [--reason …]` signs gateway-customer's NIP-98 `POST /api/v1/wallet/licences/revoke` and marks
  the sale revoked in `.sold-subscriptions.json`. A renewal under a revoked id is refused before
  any key or network access. `notify-expiring.mjs` skips revoked subscriptions. The staging
  `WALLET_URL` is `https://wallet.staging.398ja.xyz` (the NIP-98 origin).
- **The wallet honours a revocation.** A report answered 422 `LICENCE_REVOKED` is remembered per
  (subscription id, seller); `licenceStatus` answers `REVOKED_BY_SELLER` (final, no grace) when
  only revoked subscriptions are held, the Subscription screen says the seller ended it, and paid
  tills stop being offered.
- **e2e/licenceGate.e2e.ts** proves a copied licence is useless (wrong key, 422, mint refuses) and
  that revocation is immediate with no grace on a stall holding nothing else.

### Added (cashu-mint#540 phase 2)

The holder side of the mint's per-coupon redemption cap. Pairs with
imani-gateway-core#143 and imani-gateway-customer#216, which declare credits and answer
`VOUCHER_FULLY_REDEEMED`; without them nothing here fires.

- **"Redeemed in full" is terminal.** A payment or send that gateway-core reports FAILED with
  `error_code = VOUCHER_FULLY_REDEEMED` (the mint refused the coupon, 90025) shows "This coupon has
  already been redeemed in full. If you believe this is wrong, contact <stall>, quoting reference
  <8>." It is not retried and not reclaimed (nothing moved), and the coupon is marked
  `fully_redeemed`, so it is never offered for a payment again. A send that ended this way after
  the wallet stopped waiting is marked on the next login.
- **Swap back to sats** (`src/lib/swapBack.ts`), offered under that refusal and on the stall's
  coupon list: the wallet's own swap at the coupon's trusted mint turns its proofs into plain sats
  only this wallet holds, kept on the row as a `cashuB` token. It sends no declaration header, so
  it consumes none of the coupon's cap. An interrupted swap back is finished by the start-up
  recovery sweep.
- **The till** maps gateway-customer's 400 `VOUCHER_FULLY_REDEEMED` on a home-coming coupon to a
  terminal `fully-redeemed` refusal, announced to staff and never retried.
- **D9 guard tests**: the wallet never sends `X-Cashu-Voucher-Redemption` or
  `X-Cashu-Voucher-Redeemer`, and its own receive swap still refuses vouchers.
- **wallet-api**: `/v1/redeem/prepare` is documented, with the `VOUCHER_FULLY_REDEEMED` answer
  integrators get from the receive it hands them. wallet-api holds no redeemer token (it never
  swaps), pinned by a test.

## [0.18.0] - 2026-10-10

Paid extra terminals sell (#197). Pairs with imani-gateway-customer 0.25.0 and imani-gateway-portal
0.14.0; without them the report is refused and nothing changes.

### Added

- **The owner's wallet reports its licence to the server** (`src/lib/licenceReport.ts`). When the
  dashboard (after login, and whenever a licence or renewal arrives by DM) or the Terminals screen
  finds a licence that verifies, it sends `POST /api/v1/portal/licence` with the licence's proof
  SECRETS only, never C, so nothing on the path can spend it. NIP-98 signed by the stall: the server
  licenses only the signer, and only if the licence is locked to it. At most once per 6 hours for
  the same licence, at once for a renewal. Fire and forget: a failure changes nothing on screen.
- **`VITE_LICENCE_SELLER_PUBKEY`** (build arg): the licence seller's stall key. A licence must name
  it as `issuer`, or it grants nothing here and is never reported. Unset does not pin, and says so
  once in the console. The server pins regardless (`GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS`).

### Changed (review of #197)

- **A stranger's licence-shaped DM can no longer shadow the real licence.** A report refused 422
  remembers that voucher and tries the next held licence by expiry at once (at most 3 per report);
  a refused voucher is never sent again. An outage (503) stops there and remembers nothing.
- **A licence must be locked at the mint (`P2PK_VOUCHER`)**, its NUT-11 key equal to its signed
  `lock_key`, as the server requires. A plain `VOUCHER` licence is `not-locked-at-mint` here too.
- **`scripts/sell-subscription.mjs` mints licences `FIXED`** (ADR 0007): one sat, one proof, with
  the seller's own sale warrant. `PROPORTIONAL` split a GBP 40 licence into a dozen locked proofs
  whose witness header the edge refused on receive ("Request Header Or Cookie Too Large").
- **`scripts/sell-subscription.mjs` signs as the deployed seller from `IMANI_SUBSCRIPTIONS_SELLER_NSEC`**
  (env var, or `--env-file <deploy .env>`, which reads only that line). The nsec lives only in the
  deploy env file; `.seed-keys.json` stays the local dev fallback. A bad value is refused without
  being echoed.

## [0.17.0] - 2026-10-09

Terminals phase 6 (imani-wallet#160): till sales reach the owner, the terminal list syncs across
the owner's devices, one-tap Renew, expiry on the till, and the home-coming roster check. Pairs
with gateway-customer 0.24.1 (review NITs only) and imani-cashback-claim 0.1.0 (a till's cashback
ciphertext is about 73k, over the old 64 KiB deposit cap); renewal needs no server change.

### Added

- **A till's sales reach the stall's history (#202).** A till has no wallet, so its sale and
  cashback rows were lost. It now sends them to the stall as a NIP-17 gift wrap sealed by its own
  key (`imani-terminal-sale/1`), keeping any that did not land in an outbox retried at every
  unlock and every minute; Take out of service warns while any are waiting. The owner's app files
  a row only when the sealer is the lock of the credential in the row's `terminal` warrant and the
  warrant verifies for this stall, the stall's own attestation included, and files it as the
  owner's own 7376. Collected at login, on the Vouchers list and when dm-poll sees one. Each wrap
  is budgeted in UTF-8 bytes to stay at or under 55,121 bytes, inside strfry's 65,536.
- **The Note on Sell and cashback is capped at 280 characters,** the portal's own cashback memo
  limit, so a long or non-ASCII note cannot push a till's sale past the relay. Its worst case is
  about 1,960 bytes as the wrap budget counts it (escaped in the sale's JSON), 840 bytes raw.
- **A terminal's name is capped at 64 characters.** The name rides in every warrant the till
  builds, and the portal refuses a warrant over 4,096 characters, so a very long name left a till
  whose every sale was refused.
- **The Vouchers list names the till** ("· Sold on Front counter", "(no longer in service)").
- **The terminal list syncs across the owner's devices.** An encrypted kind-30078 event
  (`d=imani:terminals`), chunked above the relay budget, merged by a property-tested join that
  never un-revokes, never moves status backwards and never drops the token of an unrevoked
  credential. Rows keep every credential the device ever held (`credentials[]`). Synced at login,
  on every change (debounced) and when Terminals opens, then checked against the mint.
- **Renew.** One tap mints a fresh, attested credential to the same device key and sends it with
  `renews`. Amber 30 days and red 7 days before expiry. The till adopts it at unlock (same
  passphrase, no setup code), confirms it, tells the stall, and spends its own old credential so
  the free terminal follows the renewal. A renewal not adopted in 24 hours is cancelled, unless
  the mint shows the till adopted it and only its enrolled notice was lost: then it is completed.
  Revoking a till also spends a renewal it has not picked up yet, first. Renewals
  count against the two-waiting limit; the list says how many more wait. Replaces the four
  re-enrol steps for a till set up before owner attestation.
- **Expiry on the till.** Past its expiry a till opens for Redeem only with "Ask the owner to
  renew it. Redeeming still works."; within seven days it warns.
- **Ask the owner to renew.** A till the owner's list lost can send its own credential to the
  stall, which adopts it (only this stall's, co-keyed, locked to the sender, trusted, unspent).
- **Home-coming roster check.** A coupon from a `terminal` warrant whose credential the roster has
  never had raises "A coupon came back from a till that is not on your list" (never refused;
  quiet until the roster has synced once on the device).

### Fixed

- **Logout no longer loses the terminal list (F4).** It was the only copy of the stall's
  revocation handles; it now comes back from the roster event.
- **A restored history keeps each till sale's till (F2).** The 7376 content carries
  `terminal_pubkey`, and `toTransaction` reads it back (it never did, even locally).

## [0.16.1] - 2026-10-09

A new merchant sells from the first render (#114). Pairs with imani-gateway-core 0.21.1
(nap-java 0.9.1: `/auth/session` resolves the ACL live).

### Fixed

- **Re-read `/auth/session` after a login that lost the race to the stall record (#114, #217).**
  A merchant who publishes their stall record and logs in at once can beat the gateway's ACL,
  so the login answers customer while this device holds an active stall record, and the home
  showed no Sell until a reload. Only when the two disagree, the wallet re-reads
  `/auth/session` up to twice (after 500 ms and 1.5 s). It never grants anything itself: the
  session is whatever the server answers, and any failure keeps the customer view (fail closed).

### Tests

- The terminal e2e gate asserts a freshly registered stall shows Sell on its first render, with
  publish and login forced to race (#217).

## [0.16.0] - 2026-10-09

The stall owner attests each terminal credential, wallet half (imani-wallet#160 decision 5, step
5b-5, #211). Pairs with gateway-customer 0.24.0, gateway-core 0.21.0 and gateway-portal 0.13.0.
Also bundles #203 (chunked coupon backups) and #214 (nap from npm).

### Changed

- **A till sells only with an attested credential (#211).** At unlock, a present but invalid
  owner attestation refuses the till; a missing one admits it for Redeem only. The till and the
  roster show "Renew to keep selling" for an unattested till.
- **The owner attests each terminal credential at enrolment (#211).** The enrol screen signs an
  `owner_attestation` with the stall signer and sends its expiry T in
  `X-Idempotency-Expires-At`. The minting row keeps the attestation and the idle lock, so a
  resumed mint re-sends the identical body under the same Idempotency-Key. The returned
  credential's whole merchant metadata is checked against the request, and a credential that
  outlives T is refused.
- **Warrant checks mirror cashu-voucher 0.17.0 (#211).** `verifyTerminalWarrant` and
  `verifyOwnerAttestation` refuse `OWNER_ATTESTATION_MISSING`, `BAD_OWNER_ATTESTATION` and
  `ATTESTATION_EXCEEDED`, check the issuer tag as the Java does, and replay cashu-voucher's
  golden owner-attestation vectors. A customer reads a missing attestation as unwarranted, and a
  bad or exceeded one as failed.
- **The nap packages are npm dependencies; the build no longer needs a `../nap` checkout (#212).**
  `@imani/nap-core`, `-client-http`, `-client-web`, `-client-nip46` and `-react` are installed at
  `^0.12.0`, published as `@398ja/nap-*` and aliased to their import names in `package.json`, so
  no import changes. The source aliases in `vite.config.ts`, `tsconfig.app.json` and
  `tsconfig.services.json` are gone, and so are the Dockerfile's second build context and nap
  install and the perf workflow's nap checkout. `git clone`, `npm ci`, `npm run build` and
  `docker build .` work with this repository alone, and the nap version is pinned in
  `package-lock.json`. The bundle drops about 92 KB (gzip about 33 KB): the old layout compiled
  a second copy of `nostr-tools` and `@noble/*` from `../nap/node_modules`, and the published
  packages share the wallet's copy as peers.

### Fixed

- **A coupon too large for one relay event is now backed up in chunks (#203).** A 7-proof terminal
  coupon's NIP-60 record came to 66,063 bytes after NIP-44, and strfry (`maxEventSize` 65,536)
  refused it, so a wiped browser could not get it back. When a record's estimated size after
  NIP-44 would exceed 60,000 bytes, it is gzipped, split into chunks of 40,960 bytes or less
  (`maxNip44PlaintextSize(65536 - 1536)`), and each chunk is NIP-44-sealed to self. This uses
  `nostr-chunked-events` v0.3.0's `createSnapshotChunks` format: the `chunk`, `snapshot_id`,
  `payload_hash` (over the plaintext) and `total_chunks` tags, plus `record_id` = token_id and
  `d` = `<token_id>-chunk-<n>`. The real coupon becomes one 14 KB event. A record that fits
  stays one plain kind-7375 event, unchanged for other NIP-60 wallets.
  - Restore and back-fill reassemble chunked records in index order, not relay order. They
    verify the payload hash, accept a retried chunk, and still read single-event records and
    chunks without `record_id`.
  - A coupon with a missing or corrupted chunk is skipped with a warning, once per session and
    not at all once a good snapshot exists. Back-fill publishes it again; it trusts a chunk set
    only after hash-checking it.
  - Spent and superseded chunk sets are deleted with NIP-09. This is advisory; the tombstone
    stays the authority.
- **Relay reads no longer stop at 500 events.** strfry caps a filter at `maxFilterLimit` (500)
  newest events. `allEvents` now pages with an `until` cursor, so a wallet with a long history
  restores its oldest coupons too. It also no longer takes a page cut short by the read timeout
  as the end.
- **A relay's refusal is no longer silent.** `publish()` already counted an `OK false` as a
  failure. Now a test locks that against a real socket. The coupon, transaction and signup
  merchant-record writers ignored the result. They now log the relay's reason.

### Added

- `nostr-chunked-events` v0.3.0 as a git dependency (`github:398ja/nostr-chunked-events#v0.3.0`,
  locked at `8f45de7`). It is imported only through `src/lib/chunkedRecord.ts`. `pako` and
  `@noble/hashes` come in through it, not as direct dependencies.
## [0.15.2] - 2026-10-08

### Fixed

- **A chunked coupon is no longer stranded between reassembly and save (#204).**
  `dmChunks` marked a transfer completed, and persisted that, the moment its pieces decoded.
  That was before the coupon was redeemed, saved or its escrow acked. A reload mid-receive,
  or any outcome dm-poll leaves retryable (a failed save, a deferral, a transient error), then
  left the coupon unreceivable for 8 days ("holding chunk" on every poll), with
  gateway-customer's escrow never acked. A transfer is now marked completed only when dm-poll
  marks its completing wrap processed, after the save. Until then, the completing wrap yields the
  coupon again and the receive replays under the same idempotency key, so the coupon is saved
  once and the escrow acked once. Tombstones from earlier builds are re-checked, so coupons they
  stranded are recovered. dm-poll also no longer consumes a same-token duplicate while the first
  redemption may still fail.

## [0.15.1] - 2026-10-08

### Changed

- **Terminal e2e: an owner surface may refuse a till at the edge (401) or the portal (403).**
  imani-deploy#139 lets a till through the edge only for Sell and cashback issue. Dashboard,
  campaigns, policies and SSE still need a NAP session there and answer 401 "No session cookie"
  before the portal sees them. The phase 5 probe accepted only the portal's 403, so it would have
  failed the redeploy for the stricter answer. It now accepts either refusal, and the edge's only
  when the body is the edge's own. Sell, replay 409 and revoked 403 are unchanged.

## [0.15.0] - 2026-10-07

### Fixed

- **The wallet and cashu-voucher accept exactly the same terminal credentials (#196 review).**
  A parity fuzz against cashu-voucher found 16 verdict differences. `parseCredentialSecret` now
  refuses what the Java parser refuses: a repeated tag row (any tag); `data` that is not lowercase
  hex with a `02`/`03` prefix on secp256k1; a lone surrogate in the nonce or any tag; and anything
  NUT-11 calls malformed (bad or duplicate `pubkeys`/`refund` keys, `data` repeating a `pubkeys`
  key, `n_sigs` out of range, an unknown `sigflag`, a `locktime` with no refund keys).
  `lock_key` must be lowercase. The Java side of the same fix is cashu-voucher#56 (0.16.1,
  unreleased): one value per row, lowercase `lock_key`. The wallet does not depend on 0.16.1. It
  is a standalone mirror, and only the parity harness runs the snapshot.
- **#194: an integral float such as 1000.0 gets no legacy window.** The CBOR reader now records
  which fields arrived as floats, and `verifyVoucher` refuses the legacy form when `faceValue`,
  `expiresAt` or `faceDecimals` is one (or is not a number at all). Java's `Long.parseLong` refuses
  `"1000.0"`, and JS could not tell 1000.0 from 1000.
- **`trustedCredentialServiceKeys` reads `import.meta.env` directly**, so Vitest's `stubEnv` reaches
  it and a test can tell the build's allow-list from an empty one. Production was already inlined
  by Vite. Under tsx the list is still empty.

### Changed

- `issueAndDeliver` no longer calls `mayWarrantSale` after `canIssueNow`. For a terminal they are
  the same check, so the second call was dead code. `holdsWarrantCredential` stays.
- Documented in `terminalUnlock.ts`: a till revoked mid-day re-unlocks within its twelve-hour
  session without a mint check. The portal's revocation check at every issuance is what stops it
  selling, and the session length bounds the rest.

### Tests

- Tests that kill mutants the review found surviving: the offline `skip-offline` expiry, the
  default trusted keys, `lockTerminal` clearing the request credential, and the `/sell` and
  `/sell/cashback` route gates. The REDUCED and redeem-only route tests now wait for the stall
  record first. Before that, every till was redirected whether or not the gate existed.

### Added

- **A terminal sells (#160 phase 5).** A *Sell and redeem* till in a FULL session now has Sell
  and cashback (`/sell`, `/sell/cashback` in `TerminalApp`). It signs the new `terminal` issuance
  warrant: `{"form":"terminal","sale_total","face_decimals","unit","nonce","signature","credential"}`,
  where `signature` is BIP-340 by the till's own key `K` over `warrantSaleDigest` with
  `issuerId` = the stall, and `credential` is the terminal credential's signed NUT-10 secret
  (never the proof's `C`). Every request from an unlocked till carries
  `X-Imani-Terminal-Credential: <voucherId>`, read from the token's signed bytes. A REDUCED
  till, a redemption-only till, or a till that has lost its credential is refused before
  anything is minted. Needs gateway-portal, gateway-customer and gateway-core phase 5 deployed:
  until then the portal refuses a terminal's Sell, and nothing is minted.
- **The customer's wallet verifies `terminal` warrants offline** (`terminalWarrant.ts`), a
  mirror of cashu-voucher's `IssuanceWarrant.verifyTerminal` (0.16.0, tightened to 0.16.1 below): lowercase hex64
  `issuerId`; no C0 (US included), DEL, C1 controls or lone surrogates in `unit` and `nonce`;
  `sale_total` within 0..2^53-1 and `face_decimals` 0..18; a credential signed by a trusted
  service key (`VITE_VOUCHER_ISSUER_PUBKEYS`) under strict canonical verification with no
  legacy window; the credential's issuer is the stall, its metadata a selling terminal whose
  `lock_key` is not the stall and is the mint lock; and `K`'s sale signature. The credential's
  expiry is skipped offline (`ExpiryCheck.skipOffline`, boundary `now > expires_at`), so a
  coupon sold before the till expired stays `verified`. Pinned against the Java's frozen golden
  credential.
- **e2e: terminal Sell.** `E2E_PHASE=5 npm run e2e:terminal-setup` adds a sell-and-redeem till
  that sells to C (C's verdict `verified`, A sees the sale attributed), a replayed nonce (409),
  403 on dashboard, campaigns, policies and SSE, a REDUCED till refused before minting, and a
  revoked till's Sell (403). The server-side checks print PENDING until `E2E_P5_DEPLOYED=1`.

- **Revocation reaches the owner's list from the mint (#160 phase 4).** Opening Settings →
  Terminals asks the mint (NUT-07, read-only) about every live row with a token, and marks
  revoked any whose credential is already spent: a device that took itself out of service, or
  one revoked from another of the owner's phones. Only a definite `SPENT` marks a row; an
  unreachable mint leaves it in service, so the one handle that can revoke it is never hidden.
  A **waiting** row marked this way also gives the gateway its pending slot back (`/cancel`), as
  revoking it from this phone does, so the owner is not blocked from adding a terminal for 24
  hours (#160 review).
- **The e2e covers revocation end to end.** `npm run e2e:terminal-setup` now has A revoke B,
  then B is refused at unlock with "no longer in service", B takes itself out of service, and a
  second device that hands itself back reads Revoked on A's list.

- **A terminal opens its till (#160 phase 3).** A device set up as a terminal now lands on
  `/terminal/unlock`, where its passphrase opens the till. Unlocking never opens a NAP
  session, so a terminal makes no call to `/api/v1/auth/*` and is never signed in as a
  customer. The mint's NUT-07 answer decides the session: `UNSPENT` opens FULL, unreachable
  opens REDUCED (redeem only), `SPENT` refuses with "no longer in service" (G8: before this,
  every terminal opened REDUCED because nothing asked the mint).
- **The till is its own app.** `TerminalApp` sits beside `AuthedApp` and starts no DM poll,
  wallet sync or push. It offers the till (terminal and stall name), Redeem, Settings →
  Security → Take out of service, and Lock. Every other path, the owner's dashboard included,
  lands on the till; a locked till sends every path to the unlock screen.
- **Redeem on a terminal says Paid (G12).** The customer's coupon goes to the stall, so a
  terminal's own wallet never sees it. On a terminal the Redeem screen asks gateway-core
  (`GET /api/v1/atomic/fulfilment/{id}`, NIP-98 signed by the terminal key) every 3 s, and
  only an answer naming this stall counts. The dev proxy routes that path to gateway-core.
- **The idle lock (decision 2).** An untouched till locks after the owner's chosen minutes (10
  by default, `0` is never), and Lock does the same. Locking drops the signer and keeps the
  12-hour session, so unlocking again within it needs only the passphrase.

### Fixed

- **The legacy-canonical signature window refuses fractional `face_value`, `expires_at` and
  `face_decimals` (#194).** Mirrors cashu-voucher#54. Under the legacy truncation, `expires_at`
  rewritten from `1808069579` to `1808069579.5` hashed to the signed bytes, and Java then read
  the expiry as absent. Only `issuance_ratio` was ever fractional on a genuine pre-fix voucher.

### Changed

- The *Sell and redeem* role reads "A full till: sells and honours your coupons", and a REDUCED
  till says why it cannot sell.

### Security

- **A customer could fake "Paid" on a terminal's Redeem (#160 review, BLOCKER).** The till
  showed Paid for any fulfilment gateway-core reported, which was any completed send carrying
  the request id, and the payer sets that id. Reading it off the QR code and sending 1 sat to
  yourself was enough. The till now registers the request's terms with gateway-core before it
  shows the code (`PUT /api/v1/atomic/fulfilment/{id}`, first registration wins), and Paid
  needs the answer to name the stall as recipient and as issuer, in the request's unit, for at
  least the request's amount. An answer missing any of these, or a request gateway-core would
  not register, is never Paid. Needs imani-gateway-core#131.
- **A terminal credential needs a signer this build trusts (#160 review, IW-15).** The
  signature is checked against the `issuer_pubkey` the token carries, and an unset
  `VITE_VOUCHER_ISSUER_PUBKEYS` meant "unchecked". No deploy set it, so a credential re-signed
  with any key opened an issuing till for any stall. A terminal credential is now refused
  unless its signer is on the list, and an empty list refuses every one ("cannot confirm who
  issued this terminal's authority"). Customer coupons keep the old rule. **Deploy:** set
  `VITE_VOUCHER_ISSUER_PUBKEYS` to the gateway's voucher issuing key (imani-deploy PR), or no
  terminal opens.
- **A refused terminal is no longer stranded (#160 review).** A credential that cannot be read,
  is not this device's, or has an untrusted signer can never be handed back, so Take out of
  service failed and erased nothing. Those refusals now offer **Remove this terminal from this
  device**, which clears everything logout clears and says the owner should still revoke it.
- **A terminal record without its token stays a terminal (#160 review).** It used to read as not
  enrolled, so the device went to `/login` and its terminal key opened a customer session
  (spec 2.3). It now reaches the unlock screen, is refused, and is offered removal.
- **The idle lock is signed (#160 review).** The owner's idle lock is signed into the
  credential (`idle_lock_minutes`), and the till prefers it to the editable device record.
  Credentials minted before this fall back to the record.
- **The device record can no longer raise a terminal's role (IW-15).** Login read the stall,
  role and lock from `merchantMetadata`, `issuerId` and `permissions` stored beside the token,
  which anyone holding the device could edit: a redeem-only till could be edited into an
  issuing one. Login now reads them from the token's own bytes, after checking its single
  `P2PK_VOUCHER` lock equals the metadata's `lock_key`, its signature, and (where the build
  names them) its signing key. The record keeps only the token as authority, a record without
  one reads as not enrolled, and `completeEnrolment` refuses a token that does not match the
  credential it verified. `enrolledActor` and its `nosemgrep` are gone, so Semgrep reports 4
  findings, down from 5.

### Documentation

- **Spec 9.1 decision 6 describes what shipped (rev80-r2 LOW-E).** `free` comes from
  gateway-customer's V28 `terminal_credential` registry plus the V27 pending-row standing, and
  counts `issue-and-redeem` credentials only (a redeem-only terminal never holds the free sell
  slot, rev80-r2 LOW-D). Sections 5.2 to 5.4 now say a store or mint that cannot vouch is 503 at
  gateway-customer and core, not `live: false` (rev80-r2 MEDIUM-A).
- **Spec 5.3 (terminals in service): `live: false` yields `[]`.** A not-live credential gets no
  permissions at all, not even redeem, and the stall must be an active merchant; ACL or
  gateway-customer failures fail closed. Matches gateway-core#130 after its review (imani-wallet#160).
- **Spec 5.3, 5.4 and 9.1 after the gateway-portal#80 review.** Core relays gateway-customer's
  `free` as `terminal:free`, and answers 503 (not `[]`) when gateway-customer or the ACL store is
  down. The portal replaces (not adds to) the request's authorities, caches only refusals so a
  revoked till is refused within 30 s, and never calls gateway-customer. New section 9.1 records
  the owner's phase 5 decisions: one nonce ledger without a `form` column (option b), and `free`
  computed by gateway-customer from the voucher list (option a).

## [0.14.3] - 2026-10-06

### Fixed

- **A voucher whose expiry was stored as a numeric string is no longer spent last** (#157).
  `expires_at` reached the wallet as an ISO string, a number in seconds or milliseconds, or a
  numeric string of seconds (what gateway-core's `/inspect` returned before v0.6.1, stored verbatim
  and carried to new devices by NIP-60 restore). The numeric string read as "never expires", so
  the voucher closest to being lost went last. Every coupon is now STORED with its expiry in one
  format, epoch seconds, whichever way it arrived (DM, claim, cashback, restore, import), and
  rows stored before this are repaired when the wallet opens: idempotently, safely with two tabs
  open. One parser replaces four copies that disagreed; it reads a zone-less ISO time as UTC and
  no longer takes junk like "12/31" for a date. A stored value nobody can read is repaired from
  the expiry signed into the voucher's own token; failing that it is kept as it was and logged,
  never turned into "never expires", and as a last resort spent first. When a
  sooner-expiring voucher is left for a legitimate reason (another stall, another currency, too
  small, or it cannot be divided to the amount), the pay screen says so in one line and the
  `[pay]` log records which voucher and why.
- **A far-future expiry is never stored as a past one** (#157 review). A "practically never"
  date such as 31 Dec 9999 is 253402300799 in seconds, which the old seconds/milliseconds
  boundary (1e11) read as milliseconds in 1978. The repair would then have stored a live
  coupon as long expired. The boundary is now 1e12, and converting to whole seconds rounds up,
  so storing can only keep an expiry where it was, never move it earlier.
- **Storing an expiry is now a fixed point** (#157 review). A value of 1e15 or more (for example
  1.7e15) was stored as 1.7e12 seconds, which the next read took for milliseconds in 2023, so
  the repair that runs on every open would have written a past date over a live coupon. Any
  value whose whole seconds would reach 1e12 is now unreadable, and is repaired from the
  expiry signed into the voucher's token.
- **The expiry signed into the token wins over the stored copy** (#157 review). The stored
  `expires_at` is only a cache; a readable but wrong copy no longer hides a live coupon as
  expired or changes its place in the spend order. The stored value is used only when the token
  carries no signed expiry.
- **Values no producer writes are unreadable rather than guessed** (#157 review): a fraction
  below 1e9 such as `'0.5'`, and a day that does not exist such as `'2026-02-30'`, which used to
  roll over into March.
- **An ISO date-time with no zone is now read as UTC** (#157), not as the device's local time,
  so the same stored value names the same instant in Nairobi and in London.
- **The pay screen's "sooner voucher not used" note matches what is spent** (#157 review): it
  compares issuers the way the wallet groups them (an npub keeps its case) and leaves out
  vouchers this wallet has already spent on another device, as the payment itself does.

## [0.14.2] - 2026-10-05

### Fixed

- **A new terminal can be put in service again.** 0.14.1 sent the terminal credential
  confirm and cancel calls (`POST /api/v1/wallet/terminal-credentials/{id}/confirm` and
  `/cancel`) with no body, so their NIP-98 signature carried no `payload` tag, and the
  gateway's filter refuses every POST without one (401 "NIP-98 payload tag required for
  POST"). On staging every terminal enrolled after gateway-customer V27 stayed unconfirmed
  and could never sell. The stall confirm, the device confirm and the cancel now send `{}`
  as JSON, signed in the `payload` tag. purchase-issuer's credential confirm now sends the
  same shape. It was not broken: it already signed the hash of its empty body.
- New tests run the real wallet signer against a port of the gateway's NIP-98 checks for
  each of these calls, so a missing or wrong `payload` tag now fails `npm test`.

## [0.14.1] - 2026-10-05

### Fixed

- **The wallet image builds again.** 0.14.0's Dockerfile runs
  `scripts/check-trusted-mint-build.sh` (#133), but `.dockerignore` excluded `scripts/`, so
  every `docker build` of the SPA image failed at that `COPY`. The script is now let into the
  build context. No app change: 0.14.0's code, buildable.

## [0.14.0] - 2026-10-05

### Security

- **No trusted mint known is no longer a pass (#133 review).** When the build names no mint
  and `/api/v1/config` names none either, which was the case on beta and prod, the gate used
  to answer `unchecked` and credit coupons from any mint. It now holds them instead (see
  below), the own-swap receive and the stall's claim sweep refuse, and the image build fails
  unless `VITE_TRUSTED_MINT_URLS` is set (`scripts/check-trusted-mint-build.sh`;
  `ALLOW_UNTRUSTED_MINT_BUILD=true` for a throwaway local image only). A dev build can opt
  out with `VITE_ALLOW_ANY_MINT_IN_DEV=true`, which is logged every time it is used and
  ignored in a production build.
- **The trusted mint is the one tokens are stamped with.** The wallet reads `token_mint_urls`
  from `/api/v1/config`, the PUBLIC mint URL customer-wallet stamps in `m`
  (imani-gateway-core serves it from the same setting). `mint_url`, gateway-core's
  client-mint setting, is still accepted but no longer the only source.
- **The cashback commit checks the token's mint before it swaps.** It used to swap and credit
  whatever mint the token named. A cashback token at a mint the wallet does not list is kept
  on the device, not swapped, and banked on a later visit once the mint is confirmed. The
  device's cashback stash is now a list, so a second held claim cannot overwrite the first.
- **Mint URLs carrying userinfo, a query or a fragment are never trusted**, even when empty,
  so two different strings cannot name "the same" mint.

- **The trusted-mint gate is on by default, in every build (#133).** The gate's other source
  used to be a script only the legacy bridge loaded, and its absence read as "this deployment
  names no mint", so many builds credited coupons from any mint. The wallet now asks
  `/api/v1/config` at start-up, and the coupon poller waits for that answer before its first
  receive. Until it arrives the list is unknown, which is never read as "no mint": a coupon
  that arrives meanwhile is deferred and received on a later poll.
- **The wallet checks where a received coupon's value is before every redemption (#131).**
  dm-poll asks `RedemptionAdapter.checkBacking` (which replaces an optional `getMintUrl` hook
  nothing called), and the wallet's answer reads plain ecash and legacy `cashuA` tokens as
  well as vouchers. A foreign unit or an unreadable token is refused before the mint swap; an
  unlisted mint is held (above). Mint URLs are compared as URLs: scheme and host case, a
  default port and a trailing slash do not matter, while a different host, port, scheme or
  path does. The vouchers' face currency (EUR, XAF, GBP) is not what is checked: their proofs
  are always sat.
- **The wallet-side receive swaps only at a positively trusted mint (#133).** It swaps at the
  token's own mint, so an attacker naming their mint would be paid. Any other verdict is
  refused. This path is not switched on yet (#123).
- **A coupon that arrived before the trusted list loaded is no longer lost.** It used to be
  refused at unwrap, which marked its delivery as handled for good. It is now deferred at
  redemption and offered again.
- **A re-signed voucher proof is credited for at most the sats burnt for it**
  (imani-gateway-customer#141). A successor's sats come from the swap that mints it, and the
  mint cannot see which blinded output carries a voucher secret, so a holder could burn a 1-sat
  proof, have a full-face successor signed, fund it with sats bought today and be credited up to
  the face. The gateway now signs a `max_sats` tag into every re-signed or split proof, summing to
  at most the burn. `parseVoucherToken` reads it per proof into `creditableSats` (each proof's
  amount clamped to its own bound), and `creditableFaceValue` and `exactFaceValue` credit
  `min(face_value, creditableSats × issuance_ratio)`. Every redeemer built on them follows: the
  till's DM validation and over-redemption guard, redemption rows, reconcile, the sender's receipt
  figure and wallet-api `/redeem`. A voucher with no `max_sats` is credited exactly as before. A
  `max_sats` that is present but not a canonical positive decimal credits 0, because reading it as
  absent would let a holder strip a bound by mangling it. The tag is a plain string tag, so the
  existing canonical bytes already cover it; a Java-signed fixture pins that the two agree.
- **An untagged locked voucher proof, or one whose own issuer signature does not verify, is
  credited 0** (imani-gateway-customer#141, security review of #176). The mint signs any blinded
  output, so the holder of a locked proof can mint a twin with the same secret funded with any
  plain sats; without a signed `max_sats` its sats say nothing about what the issuer funded.
  Every locked output the gateway issues now carries `max_sats` from birth
  (imani-wallet-lib#135), so only pre-#141 locked vouchers are untagged. And callers verified
  only proof 0's signature, so a self-minted later proof with the same `voucher_id` and lock was
  credited its full amount: `creditableSats` now verifies every locked proof's signature under
  proof 0's issuer key. Unlocked `VOUCHER` tokens keep crediting their sats (their signed blob is
  shared by every proof). **Consumers must act:** a pre-#141 locked voucher (a licence or
  terminal credential issued before this change) now has a creditable value of 0 at the till and
  wallet-api `/redeem`; it still verifies, so licence and credential checks are unaffected.
  **Superseded for untagged proofs by round 3 below.**
- **An untagged locked voucher proof keeps the pre-#141 crediting** (imani-gateway-customer#141,
  round 3). Crediting it 0 stranded real customer money held in pre-#141 locked vouchers. It now
  credits its sats, bounded by its signed face value and, across
  redeemers, by the shared ledger, exactly as before #141. A same-secret twin of a pre-#141 proof is
  therefore the **accepted legacy residual**, bounded by face and ledger; the gateway caps its
  re-signed and split successors at the voucher's recorded issued sats. Tagged proofs keep the strict
  `min(sats, max_sats)`, a malformed `max_sats` still credits 0, and every locked proof's own issuer
  signature is still verified under proof 0's issuer key (a forged later proof credits 0).
- **Round 4: the count behind the legacy rule, corrected** (imani-gateway-customer#141). Round 3
  justified this rule with "141 locked vouchers on staging, face about 1.13M". That figure counted
  the mint's NUT-20 quote `pubkey`, which every voucher quote carries since 2026-09-30, not the
  P2PK voucher lock. Read-only staging counts on 2026-10-04: since the gateway's 05:50Z restart, 2
  of 25 issuances were P2PK-locked (21 sats each); 0 of 2,316 stored purchase tokens are locked; the
  only stored locked successor is one 2026-09-29 test. Earlier locked issuances are not countable
  (sealed rows, no older logs) and, at that rate, are a handful. **The rule is unchanged, because it
  is still the safest choice:** the exposure it accepts is a few vouchers, each bounded by its own
  signed face and the shared ledger, while crediting 0 would strand those holders' money for no
  measurable gain, and a redeemer has no issuance record to bound them more tightly. No code change.
- **Test: a Java-signed `max_sats` 1 proof next to an unsigned `max_sats` 64 proof credits 1 sat**
  (imani-gateway-customer#141, round 5 review LOW-3). Pins, with real Java-signed bytes, that an
  unsigned later proof credits 0, and that one with no `issuer_sig` at all is refused. No code change.
- **An unsigned `processor` issuance warrant is refused on receipt** (#152). It names a
  payment record but carries no signature, and nothing on the device can check the record, so
  it was the issuing service's word alone, read as `claimed` and accepted. Any merchant session
  could have the portal mint one (imani-gateway-portal#54). `refuseIfUnwarranted` now refuses
  `claimed` before the mint swap with the same "Coupon not authorised" reason as `absent`,
  `unwarranted` and `failed`. The validation badge shows it as failed, and `isWarranted` no
  longer counts it. Merchant-signed coupons are unaffected.
- Card-purchase coupons are NOT refused: see the next entry, which ships with this one.
- **The till verifies a `delegated` issuance warrant, and card purchases sign one** (#152).
  A stall signs one kind-30078 delegation event with its own key naming a delegate pubkey
  (`p`), scope `coupon:issue` and a NIP-40 `expiration`; the delegate signs the same sale
  digest a `merchant` warrant signs. The event travels inside the warrant, so verification
  stays offline. `verifyIssuanceWarrant` checks the delegation is signed by the coupon's
  issuer, is scoped `coupon:issue` and unexpired, and that the warrant signature is the
  delegate's (`src/lib/issuerDelegation.ts`). `services/purchase-issuer` now signs a
  `delegated` warrant with each stall's terminal-credential lock key and keeps the Stripe
  reference as `ref` inside the signed bytes, so the coupon still reads as "paid by card".
- **The delegate signs the Stripe reference** (#176 review). The delegated digest is the sale
  digest's fields plus `ref` (`delegatedSaleDigest`), so an edited or removed `ref` fails
  verification rather than pointing the stall's reconciliation at another payment.
- **A delegation must be the stall's `imani:issuer-delegation` record** (#176 review): exactly
  one `d` tag with that value, at the till and in purchase-issuer's pre-mint check. Another
  app's kind-30078 record signed by the same key no longer delegates.
- **The stall's own ledger judges a card sale at the time it was recorded** (#176 review).
  `issuedVoucher` and `reconcileIssuances` check the delegation was in force then
  (`created_at <= issued_at < expiration`), so past sales no longer turn "failed" the day a
  delegation lapses. The till still checks against its own clock: a voucher carries no signed
  issue time. See `docs/explanation/delegated-issuance-warrant.md` and cashu-voucher#53.
- **purchase-issuer requires a delegation to outlive the coupon by 7 days** (#176 review), so a
  till clock running ahead or a slightly later gateway expiry cannot kill a coupon at the
  counter in its last days.
- A copied delegated warrant is refused where it is minted: gateway-customer spends each
  delegated warrant's `(issuer, nonce)` on voucher create (imani-gateway-customer#190). Binding
  the signature to one coupon was not possible: the gateway picks the voucher id after signing.
- **purchase-issuer mints nothing for a stall without a delegation** the till will accept,
  including one that would lapse before the 365-day coupon does. Such a purchase is
  reported BLOCKED (nothing minted) for the stall to sign a delegation; attach it with
  `npx tsx services/purchase-issuer/attachDelegation.ts <stall> <event.json>`, which
  refuses a delegation the till would refuse.

### Added

- **A fresh device can become a terminal** (#160, phase 2).
  - **Setup.** The logged-out screen offers **Set this device up as a terminal** (`/terminal/setup`), only on a device holding no key. The device shows its public key as a QR and as text, and polls the gateway and relay for a credential DM to it.
  - **Checks.** `terminalEnrol.offersFor` opens each DM with the pending key, inside the module. Every offer must pass `terminalDelivery.offerFromRumor`:
    - the seal is verified, and the rumor's author must equal the seal's;
    - the sender must be the stall the credential names;
    - the credential, from its own signed bytes, is locked to this device and issued by that stall, with a valid signature;
    - the DM is under 24 hours old.
  - **Confirmation.** The device shows the stall's public name and the same check code as the owner. The operator confirms, and a credential they reject is never offered again.
  - **Finishing.** The operator sets a passphrase of at least 8 characters (decision 2). `completeEnrolment` stores the credential, `voucherId` and idle lock, then sends a NIP-17 **enrolled** DM to the stall, sealed by the device key.
- **The owner's phone sends the credential to the device** (#160, phase 2). After minting, **Add terminal** gift-wraps a `imani-terminal-credential/1` DM to the scanned key, sealed by the stall. It is published to the relay and mirrored to the gateway, the way transfer signatures are. The form gains **Lock when idle**: 10 minutes by default, or Never, 5, 15, 30 or 60 (decision 2). The choice travels in the DM.
- **Owner side.** The Terminals screen polls for enrolled DMs while a row waits. `markInService` promotes the row whose device key AND voucher id match a notice sealed by that device, with no reload.
- `Entry` no longer sends a device enrolled as a terminal to `/login`, where its key would open a customer session. It says the till opens in the next version (phase 3), and offers **Remove this terminal from this device** (`removeTerminalFromDevice`), which erases the terminal key and record locally. It does not revoke; the screen says only the owner can.
- **The device accepts only the offer the owner's setup code names** (#160 review, MEDIUM). `verifyVoucher` checks the signature against a key inside the token, so a self-signed credential for an onlooker's own stall passed, and its `voucher_id` could be ground offline until the six-digit check code matched; the page then picked the newest offer. Now the owner's screen shows a setup code, `imani-terminal:1:<stall>:<voucher id>` (QR and text), the operator scans it on the device, and `offerFromRumor` refuses any offer not sealed by that stall for that credential (`not-the-expected-offer`). Nothing is offered before the code is scanned, and the device never picks among offers. Also refused: a DM dated more than 5 minutes ahead (`from-the-future`), and, when `VITE_VOUCHER_ISSUER_PUBKEYS` is set, a credential signed by an unknown key (`unknown-issuer`).
- On finishing, the device also calls `POST /api/v1/wallet/terminal-credentials/{id}/confirm` (gateway-customer#187), so the gateway's pending count frees the slot and the credential may issue.

- **Adding a terminal mints its credential from the owner's phone** (#160, phase 1). **Add
  terminal** now makes one NIP-98 call, signed by the stall, to `POST /api/v1/wallet/vouchers`
  (the body `scripts/mint-terminal-credential.mjs` sends, 365 days). It then waits for the token
  and checks it from its own bytes (`terminalMint.credentialDefect`):
  - it is a `P2PK_VOUCHER` locked to the scanned key;
  - the stall is in `pubkeys`, so the owner can revoke it;
  - it was issued by the stall, with a valid signature;
  - the signed metadata matches.

  A credential that fails any check is spent at once and nothing is recorded. A good one is
  kept on the owner's roster row (`token`, `voucherId`), and the screen shows a six-digit check
  code (`checkCode`, spec 4.2). Needs imani-gateway-customer#187, which mints the stall
  co-key.
- **Waiting rows are bounded, not counted** (#160 decision 4). Waiting rows do not use up the
  free terminal. They are capped at 2 (`TOO_MANY_WAITING`, "Two terminals are already waiting
  for their device") and expire after 24 hours. The Terminals screen cancels expired rows by
  spending their credential. The client check is a hint: gateway-customer#187 enforces the same
  limit and the 24 hours at mint time (409 `TERMINAL_PENDING_LIMIT`), and Cancel tells it the
  slot is free (`POST /api/v1/wallet/terminal-credentials/{id}/cancel`).

### Fixed

- **The owner's app confirms a terminal at the gateway** (#160 round 2, MEDIUM). The device's
  `/confirm` ignored every error, and the owner never confirmed. So a lost confirm left the list
  saying *In service* while gateway-customer refused Sell (410 after 24 hours). Now, when the
  owner's app sees the enrolled DM, `confirmEnrolled` (`terminalConfirm.ts`) confirms as the
  stall, retrying with backoff from 30 s, doubling, and capped at 1 h. The device still tries,
  best effort. The roster keeps `gatewayState` (`unconfirmed`, `confirmed`, `lapsed`), and the
  list shows it.
- **A credential finished by `resumeMinting` gets its setup code and DM** (#160 round 2).
  Waiting rows show their setup code on the list. `deliverWaiting` sends the credential DM to
  any waiting row not yet `delivered`, including rows `resumeMinting` completed.
- **Remove from device clears what logout clears** (#160 round 2). `removeTerminalFromDevice`
  now also sweeps every `imani-wallet:*` key (`sweepAppStorage`, shared with logout), the resume
  cache, and the terminal's wallet database. It reports what it cleared. A `keyStore` failure no
  longer skips the rest, and the screen says so instead of navigating away.

- **A server error while adding a terminal no longer forgets a credential that may exist**
  (#160 round 2). Any HTTP status used to clear the `minting` row and its Idempotency-Key, so a
  proxy 504 after the gateway minted left an unknown credential holding a pending slot. Now only
  a definitive 4xx (not 408 or 429) clears it (`isDefinitiveRefusal`). A 5xx, timeout or network
  error keeps the row, and `resumeMinting` re-sends the same key. The enrol screen and
  `resumeMinting` share one `settleMintFailure`.
- **A wrong credential that was spent gives its gateway slot back** (#160 round 2). The
  defect-spent paths now call `/cancel`, so the slot is free at once rather than after 24 hours.
- **Credentials minted outside the app are confirmed** (#160 round 2). Since gateway-customer
  V27 an unconfirmed credential cannot sell. `scripts/mint-terminal-credential.mjs` now confirms
  what it mints, as the stall, and fails on anything but 204. `services/purchase-issuer` sells
  with `X-Imani-Terminal-Credential`, so it is affected too: it confirms each credential once,
  as its device, before first use, and retries until the gateway says yes.

- **Re-adding a device already on the list no longer orphans its first credential** (BLOCKER).
  `recordTerminal` replaced the row for the same key, so a second Add minted a new credential
  and dropped the token of the first, which stayed live and could no longer be revoked.
  `checkEnrolment` now refuses a key with a live credential (`ALREADY_LIVE`, "already on your
  list with a live authority. Cancel or revoke it there first"), and `recordTerminal` throws
  `LiveCredentialError` rather than replace such a row. A revoked device can still be added
  again.
- **A credential whose answer was lost is no longer orphaned.** A `minting` row, with the
  request's `Idempotency-Key`, is written before the mint request. The voucher id is added as
  soon as the gateway names it. If the token poll times out, or a wrong credential's cancelling
  spend fails, the row stays. The next open of Terminals (`resumeMinting`) fetches and checks the
  token, re-sends the request with the same key so the gateway replays rather than re-mints,
  retries the spend, or clears the row when the gateway refused. Rows read *Still being set up*
  meanwhile.
- **Phase 0 waiting rows no longer block Add.** They hold no token, so they are not counted
  against the two-waiting limit, and the list offers **Remove** for them (nothing was minted).
- **A minted credential must name exactly the stall as co-spender.** `credentialDefect` used
  `includes`, so a third key in `pubkeys` passed. It now requires `pubkeys` to be exactly
  `[stall]`, `n_sigs` 1, and no `refund` or `locktime` tag.

- **Revoking a terminal spends its credential** (#160, phase 1, G10). Revoke (and **Cancel**
  on a waiting row) used to mark a local row and nothing else, so the terminal kept its
  authority. `revokeTerminalAtMint` now spends the credential with the stall's key and marks the
  row only when the spend landed or the mint says it is already spent. Otherwise the row stays
  in service and the screen says the revocation did not reach the mint. `witness.ts` now signs
  for a secret whose NUT-11 `pubkeys` tag holds the wallet's key (`spendingKeys`, `n_sigs` 1
  only). Rows set up by hand before this have no token, offer no Revoke, and say *Set up before
  revocation existed: add it again*. `TerminalRecord.revocationSecret`, which was never written,
  is replaced by `token`, `voucherId` and `waitingUntil`.

- **A coupon held for over a week can still be released (#175 review).** Re-offering held
  coupons looked back from when the message was written, but relays filter on the gift
  wrap's own timestamp, which NIP-59 backdates by up to two days, so such a wrap was never
  found. `reofferEvents` now reaches back a further `GIFT_WRAP_BACKDATE_SECONDS` (2 days + 1 h).
- **A coupon at an unlisted mint is held, never dropped (#133 review).** A refusal used to be
  terminal, so a mismatch between the two services' mint settings (a migration, or an
  internal URL configured for client-side minting) would have discarded every genuine coupon
  it touched. Now nothing is swapped, the delivery is not consumed, and the wallet shows
  "N coupons are waiting to be verified" until the configuration names the mint, when they
  arrive on their own. Only a foreign unit or an unreadable token is still refused.
- **Waiting for the trusted mint heals itself.** A failed or empty `/api/v1/config` is asked
  again on a backoff (5 seconds, doubling to 5 minutes). When it answers, the poller catches
  up and re-offers every held coupon by id, including ones older than the 7-day poll window.
  A config without a NIP-05 domain no longer stops the mint from being read.
- **A sale finished after a gateway crash reaches the customer** (imani-gateway-customer#168).
  Sell now tells the gateway who a quote-backed coupon is for
  (`PUT /api/v1/wallet/vouchers/{id}/recipient`) before it polls for the token. If the gateway
  crashes mid-sale and finishes the coupon minutes later, after this screen has stopped polling,
  the gateway sends it to that customer itself. Best effort and bounded: the registration is
  abandoned after 5 seconds, so a gateway that never answers cannot stall the sale, and an older
  gateway's 404 lets the sale go on as before. A failed registration is logged with
  `console.warn` (voucher prefix and status only, no key or token).
- **The timeout message tells the truth about who delivers.** When the poll runs out and the
  gateway accepted the registration, the merchant reads that the gateway will finish and send the
  coupon, and not to sell it again. When the registration failed, the gateway does not know the
  customer, so the merchant is told to check the voucher in a few minutes and forward it
  themselves, instead of being promised a delivery that will not happen.
- `e2e/stack/crash-mid-sale.sh` uses the `up.sh` next to it unless `STACK_UP` says otherwise,
  rather than a path on one developer's machine.
- **Adding a terminal no longer claims it can trade** (#160, phase 0). The screen said
  "<name> can now trade for your stall" when no credential had been minted and nothing had
  reached the device. It now says **Waiting for the device**, that the terminal cannot take
  payments yet, and the owner's list shows the row as *Waiting for the device* rather than
  *Never used*. Rows gain an optional `status` (`waiting`, `in-service`); older rows read as
  before.
- **A code that is nobody's key is refused** (#160, phase 0). `checkEnrolment` now refuses 64
  hex characters that are not a point on secp256k1 (`NOT_A_KEY`), before anything could be
  minted. The gateway issues an unlocked, bearer credential for such a key.
- **Terminal setup never overwrites a wallet key** (#160, phase 0). `completeEnrolment` refuses
  while the key store already holds a key, so a person's wallet key in the single key slot
  stays loadable. They log out first, where they see the backup warning.
- **The terminal lock check compares with the unlocked key** (#160, phase 0, G9).
  `useTerminalIdentity` took the device key from the record it was checking, so the lock
  check compared the record with itself. It now takes `devicePubkey` from the session's
  unlocked key. A record naming another device grants no terminal authority and the mint is
  not asked. Consequence: `beATerminal()` in `e2e/terminals.e2e.ts` no longer turns the
  owner's browser into a terminal; its role-gating checks return with phase 3's terminal
  unlock.
- **A terminal record for another device no longer locks the owner out** (#160 review). Such a
  record is ignored, exactly as a missing one is, so the owner's home screen stays their own
  instead of showing *This authority is not for this device*. Nothing is granted: no terminal
  actor is produced and `canTrade` is gated by the gateway.

### Changed

- `@imani/dm-poll`: `BackingVerdict` gains `hold` (with `HoldReason`), and the service emits
  `redemption:held` and `redemption:released`. `untrusted-mint` moves from `RefusalReason` to
  `HoldReason`. New `DmPollService.reofferEvents(ids, since)` and `hasProcessed(id)`.

## [0.13.0] - 2026-10-04

### Fixed

- **A terminal no longer reports a sale the customer's wallet refused** (#159). A terminal's
  key is not the stall's, so its Sell sent a signed `none` warrant, and every wallet that
  receives a coupon by DM refuses `none`, `absent` and `failed` warrants before the mint swap.
  The customer's wallet showed "Coupon not authorised" with nothing added while the terminal
  said "It is in their wallet now". Decision (Option B): every recipient keeps refusing, so a
  customer is never left holding a coupon the issuing stall will refuse. Sell on a terminal
  now stops on arrival, before a customer is scanned or payment taken, saying terminal sales
  need the `delegated` warrant form, which is not supported yet. `issueAndDeliver` refuses the
  same request before anything is minted, and also refuses an owner sale whose warrant would
  be `none` (session key is not the stall's) or absent (wallet locked). Comments on
  `refuseIfUnwarranted` and `isWarranted` now describe this behaviour; `isWarranted` is noted
  as not wired into any screen. Cashback is closed the same way: `/sell/cashback` on a
  terminal stops on arrival, and `prepareCashbackAttempt` / `issueCashback` refuse a terminal,
  or an owner issue with a `none` or absent warrant, before anything is minted. (The cashback
  claim records an unwarranted verdict without refusing, so the customer would otherwise hold
  a code the issuing stall's till refuses.) A terminal's home screen no longer offers Sell and
  says selling is not available yet, and the "Sell and redeem" role says so at enrolment.

- **A cashback voucher's detail no longer reads like a sale** (#155). It showed "Paid: At the
  counter" and "Customer receipt: Not collected", which are Sell questions with no answer for
  value the stall gave away. It now shows what it is ("Cashback from this stall"), whether the
  customer claimed it from the same stored portal status the list uses ("Claimed on <date>",
  "Not claimed yet", "Expired unclaimed", "Withdrawn", "Needs a check", "Status unknown"),
  and the authorisation line as before. A code past its expiry that the portal never
  answered for reads "No claim on record", not "unclaimed", because nothing asks about it
  after expiry. Its transaction link says "The cashback this came from". Sell vouchers are
  unchanged.
- **Cashback coupons now show what was checked (#156).** A coupon redeemed from a cashback
  code skipped the issuer and signature check every other receive runs, so its detail screen
  read "Issuer: Not checked". The check now runs on redeem and is recorded on the row, so a
  genuine coupon reads "Signature verified" and a forged, unsigned or unrecognised-issuer one
  reads as failed rather than unchecked. Recorded, not refused: the claim is one-shot, so
  refusing would lose the value. Cashback still does not attest to the ledger. Cashback rows
  saved before the fix are re-checked from their stored coupon when opened.
- A cashback coupon now lives as long as a Sell coupon from the same stall
  (398ja/imani-gateway-portal#58). The generate request sends the stall's
  `voucherValidityDays` (0 for never expires) next to the claim-window
  `expiryDays`, which is unchanged. Needs a portal that reads the field; an
  older portal ignores it and keeps its default.

## [0.12.0] - 2026-10-01

### Added

- **A browser probe for #144** (`e2e/probe-cashback-spend.mts`). A till issues a cashback, a
  customer redeems it and pays it back to that till. The probe checks the warrant is in the
  coupon, the till books the payment, the portal stores the claim on its own, and the till's
  Vouchers list shows the cashback. Before the fix, staging failed 9 of 15 checks.
- **A browser probe for #145** (`e2e/probe-concurrent-redeem.mts`). Two customers pay one
  till at the same instant over live SSE, round after round, and the probe reads the till's
  own store to check each coupon is booked against its own voucher. On staging, 0.11.1 passed
  44 of 44 checks and 0.11.0 failed 7, including two refused honest payments. `E2E_BUNDLE_DIR`
  runs it against another build for a control run.
- **Cashback vouchers on the Vouchers list (#144).** A cashback code now stores the
  `voucherId` the portal returns and appears on `/merchant/coupons` beside Sell coupons, with
  its claim state in plain words: "Not claimed yet", "Claimed", "Withdrawn", "Expired", "Needs
  a check" or "Status unknown". Opening the list asks `GET /portal/cashback/{id}/status` once,
  only for cashback rows that are still open and not past expiry, at most 3 at a time, and
  gives up on one after 8 seconds. Its detail screen shows what was claimed and checks the
  warrant against the stall key. A second device gets the row back through the existing NIP-60
  history records.

### Fixed

- **A merchant could not take back a cashback coupon they issued (#144).** The wallet signed
  the issuance warrant only after the code was minted, so the warrant never got into the
  coupon's signed secret, and the till refused it as "Coupon not authorised". The warrant is
  now signed first and sent as `issuanceWarrant` on `POST /portal/cashback/generate` (needs
  imani-gateway-portal#52). The history row keeps that same string. If the portal refuses the
  warrant (`INVALID_WARRANT`), the merchant sees a message that says so, not a generic error.
  wallet-api's `/v1/cashback/generate` now passes the caller's `issuanceWarrant` through
  unchanged, and refuses one over 4096 characters as the portal does. It used to drop it. A
  terminal still sends a signed `none` and is still refused, which needs the `delegated` form.
  Codes issued before this fix cannot be repaired.
- **A cashback voucher had no redemption ceiling (#144).** Redemptions were matched to an
  issuance only when the row was a Sell coupon. A cashback's redemptions were filed against
  nothing, so its claimed figure stayed at zero and the over-redemption ceiling did not count
  its earlier parts. A till could take more than a cashback's face. The claimed figure, the
  ceiling, the row repair and the claim sweep now all ask one question,
  `isVoucherIssuance`, which counts a cashback as an issuance.
- **A retried cashback could mint a second code for one sale (#144).** After a network error,
  a retry or a second press sent a fresh `idempotencyKey`, so the portal could mint a SECOND
  cashback for the same sale. The issue screen now signs the warrant and picks the key once
  per issue, and resends both unchanged on every retry. The portal's idempotency check now
  stops the duplicate, so the till's warrant ceiling is no longer the only guard. Changing
  the amount, note or expiry, or finishing an issue, starts a new key and a new warrant.
  A second press while one is still in flight does nothing. If the portal answers
  `IDEMPOTENCY_CONFLICT`, the merchant is told plainly that no second code was made.
  A press made while the wallet was locked is never reused once it is unlocked, so that
  retry is signed rather than minted unwarranted. Switching account or stall starts a new
  key and warrant. A definite refusal (a 4xx other than 409) ends the attempt. A network
  error, a 5xx or a 409 keeps it for the retry.

## [0.11.1] - 2026-10-01

### Fixed

- **A till no longer refuses the honest last coupon of a voucher after two coupons arrive together
  (#145).** The legacy bridge kept one correlation slot for the redeem in flight, but redeems do
  overlap (SSE does not wait, and the per-voucher lock covers only one voucher). On staging song's
  till redeemed 206 sats of voucher 19c4fed1 and 1365 sats of another voucher 21 ms apart. The
  second redeem's stamp landed on the first row, so 19c4fed1 carried two rows for one redemption
  (89.93 booked instead of 74.91), and the customer's last honest part (208 sats, 15.17) was
  refused as "already spent". Each redeem now gets a random correlation id, carried on the voucher
  row it writes, and a row is stamped only by the redeem it names. The cashback receive registers
  too, so it can never pick up a DM coupon's claim.
- **The ledger files every row under the voucher its own coupon names (#145).** Rows the race
  already wrote are re-filed, not dropped: a row stamped with one voucher but carrying another's
  coupon counts in full against the coupon's voucher, valued from the coupon, so that voucher can
  not be taken twice either. Copies of one received token count once; two different coupons never
  merge, whatever their stamps share. A row whose coupon cannot be read keeps its stamp and still
  counts. The redemption ceiling, the claim filed for a part and the merchant's claimed figure all
  read these same rows, so song's 208 part is taken and filed at 16. No rounding tolerance was
  added: at 19c4fed1's real ratio the full 1371 sats are exactly the face of 100.

### Added

- **A refused coupon shows on its payment (#145).** "1 of 2 coupons refused: that coupon is already
  spent", with "ask the customer to pay the rest", on the transaction screen for as long as it is
  shown rather than only in a ten-second toast. The ids a refused coupon names are written by its
  sender, so the instruction is given only when the refused coupon came from the payment's own
  payer. Anything else naming the payment is shown neutrally ("a coupon naming this payment was
  refused"), and only while a payment request is still open. The `redemption:refused` event now
  carries the bundle id, its declared part count, the request id and the payload's payer. A
  cashback coupon refused as unauthorised (#144) shows the same way when its DM names the payment.

### Changed

- **The receive pacer's notes cite the new server default** (120 a minute from
  imani-gateway-customer 0.19.2). The client keeps 8 calls a minute, which is safe against any
  gateway and costs time against one on 120. Related: imani-gateway-core#114 (FLOOR
  rounding on proportional sends) is unchanged.

## [0.11.0] - 2026-09-29

### Fixed

- **A cashback code can be redeemed again.** Since gateway-portal 0.4.0 a code is ten random
  characters, `CB-XXXXX-XXXXX`, but the wallet only recognised the old six-character
  `CB-XXXX-YY`. So the Redeem button stayed disabled for every code a shop issued. Both shapes are
  now accepted, in any case and with or without dashes and the `CB` prefix, as the portal does.

### Added

- **A live re-lock probe, `reissueProbe.test.ts` (`PROBE_REISSUE=1`).** It runs against the real
  staging gateway and mint with nothing faked. A coupon is issued locked to A. The gateway
  refuses a re-signature before the burn (`PREDECESSOR_NOT_SPENT`) and refuses a stranger who
  knows both secrets (`NOT_AUTHORISED_BY_HOLDER`). It re-signs for A once, returns the same
  successor to an identical retry and refuses a second proposal (`PREDECESSOR_ALREADY_CLAIMED`).
  The mint then refuses the successor without B's witness and accepts it with one. It passed on
  staging on 2026-09-29.

### Changed

- **`reissueVoucherSecret` signs as the coupon's holder (imani-gateway-customer#136).** It
  sends `lock_authorization`: a BIP-340 signature by the key the predecessor is locked to, over
  `sha256("imani/voucher-reissue/v1" || u32be(len) || predecessor || u32be(len) || proposed)`.
  The key is borrowed from the session signer for the one signature (IW-14), never passed in
  or kept. A caller whose coupon is locked to another key, and the tests, pass a `lendKey`
  that lends it the same way.
  The gateway refuses a re-signature without it, because knowing a coupon's secret is not
  holding it. `NOT_AUTHORISED_BY_HOLDER` is a known, permanent refusal. The gateway pins a
  signature made by this code, with a key whose y is odd and a non-ASCII proposal, so the two
  languages cannot drift apart unnoticed.

## [0.10.0] - 2026-09-29

### Fixed

- **The trusted-mint gate is actually on in deployed builds (#133).** The gate reads
  `VITE_TRUSTED_MINT_URLS`, which nothing set, and otherwise falls back to the gateway's config,
  which only loads through the legacy bridge. So a default build trusted no mint in particular,
  answered `unchecked`, and credited coupons from any mint. The Dockerfile now takes
  `VITE_TRUSTED_MINT_URLS` as a build argument, and imani-deploy passes the staging mint.
  Verified in the built bundle: set, `trustedMintUrls` starts from
  `"https://mint.staging.398ja.xyz"`, unset it starts from an empty string.

- **A coupon is refused unless its proofs are at a trusted mint, in sat.** A coupon's value
  is not in the coupon, it is in the proofs at a mint, and the issuer signature covers no mint
  at all. So a copy of a genuine signed coupon backed by proofs from a mint nobody has heard of
  verified perfectly and was credited as money. The wallet read the mint URL and the unit and
  checked neither. Both crediting paths now refuse one they do not recognise. The trusted mint
  can be set with `VITE_TRUSTED_MINT_URLS` (comma-separated), and otherwise falls back to the
  mint the gateway names, so a wallet is protected without configuration. While that answer is
  still outstanding a coupon is deferred rather than waved through, since otherwise delaying one
  request would turn the check off.

- **A network blip while a send settles no longer reports it as unsent (#125).** One failed
  status read threw out of the wait, so a part the gateway had completed was shown as "Partly
  sent ... send the difference again", which pays it twice. A failed read now leaves the outcome
  unknown and the wallet keeps waiting. If it is still unknown at the end, the send is reported as
  still going through and is finished from the pending ledger on the next login.
  - **A bundle part whose outcome stays unknown is reported as in flight.** The send and pay
    screens show "still going through ... do not send it again" and no longer offer to send the
    difference.
  - **Faster answers from a gateway that cannot confirm:** a status read refused with a 4xx
    stops the wait at once. A 429 is re-read no sooner than its `Retry-After`.
- **A send whose outcome is unknown can no longer be paid twice (#128).** Pressing Send or Pay
  again drew on another coupon and paid the same person a second time. Now:
  - a second send to the same person, or a second payment of the same request, is refused while
    the first is unconfirmed, in the payment code itself and not only on the screen;
  - coupons behind an unconfirmed send are left out of what the Send and Pay screens offer;
  - after an unknown outcome the button reads "Still going through" and is locked, with Back
    locked too (it would clear the lock) and Done as the way out.
  A send unanswered for over a week stops holding anything back, the same limit reconciliation
  already used (#127).

### Added

- **Groundwork for the wallet to swap its own receives** (imani-gateway-customer#133,
  imani-wallet#123). The gateway performs the receive swap today, which is why it keeps a
  spendable copy of every coupon received and why a lost response leaves it holding the only
  copy.

  Built and verified against the real mint: the wallet-side blinding and swap, the intent
  record that makes a lost response recoverable, a transport against the mint, the join from a
  token string to a swap, a start-up sweep that finishes interrupted receives, and a client for
  the gateway's voucher re-signing endpoint.

  **Not yet wired in**, so neither bug is closed by this release. What remains is the
  switch-over itself and a voucher receive, which needs two swaps because the gateway will only
  re-sign once the predecessor is spent while the wallet needs the signature before it swaps.
  A voucher is refused rather than stripped of its identity in the meantime. See
  `docs/explanation/the-wallet-swaps-its-own-receives.md` for the current status table.

## [0.9.1] - 2026-09-28

Pairs with imani-gateway-portal 0.9.0 (token in the create response); still works against an
older portal by polling.

### Changed

- **Sell uses the voucher returned by the create call when it already carries its token
  (imani-gateway-portal#48).** Until now Sell always read each new voucher back from the gateway
  to get its token. That read is served from one gateway instance's memory, so a restart, an
  eviction or a request landing on another instance returned 404 after the backing had been spent.
  Vouchers still awaiting payment, and every voucher from a portal that predates the field, are
  polled as before.

## [0.9.0] - 2026-09-27

Pairs with imani-gateway-customer 0.15.1, whose `409 RECEIVE_ALREADY_SETTLED` and unpaced ack
this relies on.

### Fixed

- **A coupon swapped at the mint can no longer be lost to a retry of itself (#110).** The receive
  idempotency key had a random suffix, so a retry of a token whose first swap had already
  succeeded went out under a new key, re-swapped spent proofs and failed with 11001. The key is now
  `rcv_<SHA-256 of the token>`, the same on every attempt. It is never derived from TokenSecurity's
  prefix-based fallback fingerprint, which two tokens can share.
- **A settled receive the wallet does not hold is never shown as money or as success (#110).** The
  gateway's same-key replay returns the receive_id with no fresh token. The wallet used to fall
  back to saving the original, already-spent token, which is a balance with nothing behind it. That
  case, the gateway's `409 RECEIVE_ALREADY_SETTLED` (id read from `X-Receive-Id`, else `details`),
  and an 11001 on a token the wallet already has a receive_id for are now a distinct "settled at the
  gateway, not saved here" state. It is terminal for re-swapping, never reported as received, and
  logged with its receive_id for reconciliation.
- **Escrow acks are retried instead of dropped, and only for saved value (#110).** An escrow is
  acknowledged only after its voucher is saved. A failed ack retries in the background, honouring
  `Retry-After`. Saved-but-unacknowledged receive_ids are kept per account (bounded, localStorage)
  and flushed at startup and on catch-up, at most two per run, through the pacer, stopping at any
  429.
- **A rate-limited burn retries once after `Retry-After` (#110)**, like a 409.
- **A multi-voucher payment no longer blows the gateway's rate limit (#110).** Receives, acks and
  burns share one pacer counted in calls (8 a minute, under the gateway's 10). The bundle wait
  window grows from 3 to 10 minutes to outlast the conservative pacing bound plus the 429 retries.
- Receive, persist and ack are logged by receive_id (never the token).

## [0.8.0] - 2026-09-27

### Added

- **A payment sent as several vouchers reads as one payment (#94).** Sending €6 from €3 + €3
  coupons used to give the recipient two "€3.00 received" toasts and two bell rows, and the sender
  two "€3.00 was claimed" lines, with nothing saying €6.00 or "2 of 2". Now each side sees one
  toast and one bell row that updates in place: "€3.00 of €6.00 (1 of 2 vouchers so far)", then
  "€6.00 received (2 vouchers)". The advance "on its way" notice collapses the same way, and the
  sender's success screen says "Sent as 2 vouchers".

  **Declared and received are kept apart.** The total and count come from the sender and are
  unverified, so they are only ever shown as "expected". The headline is always what actually
  redeemed; nothing about balances, ledger rows, redemption ceilings or request settlement reads
  the declaration. The first declaration wins, and a later part that disagrees, comes from another
  sender or is in another currency is flagged and announced on its own rather than folded in.

  **A part that never comes is said so.** Three minutes after the first part (longer than the
  wallet's own rate-limit retries, so a queued part is not called missing), an unfinished payment
  reads "€3.00 of an expected €6.00 received. 1 voucher has not arrived." as a warning that stays
  up until dismissed. A part waiting out the rate limiter shows as "1 of 2 in, 1 still receiving"
  on the same toast instead of a toast of its own, including when it is the first part to arrive.
  Merchant tills get the same one-toast-per-payment treatment; request settlement still sums the
  individual rows. A single-voucher send, or a sender that does not declare a bundle, behaves
  exactly as before.

- **A payment of several vouchers is one line in history (#106).** The Transactions list, for
  customers and stalls, folds the rows of one multi-voucher payment into a single line showing
  the total and a "2 vouchers" tag. Tap it and the rows it was made of open underneath, each still
  linking to its own record. The total is the sum of those rows, never a figure the sender
  declared, and rows in different currencies or directions are never added together. Settling
  payment requests and reconciling merchant claims still read the individual rows.

### Changed

- **The send and pay confirmation say it in one sentence.** "Sent to Alice as 2 vouchers."
  replaces a second grey line under the amount; when a payment stops short, the count moves into
  the warning that explains it.
- **Amounts line up.** Transaction amounts use tabular figures, so a payment's total and the
  vouchers beneath it share one column the eye can add up.

### Fixed

- **Lint is clean.** `npx eslint .` reports nothing: the `withPrivkey` callback is no longer named
  `use` (which the hooks rule mistook for React's), and a handful of unused imports and parameters
  are gone.

## [0.7.0] - 2026-09-22

### Added

- **A Vouchers entry on the merchant menu, and a record behind each one.** A stall could see the
  coupons it had issued only by going through Transactions, and the screen behind a coupon could
  say what was issued and nothing about what happened next. The menu now carries **Vouchers**
  between Dashboard and Transactions, listing what the stall put into circulation.

  **Still-valid vouchers lead, expired ones are one switch away.** A merchant trades against the
  live ones, so a list led by last year's lapsed coupons buries the answer. But the customer most
  likely to present a coupon at a counter is the one holding a coupon that has run out, so they
  cannot simply be absent. The switch says how many are behind it, and the heading follows the
  switch rather than counting a set the list is not showing.

- **What has actually been claimed against a voucher.** The question a merchant opens the record
  with, and the one it could not previously answer. A coupon is spent down rather than used up, so
  one issuance legitimately comes back several times — the figure is a sum over every incoming row
  sharing the voucher id, shown beside what is still outstanding, with the claiming transactions
  listed underneath so the total can be checked rather than only believed.

  The trap here is real and is pinned by a test: stored rows carry a hardcoded `direction: 'in'`,
  so anything reading direction off the row rather than through `toTransaction` would report a
  voucher fully claimed on the day it was sold.

- **The evidence behind a sale, as three lines that are never collapsed.** How it was paid for,
  whether the stall authorised issuing it, and whether the customer said money arrived are three
  different claims, and merging any two lets a merchant read authorisation as proof of payment.
  Each line carries what it does and does not establish, on screen rather than behind a tap, and
  each carries its own **glyph as well as its colour** — a tick, a dash, a warning triangle — so
  it still reads for anyone who cannot separate green from grey from red, in sun at a stall, or
  in a greyscale screenshot.

  **Cash or card has three answers, not two.** A processor warrant is evidence of a card payment;
  a stall-signed warrant is evidence of a sale made at the counter. Everything else — every sale
  issued before warrants shipped, and every sale made on a terminal, whose key is not the stall's
  — reads as *not recorded*. Printing "cash" over those would be the wallet inventing a fact about
  money.

- **How much of a voucher has come home, drawn as well as written.** The claimed figure and the
  face value are one panel rather than a hero and two label/value rows underneath it, with the
  proportion shown as a fill: "how much of this is left" is a proportion of a known whole, which
  is the one thing a bar says faster than a sentence. Both figures are still written out at full
  precision beside it — the bar is the fast path, the words are the fact. An expired voucher's
  remainder is called *lapsed* rather than *outstanding*, because nobody can walk in with it and
  the stall no longer owes it.

### Changed

- **A voucher row now opens the voucher rather than the transaction that issued it**, on the
  issued list, the expiring list, and a scanned pass. The question behind the row is what happened
  to this coupon; the issuing movement is one row further in, as a link rather than an id.


## [0.6.1] - 2026-09-21

### Fixed

- **A large sale delivered nothing, and left the wallet unable to receive anything afterwards.**
  Reported as "selling 1000 GBP breaks the system: five batches of 200 were expected, none
  arrived, and since then nothing goes through". Both halves are on the receive path and both are
  reachable only once a sale is big enough to be split and chunked - a Cashu token carries one
  ~1840-char proof per set bit of its amount, so the parts of a large sale are the biggest tokens
  this system ever sends.

  `MAX_CHUNKS` was 16, copied from one deployment's `max_chunks` and enforced as though it were a
  protocol constant. It is the *sender's* setting. A transfer split more ways had every piece
  refused by `asChunk`, which answers null for "not a chunk" and "a chunk I refuse" alike - so the
  envelope fell through to the text parser, yielded no token, and was marked processed forever.
  The gift wraps are still on the relay; the local tombstone was the only thing in the way. The
  ceiling is now 64 with the byte bound derived from it, and `looksLikeChunk` keeps a refusal
  retryable instead of turning it into a deletion.

- **Why it stayed broken.** The completed-transfer set lived in memory while the processed-event
  tombstones it partners with live in `localStorage`, so a reload dropped one and kept the other:
  a big coupon's stragglers came back with no sibling that could finish them and rebuilt a wedged
  pending entry on every poll. Its TTL was also 24h against a 7-day fetch window. The set is now
  persisted, sized to the window, and outlives it.

- **`maxProcessedEvents` was dm-poll's default 100 against that same 7-day window.** One large sale
  is up to 80 gift wraps, so the set evicted ids still inside the window, which were re-fetched,
  re-processed, and evicted the next batch in turn. It never converged - every cycle a full round
  of redundant unwraps and mint round-trips, surviving a reload because the set is on disk. Now
  sized against the window.

- **The chunk amnesty could not run for the coupons the 16-chunk ceiling ate.** It exists to forget
  exactly these tombstones, but its key was unversioned and had already fired on every affected
  device for the earlier pre-reassembly bug. The key is versioned now, so a later fix can declare
  that the tombstones written before it are not to be trusted.

### Performance

- **A catch-up no longer freezes the page.** Sizing the processed-event set to the fetch window made
  an existing O(n) write into an O(n^2) one: dm-poll saves the set on every event it finishes and
  `localStorage.setItem` is synchronous. Measured over a 2000-event pass - 134MB serialised across
  ~1800 blocking writes, the largest ~335KB. Writes are coalesced now: the same pass does one write
  of 0.134MB. The received-token set stays synchronous, because it is the first line of defence
  against crediting a coupon twice and must survive a crash.

- **The received-token set was re-parsed from storage on every event.** `hasTokenBeenReceived` runs
  once per event and `markTokenAsReceived` re-read the whole set again to add one entry. Measured
  over a 2000-event catch-up against a 5000-entry set: ~350MB parsed and ~1.8s of blocking work,
  all re-deriving a value that had not changed. Held in memory now, mirrored to storage: 1784ms ->
  0.8ms. Dropped on an account switch, so one account cannot answer another's "have I banked this?"

- **That set also had no bound at all**, so every coupon a merchant ever banked made receiving money
  permanently slower. Capped at 2000 - the cap bounds the *write*, so it is sized against the
  seven-day window rather than "big enough to never evict". Evicting is safe because the mint, not
  this set, is what actually prevents a double-spend: an evicted fingerprint costs one round trip
  that fails safely. Oversized legacy sets are trimmed at load rather than on the first receive,
  which was a ~400ms stall at the counter.

- **The chunk-assembly map was unbounded in count.** The byte ceiling bounds one transfer; nothing
  bounded how many could be open at once, each holding decrypted fragments of someone's money for a
  10-minute TTL. Capped at 64, evicting the oldest, which costs a re-read and never a coupon.

## [0.6.0] - 2026-09-21

### Added

- **Issuance warrants are signed at Sell time and verified on receipt.** A voucher carries one
  signature and it is the issuing *service's*, so "stall X issued this" was an assertion nobody
  could verify against X. The wallet now signs a warrant binding a digest that **covers the face
  value** to the sale, and the merchant sees the warrant state at the till.

  A warrant attests a **sale**, not a voucher: one Sell mints an unknown number of coupons
  (quantity x server-side auto-split), so no voucher id exists at signing time. Verification is
  therefore a **ceiling** test rather than equality. Cross-language digest parity is pinned by
  `warrantDigestParity.test.ts` against vectors generated by the Java implementation.

- **Cash sales are reconcilable**: the warrant is stored on the row with its sibling voucher ids,
  and a customer cash attestation is signed at *receipt time* on the path that already runs.
  Attestations are verified before storage, so a poisoned row cannot displace the genuine one.

- **Cashback is warranted and reconciled.** It minted value with no warrant and was skipped by
  reconciliation entirely.

### Changed

- **A coupon without a warrant now fails validation.** While only *failed* warrants were refused,
  omitting a warrant was safer for an attacker than forging one.

### Fixed

- **Cashback signed as a fabricated owner actor.** The page built `{ kind: 'owner', stallPubkey }`
  by hand, which asserts owner-ness of whatever device is running - including a terminal, whose
  key is not the stall's - bypassing the guard meant to catch exactly that. Fail-safe, because the
  signer also compares its own pubkey against the stall, but the deliberate guard now does the
  work and both are pinned.

## [0.5.8] - 2026-09-18

### Fixed

- **Banners and coupon strips showed a blank band while they loaded.** The band was the right size,
  so nothing reflowed, but an empty grey rectangle asserts "this stall published no banner" — a
  different claim from "it is loading", and while the request is in flight, a false one. They now
  hold their space with a placeholder and fade in. A dead link still settles to the plain band
  rather than pulsing forever, because these URLs are self-published and dying is ordinary.

- **Your own profile page greeted you with your own npub.** `App` seeds its state with an empty
  profile and then awaits the relay, so on a first login — or any login after logging out, which
  wipes the device — the identity card printed the npub at the full weight a name gets. An account
  that has genuinely published no name still shows its npub: that is a settled answer, and the
  discriminator is whether anything has ever been written rather than whether a name is present.

### Changed

- Remote image loading is now one component (`RemoteImage`) rather than four copies of an `<img>`
  tag. It keeps the lazy and no-referrer rules those had, which are privacy controls and not
  tuning: fetching one of these hands the issuer the customer's IP and the moment they opened their
  wallet.
## [0.5.7] - 2026-09-18

### Changed

- **Relay reads no longer wait three seconds on a relay that is not there.** The same fault as
  0.5.6's profile fix, in the two reads that were left: `allAddressable` and `newestAddressable`
  query the relay and the gateway in parallel and merge the results, so the caller pays for the
  slower store. Reaching strfry from a browser needs its port published, which a real deployment
  does not do, and a socket to a host that DROPS packets ends on a timer rather than a refusal —
  so the ordinary deployed state was also the worst case. Measured: 3002ms uncapped against a
  black-holed address, 1201ms with the connection wait bounded, and 25ms either way to a healthy
  relay.

  These reads carry the merchant record and the issuance ledger, and a null answer takes away the
  merchant role, so the bound is deliberately gentler than the 150ms used for profiles: 1200ms is
  far above any healthy connect and far below the default. PUBLISHING IS NOT CAPPED — a read that
  gives up early costs a slower answer from the other store, while a publish that gives up early is
  an event the user believes they sent and nobody has.


## [0.5.6] - 2026-09-18

### Fixed

- **A profile that had not loaded yet was rendered as a truncated pubkey.** Avatars, display names
  and NIP-05s take time to arrive, and what stood in the gap was a hex key in the same type and
  position as a real name — indistinguishable from an answer to anyone reading a receipt. Places
  that are genuinely still waiting now show a loading placeholder instead. A lookup that came back
  EMPTY still shows the short key: that is a settled answer, not a wait, and a spinner that never
  resolves would be worse than the bug.

- **A failed lookup erased a name the device already knew.** Both profile hooks preferred the
  fetched record over the cached one, and a lookup that found nothing returns a defined-but-empty
  record — so a moment of bad signal put a hex key back over a stall the user had seen a hundred
  times.

### Changed

- **Profiles no longer wait for the relay to be read from nostrdb.** The kind-0 read awaited BOTH
  stores, so every lookup cost the slower one — and a browser WebSocket to an unreachable relay
  fails on a clock, not a packet: 3001ms to a host that drops, 4400ms with no EOSE, against 25ms
  for a healthy relay and 5ms for a refused connection. A deployment that does not publish strfry's
  port is the documented normal case, so nostrdb's answer sat complete in milliseconds while the
  browser counted down someone else's timeout. Both stores now get a 150ms budget and the newest
  answer within it wins; whatever arrives later still corrects what was shown, so the relay keeps
  overruling a frozen cache without anyone waiting for it.

- **Profiles are cached across sessions.** The cache was per-document, so every reload re-earned the
  same answers over the network. kind-0 is a replaceable event carrying its own `created_at`, so a
  stored copy is unambiguous — it is simply the newest this device has seen. A name already seen now
  renders on the first frame. Bounded at 200 records, oldest-written evicted first, since
  localStorage is a shared ~5MB quota.


## [0.5.5] - 2026-09-18

### Fixed

Faults found reviewing the split-coupon and chunked-delivery work, each with a test that fails
without its fix.

- **Pieces of an already-received coupon were held forever.** Only the message that completes a
  split coupon is recorded as handled, so the earlier pieces are re-read on every poll by design.
  Each re-read started a new assembly that could never finish, because the piece that would finish
  it is the one the wallet will not look at again. Finished transfers are now remembered, and a
  coupon already in the wallet is not offered a second time. A transfer that FAILED to decode is
  deliberately not remembered, so a corrupted delivery can still be retried.

- **Half-assembled coupons outlived the session.** Those pieces are decrypted fragments of
  someone's money held in memory, and neither signing out nor switching account cleared them. Both
  now do.

- **Nothing checked that the parts of a split sale added up.** Each part reporting success is not
  the same claim as the customer receiving what was sold, and the gateway chooses the split. The
  confirmation screen now shows the amount actually delivered rather than the amount typed, and
  says plainly when the two differ. It warns rather than failing the sale, because those coupons
  are already with the customer and cannot be recalled.

### Changed

- The issuance result no longer offers a single-coupon field. Reading the first coupon as though it
  were the whole sale is precisely what delivered 200 of a 1000 sale, so the shape no longer makes
  that possible.

## [0.5.4] - 2026-09-18

### Fixed

- **Coupons that arrive split across several DMs are now reassembled, instead of vanishing.** A
  coupon whose token exceeds the gateway's direct-send limit is not sent as one message: it is
  split into `cashu_dm_chunk` pieces, one per gift wrap. Nothing put them back together. Each
  piece failed the token-envelope test, fell through to the legacy text parser, produced no token,
  and was recorded as "not a token DM" — which is marked processed and never retried. Coupons of
  200, 150 and 150 were minted, backed, delivered to the relay and acked, and never appeared in
  the recipient's wallet.

  The wallet had assumed the gateway reassembled them. It cannot: the chunk metadata is inside the
  encrypted message and the outer wrap carries only a recipient tag, so a server holding no
  private key cannot even tell a chunk from any other DM, and it refuses to guess. The client is
  the only place the pieces are legible. Reassembly now happens at unwrap time, verifying the
  declared length and SHA-256 before the coupon is credited, and an incomplete transfer leaves its
  pieces on the relay to be re-read rather than consuming them.

- **Coupons already abandoned are recovered.** Fixing the reassembly does not on its own bring
  back what was lost to its absence: those messages were recorded as "not a token DM", which is
  never retried, so the wallet skipped them forever. The gift wraps are still on the relay, so
  that local record was the only thing between the customer and their money. Each device now
  clears that record once, on the next start, and re-reads what it gave up on. Protection against
  crediting the same coupon twice is unaffected, because it keys on the token itself and is left
  untouched.

## [0.5.2] - 2026-09-18

### Fixed

- **Each coupon of a split sale is recorded at its own value.** The create and poll endpoints
  spell the amount differently (`face_value_minor` and `face_value`), so half the pipeline saw no
  amount at all, and the fallback filed the whole sale against every part — five rows of 1000 for
  a 1000 sale, reporting five times the money as delivered. Either spelling is now read, and
  failing both, the sale is divided by its part count.

## [0.5.1] - 2026-09-18

### Fixed

- **A split sale now delivers every coupon, not just the first.** The gateway breaks a face value
  whose Cashu token would exceed the transport ceiling into several smaller coupons and returns
  all of them. This app read only the first and discarded the rest, so a 1000-unit sale issued as
  5 coupons of 200 reached the customer as 200; the other four were minted, left pending, never
  polled and never delivered. A token carries one proof per set bit of its amount, so the ceiling
  is reached by ordinary round numbers rather than extreme ones, and any sale large enough to be
  split was silently short-paying the customer.

  A sale that fails part-way now FAILS LOUDLY, reporting the amount that already reached the
  customer. A delivered coupon is a gift-wrapped DM and cannot be recalled, so a later part
  failing cannot undo an earlier delivery — reporting such a sale as successful is what let the
  shortfall go unnoticed. The merchant's own history records one row per coupon at the part's
  value, and the confirmation screen says how many coupons a sale became, so the merchant and the
  customer count the same sale the same way.

## [0.5.0] - 2026-09-17

### Added

- **A merchant dashboard that prompts rather than reports.** "Expiring soon" now shows the three
  most urgent vouchers and links to the rest, so a glance answers "what needs chasing today"
  instead of scrolling past forty rows; the section is still absent entirely when nothing is
  expiring, because a box that says zero every day trains people to stop reading it. The full list
  is a new screen at `/merchant/expiring`, built from the SAME `expiringSoon` call the dashboard
  uses rather than a second filter written to match — two definitions would drift and the link
  would disagree with its own destination. "Vouchers you have issued" gained an "Expiring soon"
  count beneath "Still valid", the total it is carved out of.

- **Paging on every record list**, 21 to a page: transactions, vouchers, issued vouchers and the
  new expiring list. These were unbounded, which is fine for a customer holding three coupons and
  unusable for the stall that issued four hundred. The control strip renders nothing for a single
  page, disables rather than hides its ends so the other control does not jump, announces the page
  change to a screen reader, and does not glide the viewport for anyone who asked for reduced
  motion.

### Changed

- **A customer paying a merchant back now reads "Pay", not "Redeem".** "Redeem" is the merchant's
  word for value coming back off their books, and it stays that way on the till. The person at the
  stall is doing the ordinary thing of paying for something, and asking them to "Redeem" made them
  adopt the counterparty's accounting language for their own purchase — it also reads like claiming
  a prize rather than handing money over. Renamed across the whole customer leg, so the flow does
  not change its mind at the last screen. The underlying operation is untouched.

- **The dashboard balance no longer shows "Taken in".** It totalled the vouchers this wallet
  HOLDS, sat directly under a liability figure, and so read as income without being income. "Value
  taken" below already answers that question properly, over the chosen range and in the stall's
  issuance currency. Two numbers that both look like takings and disagree is worse than one.

### Fixed

- **The re-authentication prompt interrupted people mid-payment, every fifteen minutes.** The
  timeout was not too short; the client's clock had stopped agreeing with the server's. The gateway
  runs a SLIDING idle window and `/api/v1/auth/validate` pushes `expires_at` out to `now + idleTtl`
  on every authenticated request, so an active session is continually renewed and never reaches the
  deadline it was issued with. Nothing told the client: `expiresAt` is recorded once, from the login
  response, so the local watcher counted down from a snapshot the user's own traffic had invalidated
  seconds later and fired on a session the server considered perfectly healthy. Dismissing it changed
  nothing, because the next snapshot was just as stale. The local deadline is now a suspicion rather
  than a verdict — the wallet asks the gateway, and only a session the server AGREES is over raises
  the dialog. A dropped connection, a 502 or a 403 is none of those things and no longer prompts.

- **...and then the wallet kept itself signed in.** Found reviewing the fix above. Asking
  `/auth/validate` SLIDES the idle window as a side effect, so a client that asks whenever its local
  clock runs out renews its own session on a timer: a phone lying face-down on a café table stayed
  unlocked, with the 15-minute idle timeout enforced only by the server's 12-hour absolute cap. That
  is not a smaller bug than the interruption it replaced. The wallet now answers locally the question
  the server cannot — has a PERSON done anything since the last check — and only then confirms.
  Real input only, nothing the app can raise itself, and the signal is spent on read so one ancient
  tap cannot renew forever. Eight idle hours now produce zero renewals and a locked wallet, where
  before they produced thirty-two and an open one.

- **The prompt never arrived at the absolute cap.** Approaching the 12-hour ceiling the server
  clamps `expires_at` to the same fixed instant on every call. The expiry watcher fires on the
  TRANSITION only, so a confirmed deadline that had stopped moving latched it: the wallet never
  asked again and sat quiet against a session about to be refused, and the user's next tap would
  have failed with no warning. A floor under the confirmed deadline guarantees the next question
  gets asked.


- **The settlement receipt went to the wrong person.** On a merchant-issued coupon spent
  wallet-to-wallet, dmPoll addressed it to `meta.issuerId` — who MINTED the coupon, not who SPENT
  it — so the stall was told its own customer had been paid and the customer heard nothing. The
  payload carried the right answer in `sender_pubkey` all along and `dmCrypto` was dropping it; it
  is now parsed and preferred, with the stall kept as the fallback for the one case where it is
  right. The recipient also got only the optimistic advance notice, so six seconds after a payment
  the sole surviving record was the provisional one; settlement now files a bell row too. And the
  sender, watching the app when their payment was claimed, saw nothing at all — there is a toast
  now, deduped so a redelivery is silent. In-app notifications also honour the settings screen,
  which they had never consulted; the lookup fails open, because a preference that throws must not
  be what hides someone's money.

- **A phone could stop ringing without saying so.** Web Push endpoints are rotated, expired or
  dropped by the browser, and the `pushsubscriptionchange` event meant to announce that is
  unreliable and missing from several engines. Nothing re-registered afterwards, so the gateway
  went on pushing at an endpoint returning 410 while the settings screen still read "on" — a state
  that was permanent until the user toggled push off and on by hand. The current subscription is
  now re-POSTed on startup; the endpoint hash upserts, so an unchanged one is a no-op.

- **The recipient's phone stayed silent when a coupon arrived** (gateway-core). `notifyVoucherReceived`
  was fully implemented and called by nothing, while the sender's half of the pair had a caller and
  worked — which is why push looked healthy. Fixed in gateway-core; the wallet's inventory note is
  updated to match.

- **The send flow named people by hex key.** Every screen of it — the voucher picker, the amount
  screen, the confirmation — printed something like `a1b2c3d4…ef56` where a name belongs. Two
  separate causes. The MERCHANT was read from `Merchant.name`, which `VoucherGrouper` fills with
  `merchant_metadata.merchant_name || merchantId`; a coupon issued without that optional metadata
  therefore carried a 64-character key as its "name", which `humanName` correctly rejected and
  `identityLabel` then dropped all the way to a short key. Nothing ever asked for the kind-0 that
  was on the relay the whole time. The new `useMerchantLabel` / `useMerchantHandle` fetch it, and
  the published profile wins over the coupon's stored copy — that copy was taken when the coupon
  was ISSUED and never updates, so a stall that renames itself now reads as its new name on old
  coupons. The RECIPIENT kept its handle only until `toRecipientPubkey` threw it away: someone
  reached by typing `cocoa@staging.398ja.xyz` who has published no kind-0 left the flow with
  nothing to show but a key, for a person the user had just named. `resolveRecipient` returns the
  address it resolved through, and `IdentityInline` takes it as `fallbackHandle`. Both legs fall
  back exactly as before when there is genuinely nothing to show.

### Dependencies

- `@imani/dm-poll` 0.4.1 → 0.4.2 (adds `TokenMetadata.senderPubkey`).

## [0.4.1] - 2026-09-16

### Fixed

- **The 0.4.0 image would not build.** `undici` was added to `devDependencies` by the load-test
  work without a lock-file update, so `npm ci` in the Dockerfile refused the checkout as out of
  sync. The lock file now carries it. No runtime change.

## [0.4.0] - 2026-09-16

### Added

- **A stall can be reached by handle.** `/profile/cocoa`, `/profile/cocoa@imani.casa`, an npub or
  a hex key all open the same page, resolved the way the scanner and the paste box already resolve
  a recipient. A handle that resolves to nobody says so, rather than rendering an empty profile for
  a name that does not exist.
- **Show code.** Beside Copy on a stall's card, a button that holds up the stall's full handle
  (or its npub, when it publishes none) as a QR code, white-backed in every theme because a
  scanner reads dark-on-light. Both are 44px round targets, the same as on your own profile card.

### Fixed

- **A stall owner was offered a card purchase of their own voucher.** Opening your own profile,
  from your own coupon, receipt or a link that came back round, showed the Buy button. The page
  now knows who is looking: the purchase control is withheld on your own stall, and a line says
  that this is how the stall looks to a shopper.

### Changed

- Load-test notes record the second staging run, what it cannot measure, and why the first
  rate-limit fix was wrong (`loadtest/`).

## [0.3.2] - 2026-09-15

### Fixed

- **Scanning a QR code did nothing.** A customer's NIP-05 code from `/receive` and a merchant's
  `vreqA…` payment request behaved identically: the camera opened, the preview ran, the scan
  region drew its outline over the code, and the app never moved.

  The broken part was one word in a response header this repository ships. `qr-scanner` decodes
  in a Web Worker it builds from a Blob URL, and `deploy/nginx.conf` sent `worker-src 'self'`,
  so the browser refused the worker and the library never produced a result. The only trace was
  a console line, on a phone, where nobody is looking.

  Two CSP headers **intersect** rather than override, so the edge already allowing `blob:` could
  not rescue this: the strictest of the two wins, and the strictest was ours. `script-src 'self'`
  is unchanged, so injected script still cannot run or be packaged into the worker.

  Nothing in the unit suite could have caught it — the scan router, the QR handlers and
  `/api/v1/resolve` were all correct. `npm run e2e:scan` (`e2e/probe-scan.mts`) now plays a QR
  code into the real deployed app as a fake webcam and asserts the app actually moves;
  `deploy/__tests__/csp.test.ts` is the cheap guard on the header itself.

- **A blocked QR decoder now says so.** The header above is repaired, but it is not the only
  header in play: this app is served behind an edge proxy, can be served behind someone else's,
  and runs in a WebView with its own policy. Two CSP headers intersect, so any of them can break
  scanning on a deployment where our own file is correct.

  Both scanning screens therefore ask, before opening the camera, whether the page may run the
  decoder, and name the cause and the fix when it may not. The Scan screen reveals its typing
  field at the same time, because a blocked decoder is exactly when the fallback matters.

## [0.3.1] - 2026-09-14

### Fixed

- **`audit-api` could not start: the image imported a file it never copied.** The IW-04 fix gave
  this service the bounded replay/rate store by importing `expiringMap` from
  `services/wallet-api`, but `services/audit-api/Dockerfile` copies only this service's own
  directory — so the container died in a MODULE_NOT_FOUND loop and came up unhealthy on staging.

  Nothing in the pipeline covers that gap. It is not a compile error, not a test failure and not
  a scan finding: 4,607 tests, three scanners and a cold-boot job were all green on the commit
  that introduced it. It only appears when the image runs, which is an argument for deploying to
  staging as part of a release rather than after one.

## [0.3.0] - 2026-09-14

The application-security review of 2026-09-13 (`imani-docs/security/appsec-2026-09-13/`) raised
17 findings against this repository, 1 Critical. All are closed.

**Minor, not patch: the services now refuse to start on an insecure relay URL in production.**
See "Upgrading" below.

### Security

- **IW-07 (Critical) — the debt-queue response was trusted verbatim**, so unvalidated input
  decided **how much value is minted**. Schema-validated before any minting now.
- **IW-01 — the NIP-98 audience was derived from the attacker-controlled `Host` header.**
- **IW-02 — free identities defeated per-key throttling**, and rate-map exhaustion silently
  disabled it.
- **IW-03 — idempotency keys were not bound to the request**, so one key replayed another
  endpoint's body.
- **IW-04 — replay protection was per-process**, so any scale-out silently re-admitted captured
  requests.
- **IW-05 — a caller-supplied `now` overrode the server clock on every expiry check.** The
  Semgrep rule written for this then found it in `reports.ts` and `requests.ts`, two files the
  review had not reached, one of which drives expiry.
- **IW-06 — the `/v1/redeem/check` ceiling was self-attested**, and negative prior redemptions
  were accepted.
- **IW-08 — the credential vault authenticated the key but not the identity it is bound to.**
- **IW-09 — decrypted issuing keys were cached for the process lifetime with no zeroisation.**
- **IW-10 — unauthenticated `/health` echoed internal failure detail.**
- **IW-11 — `audit-api` read the relay over cleartext `ws://` by default.**
- **IW-12 — no rate limiting on an unauthenticated CORS-wildcard endpoint doing curve work.**
- **IW-13 — no Content-Security-Policy anywhere in this repository.**
- **IW-14 — `privkeyHex()` handed out an unwipeable string**, defeating the eviction guarantee.
- **IW-15 — terminal enrolment records were stored unauthenticated in `localStorage`.**
- **IW-16 — `enrolledActor()` compared a field with itself**, so the device-lock check could
  never fail — under a comment asserting the comparison it could not make.
- **IW-17 — two high-severity production advisories with fixes available.** `npm audit` now gates
  the production tree in CI, and that gate *does* fail the build.

### Fixed

- **The IW-11 relay guards refused to start the shipped containers.** They threw at module load
  on a cleartext relay URL, and both Dockerfiles set `ENV ..._RELAY_URL=ws://nostr-relay:7777` —
  so the guard refused to start the very images it was protecting. A security control that stops
  the service working gets reverted wholesale, and the finding comes back with it. Now loud
  everywhere, fatal only in production.
- **`stallLookup.ts` read over cleartext `ws://`.** The comment above it already said an empty
  result "would read as 'not a stall' and allow exactly the send this module exists to refuse".
  Found by the new rules.

### Added

- `.semgrep/` with 6 TypeScript rules derived from real findings here, fixtures proving each
  still fires, and a CI check that fails when a rule matches nothing.
- gitleaks over full history with custom rules for nostr private keys, cashu tokens and LNbits
  admin keys.

## Upgrading to 0.3.0

**`AUDIT_RELAY_URL` is now mandatory — there is no default relay.** It previously fell back to a
hardcoded `ws://nostr-relay:7777`, so a misconfigured deployment silently dialled cleartext.

**In production a cleartext `ws://` relay refuses to start.** The guard fires when `NODE_ENV` or
`AUDIT_ENV` is `production`; elsewhere it warns loudly and continues. Point `*_RELAY_URL` at
`wss://` for any real deployment. For a local test stack only, `AUDIT_ALLOW_PLAINTEXT_RELAY=true`
is the written-down escape hatch.

Why it is fatal only in production: on a cleartext hop an attacker can drop one merchant of their
choosing from the stream, and this service then accuses that merchant of not having published.

**`npm audit` gates the production dependency tree in CI and fails the build.** Dev dependencies
are deliberately out of scope: they are numerous, they churn, and a vulnerability in a test runner
is not a vulnerability in the wallet a customer loads — gating on them means the gate gets
disabled, and a disabled gate protects nothing.


## [Unreleased]

## [0.2.0] - 2026-09-13

### Added

- **An expired session now asks for your passphrase instead of stranding you.**
  When the NAP session ran out, the app rendered `Signing in…` forever:
  `isAuthenticated` had gone false while the session object was still held, so
  the screen had no affordance on it and the only way back in was a page refresh
  the user had to think of for themselves. A passphrase dialog now opens over
  whatever was on screen, and unlocking returns them to it with no navigation
  and no reload. This is the flow imani-apps already had in `<reauth-modal>`,
  brought to the React wallet.

  Three pieces:

  - `lib/sessionExpiry.ts` — the local clock nap does not have. nap records
    `expiresAt` and then leaves it alone, so a wallet sitting idle on the
    coupons screen makes no requests and notices nothing until the user's next
    tap fails. This fires at the deadline the server already gave us, slightly
    early so a request in flight cannot lose the race, and re-checks on
    `visibilitychange` because a backgrounded tab throttles timers.
  - `lib/reauth.ts` — decrypt the stored key with the passphrase (the keystore
    is the verifier; there is deliberately no cheaper one), restore it if a lock
    evicted it, then `login()` for a fresh cookie. Deliberately not a silent
    renewal: the key is usually still in the signer and `login()` would go
    straight through, but a session that any open tab renews by itself is not a
    session lifetime — it is an unbounded one.
  - `components/ui/ReauthDialog.tsx` — modal, but never a dead end. A passphrase
    prompt is useless to the one person most likely to be reading it, so the
    other ways out are on the dialog: restore from a backup (nsec, file, Drive)
    and log out, one level deeper so the destructive one is not beside the
    button people mean to press.

  The dialog wears the app's own `.material` — the same translucent layer as the
  header and the menus — over a scrim that dims and pushes the content back, and
  settles down onto its resting size rather than growing from a trigger it does
  not have. Reduced motion keeps the cross-fade and drops the scale, rather than
  jump-cutting the whole viewport.

### Fixed

- **Restoring another account from the dialog ran as the previous identity.**
  The restore exit called `onLoggedOut()`, which is only `setSession(null)` — a
  React state change. The nap session lives in a module singleton outside React,
  and `createSession` returns the existing session while ignoring the key it is
  passed, so unlocking a backup handed back the *previous* account's session:
  authenticated as one identity while the keystore held another, with that
  identity's roles and its pubkey on every signature, and no error anywhere. It
  now calls `resetSession()`, the same guard `onUnlock` already applies to a
  failed login. The same fix stops the DM poller and the notifications loop,
  whose lifetime is the session rather than the component, so neither runs on
  past the account it belongs to.
- **A dismissed prompt silenced the next session loss.** The dialog closes the
  instant a correct passphrase lands, ahead of `NapProvider`'s 500ms poll, but
  the suppression was unconditional — so a later loss whose deadline had not
  arrived (a revoked cookie, which the timer never sees) stayed silent and put
  the user back on the dead screen. The dismissal is now paired with the
  authentication state it was made in.
- **The caret did not return to the passphrase field after a wrong attempt.**
  The focus call sat in the `catch`, where the field is still `disabled` —
  `busy` is cleared in the `finally`, after — and `.focus()` on a disabled input
  silently does nothing.

## [0.1.2] - 2026-09-11

### Fixed

- **The SPA builds again.** `tsc -b` failed on the receipt tests, so
  `npm run build` failed, so no image could be built from this checkout — the
  SPA, audit-api, purchase-issuer and wallet-api all ship from it. The mocks
  were bare `vi.fn()`, making `mock.calls[0]` a zero-length tuple that no `as`
  cast can widen. Each mock now carries the real parameter list of the function
  it replaces, so the assertions check the call rather than assert its shape
  (#81).

## [0.1.1] - 2026-09-11

### Fixed

- **wallet-api: the scheme now comes from the edge, not the socket.** Behind a
  TLS-terminating proxy every authenticated request answered 401 `url-mismatch`.
  NIP-98 binds a signature to an absolute URL and the comparison includes the
  protocol, so a caller signed `https://` while the service reconstructed
  `http://` from `req.headers.host`. `X-Forwarded-Proto` is now read, which
  grants nothing: it only lets a caller match a signature it already made over
  the URL it really used. This is the release that lets wallet-api be deployed
  at all (#79).

## [0.1.0] - 2026-09-11

The first numbered release. 431 commits, previously shipped as `:latest` with
`version: "0.0.0"` in `package.json` — so a container running in staging could
not be traced back to the code inside it.

0.1.0 rather than 1.0.0 deliberately: the wallet moves real money and the
number should say what it is, not flatter it.

This entry does not reconstruct those 431 commits. It starts the record here,
and the notification work below is what happens to be newest.

### Added

- **A sender learns their coupon was claimed.** The gateway had the whole
  mechanism — the receipt endpoint, an Artemis queue, a "Voucher Claimed" Web
  Push, VAPID keys, four registered subscriptions — and `push_notification_log`
  held zero rows, because nothing in this wallet ever posted a receipt. The word
  `payment-receipts` appeared here exactly once, in a comment.

  The receipt is NIP-44 encrypted to the sender, so the gateway relays a blob it
  cannot read. Its id is deterministic, so a retry collides and the gateway
  answers `409` rather than notifying twice for one claim.

- **Receipts are collected**, so a claim reaches the in-app bell and not only a
  push the user may have dismissed, denied, or never been asked for. The two
  routes dedupe on the gateway's receipt id.

### Fixed

- **Amounts are formatted, not interpolated.** Face values are minor units, so a
  72p claim rendered as `72`. Now uses the same `formatFace`/`displayDecimals`
  pair as the arrival toast, so the two notifications for one coupon agree.

- **A receipt no longer asserts an unverified amount.** `dmCrypto` is explicit
  that envelope fields are sender-written — "a genuine low-value token could be
  announced at any face value at all" — and the wallet already refuses to sign
  an attestation over one. A notification claiming "£500 was claimed" was the
  same unfounded claim in a friendlier place. Amounts now require a verified
  voucher signature; without one the receipt names no number.

- **The receipt is addressed to the issuer**, not to whoever signed the gift
  wrap. The gateway signs on a merchant's behalf, so the settlement was reaching
  the gateway while the merchant owed the news heard nothing.

- **`deliveryEventId` survives redemption.** It was set on the TokenDm and
  dropped when building the redemption options, so the receipt had no id to key
  on. There are two call sites in `dm-poll`; the fix landed on the one the
  service does not drive before being found on the one it does.

- **The dev proxy routes `/api/v1/payment-receipts`** to gateway-core. Without a
  rule it fell into the `/api` catch-all, reached customer-wallet and 404'd —
  the third time that trap has been hit in this file, and now the first that is
  tested for.
