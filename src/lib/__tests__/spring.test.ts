import { describe, expect, it } from 'vitest'

import { atRest, project, rubberband, stepSpring, type SpringState } from '../spring'

/** Drive a spring the way the rAF loop does, at a steady 60fps. */
function settle(from: number, to: number, velocity: number, seconds = 2) {
  let state: SpringState = { value: from, velocity }
  let furthestPast = 0
  for (let t = 0; t < seconds * 60; t += 1) {
    state = stepSpring(state, 1 / 60, { to, damping: 1, response: 0.4 })
    // How far it went beyond the target, in the direction of travel.
    const past = (state.value - to) * Math.sign(to - from || 1)
    furthestPast = Math.max(furthestPast, past)
  }
  return { state, furthestPast }
}

describe('project', () => {
  it('lands a flick where its momentum was heading, not where the finger lifted', () => {
    // The exponential-decay form: (v/1000) * d / (1 - d).
    expect(project(1000)).toBeCloseTo(499, 0)
    // Twice the speed, twice the throw — and direction is carried.
    expect(project(2000)).toBeCloseTo(2 * project(1000), 6)
    expect(project(-1000)).toBeCloseTo(-project(1000), 6)
  })

  it('projects nothing when the gesture stopped before release', () => {
    expect(project(0)).toBe(0)
  })
})

describe('rubberband', () => {
  it('always gives less than it is asked for, and less the further it is pushed', () => {
    const width = 320
    expect(rubberband(0, width)).toBe(0)
    for (const overshoot of [10, 50, 200, 1000]) {
      expect(rubberband(overshoot, width)).toBeLessThan(overshoot)
    }
    // Diminishing returns: the second 50px of pull moves it less than the first.
    const first = rubberband(50, width)
    expect(rubberband(100, width) - first).toBeLessThan(first)
  })

  it('resists both directions symmetrically', () => {
    expect(rubberband(-80, 320)).toBeCloseTo(-rubberband(80, 320), 6)
  })
})

describe('stepSpring', () => {
  it('arrives, stops, and — critically damped — never overshoots', () => {
    const { state, furthestPast } = settle(0, 300, 0)
    expect(atRest(state, 300)).toBe(true)
    expect(furthestPast).toBeLessThan(1)
  })

  it('carries the release velocity, so there is no seam after the finger leaves', () => {
    const slow = stepSpring({ value: 0, velocity: 0 }, 0.1, { to: 300 })
    const flicked = stepSpring({ value: 0, velocity: 800 }, 0.1, { to: 300 })
    expect(flicked.value).toBeGreaterThan(slow.value)
  })

  it('settles even when thrown away from its target', () => {
    const { state } = settle(0, 300, -1500)
    expect(atRest(state, 300)).toBe(true)
  })

  it('survives the dt a backgrounded tab hands back', () => {
    const state = stepSpring({ value: 0, velocity: 0 }, 30, { to: 300 })
    expect(Number.isFinite(state.value)).toBe(true)
    // Clamped to one frame's worth of travel rather than teleporting.
    expect(state.value).toBeLessThan(300)
  })
})
