import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  PRECISION_HEADER,
  ShaderIncludeError,
  applyDefines,
  buildShader,
  formatFloat,
  normalizeDefines,
  resolveIncludes,
  shaderChunks,
} from '../../../src/render/shaderLib'
import { atmosphereChunks, createEarthAtmosphere } from '../../../src/atmosphere/AtmosphereParams'

describe('resolveIncludes', () => {
  const chunks = { a: 'A\n#include "b"', b: 'B', c: '#include "d"', d: '#include "c"', e: '#include "b"\n#include "b"' }

  it('inlines nested includes', () => {
    const out = resolveIncludes('#include "a"\nmain', chunks)
    expect(out).toContain('A')
    expect(out).toContain('B')
    expect(out).not.toMatch(/#include/)
  })

  it('includes each chunk once (guard semantics)', () => {
    const out = resolveIncludes('#include "e"', chunks)
    expect(out.match(/^B$/gm)?.length).toBe(1)
  })

  it('throws on cycles and missing chunks', () => {
    expect(() => resolveIncludes('#include "c"', chunks)).toThrow(ShaderIncludeError)
    expect(() => resolveIncludes('#include "nope"', chunks)).toThrow(/Unresolved/)
  })

  it('every registered chunk resolves without errors', () => {
    expect(Object.keys(shaderChunks).length).toBeGreaterThan(0)
    const all = { ...shaderChunks, ...atmosphereChunks(createEarthAtmosphere()) }
    for (const [name, src] of Object.entries(all)) {
      expect(() => resolveIncludes(src, all), name).not.toThrow()
    }
  })

  it('buildShader prepends precision qualifiers for all sampler types', () => {
    const s = buildShader('void main(){}')
    expect(s.startsWith(PRECISION_HEADER)).toBe(true)
    for (const t of ['float', 'int', 'sampler2D', 'sampler3D', 'samplerCube']) expect(s).toContain(`precision highp ${t};`)
  })
})

describe('defines', () => {
  it('normalizes values (true -> 1, false omitted, floats keep a decimal point)', () => {
    expect(normalizeDefines({ A: true, B: false, C: 3, D: 0.5, E: 2.0, F: undefined, G: 'vec3(1)' })).toEqual({
      A: '1',
      C: '3',
      D: '0.500000000',
      E: '2',
      G: 'vec3(1)',
    })
    expect(formatFloat(1e-7)).toMatch(/e/)
  })

  it('applyDefines requests a recompile only when the define set changes', () => {
    const mat = { defines: {} as Record<string, unknown>, needsUpdate: false }
    expect(applyDefines(mat, { A: true })).toBe(true)
    mat.needsUpdate = false
    expect(applyDefines(mat, { A: true, B: false })).toBe(false)
    expect(mat.needsUpdate).toBe(false)
    expect(applyDefines(mat, { A: false })).toBe(true)
  })

  it('after any sequence of updates, defines equal those of a fresh material (no stale flags)', () => {
    const keys = ['GROUND_BOUNCE', 'POWDER', 'SHAPE_DETAIL', 'LIGHT_SHAFTS', 'STEPS']
    const defineSet = fc.record(
      Object.fromEntries(keys.map((k) => [k, fc.oneof(fc.boolean(), fc.integer({ min: 0, max: 8 }))])),
    )
    fc.assert(
      fc.property(fc.array(defineSet, { minLength: 1, maxLength: 20 }), (seq) => {
        const mat = { defines: {} as Record<string, unknown>, needsUpdate: false }
        for (const d of seq) applyDefines(mat, d)
        const fresh = { defines: {} as Record<string, unknown>, needsUpdate: false }
        applyDefines(fresh, seq[seq.length - 1]!)
        expect(mat.defines).toEqual(fresh.defines)
      }),
    )
  })
})
