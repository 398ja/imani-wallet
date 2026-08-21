import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { QrCode, ScanLine } from 'lucide-react'

import { Button, Screen, Panel, PageHeader, Pass } from '../components/ui'
import { listTransactions, listVouchers, onWalletChanged } from '../lib/wallet'
import { toMerchants, walletTotals, withPastMerchants, type Merchant } from '../lib/merchants'
import { toTransaction } from '../lib/transactions'
import { toMerchantPass, EMPTY_BRANDING, type MerchantBranding } from '../lib/pass'
import { merchantBranding } from '../lib/branding'
import {
  animateSpring,
  prefersReducedMotion,
  project,
  rubberband,
} from '../lib/spring'
import { formatFace } from '../lib/format'
import { profileHandle, profileName, type Profile } from '../lib/profile'

/** A child React already gave a stable key, so the deck can reuse it. */
function isKeyed(child: ReactNode): child is ReactElement & { key: string } {
  return isValidElement(child) && child.key !== null
}

/** Past this, the gesture was a swipe and the click that follows it is not a tap. */
const TAP_SLOP = 8
/**
 * Velocity is read over the tail of the gesture, not the whole of it. A drag
 * that wandered for a second and then stopped dead has no momentum, and
 * averaging over its whole length would invent some.
 */
const VELOCITY_WINDOW_MS = 80

interface Drag {
  startX: number
  startScroll: number
  moved: number
  samples: Array<{ x: number; t: number }>
}

/** Pointer speed in px/s at release, from the tail of the movement history. */
function releaseVelocity(samples: Drag['samples']): number {
  const last = samples[samples.length - 1]
  if (!last) return 0
  const first = samples.find((s) => last.t - s.t <= VELOCITY_WINDOW_MS) ?? samples[0]
  const elapsed = last.t - first.t
  return elapsed > 0 ? ((last.x - first.x) / elapsed) * 1000 : 0
}

/**
 * A swipeable deck: one full-width card per page, one flick per card.
 *
 * Scroll-snap alone gives a *slide* — a rail you drag continuously, with the
 * neighbour peeking and a scrollbar to prove it. This is a swipe: each card
 * fills the page, there is no scrollbar, and releasing always settles on
 * exactly one card.
 *
 * The scroll container stays, because on a touchscreen the browser already does
 * the whole job — 1:1 tracking, momentum, bounce at the ends, and a flick you
 * can grab mid-flight — with a smoothness no main-thread loop can match. Pointer
 * handling adds the same behaviour for a mouse, where the platform gives none of
 * it, and replaces the two browser behaviours that are not good enough either
 * way: the page turn was chosen by distance dragged, which ignores a fast short
 * flick entirely, and the settle was `scrollTo({behavior: 'smooth'})`, a fixed
 * animation that cannot be interrupted or re-aimed once it is running.
 */
function SwipeDeck({ children, label }: { children: ReactNode[]; label: string }) {
  const rail = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const lastMoved = useRef(0)
  /** Cancels whatever spring is running, so a new gesture can take the value over. */
  const stop = useRef<(() => void) | null>(null)
  /** Live rubber-band offset — read on interrupt so a new spring starts from it. */
  const offset = useRef(0)
  const [index, setIndex] = useState(0)

  const pageWidth = () => rail.current?.clientWidth || 1
  const maxScroll = () => Math.max(0, (children.length - 1) * pageWidth())

  const setOffset = (px: number) => {
    offset.current = px
    const el = rail.current
    if (el) el.style.transform = px ? `translateX(${px}px)` : ''
  }

  const cancelSprings = () => {
    stop.current?.()
    stop.current = null
  }

  /**
   * Settle onto a card, continuing at the speed the gesture was already moving.
   *
   * Two springs, not one: scroll position and rubber-band offset are separate
   * axes with separate velocities, and driving both off a single spring would
   * make each wait for the other.
   */
  const settle = (targetScroll: number, velocity: number) => {
    const el = rail.current
    if (!el) return
    cancelSprings()

    const to = Math.max(0, Math.min(maxScroll(), targetScroll))
    const restore = () => {
      el.scrollLeft = to
      // Mandatory snapping fights a scrollLeft set by hand — the browser keeps
      // yanking back to the nearest snap point. Off while we drive it, on once
      // we are parked exactly on a snap point anyway.
      el.style.scrollSnapType = ''
    }

    if (prefersReducedMotion()) {
      setOffset(0)
      restore()
      return
    }

    el.style.scrollSnapType = 'none'
    // Critically damped. A paging deck that overshoots shows a slice of the card
    // it is not settling on, which reads as a mistake rather than as momentum.
    const stopScroll = animateSpring({
      from: el.scrollLeft,
      to,
      velocity,
      damping: 1,
      response: 0.4,
      onFrame: (value) => {
        el.scrollLeft = value
      },
      onRest: restore,
    })
    const stopOffset = offset.current
      ? animateSpring({
          from: offset.current,
          to: 0,
          damping: 1,
          response: 0.3,
          onFrame: setOffset,
          onRest: () => setOffset(0),
        })
      : null

    stop.current = () => {
      stopScroll()
      stopOffset?.()
    }
  }

  /**
   * `velocity` is the seam. A dot tap starts from rest, but a released flick has
   * to hand its speed to the spring or the card visibly stalls at the moment the
   * finger leaves and then starts again.
   */
  const goTo = (next: number, velocity = 0) => {
    const clamped = Math.max(0, Math.min(children.length - 1, next))
    setIndex(clamped)
    settle(clamped * pageWidth(), velocity)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = rail.current
    // Mouse only. A finger already gets exactly this gesture from the browser's
    // own touch scrolling, with momentum this cannot match — and running both
    // would mean fighting it for the scroll position.
    if (!el || e.pointerType !== 'mouse') return
    // Cleared HERE, where the gesture starts, not only in the click handler. A
    // drag that ends without a click — pointercancel, or a release outside the
    // rail — used to leave this above the slop, and the next genuine tap was
    // then suppressed and the merchant did not open.
    lastMoved.current = 0
    drag.current = {
      startX: e.clientX,
      startScroll: el.scrollLeft,
      moved: 0,
      samples: [{ x: e.clientX, t: e.timeStamp }],
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = rail.current
    const d = drag.current
    if (!el || !d) return
    const wasDragging = d.moved > TAP_SLOP
    d.moved = Math.max(d.moved, Math.abs(e.clientX - d.startX))
    d.samples.push({ x: e.clientX, t: e.timeStamp })
    if (d.samples.length > 8) d.samples.shift()

    // Capture only once this is definitely a drag, NOT on pointerdown. Capturing
    // early retargets the click that follows to the rail, so the card's own link
    // never sees it and a plain tap silently stopped opening the merchant.
    if (!wasDragging && d.moved > TAP_SLOP) {
      el.setPointerCapture(e.pointerId)
      // A card still flying to its target is now under the finger. The spring
      // lets go and the drag picks up from wherever it had got to — which is why
      // both baselines are re-read here rather than kept from pointerdown: the
      // scroll has moved since, and re-baselining also swallows the slop instead
      // of jumping the card by it.
      cancelSprings()
      el.style.scrollSnapType = 'none'
      d.startX = e.clientX
      d.startScroll = el.scrollLeft
      return
    }
    if (!wasDragging) return

    const raw = d.startScroll - (e.clientX - d.startX)
    const max = maxScroll()
    const overshoot = raw < 0 ? raw : raw > max ? raw - max : 0
    el.scrollLeft = raw - overshoot
    // scrollLeft cannot go past its bounds, so the resistance has to live on a
    // transform. Negated because scroll runs opposite to the content.
    setOffset(overshoot ? -rubberband(overshoot, pageWidth()) : 0)
  }

  const endDrag = () => {
    const el = rail.current
    const d = drag.current
    if (!el || !d) return
    drag.current = null
    lastMoved.current = d.moved
    if (d.moved <= TAP_SLOP) return // a tap: leave it entirely alone

    // scrollLeft increases as the finger moves left, hence the sign flip.
    const velocity = -releaseVelocity(d.samples)
    const page = pageWidth()
    const from = Math.round(d.startScroll / page)
    // Where the flick is *going*, not where it stopped. A 30px flick and a 30px
    // drag end in the same place and mean opposite things; only the projection
    // tells them apart. Held to one card either way — this is a deck, not a rail.
    const projected = Math.round((el.scrollLeft + project(velocity)) / page)
    const target = Math.max(from - 1, Math.min(from + 1, projected))

    goTo(target, velocity)
  }

  // Nothing should outlive the screen: a spring still writing scrollLeft into a
  // detached node is a leak with no symptom until it is a lot of them.
  useEffect(() => cancelSprings, [])

  return (
    <div>
      <div
        ref={rail}
        // Cards are links, so a swipe that ends on one would otherwise navigate.
        onClickCapture={(e) => {
          if (lastMoved.current > TAP_SLOP) {
            e.preventDefault()
            e.stopPropagation()
          }
          lastMoved.current = 0
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onScroll={() => {
          if (!drag.current) setIndex(Math.round((rail.current?.scrollLeft ?? 0) / pageWidth()))
        }}
        className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto"
      >
        {children.map((child, i) => (
          // Keyed off the CHILD's key, not the index. `toMerchants` sorts by
          // balance descending and the deck re-renders on every wallet write, so
          // spending a coupon can reorder the list underneath a stationary
          // scroll position — with index keys React reuses the wrong wrapper and
          // the card under the user's finger changes identity without moving.
          <div
            key={isKeyed(child) ? child.key : i}
            className="w-full shrink-0 snap-start"
          >
            {child}
          </div>
        ))}
      </div>

      {children.length > 1 && (
        <div className="mt-1 flex justify-center">
          {children.map((_, i) => (
            // The dot stays 8px; the BUTTON is padded out to a real target. As a
            // bare h-2 w-2 it was an 8x8px control with no focus ring — under any
            // usable tap size, and unreachable by keyboard in practice.
            <button
              key={i}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`${label} ${i + 1} of ${children.length}`}
              aria-current={i === index}
              className="group rounded-full p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
            >
              <span
                className={`block h-2 rounded-full transition-[width,background-color] duration-200 ease-out motion-reduce:transition-none ${
                  i === index
                    ? 'w-5 bg-mono-900 dark:bg-mono-100'
                    : 'w-2 bg-mono-300 dark:bg-mono-700'
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Home: what this customer holds in total, the merchants it came from, and the
 * two things they can do with it.
 */
export function MerchantsPage({ profile }: { profile: Profile }) {
  const navigate = useNavigate()
  const [merchants, setMerchants] = useState<Merchant[] | null>(null)
  const [branding, setBranding] = useState<Record<string, MerchantBranding>>({})

  useEffect(() => {
    // Coupons AND history: a merchant you have spent everything with still belongs
    // on this list, because it is the only route to the record of what you spent.
    const load = async () => {
      const [rows, txs] = await Promise.all([listVouchers(), listTransactions()])
      setMerchants(withPastMerchants(toMerchants(rows), txs.map(toTransaction)))
    }
    load()
    // WalletStorage broadcasts on every write, including coupons arriving by DM
    // while this screen is open, so the list stays live without polling.
    return onWalletChanged(load)
  }, [])

  useEffect(() => {
    if (!merchants?.length) return
    let live = true
    // One request per merchant, but merchantBranding caches per pubkey for the
    // session — and this effect re-runs on every wallet write, which is often.
    // None of these reject: an unbranded merchant keeps the pass defaults.
    Promise.all(
      merchants.map((f) => merchantBranding(f.pubkey).then((b) => [f.pubkey, b] as const)),
    ).then((entries) => {
      if (live) setBranding(Object.fromEntries(entries))
    })
    return () => {
      live = false
    }
  }, [merchants])

  // One figure per currency. Adding EUR to SAT would be a confident lie, so a
  // second unit gets its own line rather than being folded into the first.
  const totals = merchants ? walletTotals(merchants) : []
  const [primary, ...rest] = totals

  return (
    <Screen>
      {/* Who you are, before what you hold — the same two lines a merchant's own
          home leads with, so the handle a customer gives out to be paid is on
          screen rather than three taps away in /profile. */}
      <PageHeader title={profileName(profile)} handle={profileHandle(profile)} />

      <Panel className="mb-6 p-5">
        <p className="text-sm text-mono-500">Total balance</p>
        <p className="text-amount text-mono-900 dark:text-mono-50">
          {primary ? formatFace(primary.minor, primary) : formatFace(0, undefined)}
        </p>
        {rest.map((total) => (
          <p key={total.unit} className="text-sm text-mono-500">
            + {formatFace(total.minor, total)}
          </p>
        ))}
      </Panel>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <Button size="lg" onClick={() => navigate('/scan')}>
          <ScanLine className="mr-2 h-5 w-5" /> Pay
        </Button>
        <Button size="lg" variant="outline" onClick={() => navigate('/receive')}>
          <QrCode className="mr-2 h-5 w-5" /> Receive
        </Button>
      </div>

      {merchants?.length === 0 && (
        <p className="rounded-2xl bg-mono-100 p-5 text-center text-sm text-mono-500 dark:bg-mono-900">
          When a merchant sends you vouchers, they show up here.
        </p>
      )}

      {/*
        The same pass the merchant and coupon screens show, one merchant per card:
        the design IS the way in, so a merchant is recognised by their card rather
        than by a truncated pubkey. Swiped through, and tapped to open.
      */}
      {merchants && merchants.length > 0 && (
        <SwipeDeck label="Merchant">
          {merchants.map((merchant) => (
            <div key={merchant.pubkey}>
              <Pass
                pass={toMerchantPass(merchant, branding[merchant.pubkey] ?? EMPTY_BRANDING)}
                to={`/merchants/${merchant.pubkey}`}
              />
              <p className="mt-2 text-center text-sm text-mono-500">
                {merchant.voucherCount} voucher{merchant.voucherCount === 1 ? '' : 's'}
              </p>
            </div>
          ))}
        </SwipeDeck>
      )}
    </Screen>
  )
}
