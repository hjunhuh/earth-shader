import { describe, expect, it } from 'vitest'
import {
  dualLobePhase,
  henyeyGreenstein,
  lacisHansenReflectance,
  octaveScattering,
  slabReflectance,
} from '../../reference/cloudLighting'

describe('cloud phase functions', () => {
  it('Henyey-Greenstein and the dual lobe integrate to 1 over the sphere', () => {
    for (const g of [-0.2, 0, 0.35, 0.7, 0.9]) {
      let s = 0
      const n = 20000
      for (let i = 0; i < n; ++i) s += henyeyGreenstein(-1 + (2 * (i + 0.5)) / n, g) * 2 * Math.PI * (2 / n)
      expect(s).toBeCloseTo(1, 4)
    }
    let d = 0
    for (let i = 0; i < 20000; ++i) d += dualLobePhase(-1 + (2 * (i + 0.5)) / 20000) * 2 * Math.PI * (2 / 20000)
    expect(d).toBeCloseTo(1, 4)
  })

  it('forward lobe dominates (silver lining) and octaves decrease monotonically with depth', () => {
    expect(dualLobePhase(1)).toBeGreaterThan(5 * dualLobePhase(-1))
    let prev = Infinity
    for (let t = 0; t <= 20; t += 0.5) {
      const v = octaveScattering(0.3, t, 6)
      expect(v).toBeLessThan(prev)
      prev = v
    }
  })
})

describe('cloud slab reflectance vs Lacis–Hansen (sun at zenith, viewed from above)', () => {
  for (const tau of [1, 5, 10, 20, 50]) {
    it(`τ = ${tau}: |R − R_LH| < 0.1`, () => {
      const R = slabReflectance(tau)
      expect(Math.abs(R - lacisHansenReflectance(tau)), `R=${R.toFixed(3)} LH=${lacisHansenReflectance(tau).toFixed(3)}`).toBeLessThan(0.1)
    })
  }

  it('reflectance increases monotonically with optical thickness and stays < 1', () => {
    let prev = 0
    for (const tau of [0.5, 1, 2, 5, 10, 20, 50, 100]) {
      const R = slabReflectance(tau, 6, false, 2000)
      expect(R).toBeGreaterThan(prev)
      expect(R).toBeLessThan(1)
      prev = R
    }
  })

  it('cloud bases seen from below darken as the cloud thickens (diffuse transmission)', () => {
    const thin = slabReflectance(5, 6, true, 2000)
    const thick = slabReflectance(50, 6, true, 2000)
    expect(thick).toBeLessThan(thin)
    expect(thick).toBeGreaterThan(0)
  })
})
