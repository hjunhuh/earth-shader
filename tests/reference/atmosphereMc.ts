/**
 * Monte Carlo reference for sky radiance with multiple scattering (km
 * units), to validate the precomputed scattering tables. Backward path
 * tracing from the camera with delta tracking, next-event estimation toward
 * the sun, Rayleigh + Mie (Cornette-Shanks) scattering, ozone absorption and
 * a Lambertian ground. Scattering orders are capped like the precomputation
 * (a ground reflection counts as one order).
 */
import type { Vec3 } from '../../src/atmosphere/constants'
import { BrunetonCpu } from './brunetonCpu'

export interface McConfig {
  /** Camera altitude [km]. */
  altitude: number
  mu: number
  muS: number
  nu: number
  maxOrder: number
  paths: number
  seed: number
}

export interface McResult {
  radiance: Vec3
  stdError: Vec3
}

type V = [number, number, number]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: V) => Math.sqrt(dot(a, a))
const norm = (a: V): V => {
  const l = len(a)
  return [a[0] / l, a[1] / l, a[2] / l]
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Direction at angle acos(cosT) from d, azimuth phi. */
function rotateAround(d: V, cosT: number, phi: number): V {
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
  const t = norm(Math.abs(d[0]) < 0.9 ? [0, -d[2], d[1]] : [-d[1], d[0], 0])
  const b: V = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]]
  const c = Math.cos(phi) * sinT
  const sn = Math.sin(phi) * sinT
  return norm([d[0] * cosT + t[0] * c + b[0] * sn, d[1] * cosT + t[1] * c + b[1] * sn, d[2] * cosT + t[2] * c + b[2] * sn])
}

export class AtmosphereMc {
  constructor(
    private readonly cpu: BrunetonCpu,
    /** Transmittance to the top boundary; e.g. the validated LUT. */
    private readonly transmittanceToTop: (r: number, mu: number) => Vec3,
  ) {}

  private sigma(h: number, c: number): { sR: number; sM: number; t: number } {
    const R = BrunetonCpu.profileDensity(this.cpu.rayleighDensity, h)
    const M = BrunetonCpu.profileDensity(this.cpu.mieDensity, h)
    const A = BrunetonCpu.profileDensity(this.cpu.absorptionDensity, h)
    const sR = this.cpu.rayleighScattering[c]! * R
    const sM = this.cpu.mieScattering[c]! * M
    return { sR, sM, t: sR + this.cpu.mieExtinction[c]! * M + this.cpu.absorptionExtinction[c]! * A }
  }

  private sunTransmittance(p: V, sun: V, c: number): number {
    const r = len(p)
    const mu = dot(p, sun) / r
    if (this.cpu.rayIntersectsGround(Math.max(r, this.cpu.bottom), mu)) return 0
    return this.transmittanceToTop(Math.min(Math.max(r, this.cpu.bottom), this.cpu.top), mu)[c]!
  }

  /** Distance along the ray to the top sphere and to the ground (Infinity if missed). */
  private distances(p: V, d: V): { top: number; ground: number } {
    const b = dot(p, d)
    const c0 = dot(p, p)
    const discTop = b * b - (c0 - this.cpu.top * this.cpu.top)
    const top = discTop >= 0 ? -b + Math.sqrt(discTop) : 0
    const discG = b * b - (c0 - this.cpu.bottom * this.cpu.bottom)
    let ground = Infinity
    if (discG >= 0) {
      const t0 = -b - Math.sqrt(discG)
      if (t0 > 1e-9) ground = t0
    }
    return { top: Math.max(top, 0), ground }
  }

  run(cfg: McConfig): McResult {
    const cpu = this.cpu
    const r0 = cpu.bottom + cfg.altitude
    const camera: V = [0, 0, r0]
    const view: V = [Math.sqrt(Math.max(0, 1 - cfg.mu * cfg.mu)), 0, cfg.mu]
    const sx = view[0] === 0 ? 0 : (cfg.nu - cfg.mu * cfg.muS) / view[0]
    const sun: V = [sx, Math.sqrt(Math.max(0, 1 - sx * sx - cfg.muS * cfg.muS)), cfg.muS]
    const radiance: Vec3 = [0, 0, 0]
    const stdError: Vec3 = [0, 0, 0]
    for (let c = 0; c < 3; ++c) {
      const rand = mulberry32(cfg.seed * 7919 + c)
      // Majorant: ground extinction plus the ozone peak (density ≤ 1).
      const majorant = this.sigma(0, c).t + cpu.absorptionExtinction[c]! + 1e-9
      const E = cpu.solarIrradiance[c]!
      let sum = 0
      let sumSq = 0
      for (let n = 0; n < cfg.paths; ++n) {
        let p: V = [camera[0], camera[1], camera[2]]
        let d: V = [view[0], view[1], view[2]]
        let throughput = 1
        let L = 0
        for (let order = 1; order <= cfg.maxOrder; ++order) {
          const { top, ground } = this.distances(p, d)
          const tMax = Math.min(top, ground)
          // Delta tracking for the next real collision.
          let t = 0
          let collided = false
          let s = { sR: 0, sM: 0, t: 0 }
          for (;;) {
            t -= Math.log(1 - rand()) / majorant
            if (t >= tMax) break
            const q: V = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t]
            s = this.sigma(len(q) - cpu.bottom, c)
            if (rand() < s.t / majorant) {
              collided = true
              break
            }
          }
          if (collided) {
            const x: V = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t]
            const sS = s.sR + s.sM
            throughput *= sS / s.t
            const phase = (nu: number) => (s.sR * BrunetonCpu.rayleighPhase(nu) + s.sM * cpu.miePhase(nu)) / sS
            L += throughput * phase(dot(d, sun)) * E * this.sunTransmittance(x, sun, c)
            // One-sample MIS between a uniform lobe (Rayleigh) and a
            // Henyey-Greenstein lobe (Mie): weight = phase / pdf stays bounded,
            // avoiding the heavy-tailed estimator of uniform sampling with a
            // forward-peaked aerosol phase function.
            const wM = s.sM / sS
            const g = cpu.g
            let cosT: number
            if (rand() < wM) {
              const xi = rand()
              const sq = (1 - g * g) / (1 - g + 2 * g * xi)
              cosT = Math.min(1, Math.max(-1, (1 + g * g - sq * sq) / (2 * g)))
            } else {
              cosT = 1 - 2 * rand()
            }
            const nd = rotateAround(d, cosT, 2 * Math.PI * rand())
            const hg = (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * cosT) ** 1.5)
            const pdf = (1 - wM) / (4 * Math.PI) + wM * hg
            throughput *= phase(cosT) / pdf
            p = x
            d = nd
          } else if (ground <= top) {
            // Lambertian ground reflection (counts as one order).
            const g: V = [p[0] + d[0] * ground, p[1] + d[1] * ground, p[2] + d[2] * ground]
            const nrm = norm(g)
            const albedo = cpu.groundAlbedo[c]!
            const cosSun = Math.max(0, dot(nrm, sun))
            L += throughput * (albedo / Math.PI) * E * cosSun * this.sunTransmittance(g, sun, c)
            // Cosine-weighted hemisphere sampling: weight = albedo.
            const u1 = rand()
            const u2 = rand()
            const rad = Math.sqrt(u1)
            const ph = 2 * Math.PI * u2
            const tangent = norm(Math.abs(nrm[0]) < 0.9 ? [0, -nrm[2], nrm[1]] : [-nrm[1], nrm[0], 0])
            const bit: V = [
              nrm[1] * tangent[2] - nrm[2] * tangent[1],
              nrm[2] * tangent[0] - nrm[0] * tangent[2],
              nrm[0] * tangent[1] - nrm[1] * tangent[0],
            ]
            const lz = Math.sqrt(Math.max(0, 1 - u1))
            const lx = rad * Math.cos(ph)
            const ly = rad * Math.sin(ph)
            d = norm([
              tangent[0] * lx + bit[0] * ly + nrm[0] * lz,
              tangent[1] * lx + bit[1] * ly + nrm[1] * lz,
              tangent[2] * lx + bit[2] * ly + nrm[2] * lz,
            ])
            throughput *= albedo
            p = [g[0] + nrm[0] * 1e-6, g[1] + nrm[1] * 1e-6, g[2] + nrm[2] * 1e-6]
          } else {
            break // escaped to space
          }
        }
        sum += L
        sumSq += L * L
      }
      const mean = sum / cfg.paths
      radiance[c] = mean
      stdError[c] = Math.sqrt(Math.max(0, sumSq / cfg.paths - mean * mean) / cfg.paths)
    }
    return { radiance, stdError }
  }
}
