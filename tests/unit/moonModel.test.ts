import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { Observer, SearchLocalSolarEclipse, SearchLunarEclipse, EclipseKind } from 'astronomy-engine'
import { getECIToECEFRotationMatrix, getMoonDirectionECI, getSunDirectionECI } from '@takram/three-atmosphere'
import { Geodetic, radians } from '@takram/three-geospatial'
import {
  diskOverlapArea,
  earthshineRatio,
  GEOMETRIC_ALBEDO,
  getMoonFixedToECEF,
  getMoonPositionECEF,
  getApparentMoonPositionECI,
  getApparentSunDirectionECI,
  getMoonPositionECI,
  lunarLambertDiskIntegral,
  lunarRadianceFactor,
  MOON_MEAN_DISTANCE,
  MOON_RADIUS,
  observedPhaseCurve,
  PHASE_TABLE,
  sunVisibleFraction,
} from '../../src/scene/moonModel'

const SUN_ANGULAR_RADIUS = 0.004675 // takram AtmosphereParameters.DEFAULT
const YEAR = Date.UTC(2026, 0, 1)
const HOUR = 3600e3

/** Integrated irradiance of the disk relative to the sun, uniform albedo, at distance d. */
function diskIrradianceRatio(alphaDeg: number, distance = MOON_MEAN_DISTANCE, n = 200): number {
  const a = (alphaDeg * Math.PI) / 180
  const [sx, sz] = [Math.sin(a), Math.cos(a)]
  const h = 2 / n
  let sum = 0
  for (let j = 0; j < n; ++j) {
    for (let i = 0; i < n; ++i) {
      const x = -1 + (i + 0.5) * h
      const y = -1 + (j + 0.5) * h
      if (x * x + y * y >= 1) continue
      const mu = Math.sqrt(1 - x * x - y * y)
      sum += lunarRadianceFactor(GEOMETRIC_ALBEDO, x * sx + mu * sz, mu, alphaDeg) * h * h
    }
  }
  // Radiance × solid angle: each unit of projected disk area is (R/d)² sr.
  return sum * (MOON_RADIUS / distance) ** 2
}

describe('ephemeris', () => {
  it('distance stays within the 2026 perigee/apogee range', () => {
    let min = Infinity
    let max = 0
    for (let t = YEAR; t < YEAR + 365 * 24 * HOUR; t += 3 * HOUR) {
      const d = getMoonPositionECI(t).length()
      min = Math.min(min, d)
      max = Math.max(max, d)
    }
    expect(min).toBeGreaterThan(355_000e3)
    expect(min).toBeLessThan(360_000e3)
    expect(max).toBeGreaterThan(404_000e3)
    expect(max).toBeLessThan(407_500e3)
  })

  it('ECEF position: same length as ECI and the same direction takram uses', () => {
    for (const t of [YEAR, YEAR + 1234 * HOUR, YEAR + 5000 * HOUR]) {
      const eci = getMoonPositionECI(t)
      const ecef = getMoonPositionECEF(t)
      expect(Math.abs(ecef.length() - eci.length())).toBeLessThan(1e-3)
      // takram's direction is geometric (no aberration): within the ~20″ of aberration.
      const dir = getMoonDirectionECI(t).applyMatrix4(getECIToECEFRotationMatrix(t))
      expect(ecef.clone().normalize().angleTo(dir)).toBeLessThan(1.5e-4)
    }
  })

  it('in the scene Sun’s frame, the Sun–Moon angle is the apparent one', () => {
    for (const t of [YEAR, YEAR + 777 * HOUR, YEAR + 4321 * HOUR]) {
      const scene = getMoonPositionECI(t).angleTo(getSunDirectionECI(t))
      const apparent = getApparentMoonPositionECI(t).angleTo(getApparentSunDirectionECI(t))
      expect(Math.abs(scene - apparent)).toBeLessThan(1e-9)
      expect(getMoonPositionECI(t).length()).toBeCloseTo(getApparentMoonPositionECI(t).length(), 3)
    }
  })

  it('apparent diameter from the Earth is 29.3′–34.1′', () => {
    for (let t = YEAR; t < YEAR + 365 * 24 * HOUR; t += 24 * HOUR) {
      const arcmin = ((2 * Math.asin(MOON_RADIUS / getMoonPositionECI(t).length())) * 180 * 60) / Math.PI
      expect(arcmin).toBeGreaterThan(29.3)
      expect(arcmin).toBeLessThan(34.1)
    }
  })

  it('the body-fixed frame keeps the near side (0° longitude) facing the Earth within libration', () => {
    for (let t = YEAR; t < YEAR + 60 * 24 * HOUR; t += 24 * HOUR) {
      const m = getMoonFixedToECEF(t)
      const primeMeridian = new Vector3().setFromMatrixColumn(m, 0)
      const toEarth = getMoonPositionECEF(t).negate().normalize()
      expect((Math.acos(primeMeridian.dot(toEarth)) * 180) / Math.PI).toBeLessThan(10)
    }
  })

  it('topocentric: the Moon covers the Sun at the 2026-08-12 total eclipse seen from Burgos', () => {
    const [lat, lon] = [42.34, -3.7]
    const eclipse = SearchLocalSolarEclipse(new Date(Date.UTC(2026, 7, 1)), new Observer(lat, lon, 0))
    expect(eclipse.kind).toBe(EclipseKind.Total)
    const t = eclipse.peak.time.date.getTime()
    const observer = new Geodetic(radians(lon), radians(lat), 0).toECEF()
    const m = getECIToECEFRotationMatrix(t)
    const sun = getSunDirectionECI(t).applyMatrix4(m)
    const moon = getMoonPositionECEF(t).sub(observer)
    const separation = sun.angleTo(moon)
    const moonRadius = Math.asin(MOON_RADIUS / moon.length())
    expect(moonRadius).toBeGreaterThan(SUN_ANGULAR_RADIUS) // total, not annular
    expect(separation).toBeLessThan(moonRadius - SUN_ANGULAR_RADIUS)
    // From the Earth's center (no parallax) the Moon would miss by ~1°: the position matters.
    const geocentric = getMoonPositionECEF(t).normalize().angleTo(sun)
    expect(geocentric).toBeGreaterThan(0.005)
  })
})

describe('photometry', () => {
  it('Lunar-Lambert disk integral is 1 at full moon', () => {
    expect(lunarLambertDiskIntegral(0)).toBeCloseTo(1, 3)
  })

  it('full moon at mean distance: E/E☉ = 10^(−0.4·14.01) ≈ 2.5e−6, geometric albedo ≈ 0.12', () => {
    expect(GEOMETRIC_ALBEDO).toBeGreaterThan(0.11)
    expect(GEOMETRIC_ALBEDO).toBeLessThan(0.13)
    const ratio = diskIrradianceRatio(0)
    expect(ratio / 10 ** (-0.4 * 14.01)).toBeCloseTo(1, 2)
  })

  it('follows the observed phase curve; quarter moon is 8–12% of full', () => {
    const full = diskIrradianceRatio(0)
    for (const a of [10, 30, 60, 90, 120, 150]) {
      expect(diskIrradianceRatio(a) / full / observedPhaseCurve(a)).toBeCloseTo(1, 1)
    }
    const quarter = diskIrradianceRatio(90) / full
    expect(quarter).toBeGreaterThan(0.08)
    expect(quarter).toBeLessThan(0.12)
  })

  it('phase table is finite and positive', () => {
    for (const v of PHASE_TABLE) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })

  it('earthshine is ~1e−4 of sunlight at new moon', () => {
    const r = earthshineRatio(0, MOON_MEAN_DISTANCE)
    expect(r).toBeGreaterThan(3e-5)
    expect(r).toBeLessThan(1e-4)
    expect(earthshineRatio(Math.PI, MOON_MEAN_DISTANCE)).toBeCloseTo(0, 12)
  })
})

describe('Earth shadow', () => {
  it('disk overlap: disjoint, contained, half', () => {
    expect(diskOverlapArea(1, 1, 3)).toBe(0)
    expect(diskOverlapArea(1, 3, 0.5)).toBeCloseTo(Math.PI, 9)
    // Equal disks overlapping at c = 0: full.
    expect(diskOverlapArea(1, 1, 1e-9)).toBeCloseTo(Math.PI, 6)
  })

  it('2026-03-03 total lunar eclipse: the Moon is in the umbra at greatest eclipse', () => {
    const eclipse = SearchLunarEclipse(new Date(Date.UTC(2026, 1, 15)))
    expect(eclipse.kind).toBe(EclipseKind.Total)
    const t = eclipse.peak.date.getTime()
    expect(Math.abs(t - Date.UTC(2026, 2, 3, 11, 33))).toBeLessThan(10 * 60e3)
    const m = getECIToECEFRotationMatrix(t)
    const sun = getSunDirectionECI(t).applyMatrix4(m)
    const moon = getMoonPositionECEF(t, new Vector3(), m)
    expect(sunVisibleFraction(moon, sun, new Vector3(), SUN_ANGULAR_RADIUS)).toBe(0)
    // Two weeks later (new moon) it is in full sunlight.
    const t2 = t + 14.8 * 24 * HOUR
    const m2 = getECIToECEFRotationMatrix(t2)
    const moon2 = getMoonPositionECEF(t2, new Vector3(), m2)
    expect(sunVisibleFraction(moon2, getSunDirectionECI(t2).applyMatrix4(m2), new Vector3(), SUN_ANGULAR_RADIUS)).toBe(1)
  })
})
