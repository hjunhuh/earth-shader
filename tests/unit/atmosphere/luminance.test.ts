import { describe, expect, it } from 'vitest'
import {
  SKY_SPECTRAL_RADIANCE_TO_LUMINANCE,
  SOLAR_WHITE_POINT,
  SUN_SPECTRAL_RADIANCE_TO_LUMINANCE,
  cieCmf,
  linearSrgbToXy,
  mccamyCct,
} from '../../../src/atmosphere/luminance'
import { AEROSOL_BRUNETON_2017, createEarthAtmosphere, atmosphereGlsl } from '../../../src/atmosphere/AtmosphereParams'

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b)

describe('radiance -> luminance conversion constants', () => {
  it('reproduces Bruneton\'s SKY constants (λ^-3) to 1e-6', () => {
    const ref = [114974.916437, 71305.954816, 65310.548555]
    SKY_SPECTRAL_RADIANCE_TO_LUMINANCE.forEach((v, i) => expect(rel(v, ref[i]!)).toBeLessThan(1e-6))
  })

  it('reproduces Bruneton\'s SUN constants (λ^0) to 1e-6', () => {
    const ref = [98242.786222, 69954.398112, 66475.012354]
    SUN_SPECTRAL_RADIANCE_TO_LUMINANCE.forEach((v, i) => expect(rel(v, ref[i]!)).toBeLessThan(1e-6))
  })

  it('CIE ȳ peaks at 555 nm with value 1', () => {
    expect(cieCmf(555, 2)).toBeCloseTo(1, 4)
    expect(cieCmf(359, 2)).toBe(0)
  })

  it('solar white point is slightly warm and normalized to mean 1', () => {
    const [r, g, b] = SOLAR_WHITE_POINT
    expect((r + g + b) / 3).toBeCloseTo(1, 12)
    expect(r).toBeGreaterThan(b)
  })

  it('McCamy CCT recovers D65 (~6504 K) from its chromaticity', () => {
    expect(mccamyCct([0.3127, 0.329])).toBeGreaterThan(6450)
    expect(mccamyCct([0.3127, 0.329])).toBeLessThan(6560)
    // Linear sRGB white is D65.
    const xy = linearSrgbToXy([1, 1, 1])
    expect(xy[0]).toBeCloseTo(0.3127, 3)
    expect(xy[1]).toBeCloseTo(0.329, 3)
  })
})

describe('Earth atmosphere parameters', () => {
  const p = createEarthAtmosphere({ aerosol: AEROSOL_BRUNETON_2017 })
  it('matches the Bruneton demo coefficients at 680/550/440 nm', () => {
    expect(rel(p.rayleighScattering[0], 5.802e-6)).toBeLessThan(1e-3)
    expect(rel(p.rayleighScattering[1], 13.558e-6)).toBeLessThan(1e-3)
    expect(rel(p.rayleighScattering[2], 33.1e-6)).toBeLessThan(1e-3)
    expect(rel(p.mieExtinction[0], 4.44e-6)).toBeLessThan(1e-9)
    expect(rel(p.mieScattering[0], 3.996e-6)).toBeLessThan(1e-9)
    expect(rel(p.absorptionExtinction[0], 0.65e-6)).toBeLessThan(2e-3)
    expect(rel(p.absorptionExtinction[1], 1.881e-6)).toBeLessThan(1e-3)
    expect(rel(p.absorptionExtinction[2], 0.085e-6)).toBeLessThan(1e-2)
    expect(p.solarIrradiance).toEqual([1.474, 1.8504, 1.91198])
    expect(p.muSMin).toBeCloseTo(-0.5, 12)
  })

  it('ozone=false removes absorption (negative control switch)', () => {
    expect(createEarthAtmosphere({ ozone: false }).absorptionExtinction).toEqual([0, 0, 0])
  })

  it('emits a km-unit GLSL constant block', () => {
    const glsl = atmosphereGlsl(p)
    expect(glsl).toContain('const AtmosphereParameters ATMOSPHERE')
    expect(glsl).toContain('6378.137')
    expect(glsl).not.toMatch(/NaN|Infinity/)
  })
})

describe('aerosol presets', () => {
  it('clear-day aerosol optical depth at 550 nm ≈ 0.09 with Ångström wavelength dependence', () => {
    const p = createEarthAtmosphere()
    const tau = p.mieExtinction.map((b) => b * 1200)
    expect(tau[1]).toBeGreaterThan(0.08)
    expect(tau[1]).toBeLessThan(0.1)
    expect(tau[2]).toBeGreaterThan(tau[1]!)
    expect(tau[0]).toBeLessThan(tau[1]!)
  })
})
