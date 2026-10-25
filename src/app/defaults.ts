/**
 * Defaults mirror the takram three-geospatial "clouds/Clouds/Basic" story
 * (storybook/src/clouds/Clouds-Basic.tsx) so the two render the same scene.
 * The one intentional difference is timeOfDay = 8.0 (requested default).
 */

export const QUALITIES = ['low', 'medium', 'high', 'ultra'] as const
export type Quality = (typeof QUALITIES)[number]

/** 'realistic': area-integrated limb-darkened disk + physically based glare. 'takram': takram's own sky disk. */
export const SUN_MODELS = ['realistic', 'takram'] as const
export type SunModel = (typeof SUN_MODELS)[number]
/** 'realistic': the true-scale Moon (position, size, photometry, eclipses). 'takram': takram's fixed-size sky disk. */
export const MOON_MODELS = ['realistic', 'takram'] as const
export type MoonModel = (typeof MOON_MODELS)[number]
export const GLARE_LIMITS = { min: 0, max: 1.5 } as const
export const CORONA_LIMITS = { min: 0, max: 1 } as const

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

/** heightScale: vertical exaggeration. brightness: albedo factor for the map colors. */
export const TERRAIN_LIMITS = {
  heightScale: { min: 0, max: 10 },
  brightness: { min: 0.05, max: 1 },
} as const

export const DEFAULTS = {
  location: { longitude: 30, latitude: 35, altitude: 300 },
  date: { dayOfYear: 1, timeOfDay: 8 },
  cloud: { enabled: true, quality: 'high' as Quality, coverage: 0.3, animate: false },
  sun: { model: 'realistic' as SunModel, glare: 0.1, corona: 0.5 },
  moon: { model: 'realistic' as MoonModel },
  toneMapping: { mode: 'AgX' as ToneMappingName, exposure: 10 },
  atmosphere: { correctAltitude: true },
  // Satellite colors are close to surface albedo already.
  terrain: { enabled: true, heightScale: 1, brightness: 1 },
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

/**
 * Earth camera controls. 'globe' (default): Google Earth style, the globe
 * turns under the cursor, starting straight down over the location. 'orbit':
 * the takram story's OrbitControls around the location (the reference the
 * parity tests compare against).
 */
export const EARTH_CONTROLS = ['globe', 'orbit'] as const
export type EarthControlsName = (typeof EARTH_CONTROLS)[number]

export const GLOBE = {
  /** Starting camera height over the location: the whole Earth fills ~60% of the view. */
  initialAltitude: 1e7,
  /** Farthest the controls zoom out, from the Earth's center (meters). */
  maxDistance: 1e8,
} as const

/** `<Clouds shadow-maxFar={1e5} />` in the story. */
export const CLOUD_SHADOW_MAX_FAR = 1e5

/** Plain ocean surface albedo (linear RGB, Lambertian as in takram's post-process lighting). */
export const OCEAN_ALBEDO = [0.006, 0.026, 0.07] as const

/**
 * Imagery and elevation tiles (Web Mercator XYZ). Both are open data, need no
 * key and send CORS headers.
 * - Imagery: EOX Sentinel-2 cloudless 2016 (CC BY 4.0, https://cloudless.eox.at):
 *   a cloud-free satellite mosaic without labels, 10 m pixels, so real detail
 *   ends at z13. EOX applies a fair-use policy and asks for visible credit.
 * - Elevation: AWS Terrain Tiles, Terrarium encoding, z0–15, meters above
 *   mean sea level with ETOPO1 bathymetry (negative under the sea).
 */
export const TERRAIN = {
  imageryUrl: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg',
  /** z0–13: deeper levels exist but are only upsampled, so the terrain reuses z13. */
  imageryLevels: 14,
  elevationUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  elevationMaxZoom: 15,
  /** Screen-space error in pixels; higher loads fewer tiles. */
  errorTarget: 3,
  /** The Earth camera never goes closer than this to the ground (meters). */
  minClearance: 30,
} as const
