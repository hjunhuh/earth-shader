import { afterAll, describe, expect, it } from 'vitest'
import { hash33, perlinNoise, worleyNoise } from '../../reference/noise'
import { captureShaderErrors, createTestRenderer, disposeTestRenderer } from '../harness/context'
import { pack, runKernel } from '../harness/glslKernel'

const renderer = createTestRenderer(64, 64)
const errors = captureShaderErrors(renderer)
afterAll(() => disposeTestRenderer(renderer))

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

describe('GLSL–TS parity: noise', () => {
  it('hash33 is bit-identical on lattice points (incl. negative and wrapped cells)', () => {
    const rand = rng(2)
    const cells: number[][] = []
    for (let i = 0; i < 512; ++i) cells.push([Math.floor(rand() * 200 - 100), Math.floor(rand() * 200 - 100), Math.floor(rand() * 200 - 100), Math.floor(rand() * 40) + 1])
    const out = runKernel(renderer, {
      includes: ['common/noise'],
      body: 'vec4 kernel(vec4 a, vec4 b, vec4 c, vec4 d) { return vec4(hash33(ivec3(a.xyz), int(a.w), 3u), 0.0); }',
      inputs: [pack(cells)],
    })
    expect(errors.errors).toEqual([])
    cells.forEach(([x, y, z, p], i) => {
      const h = hash33(x!, y!, z!, p!, 3)
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]).toEqual(h.map(Math.fround))
    })
  })

  it('perlinNoise and worleyNoise match the TS twin (abs 1e-5) and tile with their period', () => {
    const rand = rng(9)
    const pts: number[][] = []
    for (let i = 0; i < 1024; ++i) pts.push([rand() * 16, rand() * 16, rand() * 16, 8])
    const out = runKernel(renderer, {
      includes: ['common/noise'],
      body: `vec4 kernel(vec4 a, vec4 b, vec4 c, vec4 d) {
        int per = int(a.w);
        return vec4(perlinNoise(a.xyz, per, 5u), worleyNoise(a.xyz, per, 5u),
                    perlinNoise(a.xyz + vec3(float(per), 0.0, 0.0), per, 5u),
                    worleyNoise(a.xyz + vec3(0.0, 0.0, float(per)), per, 5u));
      }`,
      inputs: [pack(pts)],
    })
    pts.forEach(([x, y, z, p], i) => {
      expect(Math.abs(out[i * 4]! - perlinNoise(x!, y!, z!, p!, 5))).toBeLessThan(1e-5)
      expect(Math.abs(out[i * 4 + 1]! - worleyNoise(x!, y!, z!, p!, 5))).toBeLessThan(1e-5)
      // Periodicity: shifting by one period gives the same value.
      expect(Math.abs(out[i * 4 + 2]! - out[i * 4]!)).toBeLessThan(1e-4)
      expect(Math.abs(out[i * 4 + 3]! - out[i * 4 + 1]!)).toBeLessThan(1e-4)
    })
  })
})
