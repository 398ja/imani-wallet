# Activating native (Android) push

Everything for native push is built and wired except the Firebase credentials,
which only the project owner can create. This is the whole procedure, written
so it is one sitting rather than a rediscovery.

**Current behaviour without these steps:** the Android app never registers for
push. If a token somehow reaches the server, the row is refused with 501 and
survives, so nothing is corrupted by the gap. Web push is unaffected and works
today. The in-app bell and inbox also work on Android, because they do not use
push at all.

## Why FCM at all, when web push already works

A Capacitor WebView commonly exposes `PushManager` and then never delivers
anything. That failure is silent, which is the worst kind, so the app does not
rely on it: `manager.ts` selects `NativePushTransport` whenever
`Capacitor.isNativePlatform()` is true, and that transport registers an FCM
token instead.

The token travels in the `endpoint` column behind an `fcm:` scheme rather than
in a second table, since it is one string. `WebPushService.isNativeSubscription`
recognises those rows.

## What you need

1. A Firebase project (or the existing one, if imani-apps already has it).
2. `google-services.json` for the Android app, from Firebase console →
   Project settings → Your apps → Android.
3. A **service account JSON** with the Firebase Cloud Messaging API enabled,
   from Project settings → Service accounts → Generate new private key.

The Android package name in Firebase must match the app's application ID
exactly, or registration is rejected:

    xyz.tcheeric.imani.wallet

(from `android/app/build.gradle`, verified 2026-09-11.)

## Step 1: the client

Drop the file in and rebuild. Nothing else changes.

```bash
cp ~/Downloads/google-services.json android/app/google-services.json
npm run build && npx cap sync android
```

`cap sync` is not optional here and is safe to run: it regenerates only
`android/app/capacitor.build.gradle` and `android/capacitor.settings.gradle`,
leaving the hand-edited `android/app/build.gradle` (and its conditional
google-services block) untouched. Verified 2026-09-11.

It matters because it is what registers the plugin with the Android project.
Adding `@capacitor/push-notifications` to `package.json` is NOT enough: until
sync runs, the generated gradle files never reference
`:capacitor-push-notifications`, so the plugin is absent from the built app and
the native transport would ask for a token from something that is not there.
This repository was in exactly that state until the sync was run, which is why
the registration is committed alongside this note.

Registering it pulls in `com.google.firebase:firebase-messaging`, so the first
build after sync needs network access; `--offline` fails with an unresolved
dependency rather than anything more informative.

`android/app/build.gradle` already applies the `com.google.gms.google-services`
plugin **conditionally**, only when that file exists. So the presence of the
file is the entire client-side switch. It is gitignored deliberately: it
identifies your Firebase project and does not belong in the repository.

Verified 2026-09-11 rather than assumed, since "just drop the file in" is the
kind of claim that is wrong in an expensive way:

- **Without the file**, `./gradlew :app:processDebugManifest` succeeds. The
  missing credentials do not break the Android build, they only mean push is
  never registered. Note the plugin's own message goes to `logger.info`, which
  you will not see at default log level — absence is silent by design.
- **With a malformed file**, the build FAILS loudly:
  `Missing project_info object`, exit 1. So a wrong or truncated download
  cannot slip through and leave you debugging a device that simply never gets
  a token.

That asymmetry is the useful part: no file is quiet, a bad file is loud.

Verify on a real device, because an emulator without Play Services will not
register:

```bash
npx cap run android
adb logcat | grep -iE "FirebaseMessaging|push token|Notifications"
```

Expect a token, then a `POST /api/v1/push/subscribe` carrying an endpoint that
starts with `fcm:`. Confirm it landed:

```bash
docker exec imani-gateway-db-test psql -U postgres -d imani_core -c \
  "SELECT id, left(endpoint, 12) AS scheme, active \
     FROM push_subscription WHERE endpoint LIKE 'fcm:%';"
```

The table is `push_subscription`, singular. Run today it returns zero rows,
which is the correct answer: no native device has ever registered.

## Step 2: the server

This is the part that does not exist yet. Until it does, those rows are refused
with **501 Not Implemented** — deliberately not 410, so they are never
deactivated and the user does not have to re-enable notifications by hand once
delivery lands.

The seam is a single branch in `WebPushService.sendNotification`
(gateway-core-rest), the one that currently returns the 501. Replacing it means:

1. Add the Firebase Admin SDK to `gateway-core-rest`.
2. Supply the service account to the container, as a secret, never in the image:
   `GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/firebase-sa.json`.
3. In that branch, send via FCM using the token after the `fcm:` prefix,
   with the same payload the web path already renders.
4. Map FCM's `UNREGISTERED` and `INVALID_ARGUMENT` to the **410** path, so dead
   tokens are deactivated exactly as expired Web Push endpoints are. This is the
   step worth care: without it, dead tokens accumulate and are retried forever.

Keep the payload identical across both transports. `render.ts` in the wallet
re-derives the route and refuses absolute URLs and `/voucher/home.html`, and
that check is what keeps a notification tap from becoming an open redirect.

## Step 3: prove it end to end

Test coverage is not evidence here. The failure modes that matter — a token
that never arrives, a payload the device silently drops, a tap that opens the
wrong screen — are invisible to a unit test and appear only on hardware.

1. Install on a real device and enable notifications in Settings.
2. Trigger a real event (a voucher issued to that account).
3. Confirm the notification arrives **with the app closed**, not merely
   backgrounded.
4. Tap it, and confirm it lands on the right screen.
5. Disable notifications, trigger again, and confirm nothing arrives.

Step 5 is the one people skip, and it is the one that catches a preference the
server ignores.

## What is already verified

- Transport selection: `manager.ts:49` chooses native vs web on
  `Capacitor.isNativePlatform()`. 29 tests cover the native transport and that
  branch.
- The `fcm:` scheme round-trips through subscribe and is recognised server-side.
- Native rows are refused with 501 and are **not** counted as failures and
  **not** deactivated. Covered by gateway-core tests.
- Web push is verified end to end against a real browser and a real Google
  endpoint: 24/24 e2e checks.

## What is not

No notification has ever been delivered to a real Android device, because no
Firebase credentials exist. Treat native push as unproven until step 3 passes on
hardware.
