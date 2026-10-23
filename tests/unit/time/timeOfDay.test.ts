import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { solarPosition } from '../../../src/time/solar'
import {
  DEFAULT_DATE,
  DEFAULT_TIME_OF_DAY,
  parseDateUtc,
  setTimeOfDay,
  timeOfDayAt,
  utcForTimeOfDay,
  wrap24,
} from '../../../src/time/timeOfDay'

const circDiff24 = (a: number, b: number) => Math.abs((((a - b) % 24) + 36) % 24 - 12)
const date = parseDateUtc(DEFAULT_DATE)

describe('timeofday <-> UTC', () => {
  it('defaults to 8.0 on the fixed date 2026-03-20', () => {
    expect(DEFAULT_TIME_OF_DAY).toBe(8.0)
    expect(new Date(date).toISOString()).toBe('2026-03-20T00:00:00.000Z')
  })

  it('round-trips tod -> UTC -> tod for any longitude', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 23.999, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        (tod, lon) => {
          const utc = utcForTimeOfDay(tod, lon, date)
          expect(circDiff24(timeOfDayAt(utc, lon), tod)).toBeLessThan(1e-6)
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('tod = 12 puts the sun on the local meridian (hour angle 0)', () => {
    for (const lon of [-179.9, -120, -45.5, 0, 33.3, 126.978, 179.9]) {
      const utc = utcForTimeOfDay(12, lon, date)
      expect(Math.abs(solarPosition(utc, 30, lon).hourAngle)).toBeLessThan(1e-4)
    }
  })

  it('tod = 6 and 18 put the sun 90° from the meridian', () => {
    for (const lon of [-100, 0, 127]) {
      expect(solarPosition(utcForTimeOfDay(6, lon, date), 0, lon).hourAngle).toBeCloseTo(-90, 3)
      expect(solarPosition(utcForTimeOfDay(18, lon, date), 0, lon).hourAngle).toBeCloseTo(90, 3)
    }
  })

  it('handles the date line and UTC day boundaries', () => {
    const utcEast = utcForTimeOfDay(1, 179, date) // ~1h local at +179° is the previous UTC day
    expect(utcEast).toBeLessThan(date)
    const utcWest = utcForTimeOfDay(23, -179, date) // late evening at −179° is the next UTC day
    expect(utcWest).toBeGreaterThan(date + 86_400_000)
    expect(circDiff24(timeOfDayAt(utcEast, 179), 1)).toBeLessThan(1e-6)
    expect(circDiff24(timeOfDayAt(utcWest, -179), 23)).toBeLessThan(1e-6)
  })
})

describe('state rule: Earth-anchored sun', () => {
  it('moving the camera keeps UTC; displayed tod shifts by Δlon/15', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 23.99, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: -60, max: 60, noNaN: true }),
        (tod, lon, dLon) => {
          const utc = utcForTimeOfDay(tod, lon, date)
          const newLon = lon + dLon
          expect(circDiff24(timeOfDayAt(utc, newLon), wrap24(tod + dLon / 15))).toBeLessThan(1e-9)
        },
      ),
    )
  })

  it('editing tod keeps the displayed local solar date (no day jumps when scrubbing)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 23.99, noNaN: true }),
        fc.double({ min: 0, max: 23.99, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        (tod0, tod1, lon) => {
          const utc0 = utcForTimeOfDay(tod0, lon, date)
          const utc1 = setTimeOfDay(utc0, lon, tod1)
          expect(circDiff24(timeOfDayAt(utc1, lon), tod1)).toBeLessThan(1e-6)
          // Same local day: the instants differ by less than 24 h.
          expect(Math.abs(utc1 - utc0)).toBeLessThan(86_400_000)
        },
      ),
    )
  })

  it('setTimeOfDay is idempotent for the current value', () => {
    const utc = utcForTimeOfDay(17.25, 126.978, date)
    expect(Math.abs(setTimeOfDay(utc, 126.978, timeOfDayAt(utc, 126.978)) - utc)).toBeLessThan(5)
  })
})

describe('wrap24 / parseDateUtc', () => {
  it('wraps hours', () => {
    expect(wrap24(24)).toBe(0)
    expect(wrap24(-1)).toBe(23)
    expect(wrap24(49.5)).toBeCloseTo(1.5, 12)
  })
  it('rejects malformed dates', () => {
    expect(() => parseDateUtc('2026-3-20')).toThrow()
    expect(() => parseDateUtc('foo')).toThrow()
  })
})
