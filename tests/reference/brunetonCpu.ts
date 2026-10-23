/**
 * Float64 CPU reference for the Bruneton 2017 precomputation (km units).
 * Independent of the GPU path: transmittance is integrated exactly here
 * (unless a LUT sampler is injected), so GPU tables can be validated
 * texel-by-texel and integration error separated from interpolation error.
 */
import type { AtmosphereParameters, DensityProfile, DensityProfileLayer, Vec3 } from '../../src/atmosphere/AtmosphereParams'
import {
  IRRADIANCE_TEXTURE_HEIGHT,
  IRRADIANCE_TEXTURE_WIDTH,
  SCATTERING_TEXTURE_MU_SIZE,
  SCATTERING_TEXTURE_MU_S_SIZE,
  SCATTERING_TEXTURE_NU_SIZE,
  SCATTERING_TEXTURE_R_SIZE,
  TRANSMITTANCE_TEXTURE_HEIGHT,
  TRANSMITTANCE_TEXTURE_WIDTH,
} from '../../src/atmosphere/constants'

const KM = 1000

interface Layer {
  width: number
  expTerm: number
  expScale: number
  linearTerm: number
  constantTerm: number
}

const toKmLayer = (l: DensityProfileLayer): Layer => ({
  width: l.width / KM,
  expTerm: l.expTerm,
  expScale: l.expScale * KM,
  linearTerm: l.linearTerm * KM,
  constantTerm: l.constantTerm,
})

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const div = (a: Vec3, b: Vec3): Vec3 => [a[0] / b[0], a[1] / b[1], a[2] / b[2]]
const vexp = (a: Vec3): Vec3 => [Math.exp(a[0]), Math.exp(a[1]), Math.exp(a[2])]
const vmin1 = (a: Vec3): Vec3 => [Math.min(a[0], 1), Math.min(a[1], 1), Math.min(a[2], 1)]
const clampCos = (mu: number) => Math.min(1, Math.max(-1, mu))
const safeSqrt = (a: number) => Math.sqrt(Math.max(a, 0))
const texCoordFromUnit = (x: number, size: number) => 0.5 / size + x * (1 - 1 / size)
const unitFromTexCoord = (u: number, size: number) => (u - 0.5 / size) / (1 - 1 / size)

export type TransmittanceSampler = (r: number, mu: number) => Vec3

export class BrunetonCpu {
  readonly bottom: number
  readonly top: number
  readonly rayleighDensity: [Layer, Layer]
  readonly mieDensity: [Layer, Layer]
  readonly absorptionDensity: [Layer, Layer]
  readonly rayleighScattering: Vec3
  readonly mieScattering: Vec3
  readonly mieExtinction: Vec3
  readonly absorptionExtinction: Vec3
  readonly solarIrradiance: Vec3
  readonly sunAngularRadius: number
  readonly muSMin: number
  readonly g: number
  readonly groundAlbedo: Vec3
  /** Optional LUT emulation (to isolate integration from interpolation). */
  transmittanceSampler: TransmittanceSampler | null = null

  constructor(p: AtmosphereParameters) {
    const prof = (d: DensityProfile) => [toKmLayer(d[0]), toKmLayer(d[1])] as [Layer, Layer]
    this.bottom = p.bottomRadius / KM
    this.top = p.topRadius / KM
    this.rayleighDensity = prof(p.rayleighDensity)
    this.mieDensity = prof(p.mieDensity)
    this.absorptionDensity = prof(p.absorptionDensity)
    this.rayleighScattering = scale(p.rayleighScattering, KM)
    this.mieScattering = scale(p.mieScattering, KM)
    this.mieExtinction = scale(p.mieExtinction, KM)
    this.absorptionExtinction = scale(p.absorptionExtinction, KM)
    this.solarIrradiance = [...p.solarIrradiance]
    this.sunAngularRadius = p.sunAngularRadius
    this.muSMin = p.muSMin
    this.g = p.miePhaseFunctionG
    this.groundAlbedo = [...p.groundAlbedo]
  }

  // --- geometry --------------------------------------------------------------
  distanceToTop(r: number, mu: number): number {
    const disc = r * r * (mu * mu - 1) + this.top * this.top
    return Math.max(-r * mu + safeSqrt(disc), 0)
  }
  distanceToBottom(r: number, mu: number): number {
    const disc = r * r * (mu * mu - 1) + this.bottom * this.bottom
    return Math.max(-r * mu - safeSqrt(disc), 0)
  }
  rayIntersectsGround(r: number, mu: number): boolean {
    return mu < 0 && r * r * (mu * mu - 1) + this.bottom * this.bottom >= 0
  }
  clampRadius(r: number): number {
    return Math.min(this.top, Math.max(this.bottom, r))
  }

  // --- density ---------------------------------------------------------------
  static layerDensity(l: Layer, h: number): number {
    return Math.min(1, Math.max(0, l.expTerm * Math.exp(l.expScale * h) + l.linearTerm * h + l.constantTerm))
  }
  static profileDensity(p: [Layer, Layer], h: number): number {
    return h < p[0].width ? BrunetonCpu.layerDensity(p[0], h) : BrunetonCpu.layerDensity(p[1], h)
  }

  /** Extinction coefficient [1/km] at altitude h [km]. */
  extinction(h: number): Vec3 {
    const R = BrunetonCpu.profileDensity(this.rayleighDensity, h)
    const M = BrunetonCpu.profileDensity(this.mieDensity, h)
    const A = BrunetonCpu.profileDensity(this.absorptionDensity, h)
    return add(add(scale(this.rayleighScattering, R), scale(this.mieExtinction, M)), scale(this.absorptionExtinction, A))
  }

  opticalLengthToTop(profile: [Layer, Layer], r: number, mu: number, samples = 500): number {
    const dx = this.distanceToTop(r, mu) / samples
    let result = 0
    for (let i = 0; i <= samples; ++i) {
      const d = i * dx
      const ri = Math.sqrt(d * d + 2 * r * mu * d + r * r)
      const y = BrunetonCpu.profileDensity(profile, ri - this.bottom)
      result += y * (i === 0 || i === samples ? 0.5 : 1) * dx
    }
    return result
  }

  /** Exact transmittance to the top boundary (500-sample trapezoid, like the GPU). */
  transmittanceToTopExact(r: number, mu: number, samples = 500): Vec3 {
    return vexp(
      scale(
        add(
          add(
            scale(this.rayleighScattering, this.opticalLengthToTop(this.rayleighDensity, r, mu, samples)),
            scale(this.mieExtinction, this.opticalLengthToTop(this.mieDensity, r, mu, samples)),
          ),
          scale(this.absorptionExtinction, this.opticalLengthToTop(this.absorptionDensity, r, mu, samples)),
        ),
        -1,
      ),
    )
  }

  transmittanceToTop(r: number, mu: number): Vec3 {
    return this.transmittanceSampler ? this.transmittanceSampler(r, mu) : this.transmittanceToTopExact(r, mu)
  }

  transmittance(r: number, mu: number, d: number, ground: boolean): Vec3 {
    const rd = this.clampRadius(Math.sqrt(d * d + 2 * r * mu * d + r * r))
    const mud = clampCos((r * mu + d) / rd)
    return ground
      ? vmin1(div(this.transmittanceToTop(rd, -mud), this.transmittanceToTop(r, -mu)))
      : vmin1(div(this.transmittanceToTop(r, mu), this.transmittanceToTop(rd, mud)))
  }

  transmittanceToSun(r: number, muS: number): Vec3 {
    const sinH = this.bottom / r
    const cosH = -Math.sqrt(Math.max(1 - sinH * sinH, 0))
    const e0 = -sinH * this.sunAngularRadius
    const e1 = sinH * this.sunAngularRadius
    const t = Math.min(1, Math.max(0, (muS - cosH - e0) / (e1 - e0)))
    return scale(this.transmittanceToTop(r, muS), t * t * (3 - 2 * t))
  }

  // --- texture mappings ------------------------------------------------------
  get H(): number {
    return Math.sqrt(this.top * this.top - this.bottom * this.bottom)
  }

  transmittanceUvFromRMu(r: number, mu: number): [number, number] {
    const H = this.H
    const rho = safeSqrt(r * r - this.bottom * this.bottom)
    const d = this.distanceToTop(r, mu)
    const dMin = this.top - r
    const dMax = rho + H
    return [
      texCoordFromUnit((d - dMin) / (dMax - dMin), TRANSMITTANCE_TEXTURE_WIDTH),
      texCoordFromUnit(rho / H, TRANSMITTANCE_TEXTURE_HEIGHT),
    ]
  }

  rMuFromTransmittanceUv(u: number, v: number): { r: number; mu: number } {
    const xMu = unitFromTexCoord(u, TRANSMITTANCE_TEXTURE_WIDTH)
    const xR = unitFromTexCoord(v, TRANSMITTANCE_TEXTURE_HEIGHT)
    const H = this.H
    const rho = H * xR
    const r = Math.sqrt(rho * rho + this.bottom * this.bottom)
    const dMin = this.top - r
    const dMax = rho + H
    const d = dMin + xMu * (dMax - dMin)
    const mu = d === 0 ? 1 : clampCos((H * H - rho * rho - d * d) / (2 * r * d))
    return { r, mu }
  }

  scatteringUvwzFromRMuMuSNu(r: number, mu: number, muS: number, nu: number, ground: boolean): [number, number, number, number] {
    const H = this.H
    const rho = safeSqrt(r * r - this.bottom * this.bottom)
    const uR = texCoordFromUnit(rho / H, SCATTERING_TEXTURE_R_SIZE)
    const rMu = r * mu
    const disc = rMu * rMu - r * r + this.bottom * this.bottom
    let uMu: number
    if (ground) {
      const d = -rMu - safeSqrt(disc)
      const dMin = r - this.bottom
      const dMax = rho
      uMu = 0.5 - 0.5 * texCoordFromUnit(dMax === dMin ? 0 : (d - dMin) / (dMax - dMin), SCATTERING_TEXTURE_MU_SIZE / 2)
    } else {
      const d = -rMu + safeSqrt(disc + H * H)
      const dMin = this.top - r
      const dMax = rho + H
      uMu = 0.5 + 0.5 * texCoordFromUnit((d - dMin) / (dMax - dMin), SCATTERING_TEXTURE_MU_SIZE / 2)
    }
    const d = this.distanceToTop(this.bottom, muS)
    const dMin = this.top - this.bottom
    const dMax = H
    const a = (d - dMin) / (dMax - dMin)
    const D = this.distanceToTop(this.bottom, this.muSMin)
    const A = (D - dMin) / (dMax - dMin)
    const uMuS = texCoordFromUnit(Math.max(1 - a / A, 0) / (1 + a), SCATTERING_TEXTURE_MU_S_SIZE)
    const uNu = (nu + 1) / 2
    return [uNu, uMuS, uMu, uR]
  }

  rMuMuSNuFromScatteringUvwz(
    uvwz: [number, number, number, number],
  ): { r: number; mu: number; muS: number; nu: number; ground: boolean } {
    const H = this.H
    const rho = H * unitFromTexCoord(uvwz[3], SCATTERING_TEXTURE_R_SIZE)
    const r = Math.sqrt(rho * rho + this.bottom * this.bottom)
    let mu: number
    let ground: boolean
    if (uvwz[2] < 0.5) {
      const dMin = r - this.bottom
      const dMax = rho
      const d = dMin + (dMax - dMin) * unitFromTexCoord(1 - 2 * uvwz[2], SCATTERING_TEXTURE_MU_SIZE / 2)
      mu = d === 0 ? -1 : clampCos(-(rho * rho + d * d) / (2 * r * d))
      ground = true
    } else {
      const dMin = this.top - r
      const dMax = rho + H
      const d = dMin + (dMax - dMin) * unitFromTexCoord(2 * uvwz[2] - 1, SCATTERING_TEXTURE_MU_SIZE / 2)
      mu = d === 0 ? 1 : clampCos((H * H - rho * rho - d * d) / (2 * r * d))
      ground = false
    }
    const xMuS = unitFromTexCoord(uvwz[1], SCATTERING_TEXTURE_MU_S_SIZE)
    const dMin = this.top - this.bottom
    const dMax = H
    const D = this.distanceToTop(this.bottom, this.muSMin)
    const A = (D - dMin) / (dMax - dMin)
    const a = (A - xMuS * A) / (1 + xMuS * A)
    const d = dMin + Math.min(a, A) * (dMax - dMin)
    const muS = d === 0 ? 1 : clampCos((H * H - d * d) / (2 * this.bottom * d))
    const nu = clampCos(uvwz[0] * 2 - 1)
    return { r, mu, muS, nu, ground }
  }

  /** Parameters of the 3D texel (x, y, layer) center, as in the GPU precompute. */
  scatteringTexelParams(x: number, y: number, layer: number) {
    const fx = x + 0.5
    const fy = y + 0.5
    const fz = layer + 0.5
    const fragNu = Math.floor(fx / SCATTERING_TEXTURE_MU_S_SIZE)
    const fragMuS = fx % SCATTERING_TEXTURE_MU_S_SIZE
    const p = this.rMuMuSNuFromScatteringUvwz([
      fragNu / (SCATTERING_TEXTURE_NU_SIZE - 1),
      fragMuS / SCATTERING_TEXTURE_MU_S_SIZE,
      fy / SCATTERING_TEXTURE_MU_SIZE,
      fz / SCATTERING_TEXTURE_R_SIZE,
    ])
    const lim = Math.sqrt((1 - p.mu * p.mu) * (1 - p.muS * p.muS))
    p.nu = Math.min(p.mu * p.muS + lim, Math.max(p.mu * p.muS - lim, p.nu))
    return p
  }

  irradianceTexelParams(x: number, y: number): { r: number; muS: number } {
    const u = (x + 0.5) / IRRADIANCE_TEXTURE_WIDTH
    const v = (y + 0.5) / IRRADIANCE_TEXTURE_HEIGHT
    const xMuS = unitFromTexCoord(u, IRRADIANCE_TEXTURE_WIDTH)
    const xR = unitFromTexCoord(v, IRRADIANCE_TEXTURE_HEIGHT)
    return { r: this.bottom + xR * (this.top - this.bottom), muS: clampCos(2 * xMuS - 1) }
  }

  // --- scattering ------------------------------------------------------------
  singleScattering(r: number, mu: number, muS: number, nu: number, ground: boolean, samples = 200): { rayleigh: Vec3; mie: Vec3 } {
    const dist = ground ? this.distanceToBottom(r, mu) : this.distanceToTop(r, mu)
    const dx = dist / samples
    let rs: Vec3 = [0, 0, 0]
    let ms: Vec3 = [0, 0, 0]
    for (let i = 0; i <= samples; ++i) {
      const d = i * dx
      const rd = this.clampRadius(Math.sqrt(d * d + 2 * r * mu * d + r * r))
      const muSd = clampCos((r * muS + d * nu) / rd)
      const t = mul(this.transmittance(r, mu, d, ground), this.transmittanceToSun(rd, muSd))
      const w = i === 0 || i === samples ? 0.5 : 1
      rs = add(rs, scale(t, BrunetonCpu.profileDensity(this.rayleighDensity, rd - this.bottom) * w))
      ms = add(ms, scale(t, BrunetonCpu.profileDensity(this.mieDensity, rd - this.bottom) * w))
    }
    return {
      rayleigh: mul(scale(rs, dx), mul(this.solarIrradiance, this.rayleighScattering)),
      mie: mul(scale(ms, dx), mul(this.solarIrradiance, this.mieScattering)),
    }
  }

  directIrradiance(r: number, muS: number): Vec3 {
    const a = this.sunAngularRadius
    const avg = muS < -a ? 0 : muS > a ? muS : ((muS + a) * (muS + a)) / (4 * a)
    return scale(mul(this.solarIrradiance, this.transmittanceToTop(r, muS)), avg)
  }

  static rayleighPhase(nu: number): number {
    return (3 / (16 * Math.PI)) * (1 + nu * nu)
  }

  miePhase(nu: number): number {
    const g = this.g
    const k = ((3 / (8 * Math.PI)) * (1 - g * g)) / (2 + g * g)
    return (k * (1 + nu * nu)) / (1 + g * g - 2 * g * nu) ** 1.5
  }
}
