import { describe, expect, it } from 'vitest'
import { applyPatch, createDefaultState } from '../../src/app/state'
import { parseUrl } from '../../src/app/urlState'

describe('state', () => {
  it('defaults are the takram Clouds/Basic story’s values, timeOfDay 8.0', () => {
    expect(createDefaultState()).toEqual({
      location: { longitude: 30, latitude: 35, altitude: 300 },
      date: { dayOfYear: 1, timeOfDay: 8 },
      cloud: { enabled: true, quality: 'high', coverage: 0.3, animate: false },
      sun: { model: 'realistic', glare: 0.1, corona: 0.5 },
      toneMapping: { mode: 'AgX', exposure: 10 },
      atmosphere: { correctAltitude: true },
    })
  })

  it('clamps to the panel ranges and ignores invalid values', () => {
    const s = applyPatch(createDefaultState(), {
      location: { longitude: 400, latitude: -95, altitude: 1e6 },
      date: { timeOfDay: 30, dayOfYear: 0 },
      cloud: { quality: 'max' as never, coverage: 2 },
      toneMapping: { exposure: Number.NaN },
    })
    expect(s.location).toEqual({ longitude: 180, latitude: -90, altitude: 30000 })
    expect(s.date).toEqual({ dayOfYear: 1, timeOfDay: 24 })
    expect(s.cloud.quality).toBe('high')
    expect(s.cloud.coverage).toBe(1)
    expect(s.toneMapping.exposure).toBe(10)
  })

  it('patches are pure', () => {
    const a = createDefaultState()
    const b = applyPatch(a, { date: { timeOfDay: 17 } })
    expect(a.date.timeOfDay).toBe(8)
    expect(b.date.timeOfDay).toBe(17)
    expect(b.location).toEqual(a.location)
  })
})

describe('URL', () => {
  it('parses location, date, cloud and exposure', () => {
    const { state, errors } = parseUrl('?lon=127&lat=37.5&alt=1000&doy=170&tod=17.5&clouds=0&quality=ultra&coverage=0.5&exposure=15')
    expect(errors).toEqual([])
    expect(state.location).toEqual({ longitude: 127, latitude: 37.5, altitude: 1000 })
    expect(state.date).toEqual({ dayOfYear: 170, timeOfDay: 17.5 })
    expect(state.cloud).toMatchObject({ enabled: false, quality: 'ultra', coverage: 0.5 })
    expect(state.toneMapping.exposure).toBe(15)
  })

  it('reports bad values and keeps defaults', () => {
    const { state, errors } = parseUrl('?lon=abc&quality=max&clouds=maybe&size=big')
    expect(errors).toHaveLength(4)
    expect(state).toEqual(createDefaultState())
  })

  it('parses test flags', () => {
    expect(parseUrl('?test=1&frames=64&size=640x360&ui=1').test).toEqual({
      enabled: true,
      frames: 64,
      size: { width: 640, height: 360 },
      ui: true,
      dpr: 1,
    })
    expect(parseUrl('').test.enabled).toBe(false)
  })
})
