/**
 * Does the terminal setup QR decode? Rendered exactly as the owner's screen renders it, decoded by
 * qr-scanner (the app's own decoder), from a fake webcam feed in real Chromium (#160 owner report).
 *
 * The owner's report ("not an accepted QR code type") could have been an unreadable QR. This
 * proves it is not: the QR the app draws (qrcode `toDataURL`, 512 px, margin 1) decodes to the
 * exact setup code, at a phone-like scale (the QR shown 240 px wide inside a 640x480 frame, and
 * again at 160 px), and also through qr-scanner's still-image API. Static density figures are
 * printed: version, modules, error correction level, pixels per module.
 *
 * No server: the page is a blank document with qr-scanner loaded from node_modules.
 *
 *   npx tsx e2e/probe-setup-qr.mts
 *
 * Needs ffmpeg for the fake camera feed.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

import { chromium } from 'playwright'
import QRCode from 'qrcode'

import { setupCode, parseSetupCode } from '../src/lib/terminalDelivery'

const STALL = '7952939535a79edc46d86e103785cee6f8119e8533787de8352257b051548448'
const VOUCHER = '5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9'
const CODE = setupCode(STALL, VOUCHER)
const work = mkdtempSync(join(tmpdir(), 'setup-qr-'))
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

// The app's exact render (TerminalEnrolPage, TerminalsPage): toDataURL, width 512, margin 1.
const dataUrl = await QRCode.toDataURL(CODE, { width: 512, margin: 1 })
const png = join(work, 'setup.png')
writeFileSync(png, Buffer.from(dataUrl.split(',')[1], 'base64'))
const qr = QRCode.create(CODE, {})
const modules = qr.modules.size
console.log(`setup code: ${CODE} (${CODE.length} chars)`)
console.log(`QR version ${qr.version}, ${modules}x${modules} modules, ECC ${['M', 'L', 'H', 'Q'][qr.errorCorrectionLevel.bit]}, ` +
  `${(512 / (modules + 2)).toFixed(1)} px/module at 512 px`)
check('the setup QR is a modest version (<= 10), not overly dense', qr.version <= 10, `version ${qr.version}`)

// A control: a short code the scanner surely reads. If it fails too, the harness is broken, not
// the setup QR.
const CONTROL = 'imani-control'
const controlPng = join(work, 'control.png')
writeFileSync(controlPng, Buffer.from((await QRCode.toDataURL(CONTROL, { width: 512, margin: 1 })).split(',')[1], 'base64'))

function feed(size: number): string {
  const y4m = join(work, `feed-${size}.y4m`)
  const pad = `pad=640:480:${(640 - size) / 2}:${(480 - size) / 2}:white`
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', png, '-t', '6', '-r', '25',
    '-vf', `scale=${size}:${size},${pad},format=yuv420p`, y4m])
  return y4m
}

// qr-scanner, served the way the app loads it (an ES module that builds its worker from a Blob).
const lib = readFileSync(new URL('../node_modules/qr-scanner/qr-scanner.min.js', import.meta.url))
const worker = readFileSync(new URL('../node_modules/qr-scanner/qr-scanner-worker.min.js', import.meta.url))
const server = createServer((req, res) => {
  if (req.url === '/qr-scanner.min.js' || req.url === '/qr-scanner-worker.min.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    return res.end(req.url === '/qr-scanner.min.js' ? lib : worker)
  }
  if (req.url === '/setup.png' || req.url === '/control.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    return res.end(readFileSync(req.url === '/setup.png' ? png : controlPng))
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><video id="v" playsinline muted></video>')
}).listen(0)
const base = `http://localhost:${(server.address() as { port: number }).port}`

async function camera(size: number): Promise<string | null> {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${feed(size)}`],
  })
  try {
    const page = await (await browser.newContext({ permissions: ['camera'] })).newPage()
    await page.goto(base)
    return await page.evaluate(async () => {
      const { default: QrScanner } = await import('/qr-scanner.min.js' as string)
      const video = document.getElementById('v') as HTMLVideoElement
      return await new Promise<string | null>((resolve) => {
        const scanner = new QrScanner(video, (r: { data: string }) => { scanner.destroy(); resolve(r.data) }, {})
        scanner.start().catch(() => resolve(null))
        setTimeout(() => { scanner.destroy(); resolve(null) }, 8000)
      })
    })
  } finally {
    await browser.close()
  }
}

async function still(path = '/setup.png'): Promise<string | null> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(base)
    return await page.evaluate(async (p) => {
      const { default: QrScanner } = await import('/qr-scanner.min.js' as string)
      return (await QrScanner.scanImage(p, { returnDetailedScanResult: true })).data as string
    }, path).catch((e) => (console.log('    scanImage threw:', String(e).slice(0, 200)), null))
  } finally {
    await browser.close()
  }
}

try {
  check('control: qr-scanner reads a short QR (the harness works)', (await still('/control.png')) === CONTROL)
  const fromImage = await still()
  check('qr-scanner.scanImage decodes the 512 px setup QR to the exact code', fromImage === CODE, String(fromImage))
  for (const size of [240, 160]) {
    const read = await camera(size)
    check(`the fake camera (QR ${size} px in a 640x480 frame) decodes the exact code`, read === CODE, String(read))
    check(`what the camera read parses as a setup code (${size} px)`, parseSetupCode(read ?? '')?.voucherId === VOUCHER)
  }
} finally {
  server.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(failures.length === 0 ? '\nAll checks passed.\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
