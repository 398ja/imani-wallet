/// <reference types="vite/client" />

/**
 * The version from package.json, baked in at build time (see vite.config.ts).
 *
 * Declared here rather than imported, so nothing pulls package.json into the
 * bundle to read one string.
 */
declare const __APP_VERSION__: string

/** When the bundle was built, ISO 8601 (see vite.config.ts). */
declare const __BUILD_DATE__: string

/**
 * Build-time `VITE_*` values this app reads through `import.meta.env`. Each is
 * compiled into the bundle, none is a secret, and the image passes them as
 * Dockerfile build args (see .env.example for the list and what each does).
 * Only the ones with a fixed contract are typed here; the rest read as `any`
 * through Vite's own index signature, as before.
 */
interface ImportMetaEnv {
  /**
   * The public website, e.g. `https://www.imani.casa` (#357). New accounts accept the Terms and
   * Conditions at `<this>/terms.html`. Required by the image build; without it the app refuses to
   * create accounts (src/lib/terms.ts).
   */
  readonly VITE_WEBSITE_BASE_URL?: string
  /** #402: `on` shows "Use online" (checkout codes). Off by default, so the feature ships dark. */
  readonly VITE_CHECKOUT_CODES?: string
  /** The imani-deploy release this build shipped in (Settings → About). Unset: shown as "dev". */
  readonly VITE_DEPLOY_VERSION?: string
  /** The imani-wallet release tag this build is (Settings → About). Unset: package.json + "dev". */
  readonly VITE_WALLET_VERSION?: string
  /** The Android APK this deploy publishes (Settings → About's download row). Unset: no row. */
  readonly VITE_ANDROID_APK_URL?: string
}
