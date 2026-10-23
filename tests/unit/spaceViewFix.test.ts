import { describe, expect, it } from 'vitest'
import { AerialPerspectiveEffect } from '@takram/three-atmosphere'
import { applySpaceViewFix, patchSkyRadianceShader } from '../../src/scene/spaceViewFix'

describe('space-view fix for takram GetSkyRadiance', () => {
  const source = new AerialPerspectiveEffect().getFragmentShader()

  it('finds the takram code it targets exactly once', () => {
    expect(source.match(/SafeSqrt\(rmu \* rmu - r \* r \+/g)?.length).toBe(2) // GetSkyRadiance + ToPoint
    const patched = patchSkyRadianceShader(source)
    expect(patched).not.toBe(source)
    expect(patched.match(/earth-shader: a ray from space/g)?.length).toBe(1)
  })

  it('only inserts an early return; the rest of the shader is untouched', () => {
    const patched = patchSkyRadianceShader(source)
    const inserted = patched.length - source.length
    const start = patched.indexOf('  // earth-shader: a ray from space')
    const removed = patched.slice(0, start) + patched.slice(start + inserted)
    expect(removed).toBe(source)
  })

  it('patches an effect in place', () => {
    const effect = applySpaceViewFix(new AerialPerspectiveEffect())
    expect(effect.getFragmentShader()).toContain('earth-shader: a ray from space')
  })

  it('fails loudly if takram changes the shader', () => {
    expect(() => patchSkyRadianceShader('void main() {}')).toThrow(/not found/)
  })
})
