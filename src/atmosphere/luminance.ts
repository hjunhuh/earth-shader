import {
  CIE_2DEG_CMF,
  MAX_LUMINOUS_EFFICACY,
  SOLAR_IRRADIANCE,
  SPECTRUM_LAMBDA_MAX,
  SPECTRUM_LAMBDA_MIN,
  XYZ_TO_SRGB,
} from './spectralData'
import { LAMBDA_B, LAMBDA_G, LAMBDA_R, type Vec3 } from './constants'

/**
 * Spectral radiance -> luminance conversion constants (Bruneton 2017,
 * model.cc ComputeSpectralRadianceToLuminanceFactors; "A Qualitative and
 * Quantitative Evaluation of 8 Clear Sky Models", §14.3).
 */

/** CIE 1931 2° CMF value (column 1 = x̄, 2 = ȳ, 3 = z̄), linear interpolation on the 5 nm table. */
export function cieCmf(lambda: number, column: 1 | 2 | 3): number {
  if (lambda <= SPECTRUM_LAMBDA_MIN || lambda >= SPECTRUM_LAMBDA_MAX) return 0
  let u = (lambda - SPECTRUM_LAMBDA_MIN) / 5
  const row = Math.floor(u)
  u -= row
  return CIE_2DEG_CMF[row]![column] * (1 - u) + CIE_2DEG_CMF[row + 1]![column] * u
}

/** Interpolates a 10 nm spectrum sampled from 360 nm. */
export function interpolateSpectrum(spectrum: readonly number[], lambda: number): number {
  const wavelengths = spectrum.map((_, i) => SPECTRUM_LAMBDA_MIN + 10 * i)
  if (lambda < wavelengths[0]!) return spectrum[0]!
  for (let i = 0; i < wavelengths.length - 1; ++i) {
    if (lambda < wavelengths[i + 1]!) {
      const u = (lambda - wavelengths[i]!) / (wavelengths[i + 1]! - wavelengths[i]!)
      return spectrum[i]! * (1 - u) + spectrum[i + 1]! * u
    }
  }
  return spectrum[spectrum.length - 1]!
}

function rgbBar(lambda: number): Vec3 {
  const x = cieCmf(lambda, 1)
  const y = cieCmf(lambda, 2)
  const z = cieCmf(lambda, 3)
  const m = XYZ_TO_SRGB
  return [m[0]! * x + m[1]! * y + m[2]! * z, m[3]! * x + m[4]! * y + m[5]! * z, m[6]! * x + m[7]! * y + m[8]! * z]
}

export function spectralRadianceToLuminanceFactors(lambdaPower: number, solar = SOLAR_IRRADIANCE): Vec3 {
  const k: Vec3 = [0, 0, 0]
  const lambdas = [LAMBDA_R, LAMBDA_G, LAMBDA_B]
  const solarRgb = lambdas.map((l) => interpolateSpectrum(solar, l))
  for (let lambda = SPECTRUM_LAMBDA_MIN; lambda < SPECTRUM_LAMBDA_MAX; ++lambda) {
    const bar = rgbBar(lambda)
    const irradiance = interpolateSpectrum(solar, lambda)
    for (let c = 0; c < 3; ++c) {
      k[c] += ((bar[c]! * irradiance) / solarRgb[c]!) * (lambda / lambdas[c]!) ** lambdaPower
    }
  }
  return k.map((v) => v * MAX_LUMINOUS_EFFICACY) as Vec3
}

/** SKY_SPECTRAL_RADIANCE_TO_LUMINANCE (λ^-3 weighting, Rayleigh-like spectra). */
export const SKY_SPECTRAL_RADIANCE_TO_LUMINANCE = spectralRadianceToLuminanceFactors(-3)
/** SUN_SPECTRAL_RADIANCE_TO_LUMINANCE. */
export const SUN_SPECTRAL_RADIANCE_TO_LUMINANCE = spectralRadianceToLuminanceFactors(0)

/** Linear sRGB "luminance" of a full spectrum (Bruneton's ConvertSpectrumToLinearSrgb). */
export function spectrumToLinearSrgb(spectrumAt: (lambda: number) => number): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  for (let lambda = SPECTRUM_LAMBDA_MIN; lambda < SPECTRUM_LAMBDA_MAX; ++lambda) {
    const v = spectrumAt(lambda)
    x += cieCmf(lambda, 1) * v
    y += cieCmf(lambda, 2) * v
    z += cieCmf(lambda, 3) * v
  }
  const m = XYZ_TO_SRGB
  return [
    MAX_LUMINOUS_EFFICACY * (m[0]! * x + m[1]! * y + m[2]! * z),
    MAX_LUMINOUS_EFFICACY * (m[3]! * x + m[4]! * y + m[5]! * z),
    MAX_LUMINOUS_EFFICACY * (m[6]! * x + m[7]! * y + m[8]! * z),
  ]
}

/**
 * White point that maps the extraterrestrial solar spectrum to neutral
 * (normalized to mean 1). The composite pass divides by it, like a camera
 * white-balanced for sunlight.
 */
export const SOLAR_WHITE_POINT: Vec3 = (() => {
  const wp = spectrumToLinearSrgb((l) => interpolateSpectrum(SOLAR_IRRADIANCE, l))
  const mean = (wp[0] + wp[1] + wp[2]) / 3
  return wp.map((v) => v / mean) as Vec3
})()

/** CIE 1931 xy chromaticity of linear sRGB. */
export function linearSrgbToXy([r, g, b]: Vec3): [number, number] {
  // sRGB (D65) -> XYZ
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b
  const s = X + Y + Z
  return [X / s, Y / s]
}

/** McCamy (1992) correlated color temperature from xy [K]. */
export function mccamyCct([x, y]: [number, number]): number {
  const n = (x - 0.332) / (0.1858 - y)
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33
}
