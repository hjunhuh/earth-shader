import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Body, Equator, Observer, SiderealTime } from 'astronomy-engine'
import { localDateMs } from '../../src/app/localDate'

/** Local hour angle of the sun in degrees (−180..180, 0 = upper transit), independent of takram. */
function hourAngle(dateMs: number, longitude: number): number {
  const date = new Date(dateMs)
  const eq = Equator(Body.Sun, date, new Observer(0, longitude, 0), true, true)
  const lst = SiderealTime(date) + longitude / 15
  return ((((lst - eq.ra) * 15 + 540) % 360) + 360) % 360 - 180
}

describe('local date (takram useLocalDateControls)', () => {
  it('maps (longitude, dayOfYear, timeOfDay) to UTC like the story', () => {
    expect(localDateMs(0, 1, 12, 2026)).toBe(Date.UTC(2026, 0, 2, 12))
    expect(localDateMs(30, 1, 8, 2026)).toBe(Date.UTC(2026, 0, 2, 6))
    expect(localDateMs(-90, 1, 0, 2026)).toBe(Date.UTC(2026, 0, 2, 6))
    // dayOfYear is floored like the story's Math.floor.
    expect(localDateMs(0, 10.9, 0, 2026)).toBe(Date.UTC(2026, 0, 11, 0))
  })

  it('is local mean time: the sun transits within the equation of time (±16.5 min) of 12:00', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.integer({ min: 1, max: 365 }),
        (longitude, day) => {
          const ha = hourAngle(localDateMs(longitude, day, 12, 2026), longitude)
          expect(Math.abs(ha)).toBeLessThan((16.5 / 60) * 15)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('each hour of timeOfDay advances the sun by 15° of hour angle', () => {
    for (const tod of [6, 9, 15, 18]) {
      const ha = hourAngle(localDateMs(30, 1, tod, 2026), 30)
      const expected = (tod - 12) * 15
      expect(Math.abs(ha - expected)).toBeLessThan(5)
    }
  })

  it('a location further east at the same local time is an earlier UTC instant', () => {
    expect(localDateMs(45, 1, 8) - localDateMs(30, 1, 8)).toBe(-3600000)
  })
})
