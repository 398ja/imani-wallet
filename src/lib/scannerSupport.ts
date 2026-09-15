/**
 * Can this page decode a QR code at all?
 *
 * `qr-scanner` decodes in a Web Worker it builds from a Blob URL. If the page's
 * Content-Security-Policy does not allow `worker-src blob:`, the browser
 * refuses that worker and the library reports nothing: the camera opens, the
 * preview runs, the scan region even outlines the code, and no result is ever
 * produced. That is exactly how this shipped — every scan on staging silently
 * did nothing, because the only trace was a console line on a phone.
 *
 * `deploy/nginx.conf` is fixed and `deploy/__tests__/csp.test.ts` holds it
 * there, so this is not the fix. It is the part that stops the NEXT
 * misconfigured deployment from being invisible: a wallet behind someone else's
 * proxy, a hardened edge, an embedded WebView with its own policy. A dead
 * camera with a reason on it costs one line of text; a dead camera without one
 * costs a merchant at a stall, scanning, wondering which of them is broken.
 *
 * ## Why this is async, and why it round-trips a message
 *
 * The obvious probe — construct a Worker and see if it throws — DOES NOT WORK,
 * and was written that way first. Chromium blocks the worker but the
 * constructor returns normally; the refusal arrives later as an `error` event.
 * Probed against the real deployment with the header rewritten to the broken
 * value, `new Worker(blobUrl)` reported success on the exact policy that breaks
 * scanning. So the probe waits for the worker to answer: a worker that cannot
 * run cannot reply, which is true regardless of how a given engine signals it.
 */

/** How long a worker gets to say hello before it is presumed blocked. */
const REPLY_TIMEOUT_MS = 2000

let cached: Promise<string | null> | undefined

/**
 * `null` when scanning can work, or a sentence to show the user when it cannot.
 *
 * The PROMISE is cached, not just the answer: the result is a property of the
 * document's policy, which cannot change without a navigation, and both
 * scanning screens ask on mount. Caching the promise also means two mounts in
 * the same tick share one worker rather than racing two.
 */
export function scannerBlocked(): Promise<string | null> {
  cached ??= probe()
  return cached
}

const BLOCKED_MESSAGE =
  'This page is not allowed to run the QR decoder, so the camera cannot read codes. ' +
  'Paste the code instead, and tell whoever deployed this app that its ' +
  'Content-Security-Policy needs worker-src blob:.'

async function probe(): Promise<string | null> {
  // No Worker or Blob at all is not this bug and not something a user can act
  // on. Let the library fail in its own words rather than blame a policy.
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return null

  let url: string | undefined
  let worker: Worker | undefined
  try {
    url = URL.createObjectURL(
      new Blob(['self.onmessage=()=>{self.postMessage(1);self.close()}'], {
        type: 'text/javascript',
      }),
    )
    worker = new Worker(url)
  } catch {
    // Firefox and Safari do refuse at construction. Same conclusion.
    return BLOCKED_MESSAGE
  }

  const live = worker
  try {
    return await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(BLOCKED_MESSAGE), REPLY_TIMEOUT_MS)
      const settle = (value: string | null) => {
        clearTimeout(timer)
        resolve(value)
      }
      live.onmessage = () => settle(null)
      live.onerror = () => settle(BLOCKED_MESSAGE)
      live.postMessage(1)
    })
  } finally {
    // Unconditional: the worker self-closes on the happy path, but a timeout
    // means it may yet be alive, and this runs on a screen mounted often.
    live.terminate()
    if (url) URL.revokeObjectURL(url)
  }
}

/** Testing seam. The probe caches, and a test needs to ask more than once. */
export function resetScannerSupportCache(): void {
  cached = undefined
}
