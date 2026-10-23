import { Vector4 } from 'three'

/**
 * Up to four cloud layers, one per vec4 channel, so all density math runs
 * once per sample on vec4s (report §2.1).
 */
export interface DensityProfile {
  /** ρ(f) = expTerm · exp(exponent · f) + linearTerm · f + constantTerm, f = height fraction. */
  expTerm: number
  exponent: number
  linearTerm: number
  constantTerm: number
}

export interface CloudLayer {
  /** Base altitude [m]. 0 height disables the layer. */
  altitude: number
  /** Thickness [m]. */
  height: number
  /** Extinction coefficient at density 1 [1/m]. */
  densityScale: number
  /** 3D shape erosion strength (0 = none). */
  shapeAmount: number
  /** 3D detail erosion strength. */
  detailAmount: number
  /** Exponent applied to the weather (coverage) value. */
  weatherExponent: number
  /** Shape-altering bias: S(f) = 1 − (2f^bias − 1)². */
  shapeAlteringBias: number
  /** Softness of the coverage threshold. */
  coverageFilterWidth: number
  densityProfile: DensityProfile
  /** Whether this layer casts shadows. */
  shadow: boolean
}

const EMPTY: CloudLayer = {
  altitude: 0,
  height: 0,
  densityScale: 0,
  shapeAmount: 0,
  detailAmount: 0,
  weatherExponent: 1,
  shapeAlteringBias: 0.35,
  coverageFilterWidth: 0.6,
  densityProfile: { expTerm: 0, exponent: 0, linearTerm: 0.75, constantTerm: 0.25 },
  shadow: false,
}

/**
 * Defaults (report §2.1): low cumulus, mid layer, cirrus, empty. Extinction
 * is calibrated so typical columns reach τ ≈ 10–40 (cumulus/stratocumulus)
 * and cirrus stays τ < 1 (measured in tests/e2e/clouds.spec.ts).
 */
export const DEFAULT_LAYERS: readonly CloudLayer[] = [
  {
    ...EMPTY,
    altitude: 750,
    height: 650,
    densityScale: 0.06,
    shapeAmount: 1,
    detailAmount: 1,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.6,
    shadow: true,
  },
  {
    ...EMPTY,
    altitude: 1000,
    height: 1200,
    densityScale: 0.04,
    shapeAmount: 1,
    detailAmount: 1,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.6,
    shadow: true,
  },
  {
    ...EMPTY,
    altitude: 7500,
    height: 500,
    densityScale: 0.0008,
    shapeAmount: 0.4,
    detailAmount: 0,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.5,
    densityProfile: { expTerm: 0, exponent: 0, linearTerm: 0, constantTerm: 1 },
    shadow: true,
  },
  EMPTY,
]

export interface Interval {
  min: number
  max: number
}

/**
 * Merges active layer intervals; returns the overall shell [min, max] and
 * the empty gaps between merged intervals (at most 3, report §2.1) so the
 * ray marcher can skip them.
 */
export function packIntervals(layers: readonly CloudLayer[]): { shell: Interval; gaps: Interval[] } {
  const active = layers
    .filter((l) => l.height > 0)
    .map((l) => ({ min: l.altitude, max: l.altitude + l.height }))
    .sort((a, b) => a.min - b.min)
  if (active.length === 0) return { shell: { min: 0, max: 0 }, gaps: [] }
  const merged: Interval[] = [{ ...active[0]! }]
  for (const iv of active.slice(1)) {
    const last = merged[merged.length - 1]!
    if (iv.min <= last.max) last.max = Math.max(last.max, iv.max)
    else merged.push({ ...iv })
  }
  const gaps: Interval[] = []
  for (let i = 1; i < merged.length; ++i) gaps.push({ min: merged[i - 1]!.max, max: merged[i]!.min })
  return { shell: { min: merged[0]!.min, max: merged[merged.length - 1]!.max }, gaps: gaps.slice(0, 3) }
}

export interface PackedLayers {
  minHeights: Vector4
  maxHeights: Vector4
  densityScales: Vector4
  shapeAmounts: Vector4
  detailAmounts: Vector4
  weatherExponents: Vector4
  shapeAlteringBiases: Vector4
  coverageFilterWidths: Vector4
  profileExpTerms: Vector4
  profileExponents: Vector4
  profileLinearTerms: Vector4
  profileConstantTerms: Vector4
  shadowMask: Vector4
  shellMin: number
  shellMax: number
  /** Gap intervals packed as (min, max) pairs in xy / zw; unused = (0, 0). */
  gapsA: Vector4
  gapB: Vector4
}

export function packLayers(layers: readonly CloudLayer[]): PackedLayers {
  const l = [0, 1, 2, 3].map((i) => layers[i] ?? EMPTY)
  const v = (f: (x: CloudLayer) => number) => new Vector4(f(l[0]!), f(l[1]!), f(l[2]!), f(l[3]!))
  const { shell, gaps } = packIntervals(l)
  const g = (i: number) => gaps[i] ?? { min: 0, max: 0 }
  return {
    minHeights: v((x) => x.altitude),
    maxHeights: v((x) => x.altitude + x.height),
    densityScales: v((x) => (x.height > 0 ? x.densityScale : 0)),
    shapeAmounts: v((x) => x.shapeAmount),
    detailAmounts: v((x) => x.detailAmount),
    weatherExponents: v((x) => x.weatherExponent),
    shapeAlteringBiases: v((x) => x.shapeAlteringBias),
    coverageFilterWidths: v((x) => x.coverageFilterWidth),
    profileExpTerms: v((x) => x.densityProfile.expTerm),
    profileExponents: v((x) => x.densityProfile.exponent),
    profileLinearTerms: v((x) => x.densityProfile.linearTerm),
    profileConstantTerms: v((x) => x.densityProfile.constantTerm),
    shadowMask: v((x) => (x.shadow && x.height > 0 ? 1 : 0)),
    shellMin: shell.min,
    shellMax: shell.max,
    gapsA: new Vector4(g(0).min, g(0).max, g(1).min, g(1).max),
    gapB: new Vector4(g(2).min, g(2).max, 0, 0),
  }
}

/** Shape-altering function S(f) = 1 − (2 f^bias − 1)² (TS twin of clouds/density.glsl). */
export function shapeAltering(f: number, bias: number): number {
  const x = 2 * Math.max(0, f) ** bias - 1
  return 1 - x * x
}
