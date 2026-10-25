import type { PrecomputedTexturesGenerator } from '@takram/three-atmosphere'

/**
 * Fix for a bright sky seen from just below the top of the atmosphere
 * (camera within ~4 km under it, e.g. 56–60 km with correctAltitude) in
 * @takram/three-atmosphere 0.19.1: every ray above the camera's horizontal
 * renders as blue sky over a black band, instead of black space.
 *
 * Cause: one bad texel row in the precomputed scattering LUT. The precompute
 * recovers mu for each texel as (H² − rho² − d²) / (2·r·d). For the top r
 * slice's first sky row, r = top and d = d_min = top − r, so mu is exactly 1
 * (zenith, zero-length ray, zero scattering). In float32, r = sqrt(rho² + b²)
 * misses top by a rounding error, d becomes that tiny error instead of 0, and
 * the formula turns into rounding noise / rounding noise. The texel then holds
 * the scattering of a long downward ray (~0.36 instead of ~0.001). Runtime
 * lookups interpolate between the top two r slices (~3.8 km apart), so
 * upward rays from a camera inside that last slice pick it up.
 *
 * The patch uses the identity H² − rho² = top² − r² = d_min·(top + r), which
 * has no cancellation: at d = d_min it gives (top + r − d_min) / 2r = 1.
 * Elsewhere it is the same value up to float rounding.
 */
const ANCHOR = `    mu = d == 0.0 * m ? Number(1.0) :
        ClampCosine((H * H - rho * rho - d * d) / (2.0 * r * d));`

const FIX = `    // earth-shader: H² − rho² = d_min·(top + r), without cancellation, so
    // that d = d_min maps to mu = 1 even when r misses top by a rounding error.
    mu = d == 0.0 * m ? Number(1.0) :
        ClampCosine((d_min * (atmosphere.top_radius + r) - d * d) / (2.0 * r * d));`

export function patchScatteringLutShader(source: string): string {
  const first = source.indexOf(ANCHOR)
  if (first < 0) throw new Error('scatteringLutFix: GetRMuMuSNuFromScatteringTextureUvwz not found (takram shader changed?)')
  if (source.indexOf(ANCHOR, first + 1) >= 0) throw new Error('scatteringLutFix: anchor is not unique')
  return source.replace(ANCHOR, FIX)
}

/** Patch the generator's scattering precompute passes. Call before `generator.update()`. */
export function applyScatteringLutFix<T extends PrecomputedTexturesGenerator>(generator: T): T {
  for (const material of [
    generator.singleScatteringMaterial,
    generator.scatteringDensityMaterial,
    generator.multipleScatteringMaterial,
  ]) {
    material.fragmentShader = patchScatteringLutShader(material.fragmentShader)
    material.needsUpdate = true
  }
  return generator
}
