/**
 * Map-color helpers for the terrain, mirrored by the GLSL in Terrain.ts.
 */

/** OpenStreetMap Carto's water fill, #aad3df. */
export const OSM_WATER_SRGB = [0xaa / 255, 0xd3 / 255, 0xdf / 255] as const

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export const OSM_WATER_LINEAR = OSM_WATER_SRGB.map(srgbToLinear) as [number, number, number]

/** Linear-RGB distance below which a map texel is fully water, and above which it is fully land. */
export const WATER_EDGE = [0.02, 0.08] as const

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** 1 for OSM water, 0 for anything else, smooth across anti-aliased coastlines. */
export function waterWeight(linear: readonly [number, number, number]): number {
  const d = Math.hypot(linear[0] - OSM_WATER_LINEAR[0], linear[1] - OSM_WATER_LINEAR[1], linear[2] - OSM_WATER_LINEAR[2])
  return 1 - smoothstep(WATER_EDGE[0], WATER_EDGE[1], d)
}
