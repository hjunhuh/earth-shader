import { describe, expect, it } from 'vitest'
import { FloatType, type WebGLRenderer } from 'three'
import { PrecomputedTexturesGenerator } from '@takram/three-atmosphere'
import { applyScatteringLutFix, patchScatteringLutShader } from '../../src/scene/scatteringLutFix'

// The materials are built in the constructor; the renderer is only used by update().
const generator = () => new PrecomputedTexturesGenerator({} as WebGLRenderer, { type: FloatType })

describe('scattering LUT precision fix for takram precompute', () => {
  const source = generator().singleScatteringMaterial.fragmentShader

  it('finds the takram code it targets exactly once', () => {
    // The transmittance LUT's inverse has the same formula; its texel is correct (1.0) and is left alone.
    expect(source.match(/ClampCosine\(\(H \* H - rho \* rho - d \* d\)/g)?.length).toBe(1)
    const patched = patchScatteringLutShader(source)
    expect(patched).not.toContain('ClampCosine((H * H - rho * rho - d * d)')
    expect(patched).toContain('d_min * (atmosphere.top_radius + r) - d * d')
  })

  it('changes only the mu formula of the sky half', () => {
    const patched = patchScatteringLutShader(source)
    const strip = (s: string) =>
      s.replace(/\n {4}\/\/ earth-shader:[^\n]*\n[^\n]*\n/, '\n').replace(/ClampCosine\(\([^;]*\/ \(2\.0 \* r \* d\)\);\n {4}ray_r_mu_intersects_ground = false/, 'X')
    expect(strip(patched)).toBe(strip(source))
  })

  it('the new form is the same mu, and exactly 1 at d = d_min even when r misses top', () => {
    const top = 6420
    const bottom = 6360
    const H = Math.sqrt(top * top - bottom * bottom)
    const f = Math.fround
    for (const x of [0.2, 0.5, 0.9, 1]) {
      const rho = H * x
      const r = Math.sqrt(rho * rho + bottom * bottom)
      const dMin = top - r
      for (const t of [0.01, 0.3, 1]) {
        const d = dMin + (rho + H - dMin) * t
        const before = (H * H - rho * rho - d * d) / (2 * r * d)
        const after = (dMin * (top + r) - d * d) / (2 * r * d)
        expect(after).toBeCloseTo(before, 9)
      }
    }
    // Top slice in float32: r = top + rounding error, d = d_min = that error.
    const rho = f(H)
    const r = f(Math.sqrt(f(f(rho * rho) + f(bottom * bottom))))
    const dMin = f(top - r)
    if (dMin !== 0) {
      const after = f(f(f(dMin * f(top + r)) - f(dMin * dMin)) / f(2 * f(r * dMin)))
      expect(after).toBeCloseTo(1, 6)
    }
  })

  it('patches all three scattering passes of a generator', () => {
    const g = applyScatteringLutFix(generator())
    for (const m of [g.singleScatteringMaterial, g.scatteringDensityMaterial, g.multipleScatteringMaterial]) {
      expect(m.fragmentShader).toContain('earth-shader: H² − rho²')
    }
  })

  it('fails loudly if takram changes the shader', () => {
    expect(() => patchScatteringLutShader('void main() {}')).toThrow(/not found/)
  })
})
