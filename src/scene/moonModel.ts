import { AstroTime, Body, GeoVector, KM_PER_AU } from 'astronomy-engine'
import { Matrix4, Quaternion, Vector3 } from 'three'
import {
  getECIToECEFRotationMatrix,
  getMoonFixedToECIRotationMatrix,
  getSunDirectionECI as getGeometricSunDirectionECI,
} from '@takram/three-atmosphere'

/**
 * The Moon as a body at its true position and size (pure; shared by Moon,
 * MoonEffect, navigation and the tests). Units: meters, radians unless noted.
 *
 * Ephemeris: astronomy-engine (the library takram's sun/moon directions use),
 * geocentric J2000 vectors; ECEF via takram's ECI→ECEF. The scene's Sun is
 * takram's getSunDirectionECI, which omits aberration (~20″); the atmosphere
 * and clouds are built on it, so it stays. The Moon is placed at its
 * *apparent* position rotated by the same 20″ (apparent Sun → takram's Sun):
 * the Sun–Moon geometry is then the apparent one, which eclipses need (20″ is
 * the difference between a total and a partial eclipse).
 *
 * Photometry: the Lunar-Lambert function of McEwen (1991, 1996),
 *   r = ρ/π · Ψ(α) · [2L(α)·μ0/(μ0+μ) + (1−L(α))·μ0],
 * where ρ is the local albedo, μ0/μ the cosines of incidence/emission and α
 * the phase angle. Ψ(α) is fixed so the integrated disk follows the observed
 * lunar phase curve (Allen's Astrophysical Quantities):
 *   V(α) = −12.73 + 0.026·|α| + 4e−9·α⁴   (α in degrees, mean distance),
 * against V☉ = −26.74. At full moon this gives the geometric albedo
 * p = 10^(−0.4·(V(0) − V☉)) / (R/d)² ≈ 0.12.
 */

export const MOON_RADIUS = 1737400
/** Mean Earth–Moon distance used by the photometric reference. */
export const MOON_MEAN_DISTANCE = 384400e3
export const AU = KM_PER_AU * 1000

export const SUN_V_MAG = -26.74
export const FULL_MOON_V_MAG = -12.73

/** Geometric albedo implied by the magnitudes above (≈ 0.122). */
export const GEOMETRIC_ALBEDO = 10 ** (-0.4 * (FULL_MOON_V_MAG - SUN_V_MAG)) / (MOON_RADIUS / MOON_MEAN_DISTANCE) ** 2

/**
 * Mean linear value (G channel) of public/moon/color.jpg over the near side,
 * weighted by projected area at full moon. Texture × (p / this) = albedo.
 */
export const COLOR_TEXTURE_NEAR_SIDE_MEAN = 0.2237
export const ALBEDO_SCALE = GEOMETRIC_ALBEDO / COLOR_TEXTURE_NEAR_SIDE_MEAN

/** Earth's shadow: mean radius enlarged ~1/85 by the atmosphere (Danjon). */
export const EARTH_MEAN_RADIUS = 6371008.8
export const EARTH_SHADOW_RADIUS = EARTH_MEAN_RADIUS * (1 + 1 / 85)
/** Bond albedo of the Earth, for earthshine. */
export const EARTH_ALBEDO = 0.3
/** Umbral brightness relative to direct sunlight (refracted, reddened light; Danjon L ≈ 2–3). */
export const UMBRA_GLOW = [2.2e-4, 0.9e-4, 0.35e-4] as const

const DEG = Math.PI / 180

// --- ephemeris ---------------------------------------------------------------

const toTime = (date: number | Date) => new AstroTime(new Date(date))

/** Apparent geocentric direction of the Sun in ECI (J2000 equatorial). */
export function getApparentSunDirectionECI(date: number | Date, result = new Vector3()): Vector3 {
  const v = GeoVector(Body.Sun, toTime(date), true)
  return result.set(v.x, v.y, v.z).normalize()
}

/** Apparent geocentric position of the Moon's center in ECI (J2000 equatorial), meters. */
export function getApparentMoonPositionECI(date: number | Date, result = new Vector3()): Vector3 {
  const v = GeoVector(Body.Moon, toTime(date), true)
  return result.set(v.x, v.y, v.z).multiplyScalar(AU)
}

const apparentSun = new Vector3()
const geometricSun = new Vector3()
const aberration = new Quaternion()

/**
 * The Moon's center in ECI, meters, in the frame of the scene's Sun (takram's
 * getSunDirectionECI): apparent position × (apparent Sun → takram's Sun).
 */
export function getMoonPositionECI(date: number | Date, result = new Vector3()): Vector3 {
  getApparentSunDirectionECI(date, apparentSun)
  getGeometricSunDirectionECI(date, geometricSun)
  aberration.setFromUnitVectors(apparentSun, geometricSun)
  return getApparentMoonPositionECI(date, result).applyQuaternion(aberration)
}

const eciToEcefScratch = new Matrix4()

/** Moon's center in ECEF meters. */
export function getMoonPositionECEF(date: number | Date, result = new Vector3(), eciToECEF?: Matrix4): Vector3 {
  return getMoonPositionECI(date, result).applyMatrix4(eciToECEF ?? getECIToECEFRotationMatrix(date, eciToEcefScratch))
}

/** Rotation from the Moon's body-fixed frame (IAU; x = prime meridian, z = north pole) to ECEF. */
export function getMoonFixedToECEF(date: number | Date, result = new Matrix4(), eciToECEF?: Matrix4): Matrix4 {
  getMoonFixedToECIRotationMatrix(date, result)
  return result.premultiply(eciToECEF ?? getECIToECEFRotationMatrix(date, eciToEcefScratch))
}

// --- photometry --------------------------------------------------------------

/** McEwen's lunar L(α), α in degrees, clamped to [0, 1]. */
export function lunarLambertL(alphaDeg: number): number {
  const a = Math.abs(alphaDeg)
  return Math.min(1, Math.max(0, 1 - 0.019 * a + 2.42e-4 * a * a - 1.46e-6 * a * a * a))
}

/** Bracketed Lunar-Lambert term (without ρ/π and Ψ). */
export function lunarLambert(mu0: number, mu: number, alphaDeg: number): number {
  if (mu0 <= 0 || mu <= 0) return 0
  const L = lunarLambertL(alphaDeg)
  return (2 * L * mu0) / (mu0 + mu) + (1 - L) * mu0
}

/** Observed integrated brightness relative to full moon at the same distance. */
export function observedPhaseCurve(alphaDeg: number): number {
  const a = Math.abs(alphaDeg)
  return 10 ** (-0.4 * (0.026 * a + 4e-9 * a ** 4))
}

/**
 * ∫ lunarLambert · μ dA over the visible disk / π (uniform albedo), i.e. the
 * integrated brightness relative to a flat full disk. 1 at α = 0.
 */
export function lunarLambertDiskIntegral(alphaDeg: number, n = 160): number {
  const alpha = alphaDeg * DEG
  // Observer along +z; sun in the x–z plane at phase angle α.
  const sx = Math.sin(alpha)
  const sz = Math.cos(alpha)
  let sum = 0
  const h = 2 / n
  for (let j = 0; j < n; ++j) {
    const y = -1 + (j + 0.5) * h
    for (let i = 0; i < n; ++i) {
      const x = -1 + (i + 0.5) * h
      const r2 = x * x + y * y
      if (r2 >= 1) continue
      const mu = Math.sqrt(1 - r2) // = normal.z
      const mu0 = x * sx + mu * sz
      sum += lunarLambert(mu0, mu, alphaDeg) * h * h
    }
  }
  return sum / Math.PI
}

/** Ψ(α) sampled every PHASE_STEP degrees from 0 to 180 (shader lookup table). */
export const PHASE_STEP = 2
export const PHASE_TABLE: readonly number[] = Array.from({ length: 180 / PHASE_STEP + 1 }, (_, i) => {
  const a = Math.min(i * PHASE_STEP, 170) // the curve and the integral both vanish at 180°
  return observedPhaseCurve(a) / lunarLambertDiskIntegral(a, 120)
})

export function phaseCorrection(alphaDeg: number): number {
  const x = Math.min(180, Math.max(0, Math.abs(alphaDeg))) / PHASE_STEP
  const i = Math.min(PHASE_TABLE.length - 2, Math.floor(x))
  const f = x - i
  return PHASE_TABLE[i]! * (1 - f) + PHASE_TABLE[i + 1]! * f
}

/** Radiance factor r = L / E☉ at a surface point (uniform albedo ρ). */
export function lunarRadianceFactor(albedo: number, mu0: number, mu: number, alphaDeg: number): number {
  return (albedo / Math.PI) * phaseCorrection(alphaDeg) * lunarLambert(mu0, mu, alphaDeg)
}

// --- shadows and earthshine --------------------------------------------------

/**
 * Area of the overlap of two disks of radii a, b with centers c apart (small
 * angles: planar).
 */
export function diskOverlapArea(a: number, b: number, c: number): number {
  if (c >= a + b) return 0
  if (c <= Math.abs(a - b)) return Math.PI * Math.min(a, b) ** 2
  const a2 = a * a
  const b2 = b * b
  const alpha = Math.acos(Math.min(1, Math.max(-1, (c * c + a2 - b2) / (2 * c * a))))
  const beta = Math.acos(Math.min(1, Math.max(-1, (c * c + b2 - a2) / (2 * c * b))))
  return a2 * (alpha - Math.sin(2 * alpha) / 2) + b2 * (beta - Math.sin(2 * beta) / 2)
}

/**
 * Fraction of the solar disk visible from `point` past the Earth (shadow
 * radius EARTH_SHADOW_RADIUS centered at `earthCenter`). 1 = full sunlight,
 * 0 = umbra.
 */
export function sunVisibleFraction(
  point: Vector3,
  sunDirection: Vector3,
  earthCenter: Vector3,
  sunAngularRadius: number,
  shadowRadius = EARTH_SHADOW_RADIUS,
): number {
  const toEarth = new Vector3().subVectors(earthCenter, point)
  const distance = toEarth.length()
  const earthAngularRadius = Math.asin(Math.min(1, shadowRadius / distance))
  const separation = 2 * Math.asin(Math.min(1, toEarth.divideScalar(distance).sub(sunDirection).length() / 2))
  const covered = diskOverlapArea(sunAngularRadius, earthAngularRadius, separation)
  return Math.max(0, 1 - covered / (Math.PI * sunAngularRadius * sunAngularRadius))
}

/** Lambert-sphere phase function (Φ(0) = 1). */
export function lambertPhase(beta: number): number {
  return (Math.sin(beta) + (Math.PI - beta) * Math.cos(beta)) / Math.PI
}

/**
 * Earthshine illuminance at the Moon relative to the solar irradiance:
 * a Lambert sphere of albedo A seen at phase angle β from distance d.
 */
export function earthshineRatio(beta: number, distance: number): number {
  return EARTH_ALBEDO * (2 / 3) * (EARTH_MEAN_RADIUS / distance) ** 2 * lambertPhase(beta)
}
