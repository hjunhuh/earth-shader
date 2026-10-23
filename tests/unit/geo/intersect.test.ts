import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Vector3 } from 'three'
import { pickEllipsoid, raySphereNaive, raySphereStable } from '../../../src/geo/intersect'
import { sphereCTerm } from '../../../src/geo/shadingSpace'
import { WGS84_A, WGS84_B, ecefToGeodetic, geodeticToEcef } from '../../../src/geo/wgs84'

const f = Math.fround

/** Float32 emulation of the GPU path: b = dot(o, d) in float32, c from CPU (float64 -> float32). */
function stableFloat32(o: Vector3, d: Vector3, R: number): number | null {
  const ox = f(o.x), oy = f(o.y), oz = f(o.z)
  const dx = f(d.x), dy = f(d.y), dz = f(d.z)
  const b = f(f(f(ox * dx) + f(oy * dy)) + f(oz * dz))
  const c = f(sphereCTerm(o.length(), R))
  const disc = f(f(b * b) - c)
  if (disc < 0) return null
  const s = f(Math.sqrt(disc))
  const q = b > 0 ? f(-b - s) : f(-b + s)
  const t0 = q
  const t1 = f(c / q)
  return Math.min(t0, t1) >= 0 ? Math.min(t0, t1) : Math.max(t0, t1)
}

function naiveFloat32(o: Vector3, d: Vector3, R: number): number | null {
  const ox = f(o.x), oy = f(o.y), oz = f(o.z)
  const dx = f(d.x), dy = f(d.y), dz = f(d.z)
  const b = f(f(f(ox * dx) + f(oy * dy)) + f(oz * dz))
  const c = f(f(f(f(ox * ox) + f(oy * oy)) + f(oz * oz)) - f(R * R))
  const disc = f(f(b * b) - c)
  if (disc < 0) return null
  return f(-b - f(Math.sqrt(disc)))
}

function exactNear(o: Vector3, d: Vector3, R: number): number | null {
  const hit = raySphereStable(o.dot(d), sphereCTerm(o.length(), R))
  if (!hit) return null
  return hit.near >= 0 ? hit.near : hit.far
}

describe('raySphereStable', () => {
  it('matches the analytic roots', () => {
    // Origin at (0,0,10) looking down -z onto a unit-radius-5 sphere at the origin.
    const o = new Vector3(0, 0, 10)
    const d = new Vector3(0, 0, -1)
    const hit = raySphereStable(o.dot(d), sphereCTerm(o.length(), 5))!
    expect(hit.near).toBeCloseTo(5, 12)
    expect(hit.far).toBeCloseTo(15, 12)
    expect(raySphereStable(0, 1)).toBeNull()
  })

  it('agrees with the naive form in float64 for random rays', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 6.4e6, max: 4e7, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (r, dy, dz) => {
          const o = new Vector3(r, 0, 0)
          const d = new Vector3(-1, dy, dz).normalize()
          const a = raySphereStable(o.dot(d), sphereCTerm(o.length(), WGS84_A))
          const n = raySphereNaive(o, d, WGS84_A)
          expect(a === null).toBe(n === null)
          if (a && n) {
            expect(Math.abs(a.near - n.near)).toBeLessThan(1e-3)
            expect(Math.abs(a.far - n.far)).toBeLessThan(1e-3)
          }
        },
      ),
    )
  })

  for (const altitude of [10, 1000, 36_000_000]) {
    it(`keeps float32 relative error < 1e-4 at altitude ${altitude} m (and beats the naive form)`, () => {
      const R = WGS84_A
      let worstStable = 0
      let worstNaive = 0
      for (let i = 0; i < 2000; ++i) {
        const theta = (i / 2000) * 0.999 // angle from nadir toward horizon, in units of the horizon angle
        const o = new Vector3(R + altitude, 0, 0)
        const horizon = Math.asin(R / (R + altitude))
        const ang = theta * horizon
        const d = new Vector3(-Math.cos(ang), Math.sin(ang), 0)
        const exact = exactNear(o, d, R)
        if (exact === null || exact <= 0) continue
        const s = stableFloat32(o, d, R)
        expect(s).not.toBeNull()
        worstStable = Math.max(worstStable, Math.abs(s! - exact) / exact)
        const n = naiveFloat32(o, d, R)
        worstNaive = Math.max(worstNaive, n === null ? 1 : Math.abs(n - exact) / exact)
      }
      expect(worstStable).toBeLessThan(1e-4)
      if (altitude <= 1000) expect(worstNaive).toBeGreaterThan(worstStable * 10)
    })
  }
})

describe('pickEllipsoid', () => {
  it('hits the exact ellipsoid surface (geodetic height 0)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -3, max: 3, noNaN: true }),
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        fc.double({ min: 100, max: 3e7, noNaN: true }),
        (lon, lat, alt) => {
          const o = geodeticToEcef(lon, lat, alt)
          const target = geodeticToEcef(lon + 0.001, lat - 0.001, 0)
          const d = target.clone().sub(o).normalize()
          const hit = pickEllipsoid(o, d)
          expect(hit).not.toBeNull()
          const g = ecefToGeodetic(hit!)!
          expect(Math.abs(g.height)).toBeLessThan(1e-3)
        },
      ),
    )
  })

  it('misses when looking away from the planet', () => {
    const o = geodeticToEcef(0, 0, 1e6)
    expect(pickEllipsoid(o, o.clone().normalize())).toBeNull()
  })

  it('handles polar flattening (pole is b, not a)', () => {
    const o = new Vector3(0, 0, WGS84_B + 1000)
    const hit = pickEllipsoid(o, new Vector3(0, 0, -1))!
    expect(hit.z).toBeCloseTo(WGS84_B, 6)
  })
})
