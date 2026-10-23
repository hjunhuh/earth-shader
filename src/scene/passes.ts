import { EffectAttribute, type Effect } from 'postprocessing'

const isConvolution = (effect: Effect) =>
  (effect.getAttributes() & EffectAttribute.CONVOLUTION) === EffectAttribute.CONVOLUTION

/**
 * Pass grouping of @react-three/postprocessing 3.0.4 (the version the takram
 * storybook uses): a non-convolution effect absorbs the following
 * non-convolution effects; convolution effects get a pass of their own.
 */
export function groupEffects<T extends Effect>(effects: readonly T[]): T[][] {
  const groups: T[][] = []
  for (let i = 0; i < effects.length; i++) {
    const group = [effects[i]!]
    if (!isConvolution(effects[i]!)) {
      while (i + 1 < effects.length && !isConvolution(effects[i + 1]!)) group.push(effects[++i]!)
    }
    groups.push(group)
  }
  return groups
}
