import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Vector3 } from 'three'
import {
  DEG,
  WGS84_A,
  WGS84_B,
  ecefToGeodetic,
  enuFrame,
  geodeticDegToEcef,
  geodeticNormal,
  geodeticToEcef,
  projectOnEllipsoid,
  surfaceNormalAt,
  wrapLongitudeDeg,
} from '../../../src/geo/wgs84'
import { vermeilleEcefToGeodetic } from '../../reference/vermeille'

describe('WGS84 constants', () => {
  it('matches the defining parameters', () => {
    expect(WGS84_A).toBe(6378137)
    expect(WGS84_B).toBeCloseTo(6356752.314245, 6)
  })
})

describe('geodeticToEcef', () => {
  it('maps reference points exactly', () => {
    const eq = geodeticToEcef(0, 0, 0)
    expect(eq.x).toBeCloseTo(WGS84_A, 9)
    expect(eq.y).toBeCloseTo(0, 9)
    expect(eq.z).toBeCloseTo(0, 9)
    const np = geodeticToEcef(0, Math.PI / 2, 0)
    expect(np.x).toBeCloseTo(0, 6)
    expect(np.z).toBeCloseTo(WGS84_B, 6)
    const e90 = geodeticToEcef(Math.PI / 2, 0, 1000)
    expect(e90.y).toBeCloseTo(WGS84_A + 1000, 9)
    const sp = geodeticToEcef(0, -Math.PI / 2, -10_000)
    expect(sp.z).toBeCloseTo(-(WGS84_B - 10_000), 6)
  })

  it('agrees with the textbook N(φ) formula', () => {
    const e2 = 1 - (WGS84_B / WGS84_A) ** 2
    for (const [lon, lat, h] of [
      [126.978, 37.5665, 38],
      [151.2093, -33.8688, 58],
      [-105.1786, 39.742476, 1830.14],
      [0, -89.99, 2835],
      [-180, 10, -10_000],
    ] as const) {
      const phi = lat * DEG
      const lam = lon * DEG
      const N = WGS84_A / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
      const expected = new Vector3(
        (N + h) * Math.cos(phi) * Math.cos(lam),
        (N + h) * Math.cos(phi) * Math.sin(lam),
        (N * (1 - e2) + h) * Math.sin(phi),
      )
      expect(geodeticDegToEcef(lon, lat, h).distanceTo(expected)).toBeLessThan(1e-6)
    }
  })
})

describe('ecefToGeodetic', () => {
  it('round-trips random points to < 1e-6 m and agrees with Vermeille 2011', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: -89.999, max: 89.999, noNaN: true }),
        fc.double({ min: -10_000, max: 40_000_000, noNaN: true }),
        (lonDeg, latDeg, h) => {
          const p = geodeticDegToEcef(lonDeg, latDeg, h)
          const g = ecefToGeodetic(p)!
          const back = geodeticToEcef(g.lon, g.lat, g.height)
          expect(back.distanceTo(p)).toBeLessThan(1e-6 * Math.max(1, h / 1e6))
          const v = vermeilleEcefToGeodetic(p.x, p.y, p.z)
          expect(Math.abs(v.lat - g.lat)).toBeLessThan(1e-10)
          expect(Math.abs(v.height - g.height)).toBeLessThan(1e-4 * Math.max(1, h / 1e6))
        },
      ),
      { numRuns: 10_000 },
    )
  })

  it('returns undefined near the planet center', () => {
    expect(ecefToGeodetic(new Vector3(0, 0, 0))).toBeUndefined()
    expect(ecefToGeodetic(new Vector3(1, 2, 3))).toBeUndefined()
  })

  it('reports negative heights below the surface', () => {
    const g = ecefToGeodetic(geodeticDegToEcef(20, 45, -5000))!
    expect(g.height).toBeCloseTo(-5000, 6)
  })

  it('projects onto the surface along the normal', () => {
    const p = geodeticDegToEcef(33, -60, 123_456)
    const s = projectOnEllipsoid(p)!
    const residual = (s.x * s.x + s.y * s.y) / WGS84_A ** 2 + (s.z * s.z) / WGS84_B ** 2 - 1
    expect(Math.abs(residual)).toBeLessThan(1e-12)
    const n = surfaceNormalAt(s)
    const d = p.clone().sub(s).normalize()
    expect(d.dot(n)).toBeCloseTo(1, 12)
  })
})

describe('ENU frame', () => {
  it('is orthonormal and right-handed with up = geodetic normal', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        (lon, lat) => {
          const { east, north, up } = enuFrame(lon, lat)
          expect(east.length()).toBeCloseTo(1, 12)
          expect(north.length()).toBeCloseTo(1, 12)
          expect(east.dot(north)).toBeCloseTo(0, 12)
          expect(east.dot(up)).toBeCloseTo(0, 12)
          expect(new Vector3().crossVectors(east, north).dot(up)).toBeCloseTo(1, 12)
          expect(up.distanceTo(geodeticNormal(lon, lat))).toBeLessThan(1e-14)
          // north points toward +Z hemisphere
          expect(north.z).toBeGreaterThan(0)
        },
      ),
    )
  })

  it('normal equals the gradient direction at the surface point', () => {
    const lon = 1.1
    const lat = -0.7
    const p = geodeticToEcef(lon, lat, 0)
    expect(surfaceNormalAt(p).distanceTo(geodeticNormal(lon, lat))).toBeLessThan(1e-12)
  })
})

describe('wrapLongitudeDeg', () => {
  it('wraps into [-180, 180)', () => {
    expect(wrapLongitudeDeg(180)).toBe(-180)
    expect(wrapLongitudeDeg(-180)).toBe(-180)
    expect(wrapLongitudeDeg(190)).toBeCloseTo(-170, 12)
    expect(wrapLongitudeDeg(-190)).toBeCloseTo(170, 12)
    expect(wrapLongitudeDeg(720 + 45)).toBeCloseTo(45, 12)
    expect(wrapLongitudeDeg(0)).toBe(0)
  })
})
