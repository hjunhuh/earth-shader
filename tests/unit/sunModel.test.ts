import { describe, expect, it } from 'vitest'
import { glareFraction, glarePsf, LIMB_DARKENING, psfTerms, SCATTERED_FRACTION, SPENCER, sunDiskSolidAngle } from '../../src/scene/sunModel'

/** ∫ f dΩ over the sphere for f(θ in degrees), per steradian. */
function sphereIntegral(f: (deg: number) => number): number {
  // Log-spaced in θ to resolve the cores (0.02° and the 1/θ³ cusp).
  let sum = 0
  const n = 200000
  const lo = Math.log(1e-6)
  const hi = Math.log(180)
  for (let i = 0; i < n; ++i) {
    const a = Math.exp(lo + ((i + 0.5) / n) * (hi - lo))
    const da = a * ((hi - lo) / n)
    const t = (a * Math.PI) / 180
    sum += f(a) * 2 * Math.PI * Math.sin(t) * ((da * Math.PI) / 180)
  }
  return sum
}

describe('Spencer et al. 1995 photopic PSF', () => {
  it('each term is normalized over the sphere (per steradian)', () => {
    expect(sphereIntegral(psfTerms.f0)).toBeCloseTo(1, 2)
    expect(sphereIntegral(psfTerms.f1)).toBeCloseTo(1, 1)
    expect(Math.abs(sphereIntegral(psfTerms.f2) - 1)).toBeLessThan(0.1)
  })

  it('weights sum to 1; 61.6% of the light is scattered into the glare', () => {
    expect(SPENCER.w0 + SPENCER.w1 + SPENCER.w2).toBeCloseTo(1, 9)
    expect(SCATTERED_FRACTION).toBeCloseTo(0.616, 9)
  })

  it('glare PSF falls off monotonically: ~1/θ³ near the sun, ~1/θ² far away', () => {
    let prev = Infinity
    for (let d = 0.1; d < 60; d *= 1.2) {
      const v = glarePsf(d)
      expect(v).toBeLessThan(prev)
      prev = v
    }
    const slope = (a: number, b: number) => Math.log(glarePsf(b) / glarePsf(a)) / Math.log(b / a)
    expect(slope(0.2, 0.3)).toBeLessThan(-2.5)
    expect(slope(30, 60)).toBeGreaterThan(-2.2)
  })

  it('glare fraction scales with the glare setting and never empties the disk', () => {
    expect(glareFraction(0)).toBe(0)
    expect(glareFraction(0.4)).toBeCloseTo(0.4 * 0.616, 9)
    expect(glareFraction(10)).toBe(0.95)
    expect(glareFraction(-1)).toBe(0)
  })
})

describe('sun disk', () => {
  it('solid angle 2π(1 − cos r) ≈ πr² for the sun (6.87e-5 sr)', () => {
    expect(sunDiskSolidAngle(0.004675)).toBeCloseTo(6.866e-5, 7)
  })

  it('limb darkening is stronger at shorter wavelengths', () => {
    expect(LIMB_DARKENING[0]).toBeLessThan(LIMB_DARKENING[1])
    expect(LIMB_DARKENING[1]).toBeLessThan(LIMB_DARKENING[2])
    for (const u of LIMB_DARKENING) expect(u).toBeGreaterThan(0.4)
  })
})
