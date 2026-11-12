# play-listing

Google Play store listing assets for the Imani wallet (issue #558). Regenerate every image with `./build.sh` (ImageMagick 7). It reads the owner's existing assets; set `IMANI_WWW` and `IMANI_SHOTS` if the repos live elsewhere.

| File | What it is | Source | Play Console section |
|---|---|---|---|
| `icon-512.png` | 512x512 32-bit PNG app icon, full bleed (Play rounds it) | The Imani mark `public/imani.svg` (`#171717`) on the app background `#fafafa`, the same as the web app icon `public/icon-512.png` and the Android launcher icon (`drawable/ic_launcher_foreground.xml` in the adaptive icon, and the `mipmap-*` PNGs for older Android) | Grow > Store presence > Main store listing > Graphics > App icon |
| `feature-graphic-1024x500.png` | 1024x500 24-bit PNG, no alpha | `imani-www/mark.svg` in the site accent `#1c6cf5`, site cream `#f3efe7` and ink `#1b1814` from `site.css`, tagline from `index.html` | Main store listing > Graphics > Feature graphic |
| `screenshots/phone-01.png` | Home with a voucher | `imani-marketting/deck/shots/c-home-voucher.png` | Main store listing > Phone screenshots |
| `screenshots/phone-02.png` | Receive (show your code) | `c-receive.png` | same |
| `screenshots/phone-03.png` | Pay a shop | `c-pay-confirm.png` | same |
| `screenshots/phone-04.png` | Send to a friend | `c-share-1-amount.png` | same |
| `screenshots/phone-05.png` | Friend's wallet after receiving | `c-share-5-friend-home.png` | same |
| `screenshots/phone-06.png` | Stall: sell a voucher | `m-sell-2-amount.png` | same |
| `screenshots/phone-07.png` | Stall: sale delivered | `m-sell-3-delivered.png` | same |
| `screenshots/phone-08.png` | Cashlink ready | `tutorial-send-links/c-4-priya-ready.png` | same |
| `listing.md` | App name, short and full description, category, contact, privacy URL | `imani-www/index.html`, issue #558 | Main store listing (text) and Store settings |
| `build.sh` | Regenerates all images | | |

Screenshots are 1170x2532 captures padded left and right with the app background (`#fafafa`) to 1266x2532, so the long side is exactly 2x the short side as Play requires. All use demo personas (Priya Raval, Sam Okafor, Harbour Bakery), with no key, backup, email or staging URL on screen.
