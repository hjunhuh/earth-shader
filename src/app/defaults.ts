/**
 * Defaults mirror the takram three-geospatial "clouds/Clouds/Basic" story
 * (storybook/src/clouds/Clouds-Basic.tsx) so the two render the same scene.
 * The one intentional difference is timeOfDay = 8.0 (requested default).
 */

export const QUALITIES = ['low', 'medium', 'high', 'ultra'] as const
export type Quality = (typeof QUALITIES)[number]

export const TONE_MAPPING_MODES = ['AgX', 'Reinhard', 'Cineon', 'ACES Filmic', 'Linear'] as const
export type ToneMappingName = (typeof TONE_MAPPING_MODES)[number]

/** takram uses `new Date().getFullYear()`; pinned so renders are reproducible. */
export const DATE_YEAR = 2026

export const LOCATION_LIMITS = {
  longitude: { min: -180, max: 180 },
  latitude: { min: -90, max: 90 },
  altitude: { min: 0, max: 30000 },
} as const

export const DATE_LIMITS = {
  // leva clamps the story's `dayOfYear: 0` to its min of 1.
  dayOfYear: { min: 1, max: 365, step: 1 },
  timeOfDay: { min: 0, max: 24, step: 0.1 },
} as const

export const EXPOSURE_LIMITS = { min: 1, max: 100 } as const

export const DEFAULTS = {
  location: { longitude: 30, latitude: 35, altitude: 300 },
  date: { dayOfYear: 1, timeOfDay: 8 },
  cloud: { enabled: true, quality: 'high' as Quality, coverage: 0.3, animate: false },
  toneMapping: { mode: 'AgX' as ToneMappingName, exposure: 10 },
  atmosphere: { correctAltitude: true },
} as const

/** Camera and controls exactly as the story: R3F Canvas + drei OrbitControls. */
export const CAMERA = {
  fov: 75,
  near: 1,
  far: 4e5,
  /** R3F's default camera position before useApplyLocation runs. */
  initialPosition: [0, 0, 5] as const,
} as const

export const CONTROLS = {
  minDistance: 1000,
  enableDamping: true,
} as const

/** `<Clouds shadow-maxFar={1e5} />` in the story. */
export const CLOUD_SHADOW_MAX_FAR = 1e5

/** Plain ocean surface albedo (linear RGB, Lambertian as in takram's post-process lighting). */
export const OCEAN_ALBEDO = [0.006, 0.026, 0.07] as const
