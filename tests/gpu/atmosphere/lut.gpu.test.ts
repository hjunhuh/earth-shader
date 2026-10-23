import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AtmospherePrecompute } from '../../../src/atmosphere/AtmospherePrecompute'
import { createEarthAtmosphere } from '../../../src/atmosphere/AtmosphereParams'
import {
  IRRADIANCE_TEXTURE_HEIGHT,
  IRRADIANCE_TEXTURE_WIDTH,
  SCATTERING_TEXTURE_DEPTH,
  SCATTERING_TEXTURE_HEIGHT,
  SCATTERING_TEXTURE_WIDTH,
  TRANSMITTANCE_TEXTURE_HEIGHT,
  TRANSMITTANCE_TEXTURE_WIDTH,
  type Vec3,
} from '../../../src/atmosphere/constants'
import { ReadbackPass } from '../../../src/render/ReadbackPass'
import { BrunetonCpu } from '../../reference/brunetonCpu'
import { captureShaderErrors, createTestRenderer, disposeTestRenderer } from '../harness/context'
import { maxRelErr, sampleBilinear } from '../harness/sampling'

const renderer = createTestRenderer(64, 64)
const errors = captureShaderErrors(renderer)
const readback = new ReadbackPass()
const params = createEarthAtmosphere()
const cpu = new BrunetonCpu(params)
let pre: AtmospherePrecompute
let transmittance: Float32Array
let precomputeMs = 0

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

const px = (data: Float32Array, i: number): Vec3 => [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!]

beforeAll(() => {
  pre = new AtmospherePrecompute(renderer, params)
  pre.keepScratch = true
  const t0 = performance.now()
  pre.runAll()
  ;(renderer.getContext() as WebGL2RenderingContext).finish()
  precomputeMs = performance.now() - t0
  transmittance = readback.read2D(renderer, pre.textures.transmittance, TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT)
})

afterAll(() => {
  pre.dispose()
  readback.dispose()
  disposeTestRenderer(renderer)
})

describe('Bruneton precompute on the GPU', () => {
  it('compiles every pass and finishes', () => {
    expect(errors.errors).toEqual([])
    expect(pre.done).toBe(true)
    console.info(`[atmosphere] precompute ${pre.stepCount} steps in ${precomputeMs.toFixed(0)} ms`)
  })

  it('transmittance texel centers match the float64 integral (|Δτ| < max(1e-3, 3e-4·τ))', () => {
    // Compare optical depth τ = -ln T: float32 accumulation over 500 samples
    // limits τ to ~1e-4 relative, so relative T error is meaningless near the
    // horizon (τ ≈ 10+). Texels with T > 0.5 must also be within 2e-4.
    let worstTau = 0
    let worstRelHigh = 0
    for (let y = 0; y < TRANSMITTANCE_TEXTURE_HEIGHT; ++y) {
      for (let x = 0; x < TRANSMITTANCE_TEXTURE_WIDTH; ++x) {
        const { r, mu } = cpu.rMuFromTransmittanceUv((x + 0.5) / TRANSMITTANCE_TEXTURE_WIDTH, (y + 0.5) / TRANSMITTANCE_TEXTURE_HEIGHT)
        const ref = cpu.transmittanceToTopExact(r, mu)
        const got = px(transmittance, y * TRANSMITTANCE_TEXTURE_WIDTH + x)
        for (let c = 0; c < 3; ++c) {
          if (ref[c]! < 1e-6) continue
          const tau = -Math.log(ref[c]!)
          worstTau = Math.max(worstTau, Math.abs(Math.log(got[c]!) - Math.log(ref[c]!)) / Math.max(1e-3, 3e-4 * tau))
          if (ref[c]! > 0.5) worstRelHigh = Math.max(worstRelHigh, Math.abs(got[c]! - ref[c]!) / ref[c]!)
        }
      }
    }
    console.info(`[atmosphere] transmittance worst |Δτ|/bound ${worstTau.toFixed(3)}, worst rel (T>0.5) ${worstRelHigh.toExponential(2)}`)
    expect(worstTau).toBeLessThan(1)
    expect(worstRelHigh).toBeLessThan(2e-4)
  })

  it('single Rayleigh/Mie scattering texel centers match the CPU integral (median < 2e-4, p99 < 1e-2, max < 3e-2)', () => {
    // Use the GPU transmittance table (bilinear) inside the CPU integral to
    // separate integration from transmittance interpolation error. The max
    // bound covers grazing ground rays where r²(μ²−1)+b² cancels in float32.
    cpu.transmittanceSampler = (r, mu) => {
      const [u, v] = cpu.transmittanceUvFromRMu(r, mu)
      return sampleBilinear(transmittance, TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT, u, v)
    }
    const rand = rng(11)
    const errs: number[] = []
    const layers = new Map<number, { rayleigh: Float32Array; mie: Float32Array }>()
    for (let i = 0; i < 600; ++i) {
      const x = Math.floor(rand() * SCATTERING_TEXTURE_WIDTH)
      const y = Math.floor(rand() * SCATTERING_TEXTURE_HEIGHT)
      const z = Math.floor(rand() * SCATTERING_TEXTURE_DEPTH)
      if (!layers.has(z)) {
        layers.set(z, {
          rayleigh: readback.read3DLayer(renderer, pre.debugTextures.deltaRayleigh!, SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, z),
          mie: readback.read3DLayer(renderer, pre.textures.singleMieScattering, SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, z),
        })
      }
      const p = cpu.scatteringTexelParams(x, y, z)
      const ref = cpu.singleScattering(p.r, p.mu, p.muS, p.nu, p.ground)
      const idx = y * SCATTERING_TEXTURE_WIDTH + x
      const L = layers.get(z)!
      const floor = 1e-4 * cpu.solarIrradiance[0] * cpu.rayleighScattering[0] // ignore near-zero texels
      if (Math.max(...ref.rayleigh) > floor) errs.push(maxRelErr(px(L.rayleigh, idx), ref.rayleigh))
      if (Math.max(...ref.mie) > floor * 0.1) errs.push(maxRelErr(px(L.mie, idx), ref.mie))
    }
    cpu.transmittanceSampler = null
    errs.sort((a, b) => a - b)
    const q = (f: number) => errs[Math.min(errs.length - 1, Math.floor(f * errs.length))]!
    console.info(`[atmosphere] single scattering rel err median ${q(0.5).toExponential(2)} p99 ${q(0.99).toExponential(2)} max ${q(1).toExponential(2)} (n=${errs.length})`)
    expect(q(0.5)).toBeLessThan(2e-4)
    expect(q(0.99)).toBeLessThan(1e-2)
    expect(q(1)).toBeLessThan(3e-2)
  })

  it('final tables contain no NaN/Inf and no negative values', () => {
    const check = (data: Float32Array, name: string) => {
      for (let i = 0; i < data.length; ++i) {
        const v = data[i]!
        if (!Number.isFinite(v) || v < 0) throw new Error(`${name}[${i}] = ${v}`)
      }
    }
    check(transmittance, 'transmittance')
    check(readback.read2D(renderer, pre.textures.irradiance, IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT), 'irradiance')
    for (let z = 0; z < SCATTERING_TEXTURE_DEPTH; ++z) {
      check(readback.read3DLayer(renderer, pre.textures.scattering, SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, z), `scattering[${z}]`)
      check(readback.read3DLayer(renderer, pre.textures.singleMieScattering, SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, z), `mie[${z}]`)
    }
  })

  // Magnitude is validated against Monte Carlo in multiscatter.gpu.test.ts.
  it('multiple scattering only adds energy over single scattering', () => {
    // Daytime texels on the sky half: total (single + multiple) / single Rayleigh.
    const z = 0 // ground level
    const total = readback.read3DLayer(renderer, pre.textures.scattering, SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, z)
    const single = readback.read3DLayer(renderer, pre.debugTextures.deltaRayleigh!, SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, z)
    const ratios: number[] = []
    for (let y = SCATTERING_TEXTURE_HEIGHT / 2 + 8; y < SCATTERING_TEXTURE_HEIGHT; y += 8) {
      for (let x = 0; x < SCATTERING_TEXTURE_WIDTH; x += 7) {
        const p = cpu.scatteringTexelParams(x, y, z)
        if (p.muS < 0.3) continue
        const i = (y * SCATTERING_TEXTURE_WIDTH + x) * 4 + 2 // blue
        if (single[i]! > 0) ratios.push(total[i]! / single[i]!)
      }
    }
    ratios.sort((a, b) => a - b)
    const median = ratios[Math.floor(ratios.length / 2)]!
    console.info(`[atmosphere] blue (single+multiple)/single median ${median.toFixed(3)}`)
    expect(ratios[0]!).toBeGreaterThanOrEqual(1)
    expect(median).toBeGreaterThan(1.05)
  })
})
