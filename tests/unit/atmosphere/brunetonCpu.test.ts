import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createEarthAtmosphere } from '../../../src/atmosphere/AtmosphereParams'
import { BrunetonCpu } from '../../reference/brunetonCpu'

const cpu = new BrunetonCpu(createEarthAtmosphere())

describe('Bruneton CPU reference: texture mappings', () => {
  it('transmittance UV <-> (r, mu) round-trips', () => {
    fc.assert(
      // Domain: texel-center range [0.5/size, 1 - 0.5/size] (width 256, height 64).
      fc.property(fc.double({ min: 0.5 / 256, max: 1 - 0.5 / 256, noNaN: true }), fc.double({ min: 0.5 / 64, max: 1 - 0.5 / 64, noNaN: true }), (u, v) => {
        const { r, mu } = cpu.rMuFromTransmittanceUv(u, v)
        const [u2, v2] = cpu.transmittanceUvFromRMu(r, mu)
        expect(u2).toBeCloseTo(u, 9)
        expect(v2).toBeCloseTo(v, 9)
      }),
    )
  })

  it('scattering UVWZ <-> (r, mu, mu_s, nu) round-trips on both ground/sky halves', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        fc.double({ min: 0.02, max: 0.98, noNaN: true }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        fc.double({ min: 0.02, max: 0.98, noNaN: true }),
        (x, y, z, w) => {
          if (Math.abs(z - 0.5) < 0.01) return
          const p = cpu.rMuMuSNuFromScatteringUvwz([x, y, z, w])
          const back = cpu.scatteringUvwzFromRMuMuSNu(p.r, p.mu, p.muS, p.nu, p.ground)
          expect(back[0]).toBeCloseTo(x, 7)
          expect(back[1]).toBeCloseTo(y, 6)
          expect(back[2]).toBeCloseTo(z, 6)
          expect(back[3]).toBeCloseTo(w, 7)
        },
      ),
    )
  })

  it('ground flag matches RayIntersectsGround for decoded parameters', () => {
    for (let z = 0.02; z < 0.98; z += 0.01) {
      const p = cpu.rMuMuSNuFromScatteringUvwz([0.5, 0.5, z, 0.5])
      if (Math.abs(z - 0.5) < 0.01) continue
      expect(cpu.rayIntersectsGround(p.r, p.mu)).toBe(p.ground)
    }
  })
})

describe('Bruneton CPU reference: physics sanity', () => {
  it('zenith transmittance at sea level is plausible (blue < green < red, red ≈ 0.9)', () => {
    const t = cpu.transmittanceToTopExact(cpu.bottom, 1)
    expect(t[0]).toBeGreaterThan(t[1])
    expect(t[1]).toBeGreaterThan(t[2])
    expect(t[0]).toBeGreaterThan(0.85)
    expect(t[0]).toBeLessThan(0.97)
    expect(t[2]).toBeGreaterThan(0.6)
  })

  it('transmittance is 1 at the top and decreases toward the horizon', () => {
    const top = cpu.transmittanceToTopExact(cpu.top, 0.5)
    expect(top[2]).toBeCloseTo(1, 9)
    let prev = 2
    for (let mu = 1; mu >= 0; mu -= 0.1) {
      const t = cpu.transmittanceToTopExact(cpu.bottom, mu)[2]
      expect(t).toBeLessThan(prev)
      prev = t
    }
  })

  it('Rayleigh phase integrates to 1 over the sphere; Mie (Cornette-Shanks) too', () => {
    let ir = 0
    let im = 0
    const n = 20000
    for (let i = 0; i < n; ++i) {
      const mu = -1 + (2 * (i + 0.5)) / n
      ir += BrunetonCpu.rayleighPhase(mu) * 2 * Math.PI * (2 / n)
      im += cpu.miePhase(mu) * 2 * Math.PI * (2 / n)
    }
    expect(ir).toBeCloseTo(1, 6)
    expect(im).toBeCloseTo(1, 3)
  })

  it('direct irradiance follows the cosine law above the sun radius', () => {
    const a = cpu.directIrradiance(cpu.bottom, 1)
    const t = cpu.transmittanceToTopExact(cpu.bottom, 1)
    expect(a[1]).toBeCloseTo(cpu.solarIrradiance[1] * t[1], 9)
    expect(cpu.directIrradiance(cpu.bottom, -0.1)).toEqual([0, 0, 0])
  })
})
