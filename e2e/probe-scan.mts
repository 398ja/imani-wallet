/**
 * Does the scanner actually read a code? Against the real deployed app.
 *
 * ## The bug this exists for
 *
 * Scanning did nothing. A customer's NIP-05 QR from `/receive`, a merchant's
 * `vreqA…` payment request — the camera opened, the preview ran, the scan
 * region even drew its outline over the code, and the app never moved. The
 * cause was one word in a CSP: `worker-src 'self'`, in this repo's own
 * `deploy/nginx.conf`. qr-scanner decodes in a Worker built from a Blob URL,
 * the browser refused it, and the only trace was a console line nobody was
 * watching on a phone.
 *
 * Nothing in the unit suite could have caught it. The router in `ScanPage` was
 * correct, the handlers were correct, `/api/v1/resolve` was correct: the one
 * broken part was a response header on a container, and only a real browser
 * pointed at the real deployment ever sees that.
 *
 * `deploy/__tests__/csp.test.ts` now holds the header itself, which is the
 * cheap guard. This is the expensive one, and it asserts the thing that
 * actually matters: a code held in front of the camera MOVES THE APP.
 *
 * ## How the camera is faked
 *
 * Chromium plays a Y4M file as a webcam. The QR must occupy a modest part of
 * the frame — filling it edge to edge leaves the decoder no quiet zone, which
 * looks exactly like a decoder that is not running, so the padding in `frame()`
 * is load-bearing.
 *
 * ## Running
 *
 *   npx tsx e2e/probe-scan.mts                    # against staging
 *   BASE=http://localhost:5177 npx tsx e2e/probe-scan.mts
 *
 * Needs ffmpeg for the fake camera feed.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium, type Page } from '@playwright/test'
import QRCode from 'qrcode'

import { registerCustomer } from './register.mts'

const BASE = process.env.E2E_BASE ?? 'https://wallet.staging.398ja.xyz'
/** A handle that resolves on the target deployment. */
const HANDLE = process.env.E2E_HANDLE ?? 'song@staging.398ja.xyz'

const work = mkdtempSync(join(tmpdir(), 'scan-probe-'))

/** A QR code as a webcam feed: 240px of code centred in a 640x480 white frame. */
async function frame(text: string, name: string): Promise<string> {
  const png = join(work, `${name}.png`)
  const y4m = join(work, `${name}.y4m`)
  await QRCode.toFile(png, text, { width: 512, margin: 4 })
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y', '-loop', '1', '-i', png, '-t', '8', '-r', '25',
    '-vf', 'scale=240:240,pad=640:480:200:120:white,format=yuv420p', y4m,
  ])
  return y4m
}

/**
 * Open /scan with `video` playing, and report where the app went.
 *
 * A fresh browser per code, because the fake camera file is a launch argument.
 * Registration is per-run for the same reason it is in the other probes: a
 * shared account is state a probe cannot assume.
 */
async function scan(video: string): Promise<{ url: string; violations: string[] }> {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${video}`,
    ],
  })
  try {
    const ctx = await browser.newContext({ permissions: ['camera'] })
    const page: Page = await ctx.newPage()
    const violations: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      // The exact signature of the bug, kept visible: a refused worker is the
      // difference between "no code in frame" and "cannot decode at all".
      if (t.includes('Content Security Policy')) violations.push(t)
    })

    await registerCustomer(page, BASE)
    await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle' })

    for (let i = 0; i < 25; i++) {
      if (!page.url().endsWith('/scan')) break
      await page.waitForTimeout(1000)
    }
    if (violations.length > 0) console.error('  CSP violations:', violations.join(' | '))
    return { url: page.url(), violations }
  } finally {
    await browser.close()
  }
}

let failed = false

async function check(label: string, code: string, expected: RegExp) {
  const { url, violations } = await scan(await frame(code, label.replace(/\W+/g, '-')))
  const ok = expected.test(url)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${url}`)
  if (!ok) {
    console.error(`  expected ${expected}`)
    // Naming the cause, not just the symptom. "The app did not navigate" sends
    // the next reader to the scan router, which was never the broken part.
    if (violations.some((v) => v.includes('worker-src')))
      console.error('  CAUSE: the CSP refused the decoder worker — see deploy/nginx.conf')
    failed = true
  }
  // A policy that allows the worker but trips something else is still a
  // deployment defect, and still one nobody would see from a phone.
  if (ok && violations.length > 0) {
    console.error(`  FAIL  ${label} navigated, but the page reported CSP violations:`)
    for (const v of violations) console.error(`    ${v}`)
    failed = true
  }
}

// A person's address, as printed by /receive. Must resolve and open Send.
await check('nip05 handle', HANDLE, /\/send\?to=[0-9a-f]{64}/)
// A merchant's voucher payment request. Must open Pay, carrying the request.
await check('vreq payment request', 'vreqAprobe000000000000', /\/pay\?paymentRequest=vreqA/i)

rmSync(work, { recursive: true, force: true })

process.exit(failed ? 1 : 0)
