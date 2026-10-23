import type { Quality } from '../app/state'
import type { DefineInput } from '../render/shaderLib'

/** Per-preset knobs (see plan: 품질 프리셋). */
export interface QualityPreset {
  /** Cloud render resolution relative to the screen (before temporal upscale). */
  resolutionScale: number
  /** Temporal upscale factor per axis (1 = none, 2 = 2×2, 4 = 4×4 Bayer). */
  temporalUpscale: 1 | 2 | 4
  maxPrimarySteps: number
  /** Step size as a fraction of the ray distance (α). */
  stepScale: number
  minStep: number
  maxStep: number
  lightSteps: number
  msOctaves: number
  shapeDetail: 'off' | 'near' | 'on'
  turbulence: boolean
  oceanShadowSteps: number
  sunOpticalDepthSize: number
  weatherSize: number
  lightShaftSamples: number
  minTransmittance: number
}

export const QUALITY_PRESETS: Readonly<Record<Quality, QualityPreset>> = {
  low: {
    resolutionScale: 0.5,
    temporalUpscale: 4,
    maxPrimarySteps: 64,
    stepScale: 0.02,
    minStep: 80,
    maxStep: 1000,
    lightSteps: 2,
    msOctaves: 3,
    shapeDetail: 'off',
    turbulence: false,
    oceanShadowSteps: 4,
    sunOpticalDepthSize: 128,
    weatherSize: 1024,
    lightShaftSamples: 0,
    minTransmittance: 0.1,
  },
  medium: {
    resolutionScale: 0.75,
    temporalUpscale: 4,
    maxPrimarySteps: 128,
    stepScale: 0.015,
    minStep: 60,
    maxStep: 800,
    lightSteps: 3,
    msOctaves: 4,
    shapeDetail: 'near',
    turbulence: false,
    oceanShadowSteps: 8,
    sunOpticalDepthSize: 256,
    weatherSize: 1024,
    lightShaftSamples: 0,
    minTransmittance: 0.05,
  },
  high: {
    resolutionScale: 1,
    temporalUpscale: 4,
    maxPrimarySteps: 256,
    stepScale: 0.01,
    minStep: 50,
    maxStep: 600,
    lightSteps: 4,
    msOctaves: 6,
    shapeDetail: 'on',
    turbulence: true,
    oceanShadowSteps: 12,
    sunOpticalDepthSize: 256,
    weatherSize: 1024,
    lightShaftSamples: 64,
    minTransmittance: 0.01,
  },
  ultra: {
    resolutionScale: 1,
    temporalUpscale: 2,
    maxPrimarySteps: 384,
    stepScale: 0.007,
    minStep: 40,
    maxStep: 500,
    lightSteps: 6,
    msOctaves: 8,
    shapeDetail: 'on',
    turbulence: true,
    oceanShadowSteps: 16,
    sunOpticalDepthSize: 512,
    weatherSize: 2048,
    lightShaftSamples: 128,
    minTransmittance: 0.005,
  },
}

export interface CloudDefineOptions {
  enabled: boolean
  /** Disable non-physical terms (powder) for measured tests. */
  physical: boolean
  shadows: boolean
  weatherMode: 0 | 1 | 2 | 3
}

/**
 * Pure mapping preset → shader defines. Materials apply it through
 * applyDefines(), which recompiles only when the resulting set differs, so a
 * define can never be left stale by toggling the wrong flag (report §7).
 */
export function presetToDefines(preset: QualityPreset, opts: CloudDefineOptions): DefineInput {
  if (!opts.enabled) return { CLOUDS: false }
  return {
    CLOUDS: true,
    CLOUD_SHADOWS: opts.shadows,
    MAX_PRIMARY_STEPS: preset.maxPrimarySteps,
    LIGHT_STEPS: preset.lightSteps,
    MS_OCTAVES: preset.msOctaves,
    OCEAN_SHADOW_STEPS: preset.oceanShadowSteps,
    SHAPE_DETAIL: preset.shapeDetail !== 'off',
    SHAPE_DETAIL_NEAR_ONLY: preset.shapeDetail === 'near',
    TURBULENCE: preset.turbulence,
    POWDER: !opts.physical,
    LIGHT_SHAFTS: preset.lightShaftSamples > 0,
    LIGHT_SHAFT_SAMPLES: preset.lightShaftSamples,
    WEATHER_MODE: opts.weatherMode,
  }
}

/** Rough per-pixel cost proxy (steps × lighting work), for ordering tests. */
export function presetCost(p: QualityPreset): number {
  const pixels = (p.resolutionScale / p.temporalUpscale) ** 2
  return pixels * p.maxPrimarySteps * (1 + p.lightSteps + p.msOctaves * 0.1)
}
