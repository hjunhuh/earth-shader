import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  createDefaultState,
  getTimeOfDay,
  withCamera,
  withCloud,
  withTimeOfDay,
} from '../../../src/app/state'
import { parseUrl, parseWeather, serializeState } from '../../../src/app/urlState'

const circDiff24 = (a: number, b: number) => Math.abs((((a - b) % 24) + 36) % 24 - 12)

describe('AppState', () => {
  it('defaults: timeofday 8.0 at the default location, clouds on, quality high', () => {
    const s = createDefaultState()
    expect(getTimeOfDay(s)).toBeCloseTo(8.0, 6)
    expect(s.cloud).toMatchObject({ enabled: true, quality: 'high' })
  })

  it('moving the camera keeps the instant and shifts the displayed tod', () => {
    const s = createDefaultState()
    const moved = withCamera(s, { ...s.camera, lon: s.camera.lon + 15 })
    expect(moved.utcMs).toBe(s.utcMs)
    expect(getTimeOfDay(moved)).toBeCloseTo(9.0, 6)
  })

  it('editing tod moves the instant and sticks', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 24, noNaN: true }), (tod) => {
        const s = withTimeOfDay(createDefaultState(), tod)
        expect(circDiff24(getTimeOfDay(s), tod % 24)).toBeLessThan(1e-6)
      }),
    )
  })

  it('withCloud validates quality and coverage', () => {
    const s = withCloud(createDefaultState(), { quality: 'bogus' as never, coverage: 3 })
    expect(s.cloud.quality).toBe('high')
    expect(s.cloud.coverage).toBe(1)
  })
})

describe('URL state', () => {
  it('parses all user-facing parameters', () => {
    const { state, errors } = parseUrl('?lon=10&lat=-20&alt=5000&heading=45&tilt=30&tod=18.5&clouds=0&quality=low')
    expect(errors).toEqual([])
    expect(state.camera).toMatchObject({ lon: 10, lat: -20, alt: 5000, heading: 45, tilt: 30 })
    expect(getTimeOfDay(state)).toBeCloseTo(18.5, 6)
    expect(state.cloud).toMatchObject({ enabled: false, quality: 'low' })
  })

  it('round-trips through serializeState', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -80, max: 80, noNaN: true }),
        fc.double({ min: 100, max: 3e7, noNaN: true }),
        fc.double({ min: 0, max: 23.99, noNaN: true }),
        fc.constantFrom('low', 'medium', 'high', 'ultra'),
        fc.boolean(),
        (lon, lat, alt, tod, quality, enabled) => {
          const a = parseUrl(`?lon=${lon}&lat=${lat}&alt=${alt}&tod=${tod}&quality=${quality}&clouds=${enabled ? 1 : 0}`).state
          const b = parseUrl(`?${serializeState(a)}`).state
          expect(Math.abs(b.camera.lon - a.camera.lon)).toBeLessThan(1e-5)
          expect(Math.abs(b.camera.lat - a.camera.lat)).toBeLessThan(1e-5)
          expect(Math.abs(b.utcMs - a.utcMs)).toBeLessThan(1000)
          expect(b.cloud).toMatchObject({ quality, enabled })
        },
      ),
    )
  })

  it('reports invalid values without throwing and keeps defaults', () => {
    const { state, errors } = parseUrl('?lon=abc&quality=max&date=2026-13-45&size=big')
    expect(errors.length).toBe(4)
    expect(state.cloud.quality).toBe('high')
    expect(state.camera.lon).toBe(createDefaultState().camera.lon)
  })

  it('parses test-mode flags and synthetic weather', () => {
    const { test, state } = parseUrl('?test=1&frames=64&size=640x360&physical=1&weather=blob:10,20,1500,3000,4000&shadows=0&ozone=0')
    expect(test).toEqual({ enabled: true, frames: 64, size: { width: 640, height: 360 }, ui: false })
    expect(state.debug).toMatchObject({ physical: true, shadows: false, ozone: false })
    expect(state.debug.weather).toEqual({ kind: 'blob', lat: 10, lon: 20, bottom: 1500, top: 3000, radius: 4000 })
  })

  it('validates synthetic weather specs', () => {
    const errors: string[] = []
    expect(parseWeather('slab:10,1000,2000', errors)).toEqual({ kind: 'slab', tau: 10, bottom: 1000, top: 2000 })
    expect(parseWeather('slab:10,2000,1000', errors).kind).toBe('procedural')
    expect(parseWeather('clear', errors).kind).toBe('clear')
    expect(errors.length).toBe(1)
  })
})
