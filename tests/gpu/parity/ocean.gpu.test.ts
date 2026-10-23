import { afterAll, describe, expect, it } from 'vitest'
import { Atmosphere } from '../../../src/atmosphere/Atmosphere'
import { luma } from '../../../src/atmosphere/AtmosphereCpu'
import { oceanDiffuse, oceanSpecular } from '../../reference/oceanBrdf'
import { captureShaderErrors, createTestRenderer, disposeTestRenderer } from '../harness/context'
import { pack, relErr, runKernel } from '../harness/glslKernel'

const renderer = createTestRenderer(64, 64)
const errors = captureShaderErrors(renderer)
afterAll(() => disposeTestRenderer(renderer))

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

describe('GLSL–TS parity: ocean BRDF', () => {
  it('oceanSpecular and oceanDiffuse match the TS twin (relative 1e-4)', () => {
    const rand = rng(5)
    const items: number[][] = []
    const vs: number[][] = []
    for (let i = 0; i < 1024; ++i) {
      const th = Math.acos(rand())
      const ph = rand() * 2 * Math.PI
      const tl = Math.acos(rand())
      const pl = rand() * 2 * Math.PI
      items.push([Math.sin(tl) * Math.cos(pl), Math.sin(tl) * Math.sin(pl), Math.cos(tl), 0.05 + rand() * 0.5])
      vs.push([Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)])
    }
    const out = runKernel(renderer, {
      includes: ['ocean'],
      body: `vec4 kernel(vec4 l, vec4 v, vec4 c, vec4 d) {
        vec3 n = vec3(0.0, 0.0, 1.0);
        return vec4(oceanSpecular(n, v.xyz, l.xyz, l.w), oceanDiffuse(vec3(0.016), l.z, v.z).g, 0.0, 0.0);
      }`,
      inputs: [pack(items), pack(vs)],
    })
    expect(errors.errors).toEqual([])
    items.forEach((l, i) => {
      const v = vs[i] as [number, number, number]
      const spec = oceanSpecular([0, 0, 1], v, [l[0]!, l[1]!, l[2]!], l[3]!)
      const diff = oceanDiffuse(0.016, l[2]!, v[2])
      expect(relErr(out[i * 4]!, spec, 1e-6)).toBeLessThan(1e-4)
      expect(relErr(out[i * 4 + 1]!, diff, 1e-6)).toBeLessThan(1e-4)
    })
  })
})

describe('CPU illuminance mirror vs GPU', () => {
  // GPU bilinear filtering uses fixed-point sub-texel weights (≈1/256), the CPU
  // mirror interpolates exactly; the residual is ~2e-3.
  it('AtmosphereCpu.horizontalIlluminance matches GetSunAndSkyIlluminance (relative 5e-3)', () => {
    const atm = new Atmosphere(renderer)
    atm.initSync()
    const mus = Array.from({ length: 64 }, (_, i) => -0.3 + (1.3 * i) / 63)
    const out = runKernel(renderer, {
      chunks: atm.chunks,
      includes: ['atmosphere/runtime'],
      uniforms: { ...atm.uniforms },
      body: `vec4 kernel(vec4 a, vec4 b, vec4 c, vec4 d) {
        vec3 n = vec3(0.0, 0.0, 1.0);
        vec3 p = n * ATMOSPHERE.bottom_radius;
        vec3 sun = vec3(sqrt(1.0 - a.x * a.x), 0.0, a.x);
        vec3 sky;
        vec3 sunI = GetSunAndSkyIlluminance(p, n, sun, sky);
        return vec4((sunI + sky) * 1000.0, 0.0);
      }`,
      inputs: [pack(mus.map((m) => [m]))],
    })
    const cpu = atm.cpu!
    mus.forEach((mu, i) => {
      const ref = luma(cpu.horizontalIlluminance(mu).total)
      const gpu = 0.2126 * out[i * 4]! + 0.7152 * out[i * 4 + 1]! + 0.0722 * out[i * 4 + 2]!
      if (ref > 1e-3) expect(relErr(gpu, ref)).toBeLessThan(5e-3)
    })
    atm.dispose()
  })
})
