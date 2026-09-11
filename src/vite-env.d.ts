
/**
 * The version from package.json, baked in at build time (see vite.config.ts).
 *
 * Declared here rather than imported, so nothing pulls package.json into the
 * bundle to read one string.
 */
declare const __APP_VERSION__: string
