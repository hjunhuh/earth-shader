import {
  MOON_MODELS,
  QUALITIES,
  SUN_MODELS,
  TONE_MAPPING_MODES,
  type MoonModel,
  type Quality,
  type SunModel,
  type ToneMappingName,
} from './defaults'
import { applyPatch, createDefaultState, type AppState, type StatePatch } from './state'

export interface TestConfig {
  enabled: boolean
  /** Frames to render before reporting ready. */
  frames: number
  size: { width: number; height: number } | null
  /** Show the panel in test mode. */
  ui: boolean
  /** Pixel ratio in test mode. */
  dpr: number
}

/** Start orbiting the Moon: `?focus=moon&moonAlt=&moonLon=&moonLat=&moonHeading=&moonTilt=` (meters / degrees). */
export interface StartView {
  focus: 'earth' | 'moon'
  altitude?: number
  longitude?: number
  latitude?: number
  heading?: number
  tilt?: number
}

export interface ParsedUrl {
  state: AppState
  test: TestConfig
  view: StartView
  errors: string[]
}

function number(params: URLSearchParams, key: string, errors: string[]): number | undefined {
  const raw = params.get(key)
  if (raw === null) return undefined
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value)) {
    errors.push(`${key}: not a number "${raw}"`)
    return undefined
  }
  return value
}

function flag(params: URLSearchParams, key: string, errors: string[]): boolean | undefined {
  const raw = params.get(key)
  if (raw === null) return undefined
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  errors.push(`${key}: expected 0/1 "${raw}"`)
  return undefined
}

function prune<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** `?lon=&lat=&alt=&doy=&tod=&clouds=&quality=&coverage=&sun=&glare=&moon=&exposure=` plus the start view and test flags. */
export function parseUrl(search: string): ParsedUrl {
  const params = new URLSearchParams(search)
  const errors: string[] = []
  const quality = params.get('quality')
  if (quality !== null && !(QUALITIES as readonly string[]).includes(quality)) errors.push(`quality: unknown "${quality}"`)
  const sunModel = params.get('sun')
  if (sunModel !== null && !(SUN_MODELS as readonly string[]).includes(sunModel)) errors.push(`sun: unknown "${sunModel}"`)
  const moonModel = params.get('moon')
  if (moonModel !== null && !(MOON_MODELS as readonly string[]).includes(moonModel)) errors.push(`moon: unknown "${moonModel}"`)
  const tone = params.get('tonemapping')
  if (tone !== null && !(TONE_MAPPING_MODES as readonly string[]).includes(tone)) errors.push(`tonemapping: unknown "${tone}"`)

  const patch: StatePatch = {
    location: prune({
      longitude: number(params, 'lon', errors),
      latitude: number(params, 'lat', errors),
      altitude: number(params, 'alt', errors),
    }),
    date: prune({ dayOfYear: number(params, 'doy', errors), timeOfDay: number(params, 'tod', errors) }),
    cloud: prune({
      enabled: flag(params, 'clouds', errors),
      quality: quality !== null && (QUALITIES as readonly string[]).includes(quality) ? (quality as Quality) : undefined,
      coverage: number(params, 'coverage', errors),
      animate: flag(params, 'animate', errors),
    }),
    sun: prune({
      model: sunModel !== null && (SUN_MODELS as readonly string[]).includes(sunModel) ? (sunModel as SunModel) : undefined,
      glare: number(params, 'glare', errors),
      corona: number(params, 'corona', errors),
    }),
    moon: prune({
      model: moonModel !== null && (MOON_MODELS as readonly string[]).includes(moonModel) ? (moonModel as MoonModel) : undefined,
    }),
    toneMapping: prune({
      exposure: number(params, 'exposure', errors),
      mode: tone !== null && (TONE_MAPPING_MODES as readonly string[]).includes(tone) ? (tone as ToneMappingName) : undefined,
    }),
    atmosphere: prune({ correctAltitude: flag(params, 'correctAltitude', errors) }),
  }
  const state = applyPatch(createDefaultState(), patch)

  let size: TestConfig['size'] = null
  const rawSize = params.get('size')
  if (rawSize !== null) {
    const m = /^(\d+)x(\d+)$/.exec(rawSize)
    if (m) size = { width: Number(m[1]), height: Number(m[2]) }
    else errors.push(`size: expected WxH "${rawSize}"`)
  }
  const test: TestConfig = {
    enabled: params.get('test') === '1',
    frames: Math.max(0, Math.floor(number(params, 'frames', errors) ?? 8)),
    size,
    ui: params.get('ui') === '1',
    dpr: Math.min(4, Math.max(0.25, number(params, 'dpr', errors) ?? 1)),
  }
  const focus = params.get('focus')
  if (focus !== null && focus !== 'earth' && focus !== 'moon') errors.push(`focus: unknown "${focus}"`)
  const view: StartView = prune({
    focus: focus === 'moon' ? 'moon' : 'earth',
    altitude: number(params, 'moonAlt', errors),
    longitude: number(params, 'moonLon', errors),
    latitude: number(params, 'moonLat', errors),
    heading: number(params, 'moonHeading', errors),
    tilt: number(params, 'moonTilt', errors),
  }) as StartView
  return { state, test, view, errors }
}
