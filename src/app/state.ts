import {
  DATE_LIMITS,
  DEFAULTS,
  EXPOSURE_LIMITS,
  LOCATION_LIMITS,
  QUALITIES,
  TONE_MAPPING_MODES,
  type Quality,
  type ToneMappingName,
} from './defaults'

/**
 * User-facing parameters. These are inputs only: camera interaction never
 * writes back into them (the takram story behaves the same way).
 */
export interface AppState {
  location: { longitude: number; latitude: number; altitude: number }
  date: { dayOfYear: number; timeOfDay: number }
  cloud: { enabled: boolean; quality: Quality; coverage: number; animate: boolean }
  toneMapping: { mode: ToneMappingName; exposure: number }
  atmosphere: { correctAltitude: boolean }
}

export type StatePatch = { [K in keyof AppState]?: Partial<AppState[K]> }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export function createDefaultState(): AppState {
  return {
    location: { ...DEFAULTS.location },
    date: { ...DEFAULTS.date },
    cloud: { ...DEFAULTS.cloud },
    toneMapping: { ...DEFAULTS.toneMapping },
    atmosphere: { ...DEFAULTS.atmosphere },
  }
}

/** Merge a patch and clamp every value to the panel's range. */
export function applyPatch(state: AppState, patch: StatePatch): AppState {
  const loc = { ...state.location, ...patch.location }
  const date = { ...state.date, ...patch.date }
  const cloud = { ...state.cloud, ...patch.cloud }
  const tone = { ...state.toneMapping, ...patch.toneMapping }
  const atmosphere = { ...state.atmosphere, ...patch.atmosphere }
  return {
    location: {
      longitude: clamp(finite(loc.longitude, state.location.longitude), LOCATION_LIMITS.longitude.min, LOCATION_LIMITS.longitude.max),
      latitude: clamp(finite(loc.latitude, state.location.latitude), LOCATION_LIMITS.latitude.min, LOCATION_LIMITS.latitude.max),
      altitude: clamp(finite(loc.altitude, state.location.altitude), LOCATION_LIMITS.altitude.min, LOCATION_LIMITS.altitude.max),
    },
    date: {
      dayOfYear: clamp(finite(date.dayOfYear, state.date.dayOfYear), DATE_LIMITS.dayOfYear.min, DATE_LIMITS.dayOfYear.max),
      timeOfDay: clamp(finite(date.timeOfDay, state.date.timeOfDay), DATE_LIMITS.timeOfDay.min, DATE_LIMITS.timeOfDay.max),
    },
    cloud: {
      enabled: Boolean(cloud.enabled),
      quality: (QUALITIES as readonly string[]).includes(cloud.quality) ? cloud.quality : state.cloud.quality,
      coverage: clamp(finite(cloud.coverage, state.cloud.coverage), 0, 1),
      animate: Boolean(cloud.animate),
    },
    toneMapping: {
      mode: (TONE_MAPPING_MODES as readonly string[]).includes(tone.mode) ? tone.mode : state.toneMapping.mode,
      exposure: clamp(finite(tone.exposure, state.toneMapping.exposure), EXPOSURE_LIMITS.min, EXPOSURE_LIMITS.max),
    },
    atmosphere: { correctAltitude: Boolean(atmosphere.correctAltitude) },
  }
}
