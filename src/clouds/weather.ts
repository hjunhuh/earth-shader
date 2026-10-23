import { Vector4 } from 'three'
import type { WeatherOverride } from '../app/state'

/**
 * Global climatology of cloudiness vs latitude (applied to procedural
 * weather): ITCZ convection near 5°N, clear subtropical highs (±25°),
 * mid-latitude storm tracks (±50°). Returns a [0, 1] cloudiness bias per
 * layer channel (low, mid, cirrus). Mirrors bake/weatherCube.glsl.
 */
export function climatology(latDeg: number): [number, number, number] {
  const g = (mu: number, sigma: number) => Math.exp(-0.5 * ((latDeg - mu) / sigma) ** 2)
  const itcz = g(5, 7)
  const subtropics = g(25, 8) + g(-25, 8)
  const storms = g(52, 12) + g(-52, 12)
  const polar = g(80, 10) + g(-80, 10)
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  const low = clamp(0.45 + 0.25 * itcz - 0.15 * subtropics + 0.25 * storms + 0.05 * polar)
  const mid = clamp(0.35 + 0.35 * itcz - 0.3 * subtropics + 0.3 * storms)
  const cirrus = clamp(0.3 + 0.4 * itcz - 0.25 * subtropics + 0.25 * storms - 0.1 * polar)
  return [low, mid, cirrus]
}

/** Weather mode for shaders: 0 procedural, 1 clear, 2 slab, 3 blob. */
export function weatherMode(w: WeatherOverride): 0 | 1 | 2 | 3 {
  switch (w.kind) {
    case 'procedural':
      return 0
    case 'clear':
      return 1
    case 'slab':
      return 2
    case 'blob':
      return 3
  }
}

/**
 * Synthetic weather parameters for measured tests:
 * slab → (bottom, top, σ_t = τ/(top−bottom), 0); blob → (bottom, top, radius, σ_t)
 * plus the blob center as a unit vector (geodetic normal, ECEF).
 */
export function syntheticWeatherUniforms(w: WeatherOverride): { params: Vector4; center: Vector4 } {
  if (w.kind === 'slab') {
    return { params: new Vector4(w.bottom, w.top, w.tau / (w.top - w.bottom), 0), center: new Vector4() }
  }
  if (w.kind === 'blob') {
    const lat = (w.lat * Math.PI) / 180
    const lon = (w.lon * Math.PI) / 180
    const c = new Vector4(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat), 0)
    // Cumulus-like extinction (σ ≈ 0.05 m⁻¹, Stephens 1978 range 0.025–0.12).
    return { params: new Vector4(w.bottom, w.top, w.radius, 0.05), center: c }
  }
  return { params: new Vector4(), center: new Vector4() }
}
