import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Vector3 } from 'three'
import {
  clampState,
  maxTiltForAltitude,
  ndcToPixels,
  pixelsToNdc,
  poseToState,
  projectToNdc,
  rayDirection,
  stateToPose,
  MAX_ALTITUDE,
  MIN_ALTITUDE,
  type GeoCameraState,
} from '../../../src/camera/pose'
import { DEG, enuFrame, geodeticDegToEcef } from '../../../src/geo/wgs84'

const vp = { width: 1280, height: 720, fovY: 50 }
const angleDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

const stateArb = fc.record({
  lon: fc.double({ min: -179.9, max: 179.9, noNaN: true }),
  lat: fc.double({ min: -89, max: 89, noNaN: true }),
  alt: fc.double({ min: 50, max: 4e7, noNaN: true }),
  heading: fc.double({ min: 0, max: 359.9, noNaN: true }),
  tilt: fc.double({ min: 0.1, max: 88, noNaN: true }),
})

describe('stateToPose / poseToState', () => {
  it('produces an orthonormal pose', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const p = stateToPose(s)
        expect(p.forward.length()).toBeCloseTo(1, 12)
        expect(p.up.length()).toBeCloseTo(1, 12)
        expect(Math.abs(p.forward.dot(p.up))).toBeLessThan(1e-12)
      }),
    )
  })

  it('round-trips state -> pose -> state', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const back = poseToState(stateToPose(s))
        expect(angleDiff(back.lon, s.lon)).toBeLessThan(1e-9)
        expect(Math.abs(back.lat - s.lat)).toBeLessThan(1e-9)
        expect(Math.abs(back.alt - s.alt)).toBeLessThan(1e-5 * Math.max(1, s.alt / 1e6))
        expect(Math.abs(back.tilt - s.tilt)).toBeLessThan(1e-7)
        expect(angleDiff(back.heading, s.heading)).toBeLessThan(1e-6)
      }),
      { numRuns: 2000 },
    )
  })

  it('tilt 0 looks straight down; heading orients screen-up', () => {
    const s: GeoCameraState = { lon: 10, lat: 45, alt: 1000, heading: 90, tilt: 0 }
    const p = stateToPose(s)
    const { east, up } = enuFrame(10 * DEG, 45 * DEG)
    expect(p.forward.dot(up)).toBeCloseTo(-1, 12)
    expect(p.up.dot(east)).toBeCloseTo(1, 12)
    const back = poseToState(p)
    expect(back.heading).toBeCloseTo(90, 9)
  })

  it('tilt 90 looks along the heading at the horizon', () => {
    const s: GeoCameraState = { lon: 0, lat: 0, alt: 1000, heading: 0, tilt: 90 }
    const p = stateToPose(s)
    expect(p.forward.z).toBeCloseTo(1, 12) // north at the equator = +Z
  })
})

describe('projection', () => {
  it('projectToNdc inverts rayDirection', () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (s, x, y) => {
          const pose = stateToPose(s)
          const d = rayDirection(pose, vp, x, y)
          const p = pose.position.clone().addScaledVector(d, 1234.5)
          const ndc = projectToNdc(pose, vp, p)
          expect(ndc.behind).toBe(false)
          expect(ndc.x).toBeCloseTo(x, 9)
          expect(ndc.y).toBeCloseTo(y, 9)
        },
      ),
    )
  })

  it('maps pixels <-> NDC with +y up', () => {
    expect(pixelsToNdc(vp, 0, 0)).toEqual({ x: -1, y: 1 })
    expect(ndcToPixels(vp, 1, -1)).toEqual({ px: 1280, py: 720 })
  })

  it('the nadir view centers the sub-camera point', () => {
    const s: GeoCameraState = { lon: 126.978, lat: 37.5665, alt: 15e6, heading: 0, tilt: 0 }
    const pose = stateToPose(s)
    const ndc = projectToNdc(pose, vp, geodeticDegToEcef(126.978, 37.5665, 0))
    expect(Math.abs(ndc.x)).toBeLessThan(1e-9)
    expect(Math.abs(ndc.y)).toBeLessThan(1e-9)
  })
})

describe('clampState', () => {
  it('clamps altitude, latitude, wraps longitude and heading, limits tilt by altitude', () => {
    const c = clampState({ lon: 190, lat: 95, alt: 1, heading: -10, tilt: 120 })
    expect(c.lon).toBeCloseTo(-170, 9)
    expect(c.lat).toBeLessThan(90)
    expect(c.alt).toBe(MIN_ALTITUDE)
    expect(c.heading).toBeCloseTo(350, 9)
    expect(c.tilt).toBe(maxTiltForAltitude(MIN_ALTITUDE))
    expect(clampState({ lon: 0, lat: 0, alt: 1e9, heading: 0, tilt: 0 }).alt).toBe(MAX_ALTITUDE)
  })

  it('tilt limit is monotonically non-increasing with altitude', () => {
    let prev = Infinity
    for (let e = 1; e <= 8; e += 0.05) {
      const t = maxTiltForAltitude(10 ** e)
      expect(t).toBeLessThanOrEqual(prev)
      prev = t
    }
    expect(maxTiltForAltitude(50_000)).toBe(88)
    expect(maxTiltForAltitude(2e7)).toBe(0)
  })

  it('positions are float64 ECEF at the right altitude', () => {
    const p = stateToPose({ lon: 0, lat: 0, alt: 1000, heading: 0, tilt: 0 }).position
    expect(p.distanceTo(new Vector3(6378137 + 1000, 0, 0))).toBeLessThan(1e-6)
  })
})
