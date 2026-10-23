import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial'
import { Vector3 } from 'three'
import {
  clipPlanes,
  horizonDistance,
  intersectOcean,
  intersectOceanNaive,
  toShading,
  WGS84_A,
  WGS84_B,
  type Vec3,
} from '../../src/scene/oceanMath'

const ecef = (lon: number, lat: number, h: number): Vec3 => new Geodetic(radians(lon), radians(lat), h).toECEF().toArray() as Vec3
const down = (lon: number, lat: number): Vec3 =>
  Ellipsoid.WGS84.getSurfaceNormal(new Vector3(...ecef(lon, lat, 0)), new Vector3()).negate().toArray() as Vec3
const along = (o: Vec3, d: Vec3, t: number): Vec3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]

describe('ocean surface intersection', () => {
  it('uses the same ellipsoid as takram (WGS84)', () => {
    expect(WGS84_A).toBe(Ellipsoid.WGS84.radii.x)
    expect(WGS84_B).toBeCloseTo(Ellipsoid.WGS84.radii.z, 6)
  })

  for (const h of [1, 300, 10_000, 400_000, 36_000_000]) {
    it(`straight down from ${h} m returns the altitude (equator, 45°, pole)`, () => {
      for (const lat of [0, 45, 89.9]) {
        const o = ecef(30, lat, h)
        const t = intersectOcean(o, down(30, lat))!
        expect(Math.abs(t - h)).toBeLessThan(1e-6 * Math.max(1, h))
        const t32 = intersectOcean(o, down(30, lat), undefined, true)!
        expect(Math.abs(t32 - h)).toBeLessThan(Math.max(0.05, h * 2e-6))
      }
    })
  }

  it('the CPU c-term keeps float32 to sub-millimeter; the textbook form errs by decimeters', () => {
    let stableMax = 0
    let naiveMax = 0
    for (const h of [1, 10, 50, 300, 1000]) {
      for (const lat of [0, 35, 60]) {
        const o = ecef(30, lat, h)
        const d0 = new Vector3(...down(30, lat))
        const e = new Vector3(0, 0, 1).cross(d0).normalize()
        for (const slant of [0, 0.5, 0.95]) {
          const d = d0.clone().multiplyScalar(Math.cos(slant)).add(e.clone().multiplyScalar(Math.sin(slant))).normalize().toArray() as Vec3
          const ref = intersectOcean(o, d)!
          stableMax = Math.max(stableMax, Math.abs(intersectOcean(o, d, undefined, true)! - ref))
          const naive = intersectOceanNaive(o, d, true)
          naiveMax = Math.max(naiveMax, naive === null ? Infinity : Math.abs(naive - ref))
        }
      }
    }
    expect(stableMax).toBeLessThan(1e-3)
    expect(naiveMax).toBeGreaterThan(0.1)
    expect(naiveMax / stableMax).toBeGreaterThan(100)
  })

  it('hit points lie on the ellipsoid', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: -89, max: 89, noNaN: true }),
        fc.double({ min: 10, max: 1e6, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (lon, lat, h, a, b) => {
          const o = ecef(lon, lat, h)
          const d0 = down(lon, lat)
          const d = new Vector3(d0[0] + a * 0.7, d0[1] + b * 0.7, d0[2] + (a - b) * 0.35).normalize().toArray() as Vec3
          const t = intersectOcean(o, d)
          if (t === null) return
          const p = toShading(along(o, d, t))
          expect(Math.abs(Math.hypot(...p) - WGS84_A)).toBeLessThan(1e-6)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('rays just below the horizon hit near the horizon distance; just above miss', () => {
    const h = 300
    const o = ecef(0, 0, h)
    const up = new Vector3(1, 0, 0)
    const east = new Vector3(0, 1, 0)
    const dip = Math.acos(WGS84_A / (WGS84_A + h)) // geometric dip of the horizon
    const dir = (e: number) => east.clone().multiplyScalar(Math.cos(e)).add(up.clone().multiplyScalar(Math.sin(e))).toArray() as Vec3
    const below = intersectOcean(o, dir(-dip - 1e-4))!
    expect(Math.abs(below - horizonDistance(h)) / horizonDistance(h)).toBeLessThan(0.2)
    expect(intersectOcean(o, dir(-dip + 1e-4))).toBeNull()
  })

  it('keeps the story’s near/far (1 / 4e5) at its altitudes and grows far to cover the horizon above', () => {
    expect(clipPlanes(300)).toEqual({ near: 1, far: 4e5 })
    expect(clipPlanes(1300)).toEqual({ near: 1, far: 4e5 })
    let prev = 0
    for (const h of [1e4, 3e4, 1e5, 1e6, 1e7]) {
      const { near, far } = clipPlanes(h)
      expect(far).toBeGreaterThanOrEqual(1.2 * horizonDistance(h) - 1e-6)
      expect(far).toBeGreaterThanOrEqual(prev)
      expect(near).toBeLessThan(h)
      prev = far
    }
  })
})
