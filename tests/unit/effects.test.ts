import { describe, expect, it } from 'vitest'
import { Effect, EffectAttribute, SMAAEffect, ToneMappingEffect } from 'postprocessing'
import { DitheringEffect, LensFlareEffect } from '@takram/three-geospatial-effects'
import { groupEffects } from '../../src/scene/passes'

/** Stand-ins with the attributes of CloudsEffect / AerialPerspectiveEffect (both EffectAttribute.DEPTH). */
const depthEffect = (name: string) => new Effect(name, 'void mainImage(const in vec4 a, const in vec2 b, out vec4 c) { c = a; }', { attributes: EffectAttribute.DEPTH })

describe('effect pass grouping (@react-three/postprocessing 3.0.4)', () => {
  it('splits the story’s effect list into the same passes', () => {
    const clouds = depthEffect('Clouds')
    const aerial = depthEffect('AerialPerspective')
    const lens = new LensFlareEffect()
    const tone = new ToneMappingEffect()
    const smaa = new SMAAEffect()
    const dither = new DitheringEffect()
    expect(groupEffects([clouds, aerial, lens, tone, smaa, dither])).toEqual([[clouds, aerial], [lens], [tone], [smaa], [dither]])
    // Clouds disabled.
    expect(groupEffects([aerial, lens, tone, smaa, dither])).toEqual([[aerial], [lens], [tone], [smaa], [dither]])
  })

  it('convolution effects never share a pass', () => {
    const a = new LensFlareEffect()
    const b = new SMAAEffect()
    const c = new ToneMappingEffect()
    const d = new DitheringEffect()
    expect(groupEffects([a, b, c, d])).toEqual([[a], [b], [c, d]])
  })
})
