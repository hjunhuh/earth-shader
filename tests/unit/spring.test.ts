import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Spring, SPRING } from '../../src/app/spring'

/** Reference: integrate m·x'' = −k(x − target) − c·x' with RK4 in tiny steps. */
function integrate(x0: number, v0: number, target: number, t: number): number {
  const { mass: m, stiffness: k, damping: c } = SPRING
  const f = (x: number, v: number) => (-k * (x - target) - c * v) / m
  let x = x0
  let v = v0
  const n = 20000
  const h = t / n
  for (let i = 0; i < n; ++i) {
    const k1x = v
    const k1v = f(x, v)
    const k2x = v + (h / 2) * k1v
    const k2v = f(x + (h / 2) * k1x, v + (h / 2) * k1v)
    const k3x = v + (h / 2) * k2v
    const k3v = f(x + (h / 2) * k2x, v + (h / 2) * k2v)
    const k4x = v + h * k3v
    const k4v = f(x + h * k3x, v + h * k3v)
    x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x)
    v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v)
  }
  return x
}

describe('spring (motion useSpring with takram springOptions)', () => {
  it('uses { mass: 1, damping: 20 } and stiffness 100, i.e. critically damped', () => {
    expect(SPRING).toEqual({ mass: 1, stiffness: 100, damping: 20 })
    expect(SPRING.damping / (2 * Math.sqrt(SPRING.stiffness * SPRING.mass))).toBe(1)
  })

  it('matches the ODE solution frame by frame', () => {
    const s = new Spring(8)
    s.set(18)
    let t = 0
    for (let i = 0; i < 30; ++i) {
      s.step(1 / 60)
      t += 1 / 60
      expect(s.value).toBeCloseTo(integrate(8, 0, 18, t), 6)
    }
  })

  it('never overshoots and settles within a second', () => {
    fc.assert(
      fc.property(fc.double({ min: -100, max: 100, noNaN: true }), fc.double({ min: -100, max: 100, noNaN: true }), (a, b) => {
        const s = new Spring(a)
        s.set(b)
        let prev = Math.abs(a - b)
        for (let i = 0; i < 60; ++i) {
          s.step(1 / 60)
          const d = Math.abs(s.value - b)
          expect(d).toBeLessThanOrEqual(prev + 1e-12)
          expect(Math.sign(s.value - b) * Math.sign(a - b)).toBeGreaterThanOrEqual(0)
          prev = d
        }
        expect(Math.abs(s.value - b)).toBeLessThan(Math.max(1e-3, Math.abs(a - b) * 1e-3))
      }),
    )
  })

  it('snap jumps without animation', () => {
    const s = new Spring(1)
    s.snap(5)
    expect(s.value).toBe(5)
    expect(s.step(1 / 60)).toBe(5)
  })
})
