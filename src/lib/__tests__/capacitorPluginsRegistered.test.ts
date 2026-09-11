/**
 * Every Capacitor plugin in package.json must be registered with the Android
 * project.
 *
 * Adding a plugin to package.json does nothing for the native app on its own.
 * `npx cap sync android` is what writes the plugin into the generated gradle
 * files, and forgetting it produces the least helpful failure available: the
 * TypeScript imports resolve, the unit tests pass because they mock the
 * Capacitor bridge, the web build is unaffected, and the APK simply does not
 * contain the plugin. The first sign is a device that never does the thing.
 *
 * That happened here. @capacitor/push-notifications was added to package.json
 * and `cap sync` was never run, so `capacitor.settings.gradle` had no
 * `:capacitor-push-notifications` entry and NativePushTransport would have
 * asked a missing plugin for a registration token. No test in this repository
 * could see it, because none of them build the Android project.
 *
 * So this compares the two lists directly. It is cheap, it runs in the normal
 * suite, and the fix it names is a single command.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../..')

/** Plugins that ship Android code. Excludes the runtime and the CLI. */
function declaredPlugins(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const notPlugins = new Set(['@capacitor/core', '@capacitor/android', '@capacitor/cli'])
  return Object.keys(pkg.dependencies ?? {})
    .filter((name) => name.startsWith('@capacitor/') && !notPlugins.has(name))
    .map((name) => name.replace('@capacitor/', ''))
    .sort()
}

function registeredPlugins(): string[] {
  const settings = readFileSync(join(ROOT, 'android/capacitor.settings.gradle'), 'utf8')
  return [...settings.matchAll(/^include ':capacitor-([a-z-]+)'/gm)]
    .map((m) => m[1])
    .filter((name) => name !== 'android')
    .sort()
}

describe('the Android project and package.json agree on plugins', () => {
  it('registers every declared Capacitor plugin', () => {
    const missing = declaredPlugins().filter((p) => !registeredPlugins().includes(p))

    expect(
      missing,
      `these Capacitor plugins are in package.json but not in the Android ` +
        `project, so they are absent from the built app and will fail only on ` +
        `a device: ${missing.join(', ')}. Fix with: npx cap sync android`,
    ).toEqual([])
  })

  it('keeps push-notifications registered, since native push depends on it', () => {
    // Named explicitly because this is the one that was missing, and the one
    // whose absence is hardest to notice: web push is unaffected, so the
    // wallet looks healthy everywhere except on a phone.
    expect(
      registeredPlugins(),
      'push-notifications is no longer registered with the Android project, ' +
        'so NativePushTransport would request a token from a plugin that is ' +
        'not installed. Run: npx cap sync android',
    ).toContain('push-notifications')
  })
})
