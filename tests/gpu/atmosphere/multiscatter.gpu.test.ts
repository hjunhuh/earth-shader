import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AtmospherePrecompute } from '../../../src/atmosphere/AtmospherePrecompute'
import { createEarthAtmosphere } from '../../../src/atmosphere/AtmosphereParams'
import { TRANSMITTANCE_TEXTURE_HEIGHT, TRANSMITTANCE_TEXTURE_WIDTH } from '../../../src/atmosphere/constants'
import { ReadbackPass } from '../../../src/render/ReadbackPass'
import { AtmosphereMc, type McConfig } from '../../reference/atmosphereMc'
import { BrunetonCpu } from '../../reference/brunetonCpu'
import { createTestRenderer, disposeTestRenderer } from '../harness/context'
import { pack, runKernel } from '../harness/glslKernel'
import { sampleBilinear } from '../harness/sampling'

const renderer = createTestRenderer(64, 64)
const params = createEarthAtmosphere()
const cpu = new BrunetonCpu(params)
let pre: AtmospherePrecompute
let mc: AtmosphereMc

beforeAll(() => {
  pre = new AtmospherePrecompute(renderer, params)
  pre.runAll()
  const rb = new ReadbackPass()
  const t = rb.read2D(renderer, pre.textures.transmittance, TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT)
  rb.dispose()
  mc = new AtmosphereMc(cpu, (r, mu) => {
    const [u, v] = cpu.transmittanceUvFromRMu(r, mu)
    return sampleBilinear(t, TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT, u, v)
  })
})

afterAll(() => {
  pre.dispose()
  disposeTestRenderer(renderer)
})

/** GetSkyRadiance (radiance, not luminance) from the precomputed tables. */
function gpuSkyRadiance(configs: McConfig[]): number[][] {
  const out = runKernel(renderer, {
    chunks: pre.chunks,
    includes: ['atmosphere/runtime'],
    uniforms: {
      transmittance_texture: { value: pre.textures.transmittance },
      scattering_texture: { value: pre.textures.scattering },
      single_mie_scattering_texture: { value: pre.textures.singleMieScattering },
      irradiance_texture: { value: pre.textures.irradiance },
    },
    body: `vec4 kernel(vec4 a, vec4 b, vec4 c, vec4 d) {
      float mu = a.y; float muS = a.z; float nu = a.w;
      vec3 camera = vec3(0.0, 0.0, ATMOSPHERE.bottom_radius + a.x);
      vec3 view = vec3(sqrt(max(0.0, 1.0 - mu * mu)), 0.0, mu);
      float sx = view.x == 0.0 ? 0.0 : (nu - mu * muS) / view.x;
      vec3 sun = vec3(sx, sqrt(max(0.0, 1.0 - sx * sx - muS * muS)), muS);
      vec3 transmittance;
      return vec4(GetSkyRadiance(ATMOSPHERE, transmittance_texture, scattering_texture,
          single_mie_scattering_texture, camera, view, 0.0, sun, transmittance), 0.0);
    }`,
    inputs: [pack(configs.map((c) => [c.altitude, c.mu, c.muS, c.nu]))],
  })
  return configs.map((_, i) => [out[i * 4]!, out[i * 4 + 1]!, out[i * 4 + 2]!])
}

const base = { maxOrder: 4, paths: 60_000, seed: 1 }
const configs: (McConfig & { name: string })[] = [
  { name: 'zenith, sun 45°', altitude: 0.001, mu: 1, muS: 0.7, nu: 0.7, ...base },
  { name: 'near horizon, sun 30°, side', altitude: 0.001, mu: 0.2, muS: 0.5, nu: 0.1, ...base },
  { name: 'toward low sun (Mie)', altitude: 0.001, mu: 0.5, muS: 0.2, nu: 0.9, ...base },
  { name: 'sunset, away from sun', altitude: 0.001, mu: 0.3, muS: 0.05, nu: -0.5, ...base },
  { name: '20 km, horizontal', altitude: 20, mu: 0, muS: 0.3, nu: 0.3, ...base },
  { name: 'twilight (sun −2.9°)', altitude: 0.001, mu: 0.5, muS: -0.05, nu: 0.4, ...base },
]

describe('multiple scattering vs Monte Carlo path tracing', () => {
  it('sky radiance matches within max(5%, 4σ) for 6 configurations incl. twilight', () => {
    const gpu = gpuSkyRadiance(configs)
    const lines: string[] = []
    const failures: string[] = []
    configs.forEach((cfg, i) => {
      const ref = mc.run(cfg)
      for (let c = 0; c < 3; ++c) {
        const g = gpu[i]![c]!
        const m = ref.radiance[c]!
        const tol = Math.max(0.05 * m, 4 * ref.stdError[c]!)
        const ok = Math.abs(g - m) <= tol
        if (!ok) failures.push(`${cfg.name} ch${c}: gpu ${g.toExponential(3)} mc ${m.toExponential(3)} ±${ref.stdError[c]!.toExponential(1)}`)
      }
      lines.push(
        `${cfg.name}: gpu ${gpu[i]!.map((v) => v.toExponential(3)).join(',')} mc ${ref.radiance.map((v) => v.toExponential(3)).join(',')} (σ ${ref.stdError.map((v) => (v / Math.max(1e-30, ref.radiance[ref.stdError.indexOf(v)]!) * 100).toFixed(1)).join(',')}%)`,
      )
    })
    console.info(`[multiscatter]\n${lines.join('\n')}`)
    expect(failures).toEqual([])
  })

  it('single-scattering-only MC agrees with the single-scattering part (sanity of the MC itself)', () => {
    const cfg = { ...configs[0]!, maxOrder: 1, paths: 40_000 }
    const ref = mc.run(cfg)
    // Single scattering radiance from the CPU reference integral.
    const r = cpu.bottom + cfg.altitude
    const s = cpu.singleScattering(r, cfg.mu, cfg.muS, cfg.nu, false, 400)
    const single = [0, 1, 2].map((c) => s.rayleigh[c]! * BrunetonCpu.rayleighPhase(cfg.nu) + s.mie[c]! * cpu.miePhase(cfg.nu))
    for (let c = 0; c < 3; ++c) {
      expect(Math.abs(ref.radiance[c]! - single[c]!)).toBeLessThan(Math.max(0.03 * single[c]!, 4 * ref.stdError[c]!))
    }
  })
})
