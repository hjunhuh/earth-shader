import { afterAll, describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { raySphereStable } from '../../../src/geo/intersect'
import { directionToShading, ecefToShading, sphereCTerm } from '../../../src/geo/shadingSpace'
import { WGS84_A, geodeticToEcef } from '../../../src/geo/wgs84'
import { createTestRenderer, disposeTestRenderer, captureShaderErrors } from '../harness/context'
import { pack, relErr, runKernel } from '../harness/glslKernel'

const renderer = createTestRenderer(64, 64)
const errors = captureShaderErrors(renderer)
afterAll(() => disposeTestRenderer(renderer))

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

describe('GLSL–TS parity: geometry', () => {
  it('raySphereStable matches the float64 reference (relative 1e-4) from 10 m to 36,000 km', () => {
    const rand = rng(1)
    const cases: { b: number; c: number; expectNear: number; expectFar: number }[] = []
    for (let i = 0; i < 4096; ++i) {
      const altitude = 10 ** (1 + rand() * 6.6)
      const lon = (rand() * 2 - 1) * Math.PI
      const lat = (rand() * 2 - 1) * 1.5
      const o = ecefToShading(geodeticToEcef(lon, lat, altitude))
      // Aim below the horizon so the ray hits the ocean.
      const horizon = Math.asin(WGS84_A / o.length())
      const ang = rand() * horizon * 0.995
      const down = o.clone().normalize().negate()
      const side = new Vector3(-down.y, down.x, 0).normalize()
      const d = down.clone().multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang)).normalize()
      const b = o.dot(d)
      const c = sphereCTerm(o.length(), WGS84_A)
      const ref = raySphereStable(b, c)!
      cases.push({ b, c, expectNear: ref.near, expectFar: ref.far })
    }
    const out = runKernel(renderer, {
      includes: ['common/intersect'],
      body: 'vec4 kernel(vec4 a, vec4 b, vec4 c, vec4 d) { return vec4(raySphereStable(a.x, a.y), 0.0, 0.0); }',
      inputs: [pack(cases.map((k) => [k.b, k.c]))],
    })
    expect(errors.errors).toEqual([])
    let worst = 0
    cases.forEach((k, i) => {
      worst = Math.max(worst, relErr(out[i * 4]!, k.expectNear))
    })
    expect(worst).toBeLessThan(1e-4)
  })

  it('raySphereStable reports misses', () => {
    const out = runKernel(renderer, {
      includes: ['common/intersect'],
      body: 'vec4 kernel(vec4 a, vec4 b, vec4 c, vec4 d) { return vec4(raySphereStable(a.x, a.y), 0.0, 0.0); }',
      inputs: [pack([[0, 1], [10, 50], [-3, 8]])],
    })
    expect(Array.from(out.subarray(0, 2))).toEqual([-1, -1])
    // b=10, c=50 → t² + 20t + 50 = 0 → roots −10 ± √50
    expect(out[4]).toBeCloseTo(-10 - Math.sqrt(50), 4)
    expect(out[5]).toBeCloseTo(-10 + Math.sqrt(50), 4)
    expect(out[8]).toBeCloseTo(3 - 1, 5)
    expect(out[9]).toBeCloseTo(3 + 1, 5)
  })

  it('raySphereStable4 agrees with four scalar calls', () => {
    const rand = rng(7)
    const items: number[][] = []
    const cs: number[][] = []
    for (let i = 0; i < 512; ++i) {
      const r = WGS84_A + rand() * 20_000
      const b = -(rand() * 2 - 0.5) * r
      items.push([b])
      cs.push([0, 1000, 5000, 9000].map((h) => sphereCTerm(r, WGS84_A + h)))
    }
    const out = runKernel(renderer, {
      includes: ['common/intersect'],
      body: `vec4 kernel(vec4 a, vec4 c, vec4 x, vec4 y) {
        vec4 n, f; raySphereStable4(a.x, c, n, f); return n;
      }`,
      inputs: [pack(items), pack(cs)],
    })
    items.forEach(([b], i) => {
      for (let k = 0; k < 4; ++k) {
        const ref = raySphereStable(b!, cs[i]![k]!)
        const got = out[i * 4 + k]!
        if (ref === null) expect(got).toBe(-1)
        else expect(relErr(got, ref.near, 1)).toBeLessThan(1e-4)
      }
    })
  })

  it('shading-space direction transform matches the CPU', () => {
    const rand = rng(3)
    const dirs: number[][] = []
    for (let i = 0; i < 256; ++i) {
      dirs.push(new Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize().toArray())
    }
    const out = runKernel(renderer, {
      prelude: 'const float Z_SCALE = 1.0033640898209764;',
      body: 'vec4 kernel(vec4 a, vec4 b, vec4 c, vec4 d) { return vec4(normalize(a.xyz * vec3(1.0, 1.0, Z_SCALE)), 0.0); }',
      inputs: [pack(dirs)],
    })
    dirs.forEach((d, i) => {
      const ref = directionToShading(new Vector3(...(d as [number, number, number])))
      expect(Math.abs(out[i * 4]! - ref.x)).toBeLessThan(1e-6)
      expect(Math.abs(out[i * 4 + 2]! - ref.z)).toBeLessThan(1e-6)
    })
  })
})
