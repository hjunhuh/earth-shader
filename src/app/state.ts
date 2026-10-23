import { clampState, type GeoCameraState } from '../camera/pose'
import {
  DEFAULT_DATE,
  DEFAULT_TIME_OF_DAY,
  parseDateUtc,
  setTimeOfDay,
  timeOfDayAt,
  utcForTimeOfDay,
} from '../time/timeOfDay'

export const QUALITIES = ['low', 'medium', 'high', 'ultra'] as const
export type Quality = (typeof QUALITIES)[number]

/** Synthetic weather used by measured tests. */
export type WeatherOverride =
  | { kind: 'procedural' }
  | { kind: 'clear' }
  | { kind: 'slab'; tau: number; bottom: number; top: number }
  | { kind: 'blob'; lat: number; lon: number; bottom: number; top: number; radius: number }

export interface CloudState {
  enabled: boolean
  quality: Quality
  /** Global coverage multiplier (debug). */
  coverage: number
}

export interface DebugState {
  /** Manual EV100; null = deterministic auto curve. */
  exposure: number | null
  /** Weather drift speed [m/s]. */
  wind: number
  /** Disables non-physical terms (powder) for measured tests. */
  physical: boolean
  ozone: boolean
  shadows: boolean
  seed: number
  weather: WeatherOverride
}

export interface AppState {
  camera: GeoCameraState
  /** Canonical clock (UTC ms). timeofday is derived from it. */
  utcMs: number
  cloud: CloudState
  debug: DebugState
}

export const DEFAULT_CAMERA: GeoCameraState = {
  lon: 126.978,
  lat: 37.5665,
  alt: 15_000_000,
  heading: 0,
  tilt: 0,
}

export function createDefaultState(): AppState {
  return {
    camera: { ...DEFAULT_CAMERA },
    utcMs: utcForTimeOfDay(DEFAULT_TIME_OF_DAY, DEFAULT_CAMERA.lon, parseDateUtc(DEFAULT_DATE)),
    cloud: { enabled: true, quality: 'high', coverage: 0.5 },
    debug: {
      exposure: null,
      wind: 0,
      physical: false,
      ozone: true,
      shadows: true,
      seed: 1,
      weather: { kind: 'procedural' },
    },
  }
}

/** Displayed timeofday at the current camera longitude. */
export function getTimeOfDay(state: AppState): number {
  return timeOfDayAt(state.utcMs, state.camera.lon)
}

/** Editing timeofday moves the UTC instant (sun moves). */
export function withTimeOfDay(state: AppState, tod: number): AppState {
  const t = Math.min(24, Math.max(0, tod))
  return { ...state, utcMs: setTimeOfDay(state.utcMs, state.camera.lon, t === 24 ? 0 : t) }
}

/** Moving the camera keeps the UTC instant (terminator fixed to the Earth). */
export function withCamera(state: AppState, camera: GeoCameraState): AppState {
  return { ...state, camera: clampState(camera) }
}

export function withCloud(state: AppState, cloud: Partial<CloudState>): AppState {
  const next = { ...state.cloud, ...cloud }
  if (!QUALITIES.includes(next.quality)) next.quality = 'high'
  next.coverage = Math.min(1, Math.max(0, next.coverage))
  return { ...state, cloud: next }
}
