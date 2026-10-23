import { describe, expect, it } from 'vitest'
import { ev100FromIlluminance } from '../../../src/atmosphere/AtmosphereCpu'
import { autoEvRange, exposureFromEv100 } from '../../../src/render/exposure'
import { directionalAlbedo, fresnelSchlick, ggxD } from '../../reference/oceanBrdf'

// Defaults used by the renderer (src/render/Pipeline.ts).
const OCEAN_ALBEDO_GREEN = 0.016
const OCEAN_ROUGHNESS = 0.2

/** Taylor et al. (1996) ocean albedo for direct beam. */
const taylor = (mu0: number) => 0.037 / (1.1 * mu0 ** 1.4 + 0.15)

describe('ocean BRDF', () => {
  it('Fresnel matches water (n = 1.33): F0 = 0.02, F(grazing) = 1', () => {
    expect(fresnelSchlick(1)).toBeCloseTo(0.02, 6)
    expect(fresnelSchlick(0)).toBeCloseTo(1, 6)
  })

  it('GGX distribution is normalized: ∫ D(h) cosθh dω = 1', () => {
    let s = 0
    const n = 4000
    for (let i = 0; i < n; ++i) {
      const c = (i + 0.5) / n
      s += ggxD(c, OCEAN_ROUGHNESS) * c * (1 / n) * 2 * Math.PI
    }
    expect(s).toBeCloseTo(1, 3)
  })

  for (const mu0 of [1, 0.5, 0.1]) {
    it(`directional albedo at μ0 = ${mu0} is within ±25% of Taylor 1996 (${taylor(mu0).toFixed(3)})`, () => {
      const a = directionalAlbedo(mu0, OCEAN_ALBEDO_GREEN, OCEAN_ROUGHNESS)
      expect(Math.abs(a - taylor(mu0)) / taylor(mu0)).toBeLessThan(0.25)
    })
  }

  it('albedo never exceeds 1 (energy conservation)', () => {
    for (const mu0 of [1, 0.7, 0.3, 0.05]) expect(directionalAlbedo(mu0, 1, OCEAN_ROUGHNESS, 120)).toBeLessThan(1)
  })
})

describe('exposure', () => {
  it('incident-meter EV100 ≈ 15 at 100 klx (sunny-16) and 0 at 2.5 lx', () => {
    expect(Math.abs(ev100FromIlluminance(1e5) - 15)).toBeLessThan(0.3)
    expect(ev100FromIlluminance(2.5)).toBeCloseTo(0, 9)
  })

  it('exposure halves per EV', () => {
    expect(exposureFromEv100(10) / exposureFromEv100(11)).toBeCloseTo(2, 12)
  })

  it('auto range narrows to daylight EV from orbit and is free near the ground', () => {
    expect(autoEvRange(100)).toEqual([-3, 16])
    const [lo, hi] = autoEvRange(2e7)
    expect(lo).toBeCloseTo(14.3, 9)
    expect(hi).toBeCloseTo(15, 9)
    let prev = -Infinity
    for (let e = 1; e <= 8; e += 0.1) {
      const [l] = autoEvRange(10 ** e)
      expect(l).toBeGreaterThanOrEqual(prev)
      prev = l
    }
  })
})
