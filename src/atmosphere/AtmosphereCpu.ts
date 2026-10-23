import type { AtmosphereParameters } from './AtmosphereParams'
import {
  IRRADIANCE_TEXTURE_HEIGHT,
  IRRADIANCE_TEXTURE_WIDTH,
  TRANSMITTANCE_TEXTURE_HEIGHT,
  TRANSMITTANCE_TEXTURE_WIDTH,
  type Vec3,
} from './constants'
import { SKY_SPECTRAL_RADIANCE_TO_LUMINANCE, SUN_SPECTRAL_RADIANCE_TO_LUMINANCE } from './luminance'

/**
 * CPU lookups into read-back atmosphere tables (transmittance, irradiance),
 * mirroring GetTransmittanceToSun / GetSunAndSkyIrradiance on the GPU. Used
 * for the deterministic exposure curve and test hooks without GPU stalls.
 * Lengths in km; outputs in lux / cd·m⁻² (RGB, Y = Rec.709 luma weights).
 */

const texCoordFromUnit = (x: number, size: number) => 0.5 / size + x * (1 - 1 / size)

function bilinear(data: Float32Array, width: number, height: number, u: number, v: number): Vec3 {
  const x = Math.min(width - 1, Math.max(0, u * width - 0.5))
  const y = Math.min(height - 1, Math.max(0, v * height - 0.5))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const out: Vec3 = [0, 0, 0]
  for (let c = 0; c < 3; ++c) {
    const at = (xx: number, yy: number) => data[(yy * width + xx) * 4 + c]!
    out[c] = (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy
  }
  return out
}

export const luma = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

export class AtmosphereCpu {
  readonly bottom: number
  readonly top: number
  private readonly solar: Vec3
  private readonly sunAngularRadius: number

  constructor(
    params: AtmosphereParameters,
    private readonly transmittance: Float32Array,
    private readonly irradiance: Float32Array,
  ) {
    this.bottom = params.bottomRadius / 1000
    this.top = params.topRadius / 1000
    this.solar = [...params.solarIrradiance]
    this.sunAngularRadius = params.sunAngularRadius
  }

  private distanceToTop(r: number, mu: number): number {
    const disc = r * r * (mu * mu - 1) + this.top * this.top
    return Math.max(-r * mu + Math.sqrt(Math.max(disc, 0)), 0)
  }

  transmittanceToTop(r: number, mu: number): Vec3 {
    const H = Math.sqrt(this.top * this.top - this.bottom * this.bottom)
    const rho = Math.sqrt(Math.max(r * r - this.bottom * this.bottom, 0))
    const d = this.distanceToTop(r, mu)
    const dMin = this.top - r
    const dMax = rho + H
    const u = texCoordFromUnit((d - dMin) / (dMax - dMin), TRANSMITTANCE_TEXTURE_WIDTH)
    const v = texCoordFromUnit(rho / H, TRANSMITTANCE_TEXTURE_HEIGHT)
    return bilinear(this.transmittance, TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT, u, v)
  }

  transmittanceToSun(r: number, muS: number): Vec3 {
    const sinH = this.bottom / r
    const cosH = -Math.sqrt(Math.max(1 - sinH * sinH, 0))
    const e = sinH * this.sunAngularRadius
    const t = Math.min(1, Math.max(0, (muS - cosH + e) / (2 * e)))
    const s = t * t * (3 - 2 * t)
    const tr = this.transmittanceToTop(r, muS)
    return [tr[0] * s, tr[1] * s, tr[2] * s]
  }

  skyIrradiance(r: number, muS: number): Vec3 {
    const xR = (r - this.bottom) / (this.top - this.bottom)
    const u = texCoordFromUnit(muS * 0.5 + 0.5, IRRADIANCE_TEXTURE_WIDTH)
    const v = texCoordFromUnit(Math.min(1, Math.max(0, xR)), IRRADIANCE_TEXTURE_HEIGHT)
    return bilinear(this.irradiance, IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT, u, v)
  }

  /**
   * Illuminance on a horizontal surface at altitude h [km] with sun
   * elevation given by muS = sin(elevation). RGB in lux.
   */
  horizontalIlluminance(muS: number, altitudeKm = 0): { sun: Vec3; sky: Vec3; total: Vec3 } {
    const r = this.bottom + Math.max(0, altitudeKm)
    const tSun = this.transmittanceToSun(r, muS)
    const cos = Math.max(muS, 0)
    const sun = [0, 1, 2].map((c) => this.solar[c]! * tSun[c]! * cos * SUN_SPECTRAL_RADIANCE_TO_LUMINANCE[c]!) as Vec3
    const irr = this.skyIrradiance(r, muS)
    const sky = [0, 1, 2].map((c) => irr[c]! * SKY_SPECTRAL_RADIANCE_TO_LUMINANCE[c]!) as Vec3
    return { sun, sky, total: [sun[0] + sky[0], sun[1] + sky[1], sun[2] + sky[2]] }
  }

  /** Direct-beam sun color (illuminance on a surface facing the sun), RGB lux. */
  directSun(muS: number, altitudeKm = 0): Vec3 {
    const r = this.bottom + Math.max(0, altitudeKm)
    const t = this.transmittanceToSun(r, muS)
    return [0, 1, 2].map((c) => this.solar[c]! * t[c]! * SUN_SPECTRAL_RADIANCE_TO_LUMINANCE[c]!) as Vec3
  }
}

/** Photographic exposure value for an illuminance (incident-light meter, C = 250). */
export function ev100FromIlluminance(lux: number): number {
  return Math.log2((Math.max(lux, 1e-9) * 100) / 250)
}
