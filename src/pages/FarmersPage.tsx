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

import { Button, Screen, PageHeader, Panel, Pass } from '../components/ui'
import { listVouchers, onWalletChanged } from '../lib/wallet'
import { toFarmers, walletTotals, type Farmer } from '../lib/farmers'
import { toFarmerPass, EMPTY_BRANDING, type MerchantBranding } from '../lib/pass'
import { merchantBranding } from '../lib/branding'
import { formatFace } from '../lib/format'

/** A child React already gave a stable key, so the deck can reuse it. */
function isKeyed(child: ReactNode): child is ReactElement & { key: string } {
  return isValidElement(child) && child.key !== null
}

/** Past this many pixels a drag is a swipe, and advances one card. */
const SWIPE_THRESHOLD = 40
/** Past this, the gesture was a swipe and the click that follows it is not a tap. */
const TAP_SLOP = 8

/**
 * A swipeable deck: one full-width card per page, one flick per card.
 *
 * Scroll-snap alone gives a *slide* — a rail you drag continuously, with the
 * neighbour peeking and a scrollbar to prove it. This is a swipe: each card
 * fills the page, there is no scrollbar, and releasing always settles on
 * exactly one card.
 *
 * CSS still does the settling (`snap-x snap-mandatory`), because a hand-rolled
 * animation would have to reimplement momentum and would fight the browser's
 * own touch scrolling. Pointer events only add what CSS cannot: dragging with a
 * mouse, and treating a short flick as a full page turn.
 */
function SwipeDeck({ children, label }: { children: ReactNode[]; label: string }) {
  const rail = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startX: number; startScroll: number; moved: number } | null>(null)
  const lastMoved = useRef(0)
  const [index, setIndex] = useState(0)

  const pageWidth = () => rail.current?.clientWidth || 1

  const goTo = (next: number) => {
    const el = rail.current
    if (!el) return
    const clamped = Math.max(0, Math.min(children.length - 1, next))
    el.scrollTo({ left: clamped * pageWidth(), behavior: 'smooth' })
    setIndex(clamped)
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
    // then suppressed and the farmer did not open.
    lastMoved.current = 0
    drag.current = { startX: e.clientX, startScroll: el.scrollLeft, moved: 0 }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = rail.current
    const d = drag.current
    if (!el || !d) return
    const dx = e.clientX - d.startX
    const wasDragging = d.moved > TAP_SLOP
    d.moved = Math.max(d.moved, Math.abs(dx))

    // Capture only once this is definitely a drag, NOT on pointerdown. Capturing
    // early retargets the click that follows to the rail, so the card's own link
    // never sees it and a plain tap silently stopped opening the farmer.
    if (!wasDragging && d.moved > TAP_SLOP) {
      el.setPointerCapture(e.pointerId)
      // Mandatory snapping fights a scrollLeft set by hand — the browser keeps
      // yanking back to the nearest snap point mid-drag. Off for the drag, on
      // for the release, which is what makes the card settle instead of drift.
      el.style.scrollSnapType = 'none'
    }
    if (d.moved > TAP_SLOP) el.scrollLeft = d.startScroll - dx
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = rail.current
    const d = drag.current
    if (!el || !d) return
    drag.current = null
    lastMoved.current = d.moved
    if (d.moved <= TAP_SLOP) return // a tap: leave it entirely alone

    el.style.scrollSnapType = ''
    const dx = e.clientX - d.startX
    const from = Math.round(d.startScroll / pageWidth())
    // A short flick still turns the page. Snapping to whichever card is nearest
    // would swallow it, since a 50px flick leaves the original card nearest.
    goTo(Math.abs(dx) > SWIPE_THRESHOLD ? from + (dx < 0 ? 1 : -1) : from)
  }

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
          // Keyed off the CHILD's key, not the index. `toFarmers` sorts by
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
                className={`block h-2 rounded-full transition-all ${
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
 * Home: what this customer holds in total, the farmers it came from, and the
 * two things they can do with it.
 */
export function FarmersPage() {
  const navigate = useNavigate()
  const [farmers, setFarmers] = useState<Farmer[] | null>(null)
  const [branding, setBranding] = useState<Record<string, MerchantBranding>>({})

  useEffect(() => {
    const load = () => listVouchers().then((rows) => setFarmers(toFarmers(rows)))
    load()
    // WalletStorage broadcasts on every write, including coupons arriving by DM
    // while this screen is open, so the list stays live without polling.
    return onWalletChanged(load)
  }, [])

  useEffect(() => {
    if (!farmers?.length) return
    let live = true
    // One request per farmer, but merchantBranding caches per pubkey for the
    // session — and this effect re-runs on every wallet write, which is often.
    // None of these reject: an unbranded farmer keeps the pass defaults.
    Promise.all(
      farmers.map((f) => merchantBranding(f.pubkey).then((b) => [f.pubkey, b] as const)),
    ).then((entries) => {
      if (live) setBranding(Object.fromEntries(entries))
    })
    return () => {
      live = false
    }
  }, [farmers])

  // One figure per currency. Adding EUR to SAT would be a confident lie, so a
  // second unit gets its own line rather than being folded into the first.
  const totals = farmers ? walletTotals(farmers) : []
  const [primary, ...rest] = totals

  return (
    <Screen>
      <PageHeader
        title="Coupon wallet"
        subtitle={
          farmers === null
            ? 'Loading…'
            : farmers.length === 0
              ? 'No coupons yet'
              : `${farmers.length} farmer${farmers.length === 1 ? '' : 's'}`
        }
      />

      <Panel className="mb-6 p-5">
        <p className="text-sm text-mono-500">Total balance</p>
        <p className="text-balance text-mono-900 dark:text-mono-50">
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

      {farmers?.length === 0 && (
        <p className="rounded-2xl bg-mono-100 p-5 text-center text-sm text-mono-500 dark:bg-mono-900">
          When a farmer sends you coupons, they show up here.
        </p>
      )}

      {/*
        The same pass the farmer and coupon screens show, one farmer per card:
        the design IS the way in, so a farmer is recognised by their card rather
        than by a truncated pubkey. Swiped through, and tapped to open.
      */}
      {farmers && farmers.length > 0 && (
        <SwipeDeck label="Farmer">
          {farmers.map((farmer) => (
            <div key={farmer.pubkey}>
              <Pass
                pass={toFarmerPass(farmer, branding[farmer.pubkey] ?? EMPTY_BRANDING)}
                to={`/farmer/${farmer.pubkey}`}
              />
              <p className="mt-2 text-center text-sm text-mono-500">
                {farmer.voucherCount} coupon{farmer.voucherCount === 1 ? '' : 's'}
              </p>
            </div>
          ))}
        </SwipeDeck>
      )}
    </Screen>
  )
}
