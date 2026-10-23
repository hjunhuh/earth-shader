import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Vector3 } from 'three'
import {
  SHADING_EARTH_RADIUS,
  directionToShading,
  ecefToShading,
  normalToShading,
  shadingHeight,
  shadingToEcef,
  sphereCTerm,
} from '../../../src/geo/shadingSpace'
import { DEG, geodeticNormal, geodeticToEcef } from '../../../src/geo/wgs84'

const lonArb = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true })
const latArb = fc.double({ min: -Math.PI / 2 + 1e-6, max: Math.PI / 2 - 1e-6, noNaN: true })

describe('shading space', () => {
  it('maps the ellipsoid surface exactly onto the sphere of radius a', () => {
    fc.assert(
      fc.property(lonArb, latArb, (lon, lat) => {
        const p = ecefToShading(geodeticToEcef(lon, lat, 0))
        expect(Math.abs(p.length() / SHADING_EARTH_RADIUS - 1)).toBeLessThan(1e-12)
      }),
    )
  })

  it('distorts geodetic heights by at most 0.34%', () => {
    fc.assert(
      fc.property(lonArb, latArb, fc.double({ min: 10, max: 100_000, noNaN: true }), (lon, lat, h) => {
        const hs = shadingHeight(ecefToShading(geodeticToEcef(lon, lat, h)))
        expect(hs / h).toBeGreaterThan(0.9999)
        expect(hs / h).toBeLessThan(1.00337)
      }),
    )
  })

  it('is invertible', () => {
    fc.assert(
      fc.property(fc.tuple(fc.double({ min: -1e7, max: 1e7, noNaN: true }), fc.double({ min: -1e7, max: 1e7, noNaN: true }), fc.double({ min: -1e7, max: 1e7, noNaN: true })), ([x, y, z]) => {
        const p = new Vector3(x, y, z)
        expect(shadingToEcef(ecefToShading(p)).distanceTo(p)).toBeLessThan(1e-8)
      }),
    )
  })

  it('maps geodetic normals onto exact radial directions', () => {
    fc.assert(
      fc.property(lonArb, latArb, (lon, lat) => {
        const surface = ecefToShading(geodeticToEcef(lon, lat, 0)).normalize()
        const n = normalToShading(geodeticNormal(lon, lat))
        expect(n.distanceTo(surface)).toBeLessThan(1e-12)
      }),
    )
  })

  it('preserves the sign of the sun elevation and scales sin(e) by ≤0.34%', () => {
    fc.assert(
      fc.property(
        lonArb,
        latArb,
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true }),
        (lon, lat, sunLon, sunLat) => {
          const sun = new Vector3(
            Math.cos(sunLat) * Math.cos(sunLon),
            Math.cos(sunLat) * Math.sin(sunLon),
            Math.sin(sunLat),
          )
          const up = geodeticNormal(lon, lat)
          const sinE = sun.dot(up)
          const sinE2 = directionToShading(sun).dot(normalToShading(up))
          if (Math.abs(sinE) < 1e-9) return
          expect(Math.sign(sinE2)).toBe(Math.sign(sinE))
          const ratio = sinE2 / sinE
          expect(ratio).toBeGreaterThan(1 / 1.00337)
          expect(ratio).toBeLessThan(1.00337)
        },
      ),
      { numRuns: 5000 },
    )
  })

  it('keeps rays straight (linearity)', () => {
    const o = geodeticToEcef(0.3, 0.9, 5000)
    const d = new Vector3(0.2, -0.5, -0.84).normalize()
    const t = 12_345.678
    const pAlong = o.clone().addScaledVector(d, t)
    const os = ecefToShading(o)
    const ds = ecefToShading(d)
    expect(os.addScaledVector(ds, t).distanceTo(ecefToShading(pAlong))).toBeLessThan(1e-7)
  })

  it('computes the c-term without cancellation', () => {
    const R = 6378137
    expect(sphereCTerm(R + 10, R)).toBe(10 * (2 * R + 10))
    expect(sphereCTerm(R, R)).toBe(0)
    expect(sphereCTerm(R - 1, R)).toBeLessThan(0)
  })

  it('treats 1° of latitude consistently with DEG', () => {
    expect(DEG * 180).toBeCloseTo(Math.PI, 15)
  })
})
