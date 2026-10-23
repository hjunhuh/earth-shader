import { clampState } from '../camera/pose'
import {
  DEFAULT_DATE,
  DEFAULT_TIME_OF_DAY,
  localSolarDateUtc,
  parseDateUtc,
  timeOfDayAt,
  utcForTimeOfDay,
} from '../time/timeOfDay'
import { QUALITIES, createDefaultState, type AppState, type Quality, type WeatherOverride } from './state'

export interface TestConfig {
  /** Deterministic test mode: fixed seed, frozen clock, hooks enabled. */
  enabled: boolean
  /** Frames to render before signalling readiness (temporal convergence). */
  frames: number
  /** Fixed drawing-buffer size, or null for the window size. */
  size: { width: number; height: number } | null
  /** Show the UI panel in test mode (UI e2e tests). */
  ui: boolean
}

export interface ParsedUrl {
  state: AppState
  test: TestConfig
  errors: string[]
}

function num(params: URLSearchParams, key: string, errors: string[]): number | undefined {
  const raw = params.get(key)
  if (raw === null || raw === '') return undefined
  const v = Number(raw)
  if (!Number.isFinite(v)) {
    errors.push(`${key}: not a number ("${raw}")`)
    return undefined
  }
  return v
}

function bool(params: URLSearchParams, key: string): boolean | undefined {
  const raw = params.get(key)
  if (raw === null) return undefined
  return raw === '1' || raw === 'true' || raw === ''
}

function parseNumbers(raw: string, count: number): number[] | null {
  const parts = raw.split(',').map(Number)
  return parts.length === count && parts.every(Number.isFinite) ? parts : null
}

export function parseWeather(raw: string, errors: string[]): WeatherOverride {
  if (raw === 'clear') return { kind: 'clear' }
  if (raw === 'procedural') return { kind: 'procedural' }
  const [kind, args = ''] = raw.split(':')
  if (kind === 'slab') {
    const v = parseNumbers(args, 3)
    if (v && v[0]! >= 0 && v[2]! > v[1]!) return { kind: 'slab', tau: v[0]!, bottom: v[1]!, top: v[2]! }
  } else if (kind === 'blob') {
    const v = parseNumbers(args, 5)
    if (v && v[3]! > v[2]! && v[4]! > 0)
      return { kind: 'blob', lat: v[0]!, lon: v[1]!, bottom: v[2]!, top: v[3]!, radius: v[4]! }
  }
  errors.push(`weather: invalid "${raw}"`)
  return { kind: 'procedural' }
}

export function parseUrl(search: string): ParsedUrl {
  const params = new URLSearchParams(search)
  const errors: string[] = []
  const state = createDefaultState()

  const cam = { ...state.camera }
  cam.lon = num(params, 'lon', errors) ?? cam.lon
  cam.lat = num(params, 'lat', errors) ?? cam.lat
  cam.alt = num(params, 'alt', errors) ?? cam.alt
  cam.heading = num(params, 'heading', errors) ?? cam.heading
  cam.tilt = num(params, 'tilt', errors) ?? cam.tilt
  state.camera = clampState(cam)

  let dateUtc = parseDateUtc(DEFAULT_DATE)
  const date = params.get('date')
  if (date !== null) {
    try {
      dateUtc = parseDateUtc(date)
    } catch (e) {
      errors.push(`date: ${(e as Error).message}`)
    }
  }
  const tod = num(params, 'tod', errors)
  const todValue = tod === undefined ? DEFAULT_TIME_OF_DAY : ((tod % 24) + 24) % 24
  state.utcMs = utcForTimeOfDay(todValue, state.camera.lon, dateUtc)

  const clouds = bool(params, 'clouds')
  if (clouds !== undefined) state.cloud.enabled = clouds
  const quality = params.get('quality')
  if (quality !== null) {
    if ((QUALITIES as readonly string[]).includes(quality)) state.cloud.quality = quality as Quality
    else errors.push(`quality: invalid "${quality}"`)
  }
  const coverage = num(params, 'coverage', errors)
  if (coverage !== undefined) state.cloud.coverage = Math.min(1, Math.max(0, coverage))

  const d = state.debug
  const exposure = num(params, 'exposure', errors)
  if (exposure !== undefined) d.exposure = exposure
  d.wind = num(params, 'wind', errors) ?? d.wind
  d.seed = num(params, 'seed', errors) ?? d.seed
  d.physical = bool(params, 'physical') ?? d.physical
  d.ozone = bool(params, 'ozone') ?? d.ozone
  d.shadows = bool(params, 'shadows') ?? d.shadows
  const weather = params.get('weather')
  if (weather !== null) d.weather = parseWeather(weather, errors)

  const testEnabled = bool(params, 'test') ?? false
  let size: TestConfig['size'] = null
  const sizeRaw = params.get('size')
  if (sizeRaw !== null) {
    const m = /^(\d+)x(\d+)$/.exec(sizeRaw)
    if (m) size = { width: Number(m[1]), height: Number(m[2]) }
    else errors.push(`size: invalid "${sizeRaw}"`)
  }
  const frames = num(params, 'frames', errors)
  return {
    state,
    test: { enabled: testEnabled, frames: Math.max(1, Math.round(frames ?? 32)), size, ui: bool(params, 'ui') ?? false },
    errors,
  }
}

const round = (v: number, digits: number) => Number(v.toFixed(digits))

/** Serializes the user-facing state (not test flags) for shareable URLs. */
export function serializeState(state: AppState): string {
  const p = new URLSearchParams()
  const c = state.camera
  p.set('lon', String(round(c.lon, 6)))
  p.set('lat', String(round(c.lat, 6)))
  p.set('alt', String(round(c.alt, 1)))
  if (c.heading !== 0) p.set('heading', String(round(c.heading, 3)))
  if (c.tilt !== 0) p.set('tilt', String(round(c.tilt, 3)))
  p.set('tod', String(round(timeOfDayAt(state.utcMs, c.lon), 5)))
  p.set('date', new Date(localSolarDateUtc(state.utcMs, c.lon)).toISOString().slice(0, 10))
  p.set('clouds', state.cloud.enabled ? '1' : '0')
  p.set('quality', state.cloud.quality)
  return p.toString()
}
