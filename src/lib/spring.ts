/**
 * The physics a gesture needs once the finger has left the screen.
 *
 * A fixed-duration animation cannot answer new input: it knows only where it
 * started and how long it has left, so a card grabbed mid-flight has to finish
 * its trip before it can respond. A spring has no duration — it has a target,
 * and re-aiming it mid-motion is just a new target with the current position and
 * velocity carried through. That is what makes it grabbable.
 *
 * Parameterised the way Apple's design tools are (damping ratio + response)
 * rather than as mass/stiffness/damping, because those are the two knobs that
 * describe how it *feels*: how much it overshoots, and how quickly it arrives.
 */

/**
 * Where a flick would come to rest if nothing stopped it.
 *
 * This is the projection scroll deceleration uses, and it is why a short fast
 * flick turns a page that a longer slow drag does not: the target is chosen from
 * the trajectory, not from the point the finger happened to lift.
 *
 * Exponential decay, NOT the textbook `v² / 2a` — that curve decelerates too
 * hard early and lands short of where a thrown thing visibly wants to go.
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)
}

/**
 * Progressive resistance past a boundary.
 *
 * A hard stop at the edge reads as frozen — the user cannot tell a limit from a
 * hung interface. Resistance that grows with the overshoot says "responsive, but
 * there is nothing more here" while the finger is still down.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

export interface SpringState {
  value: number
  velocity: number
}

export interface SpringOptions {
  to: number
  /** 1 = critically damped, no overshoot. Below 1 bounces; the lower, the more. */
  damping?: number
  /** Roughly how long it takes to arrive, in seconds. Not a duration — see above. */
  response?: number
}

/** Below both of these the motion is finished as far as an eye is concerned. */
const REST_DISTANCE = 0.5
const REST_VELOCITY = 0.5
/**
 * Integration step, well under a frame. Integrating a whole frame at once is
 * unstable for a snappy response, and the error shows up as a spring that
 * overshoots when it was asked not to.
 */
const STEP_SECONDS = 1 / 240
/** A backgrounded tab hands back a dt of seconds; that would teleport the value. */
const MAX_FRAME_SECONDS = 0.064

/** Advance a spring by `seconds`. Pure — the animation loop is the impure part. */
export function stepSpring(
  state: SpringState,
  seconds: number,
  { to, damping = 1, response = 0.4 }: SpringOptions,
): SpringState {
  const frequency = (2 * Math.PI) / response
  let { value, velocity } = state
  let remaining = Math.min(seconds, MAX_FRAME_SECONDS)

  while (remaining > 0) {
    const dt = Math.min(STEP_SECONDS, remaining)
    remaining -= dt
    const displacement = value - to
    velocity += (-frequency * frequency * displacement - 2 * damping * frequency * velocity) * dt
    value += velocity * dt
  }

  return { value, velocity }
}

export function atRest(state: SpringState, to: number): boolean {
  return Math.abs(state.value - to) < REST_DISTANCE && Math.abs(state.velocity) < REST_VELOCITY
}

/**
 * Run a spring against the display clock. Returns a cancel function.
 *
 * `velocity` is the seam between a gesture and its animation: hand it the speed
 * the finger was moving at release and there is no visible transition between
 * dragging and animating — the card simply keeps going.
 */
export function animateSpring({
  from,
  velocity = 0,
  onFrame,
  onRest,
  ...options
}: SpringOptions & {
  from: number
  velocity?: number
  onFrame: (value: number) => void
  onRest?: () => void
}): () => void {
  let state: SpringState = { value: from, velocity }
  let last = performance.now()

  let frame = requestAnimationFrame(function tick(now) {
    state = stepSpring(state, (now - last) / 1000, options)
    last = now

    if (atRest(state, options.to)) {
      onFrame(options.to)
      onRest?.()
      return
    }

    onFrame(state.value)
    frame = requestAnimationFrame(tick)
  })

  return () => cancelAnimationFrame(frame)
}

/**
 * Reduced motion is not "no feedback" — it is feedback without the travel. The
 * callers here answer it by moving the value instantly rather than springing it.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
