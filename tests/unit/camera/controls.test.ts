import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Vector3 } from 'three'
import {
  interpolatePose,
  levelPose,
  orbitPose,
  panPose,
  pickAt,
  poseAltitude,
  zoomPose,
} from '../../../src/camera/controlsMath'
import {
  maxTiltForAltitude,
  poseRoll,
  poseToState,
  projectToNdc,
  stateToPose,
  MIN_ALTITUDE,
  type CameraPose,
  type GeoCameraState,
} from '../../../src/camera/pose'
import { ecefToGeodetic } from '../../../src/geo/wgs84'

const vp = { width: 1280, height: 720, fovY: 50 }
const angleDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

function pixelError(pose: CameraPose, point: Vector3, x: number, y: number): number {
  const ndc = projectToNdc(pose, vp, point)
  return Math.hypot(((ndc.x - x) * vp.width) / 2, ((ndc.y - y) * vp.height) / 2)
}

const pose = (s: GeoCameraState) => stateToPose(s)

describe('grab-pan', () => {
  it('keeps the grabbed point under the cursor (< 0.5 px) for nadir views at any altitude', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -170, max: 170, noNaN: true }),
        fc.double({ min: -70, max: 70, noNaN: true }),
        fc.double({ min: 200, max: 3e7, noNaN: true }),
        fc.double({ min: -0.3, max: 0.3, noNaN: true }),
        fc.double({ min: -0.3, max: 0.3, noNaN: true }),
        fc.double({ min: -0.15, max: 0.15, noNaN: true }),
        fc.double({ min: -0.15, max: 0.15, noNaN: true }),
        (lon, lat, alt, x0, y0, dx, dy) => {
          const p = pose({ lon, lat, alt, heading: 0, tilt: 0 })
          const grab = pickAt(p, vp, x0, y0)
          // Exactness is only defined while the cursor stays on the globe.
          if (grab === null || pickAt(p, vp, x0 + dx, y0 + dy) === null) return
          const next = panPose(p, vp, grab, x0 + dx, y0 + dy)
          expect(pixelError(next, grab, x0 + dx, y0 + dy)).toBeLessThan(0.5)
          expect(poseAltitude(next)).toBeCloseTo(alt, 4)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('tracks the cursor over a multi-step drag in a tilted low-altitude view (< 0.5 px)', () => {
    let p = pose({ lon: 127, lat: 37.5, alt: 3000, heading: 30, tilt: 60 })
    const grab = pickAt(p, vp, 0.1, -0.4)!
    for (let i = 1; i <= 20; ++i) p = panPose(p, vp, grab, 0.1 + i * 0.01, -0.4 + i * 0.005)
    expect(pixelError(p, grab, 0.3, -0.3)).toBeLessThan(0.5)
  })

  it('moves the camera opposite to the drag (dragging east shows terrain further west)', () => {
    const p = pose({ lon: 0, lat: 0, alt: 1e6, heading: 0, tilt: 0 })
    const next = panPose(p, vp, pickAt(p, vp, 0, 0)!, 0.2, 0)
    expect(poseToState(next).lon).toBeLessThan(0)
  })

  it('keeps rotating when the cursor leaves the globe', () => {
    const p = pose({ lon: 0, lat: 0, alt: 3e7, heading: 0, tilt: 0 })
    const next = panPose(p, vp, pickAt(p, vp, 0.1, 0)!, 0.95, 0.9)
    const s = poseToState(next)
    expect(Number.isFinite(s.lon)).toBe(true)
    expect(Math.abs(s.lon)).toBeGreaterThan(1)
  })
})

describe('zoom to cursor', () => {
  it('keeps the point under the cursor fixed (< 0.01 px; the pose is canonical)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1000, max: 2e7, noNaN: true }),
        fc.double({ min: -0.4, max: 0.4, noNaN: true }),
        fc.double({ min: -0.4, max: 0.4, noNaN: true }),
        fc.double({ min: 0.5, max: 1.5, noNaN: true }),
        (alt, x, y, factor) => {
          const p = pose({ lon: 20, lat: 10, alt, heading: 0, tilt: 0 })
          const target = pickAt(p, vp, x, y)
          if (target === null) return
          const next = zoomPose(p, vp, x, y, factor)
          expect(pixelError(next, target, x, y)).toBeLessThan(0.01)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('off-center zoom on a nadir view keeps the displayed heading continuous (no 90° flips)', () => {
    let p = pose({ lon: 20, lat: 10, alt: 16_695, heading: 0, tilt: 0 })
    for (let i = 0; i < 10; ++i) {
      p = zoomPose(p, vp, -0.4, 0, 0.7)
      const s = poseToState(p)
      expect(angleDiff(s.heading, 0)).toBeLessThan(1)
      expect(s.tilt).toBeLessThan(2)
    }
  })

  it('altitude decreases monotonically when zooming in and stops at the minimum', () => {
    let p = pose({ lon: 0, lat: 0, alt: 1e7, heading: 0, tilt: 0 })
    let prev = poseAltitude(p)
    for (let i = 0; i < 200; ++i) {
      p = zoomPose(p, vp, 0, 0, 0.8)
      const h = poseAltitude(p)
      expect(h).toBeLessThanOrEqual(prev + 1e-6)
      prev = h
    }
    expect(prev).toBeGreaterThanOrEqual(MIN_ALTITUDE - 1e-3)
    expect(prev).toBeLessThan(MIN_ALTITUDE + 1)
  })

  it('zooms radially when the cursor misses the globe', () => {
    const p = pose({ lon: 0, lat: 0, alt: 3e7, heading: 0, tilt: 0 })
    expect(poseAltitude(zoomPose(p, vp, 0.99, 0.99, 0.5))).toBeCloseTo(1.5e7, 0)
  })
})

describe('orbit (tilt / heading)', () => {
  it('heading orbit keeps the center pivot fixed on screen', () => {
    const p = pose({ lon: 127, lat: 37.5, alt: 5000, heading: 0, tilt: 45 })
    const pivot = pickAt(p, vp, 0, 0)!
    const next = orbitPose(p, vp, 30, 0)
    expect(poseToState(next).heading).toBeCloseTo(30, 1)
    expect(pixelError(next, pivot, 0, 0)).toBeLessThan(0.5)
    expect(Math.abs(ecefToGeodetic(pivot)!.height)).toBeLessThan(1e-3)
  })

  it('tilt orbit increases tilt within the altitude-dependent limit', () => {
    let p = pose({ lon: 0, lat: 45, alt: 2000, heading: 0, tilt: 0 })
    for (let i = 0; i < 100; ++i) p = orbitPose(p, vp, 0, 2)
    const s = poseToState(p)
    expect(s.tilt).toBeGreaterThan(60)
    expect(s.tilt).toBeLessThanOrEqual(maxTiltForAltitude(s.alt) + 1)
    expect(s.alt).toBeGreaterThan(MIN_ALTITUDE)
  })

  it('tilting back returns to a nadir view', () => {
    let p = pose({ lon: 0, lat: 45, alt: 2000, heading: 0, tilt: 40 })
    for (let i = 0; i < 40; ++i) p = orbitPose(p, vp, 0, -2)
    expect(poseToState(p).tilt).toBeLessThan(1)
  })

  it('orbit output is roll-free', () => {
    let p = pose({ lon: 10, lat: 50, alt: 4000, heading: 10, tilt: 50 })
    for (let i = 0; i < 5; ++i) p = zoomPose(p, vp, 0.5, 0.3, 0.6) // introduces roll
    const leveled = orbitPose(p, vp, 1, 0)
    expect(Math.abs(poseRoll(leveled))).toBeLessThan(1e-4)
  })
})

describe('pose utilities', () => {
  it('levelPose keeps forward and removes roll', () => {
    let p = pose({ lon: 0, lat: 0, alt: 3000, heading: 0, tilt: 70 })
    p = zoomPose(p, vp, 0.6, -0.2, 0.5)
    const l = levelPose(p)
    expect(l.forward.distanceTo(p.forward)).toBe(0)
    expect(Math.abs(poseRoll(l))).toBeLessThan(1e-4)
  })

  it('interpolatePose hits both endpoints', () => {
    const a = pose({ lon: 170, lat: 10, alt: 1e7, heading: 350, tilt: 0 })
    const b = pose({ lon: -170, lat: 20, alt: 1e4, heading: 10, tilt: 30 })
    expect(interpolatePose(a, b, 0).position.distanceTo(a.position)).toBeLessThan(1e-3)
    expect(interpolatePose(a, b, 1).position.distanceTo(b.position)).toBeLessThan(1e-3)
    // Takes the short way across the date line.
    expect(Math.abs(poseToState(interpolatePose(a, b, 0.5)).lon)).toBeGreaterThan(170)
  })
})
