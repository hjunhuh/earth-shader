/** TS twin of src/shaders/clouds/lighting.glsl and a slab integrator for calibration. */

const INV_4PI = 1 / (4 * Math.PI)
const INV_PI = 1 / Math.PI

export const CLOUD = {
  gForward: 0.7,
  gBack: -0.2,
  lobeMix: 0.5,
  msA: 0.1,
  msB: 0.5,
  msC: 0.5,
  diffusionA: 0.8,
}

export function henyeyGreenstein(cosTheta: number, g: number): number {
  const g2 = g * g
  return (INV_4PI * (1 - g2)) / Math.max(1 + g2 - 2 * g * cosTheta, 1e-6) ** 1.5
}

export function dualLobePhase(cosTheta: number, scale = 1): number {
  const a = henyeyGreenstein(cosTheta, CLOUD.gForward * scale)
  const b = henyeyGreenstein(cosTheta, CLOUD.gBack * scale)
  return a + (b - a) * CLOUD.lobeMix
}

export function octaveScattering(cosTheta: number, tauSun: number, octaves: number, tauColumn = Infinity): number {
  const P = 1 - Math.exp(-tauColumn)
  let sum = 0
  let a = 1
  let b = 1
  let c = 1
  for (let i = 0; i < octaves; ++i) {
    sum += a * dualLobePhase(cosTheta, c) * Math.exp(-b * tauSun)
    a *= CLOUD.msA * P
    b *= CLOUD.msB
    c *= CLOUD.msC
  }
  return sum
}

export const lacisHansenReflectance = (tau: number) => (0.13 * tau) / (1 + 0.13 * tau)

/**
 * Per-unit-σ in-scattered luminance for unit sun illuminance plus a sky
 * illuminance `skyRatio` (relative to the sun) at height fraction hf.
 */
export function cloudSource(cosTheta: number, tauSun: number, tauColumn: number, octaves: number, skyRatio = 0, hf = 1): number {
  const tc = Math.max(tauColumn, tauSun + 1e-4)
  const f = Math.min(1, Math.max(0, tauSun / tc))
  const R = lacisHansenReflectance(tc)
  const Td = Math.max(0, 1 - R - Math.exp(-tc))
  const w = 0.5 - 0.5 * cosTheta
  const diffusion = CLOUD.diffusionA * INV_PI * (w * R * (1 - f) + (1 - w) * Td * f)
  const sky = skyRatio * INV_PI * 0.5 * (0.6 + 0.4 * hf)
  return octaveScattering(cosTheta, tauSun, octaves, tc) + diffusion + sky
}

/**
 * Reflectance (π L / E μ0) of a uniform slab of optical thickness τ, sun at
 * zenith, observed from straight above (or transmittance factor from below).
 */
export function slabReflectance(tau: number, octaves = 6, fromBelow = false, steps = 4000, skyRatio = 0): number {
  // Optical depth coordinate t from the top (sun side).
  const dt = tau / steps
  let L = 0
  let T = 1
  for (let i = 0; i < steps; ++i) {
    const tTop = (i + 0.5) * dt
    // View path: from above the viewer enters at the top; from below at the bottom.
    const tSun = tTop
    const cosTheta = fromBelow ? 1 : -1 // backscatter seen from above, forward from below
    const J = cloudSource(cosTheta, tSun, tau, octaves, skyRatio, 1 - tTop / tau)
    if (fromBelow) {
      // March from the bottom upward: depth from viewer = tau - tTop.
      continue
    }
    // Analytic integration over the step (Frostbite).
    const s = J
    L += T * (s - s * Math.exp(-dt))
    T *= Math.exp(-dt)
    void tTop
  }
  if (fromBelow) {
    T = 1
    for (let i = steps - 1; i >= 0; --i) {
      const tTop = (i + 0.5) * dt
      const J = cloudSource(1, tTop, tau, octaves, skyRatio, 1 - tTop / tau)
      L += T * (J - J * Math.exp(-dt))
      T *= Math.exp(-dt)
    }
    // Directly transmitted sun is not diffuse radiance; it is excluded here.
  }
  return Math.PI * L
}
