import { describe, expect, it } from 'vitest'
import * as Astronomy from 'astronomy-engine'
import {
  gmstDegrees,
  refractionDegrees,
  solarCoordinates,
  solarPosition,
  subsolarPoint,
  sunDirectionEcef,
} from '../../../src/time/solar'

const angleDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

/** Independent oracle: subsolar point from astronomy-engine (apparent RA/Dec of date, GAST). */
function oracleSubsolar(utcMs: number): { lat: number; lon: number } {
  const time = Astronomy.MakeTime(new Date(utcMs))
  const eq = Astronomy.Equator(Astronomy.Body.Sun, time, new Astronomy.Observer(0, 0, 0), true, true)
  const gast = Astronomy.SiderealTime(time)
  const lon = ((((eq.ra - gast) * 15) % 360) + 540) % 360 - 180
  return { lat: eq.dec, lon }
}

describe('NREL SPA reference case (Reda & Andreas 2004)', () => {
  // 2003-10-17 12:30:30 local (UTC−7), Golden CO, 820 mbar, 11 °C.
  const utc = Date.UTC(2003, 9, 17, 19, 30, 30)
  const pos = solarPosition(utc, 39.742476, -105.1786, 820, 11)

  it('matches the published topocentric zenith angle within 0.05°', () => {
    expect(Math.abs(pos.apparentZenith - 50.11162)).toBeLessThan(0.05)
  })

  it('matches the published azimuth within 0.05°', () => {
    expect(angleDiff(pos.azimuth, 194.34024)).toBeLessThan(0.05)
  })
})

describe('solar ephemeris vs astronomy-engine', () => {
  // A spread of instants over several years, all hours of the day.
  const instants: number[] = []
  for (let i = 0; i < 400; ++i) {
    instants.push(Date.UTC(2020, 0, 1) + i * 4.37 * 86_400_000 + ((i * 7919) % 86_400) * 1000)
  }

  it('subsolar latitude (declination) within 0.01°', () => {
    for (const t of instants) {
      expect(Math.abs(subsolarPoint(t).lat - oracleSubsolar(t).lat)).toBeLessThan(0.01)
    }
  })

  it('subsolar longitude within 0.02° (i.e. equation of time within ~5 s)', () => {
    for (const t of instants) {
      expect(angleDiff(subsolarPoint(t).lon, oracleSubsolar(t).lon)).toBeLessThan(0.02)
    }
  })

  it('horizontal sun position at assorted sites within 0.03°', () => {
    const sites = [
      [37.5665, 126.978],
      [-33.8688, 151.2093],
      [64.1466, -21.9426],
      [0, 0],
      [-77.85, 166.67],
    ] as const
    for (const t of instants.slice(0, 120)) {
      for (const [lat, lon] of sites) {
        const ours = solarPosition(t, lat, lon)
        const time = Astronomy.MakeTime(new Date(t))
        const obs = new Astronomy.Observer(lat, lon, 0)
        const eq = Astronomy.Equator(Astronomy.Body.Sun, time, obs, true, true)
        const hor = Astronomy.Horizon(time, obs, eq.ra, eq.dec)
        expect(Math.abs(90 - ours.zenith - hor.altitude)).toBeLessThan(0.03)
        if (hor.altitude > -80 && hor.altitude < 85) expect(angleDiff(ours.azimuth, hor.azimuth)).toBeLessThan(0.1)
      }
    }
  })
})

describe('solar geometry invariants', () => {
  it('places the subsolar point on the equator at the March equinox', () => {
    // 2026 March equinox: 2026-03-20 14:46 UTC.
    expect(Math.abs(subsolarPoint(Date.UTC(2026, 2, 20, 14, 46)).lat)).toBeLessThan(0.01)
  })

  it('reaches maximum elevation at hour angle 0 (local apparent noon)', () => {
    const lat = 37.5
    const lon = 127
    const day = Date.UTC(2026, 2, 20)
    let best = { t: 0, el: -90 }
    for (let m = 0; m < 1440; m += 0.25) {
      const t = day + m * 60_000
      const el = 90 - solarPosition(t, lat, lon).zenith
      if (el > best.el) best = { t, el }
    }
    expect(Math.abs(solarPosition(best.t, lat, lon).hourAngle)).toBeLessThan(0.1)
  })

  it('equation of time stays within its physical range (−14.3 … +16.5 min)', () => {
    for (let d = 0; d < 366; ++d) {
      const eot = solarCoordinates(Date.UTC(2026, 0, 1) + d * 86_400_000).equationOfTime
      expect(eot).toBeGreaterThan(-14.7)
      expect(eot).toBeLessThan(16.7)
    }
  })

  it('sun direction is a unit vector consistent with the subsolar point', () => {
    const t = Date.UTC(2026, 5, 21, 3, 0)
    const d = sunDirectionEcef(t)
    expect(d.length()).toBeCloseTo(1, 12)
    const s = subsolarPoint(t)
    expect(Math.asin(d.z) * (180 / Math.PI)).toBeCloseTo(s.lat, 10)
    expect(Math.atan2(d.y, d.x) * (180 / Math.PI)).toBeCloseTo(s.lon, 10)
  })

  it('GMST matches astronomy-engine sidereal time within 0.01°', () => {
    for (let i = 0; i < 50; ++i) {
      const t = Date.UTC(2024, 0, 1) + i * 9.1 * 86_400_000 + i * 3_600_000
      const gast = Astronomy.SiderealTime(Astronomy.MakeTime(new Date(t))) * 15
      // GAST − GMST = equation of the equinoxes (< 0.005°)
      expect(angleDiff(gmstDegrees(t), gast)).toBeLessThan(0.01)
    }
  })

  it('refraction is ~0.57° at the horizon and vanishes overhead', () => {
    expect(refractionDegrees(0)).toBeGreaterThan(0.45)
    expect(refractionDegrees(0)).toBeLessThan(0.65)
    expect(refractionDegrees(89.9)).toBeLessThan(0.001)
    expect(refractionDegrees(-5)).toBe(0)
  })
})
