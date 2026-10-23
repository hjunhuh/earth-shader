import { WGS84_A } from '../geo/wgs84'
import { LUMINANCE_UNIT } from '../render/units'
import { SKY_SPECTRAL_RADIANCE_TO_LUMINANCE, SUN_SPECTRAL_RADIANCE_TO_LUMINANCE } from './luminance'
import { OZONE_CROSS_SECTION, SOLAR_IRRADIANCE, SPECTRUM_LAMBDA_MIN } from './spectralData'

/**
 * Earth atmosphere parameters (Bruneton 2017 demo values), sampled at the
 * three precomputed wavelengths. TS side uses meters; the GLSL constant
 * block uses kilometers (Bruneton's length unit) for float precision.
 */

export * from './constants'
import { LAMBDAS, TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT, SCATTERING_TEXTURE_R_SIZE, SCATTERING_TEXTURE_MU_SIZE, SCATTERING_TEXTURE_MU_S_SIZE, SCATTERING_TEXTURE_NU_SIZE, IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT, type Vec3 } from './constants'

export interface DensityProfileLayer {
  /** [m] (ignored for the top layer). */
  width: number
  expTerm: number
  /** [1/m] */
  expScale: number
  /** [1/m] */
  linearTerm: number
  constantTerm: number
}

/** Two layers, bottom to top (Bruneton's DensityProfile). */
export type DensityProfile = [DensityProfileLayer, DensityProfileLayer]

export interface AtmosphereParameters {
  /** Top-of-atmosphere solar irradiance [W m^-2 nm^-1]. */
  solarIrradiance: Vec3
  /** [rad] */
  sunAngularRadius: number
  /** [m] */
  bottomRadius: number
  /** [m] */
  topRadius: number
  rayleighDensity: DensityProfile
  /** [1/m] */
  rayleighScattering: Vec3
  mieDensity: DensityProfile
  /** [1/m] */
  mieScattering: Vec3
  /** [1/m] */
  mieExtinction: Vec3
  miePhaseFunctionG: number
  absorptionDensity: DensityProfile
  /** [1/m] */
  absorptionExtinction: Vec3
  groundAlbedo: Vec3
  /** Cosine of the maximum precomputed sun zenith angle. */
  muSMin: number
}

const EMPTY_LAYER: DensityProfileLayer = { width: 0, expTerm: 0, expScale: 0, linearTerm: 0, constantTerm: 0 }

const DOBSON_UNIT = 2.687e20
const MAX_OZONE_NUMBER_DENSITY = (300 * DOBSON_UNIT) / 15000
const RAYLEIGH = 1.24062e-6
const RAYLEIGH_SCALE_HEIGHT = 8000

/** Aerosol model: optical depth τ(λ) = β · λ[µm]^-α, exponential profile. */
export interface AerosolParameters {
  angstromAlpha: number
  angstromBeta: number
  /** [m] */
  scaleHeight: number
  singleScatteringAlbedo: number
  /** Cornette-Shanks asymmetry. */
  g: number
}

/** Bruneton 2017 demo: an extremely clean atmosphere (τ ≈ 0.005). */
export const AEROSOL_BRUNETON_2017: AerosolParameters = {
  angstromAlpha: 0,
  angstromBeta: 5.328e-3,
  scaleHeight: 1200,
  singleScatteringAlbedo: 0.9,
  g: 0.8,
}

/**
 * Typical clear day (τ550 ≈ 0.09, continental α = 1.3). Calibrated against
 * measured twilight illuminance and clear-sky zenith luminance; see
 * tests/e2e/atmosphere.spec.ts.
 */
export const AEROSOL_CLEAR_DAY: AerosolParameters = {
  angstromAlpha: 1.3,
  angstromBeta: 0.04,
  scaleHeight: 1200,
  singleScatteringAlbedo: 0.9,
  g: 0.76,
}

function spectralAt(table: readonly number[], lambda: number): number {
  const i = (lambda - SPECTRUM_LAMBDA_MIN) / 10
  if (!Number.isInteger(i)) throw new Error('Precomputed wavelengths must be on the 10 nm grid')
  return table[i]!
}

export interface AtmosphereOptions {
  /** Ozone absorption on/off (negative control for the blue hour test). */
  ozone?: boolean
  /** Aerosol model (default: typical clear day). */
  aerosol?: AerosolParameters
  /** Maximum sun zenith angle [deg]: 120 with float32 LUTs, 102 with half floats. */
  maxSunZenithDeg?: number
}

export function createEarthAtmosphere(options: AtmosphereOptions = {}): AtmosphereParameters {
  const ozone = options.ozone ?? true
  const aerosol = options.aerosol ?? AEROSOL_CLEAR_DAY
  const maxSunZenith = ((options.maxSunZenithDeg ?? 120) * Math.PI) / 180
  const perLambda = (f: (lambdaNm: number) => number): Vec3 => LAMBDAS.map(f) as Vec3
  const mie = (l: number) => (aerosol.angstromBeta / aerosol.scaleHeight) * (l * 1e-3) ** -aerosol.angstromAlpha
  return {
    solarIrradiance: perLambda((l) => spectralAt(SOLAR_IRRADIANCE, l)),
    sunAngularRadius: 0.00935 / 2,
    // Shading space turns the WGS84 ellipsoid into a sphere of radius a.
    bottomRadius: WGS84_A,
    topRadius: WGS84_A + 60_000,
    rayleighDensity: [EMPTY_LAYER, { width: 0, expTerm: 1, expScale: -1 / RAYLEIGH_SCALE_HEIGHT, linearTerm: 0, constantTerm: 0 }],
    rayleighScattering: perLambda((l) => RAYLEIGH * (l * 1e-3) ** -4),
    mieDensity: [EMPTY_LAYER, { width: 0, expTerm: 1, expScale: -1 / aerosol.scaleHeight, linearTerm: 0, constantTerm: 0 }],
    mieScattering: perLambda((l) => mie(l) * aerosol.singleScatteringAlbedo),
    mieExtinction: perLambda(mie),
    miePhaseFunctionG: aerosol.g,
    absorptionDensity: [
      { width: 25_000, expTerm: 0, expScale: 0, linearTerm: 1 / 15_000, constantTerm: -2 / 3 },
      { width: 0, expTerm: 0, expScale: 0, linearTerm: -1 / 15_000, constantTerm: 8 / 3 },
    ],
    absorptionExtinction: perLambda((l) => (ozone ? MAX_OZONE_NUMBER_DENSITY * spectralAt(OZONE_CROSS_SECTION, l) : 0)),
    groundAlbedo: [0.1, 0.1, 0.1],
    muSMin: Math.cos(maxSunZenith),
  }
}

// --- GLSL constant block (km units) ---------------------------------------

const f = (v: number) => {
  if (!Number.isFinite(v)) throw new Error('non-finite atmosphere parameter')
  const s = v.toPrecision(10)
  return /[.e]/.test(s) ? s : `${s}.0`
}
const v3 = (v: Vec3, scale = 1) => `vec3(${f(v[0] * scale)}, ${f(v[1] * scale)}, ${f(v[2] * scale)})`
const KM = 1000

function layerGlsl(l: DensityProfileLayer): string {
  return `DensityProfileLayer(${f(l.width / KM)}, ${f(l.expTerm)}, ${f(l.expScale * KM)}, ${f(l.linearTerm * KM)}, ${f(l.constantTerm)})`
}

function profileGlsl(p: DensityProfile): string {
  return `DensityProfile(DensityProfileLayer[2](${layerGlsl(p[0])}, ${layerGlsl(p[1])}))`
}

/** GLSL source defining `const AtmosphereParameters ATMOSPHERE` in km units. */
export function atmosphereGlsl(p: AtmosphereParameters): string {
  return `const AtmosphereParameters ATMOSPHERE = AtmosphereParameters(
  ${v3(p.solarIrradiance)},
  ${f(p.sunAngularRadius)},
  ${f(p.bottomRadius / KM)},
  ${f(p.topRadius / KM)},
  ${profileGlsl(p.rayleighDensity)},
  ${v3(p.rayleighScattering, KM)},
  ${profileGlsl(p.mieDensity)},
  ${v3(p.mieScattering, KM)},
  ${v3(p.mieExtinction, KM)},
  ${f(p.miePhaseFunctionG)},
  ${profileGlsl(p.absorptionDensity)},
  ${v3(p.absorptionExtinction, KM)},
  ${v3(p.groundAlbedo)},
  ${f(p.muSMin)}
);`
}

export function textureSizeDefines(): Record<string, number> {
  return {
    TRANSMITTANCE_TEXTURE_WIDTH,
    TRANSMITTANCE_TEXTURE_HEIGHT,
    SCATTERING_TEXTURE_R_SIZE,
    SCATTERING_TEXTURE_MU_SIZE,
    SCATTERING_TEXTURE_MU_S_SIZE,
    SCATTERING_TEXTURE_NU_SIZE,
    IRRADIANCE_TEXTURE_WIDTH,
    IRRADIANCE_TEXTURE_HEIGHT,
  }
}

/**
 * Generated chunk `atmosphere/parameters`: texture sizes, the ATMOSPHERE
 * constant and the luminance conversion factors (scaled to LUMINANCE_UNIT).
 */
export function atmosphereChunks(p: AtmosphereParameters): Record<string, string> {
  const sizes = Object.entries(textureSizeDefines())
    .map(([k, v]) => `const int ${k} = ${v};`)
    .join('\n')
  const sky = SKY_SPECTRAL_RADIANCE_TO_LUMINANCE.map((v) => v / LUMINANCE_UNIT) as Vec3
  const sun = SUN_SPECTRAL_RADIANCE_TO_LUMINANCE.map((v) => v / LUMINANCE_UNIT) as Vec3
  return {
    'atmosphere/parameters': `${sizes}
${atmosphereGlsl(p)}
const vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE = ${v3(sky)};
const vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE = ${v3(sun)};
`,
  }
}
