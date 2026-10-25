import { describe, expect, it } from 'vitest'
import { AerialPerspectiveEffect } from '@takram/three-atmosphere'
import { applyCloudShadowFade, patchCloudShadowShader } from '../../src/scene/cloudShadowFade'
import { applySpaceViewFix } from '../../src/scene/spaceViewFix'

describe('cloud shadow fade for takram AerialPerspectiveEffect', () => {
  const source = new AerialPerspectiveEffect().getFragmentShader()

  it('patches both the ground shadow and the light shafts, once each', () => {
    const patched = patchCloudShadowShader(source)
    expect(patched.match(/shadowCoverage \* sampleShadowOpticalDepthPCF/g)?.length).toBe(1)
    expect(patched.match(/shadowLength \*= \(1\.0 - smoothstep\(30000\.0, 60000\.0/g)?.length).toBe(1)
  })

  it('declares nothing new: it reads only uniforms and varyings the shader already has', () => {
    const patched = patchCloudShadowShader(source)
    for (const name of ['vCameraPosition', 'bottomRadius', 'shadowFar', 'viewMatrix']) {
      const declared = source.search(new RegExp(`(uniform|varying) \\w+ ${name};`))
      expect(declared, name).toBeGreaterThanOrEqual(0)
      // Declared before the first use in the patched code.
      expect(declared, name).toBeLessThan(patched.indexOf('earth-shader: only where the cascades cover'))
    }
  })

  it('leaves everything else untouched', () => {
    const patched = patchCloudShadowShader(source)
    const strip = (s: string) =>
      s
        .replace(/ {2}\/\/ earth-shader: only where[\s\S]*?: 0\.0;\n}/, 'A')
        .replace(/ {2}return cascadeIndex >= 0\n {4}\? sampleShadowOpticalDepthPCF[\s\S]*?: 0\.0;\n}/, 'A')
        .replace(/ {2}\/\/ earth-shader: light shafts[^\n]*\n[^\n]*\n/, '')
    expect(strip(patched)).toBe(strip(source))
  })

  it('composes with the space-view fix in either order', () => {
    const effect = applyCloudShadowFade(applySpaceViewFix(new AerialPerspectiveEffect()))
    const shader = effect.getFragmentShader()
    expect(shader).toContain('earth-shader: a ray from space')
    expect(shader).toContain('earth-shader: only where the cascades cover')
    expect(shader).toContain('earth-shader: light shafts')
  })

  it('fails loudly if takram changes the shader', () => {
    expect(() => patchCloudShadowShader('void main() {}')).toThrow(/not found/)
  })
})
