/**
 * Constants of the sun model (pure, shared by SunEffect and the tests).
 *
 * Point spread function: Spencer, Shirley, Zimmerman, Greenberg 1995,
 * "Physically-Based Glare Effects for Digital Images", photopic case:
 *   PSF(θ) = 0.384 f0 + 0.478 f1 + 0.138 f2,  θ in degrees, per steradian
 *   f0 = 2.61e6 exp(−(θ/0.02)²)   core: the image of the disk itself
 *   f1 = 20.91 / (θ + 0.02)³      ocular scattering
 *   f2 = 72.37 / (θ + 0.02)²      veiling glare
 * Each term integrates to ≈ 1 over the sphere, so f1 and f2 carry
 * 0.478 + 0.138 = 61.6% of the light; the glare adds only those two terms and
 * the disk keeps the rest.
 */
export const SPENCER = {
  w0: 0.384,
  w1: 0.478,
  w2: 0.138,
  a0: 2.61e6,
  a1: 20.91,
  a2: 72.37,
  offset: 0.02,
} as const

/** Scattered (glare) share of the PSF at glare = 1. */
export const SCATTERED_FRACTION = SPENCER.w1 + SPENCER.w2

/** Fraction of the sun's energy moved from the disk into the glare. */
export function glareFraction(glare: number): number {
  return Math.min(0.95, Math.max(0, glare) * SCATTERED_FRACTION)
}

/** Glare part of the PSF per steradian at an angle in degrees. */
export function glarePsf(degrees: number): number {
  const t = degrees + SPENCER.offset
  return (SPENCER.w1 * SPENCER.a1) / (t * t * t) + (SPENCER.w2 * SPENCER.a2) / (t * t)
}

/** Individual PSF terms per steradian (θ in degrees). */
export const psfTerms = {
  f0: (d: number) => SPENCER.a0 * Math.exp(-((d / 0.02) ** 2)),
  f1: (d: number) => SPENCER.a1 / (d + SPENCER.offset) ** 3,
  f2: (d: number) => SPENCER.a2 / (d + SPENCER.offset) ** 2,
}

/**
 * Linear limb-darkening coefficients I(μ)/I(1) = 1 − u(1 − μ) for the R, G, B
 * channels (≈ 650, 550, 450 nm): the solar limb is darker and redder than the
 * center (e.g. Cox, Allen's Astrophysical Quantities, u ≈ 0.55–0.8 in the visible).
 */
export const LIMB_DARKENING = [0.56, 0.64, 0.78] as const

/** Solid angle of a disk of angular radius r (radians). */
export function sunDiskSolidAngle(radius: number): number {
  return 2 * Math.PI * (1 - Math.cos(radius))
}
