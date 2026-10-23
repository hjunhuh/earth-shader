import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { DEFAULT_LAYERS, packIntervals, packLayers, shapeAltering, type CloudLayer } from '../../../src/clouds/layers'
import { QUALITY_PRESETS, presetCost, presetToDefines } from '../../../src/clouds/presets'
import { climatology, syntheticWeatherUniforms, weatherMode } from '../../../src/clouds/weather'
import { applyDefines } from '../../../src/render/shaderLib'
import { QUALITIES } from '../../../src/app/state'

const layer = (altitude: number, height: number): CloudLayer => ({ ...DEFAULT_LAYERS[0]!, altitude, height })

describe('cloud layers', () => {
  it('packs the default layers into the shell 750–8000 m with one gap 2200–7500 m', () => {
    const { shell, gaps } = packIntervals(DEFAULT_LAYERS)
    expect(shell).toEqual({ min: 750, max: 8000 })
    expect(gaps).toEqual([{ min: 2200, max: 7500 }])
  })

  it('handles overlap, containment, adjacency and empty layers', () => {
    expect(packIntervals([layer(0, 100), layer(50, 10)]).gaps).toEqual([])
    expect(packIntervals([layer(0, 100), layer(100, 50)])).toEqual({ shell: { min: 0, max: 150 }, gaps: [] })
    expect(packIntervals([layer(0, 0)])).toEqual({ shell: { min: 0, max: 0 }, gaps: [] })
    expect(packIntervals([layer(0, 10), layer(20, 10), layer(40, 10), layer(60, 10)]).gaps.length).toBe(3)
  })

  it('gaps never overlap any layer (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 0, max: 3000 })), { minLength: 1, maxLength: 4 }), (spec) => {
        const ls = spec.map(([a, h]) => layer(a, h))
        const { shell, gaps } = packIntervals(ls)
        for (const g of gaps) {
          expect(g.max).toBeGreaterThan(g.min)
          expect(g.min).toBeGreaterThanOrEqual(shell.min)
          expect(g.max).toBeLessThanOrEqual(shell.max)
          for (const l of ls) if (l.height > 0) expect(l.altitude + l.height <= g.min || l.altitude >= g.max).toBe(true)
        }
      }),
    )
  })

  it('packs vec4 channels in layer order and zeroes empty layers', () => {
    const p = packLayers(DEFAULT_LAYERS)
    expect(p.minHeights.toArray()).toEqual([750, 1000, 7500, 0])
    expect(p.maxHeights.toArray()).toEqual([1400, 2200, 8000, 0])
    expect(p.densityScales.w).toBe(0)
    expect(p.shadowMask.toArray()).toEqual([1, 1, 1, 0])
  })

  it('shape-altering function peaks at f = 0.5^(1/bias) and vanishes at the ends', () => {
    const bias = 0.35
    const peak = 0.5 ** (1 / bias)
    expect(shapeAltering(peak, bias)).toBeCloseTo(1, 12)
    expect(shapeAltering(0, bias)).toBeCloseTo(0, 12)
    expect(shapeAltering(1, bias)).toBeCloseTo(0, 12)
    expect(shapeAltering(peak + 0.1, bias)).toBeLessThan(1)
  })
})

describe('quality presets', () => {
  it('cost is monotonic low ≤ medium ≤ high and every knob is sane', () => {
    const costs = (['low', 'medium', 'high'] as const).map((q) => presetCost(QUALITY_PRESETS[q]))
    expect(costs[0]).toBeLessThan(costs[1]!)
    expect(costs[1]).toBeLessThan(costs[2]!)
    for (const q of QUALITIES) {
      const p = QUALITY_PRESETS[q]
      expect(p.minStep).toBeLessThan(p.maxStep)
      expect(p.minTransmittance).toBeGreaterThan(0)
      expect(Number.isInteger(Math.log2(p.sunOpticalDepthSize))).toBe(true)
    }
  })

  it('disabled clouds turn every cloud define off', () => {
    for (const q of QUALITIES) {
      expect(presetToDefines(QUALITY_PRESETS[q], { enabled: false, physical: false, shadows: true, weatherMode: 0 })).toEqual({ CLOUDS: false })
    }
  })

  it('after random preset/toggle sequences, defines equal those of a fresh material (no stale flags)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ q: fc.constantFrom(...QUALITIES), enabled: fc.boolean(), physical: fc.boolean(), shadows: fc.boolean() }), { minLength: 1, maxLength: 12 }),
        (seq) => {
          const mat = { defines: {} as Record<string, unknown>, needsUpdate: false }
          for (const s of seq) applyDefines(mat, presetToDefines(QUALITY_PRESETS[s.q], { ...s, weatherMode: 0 }))
          const last = seq[seq.length - 1]!
          const fresh = { defines: {} as Record<string, unknown>, needsUpdate: false }
          applyDefines(fresh, presetToDefines(QUALITY_PRESETS[last.q], { ...last, weatherMode: 0 }))
          expect(mat.defines).toEqual(fresh.defines)
        },
      ),
    )
  })
})

describe('weather', () => {
  it('climatology: ITCZ cloudier than the subtropical highs; storm tracks cloudier than subtropics', () => {
    const itcz = climatology(5)
    const sub = climatology(25)
    const storm = climatology(52)
    for (let c = 0; c < 3; ++c) {
      expect(itcz[c]).toBeGreaterThan(sub[c]!)
      expect(storm[c]).toBeGreaterThan(sub[c]!)
    }
    for (let lat = -90; lat <= 90; lat += 5) for (const v of climatology(lat)) expect(v).toBeGreaterThanOrEqual(0)
  })

  it('synthetic weather: slab σ = τ / thickness; blob center is a unit vector', () => {
    expect(syntheticWeatherUniforms({ kind: 'slab', tau: 10, bottom: 1000, top: 2000 }).params.toArray()).toEqual([1000, 2000, 0.01, 0])
    const b = syntheticWeatherUniforms({ kind: 'blob', lat: 30, lon: 40, bottom: 1000, top: 2000, radius: 3000 })
    expect(Math.hypot(b.center.x, b.center.y, b.center.z)).toBeCloseTo(1, 12)
    expect(weatherMode({ kind: 'clear' })).toBe(1)
  })
})
