import type { Effect } from 'postprocessing'

/**
 * Fix for cloud-shadow patterns on the ocean when zooming out (looking down
 * from tens to hundreds of km) in @takram/three-atmosphere 0.19.1 with
 * @takram/three-clouds' shadows and light shafts.
 *
 * 1. Ground shadows: a hard-edged patch of dark blotches. The cascades cover
 *    the view frustum only up to shadow.maxFar (100 km), but
 *    getFadedCascadeIndex never fades out the last cascade, so every ground
 *    point beyond that range still samples it. Points that happen to fall
 *    inside the last cascade's box get shadows and the rest do not: the box's
 *    footprint shows up as a patch with straight edges (a diamond or a
 *    trapezoid, depending on the sun), filled with blotches far coarser than
 *    the clouds seen at that distance.
 * 2. Light shafts: a darker disc. Bruneton's light-shaft term assumes the
 *    shadowed part of a ray starts at the camera, which holds only when the
 *    camera is inside the cloud-shadow layer. From high above it darkens
 *    every pixel within the shadow-length march range (200 km).
 *
 * The patch scales both by coverage factors:
 *   - by camera height, 1 up to 30 km and 0 from 60 km, uniform over the
 *     screen so nothing is left in the middle of the view when zoomed out;
 *   - ground shadows also by view depth, 1 up to 0.7·maxFar and 0 at maxFar,
 *     i.e. only where the cascades are guaranteed to cover, with a soft edge.
 * Near the ground (all of the Clouds/Basic story's views) the factors are 1
 * for everything closer than 70 km, so shadows there are unchanged.
 */
const FADE_START = 30_000 // m above the atmosphere's bottom radius
const FADE_END = 60_000

const CAMERA_HEIGHT_FADE = `(1.0 - smoothstep(${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, length(vCameraPosition) / METER_TO_LENGTH_UNIT - bottomRadius))`

const PATCHES: { name: string; anchor: string; fix: string }[] = [
  {
    name: 'sampleShadowOpticalDepth',
    anchor: `  return cascadeIndex >= 0
    ? sampleShadowOpticalDepthPCF(worldPosition, distanceToTop, radius, cascadeIndex)
    : 0.0;
}`,
    fix: `  // earth-shader: only where the cascades cover (view depth < shadowFar),
  // and not from high above, where they cover only a patch of the view.
  float shadowViewDepth = -(viewMatrix * vec4(worldPosition, 1.0)).z;
  float shadowCoverage =
    (1.0 - smoothstep(0.7 * shadowFar, shadowFar, shadowViewDepth)) *
    ${CAMERA_HEIGHT_FADE};
  return cascadeIndex >= 0 && shadowCoverage > 0.0
    ? shadowCoverage * sampleShadowOpticalDepthPCF(worldPosition, distanceToTop, radius, cascadeIndex)
    : 0.0;
}`,
  },
  {
    name: 'shadow length',
    anchor: `  shadowLength = texture(shadowLengthBuffer, uv).r;
`,
    fix: `  shadowLength = texture(shadowLengthBuffer, uv).r;
  // earth-shader: light shafts assume the camera is in the cloud-shadow layer.
  shadowLength *= ${CAMERA_HEIGHT_FADE};
`,
  },
]

export function patchCloudShadowShader(source: string): string {
  let result = source
  for (const { name, anchor, fix } of PATCHES) {
    const first = result.indexOf(anchor)
    if (first < 0) throw new Error(`cloudShadowFade: ${name} not found (takram shader changed?)`)
    if (result.indexOf(anchor, first + 1) >= 0) throw new Error(`cloudShadowFade: ${name} anchor is not unique`)
    result = result.replace(anchor, fix)
  }
  return result
}

/** Apply to AerialPerspectiveEffect. */
export function applyCloudShadowFade<T extends Effect>(effect: T): T {
  const e = effect as unknown as { getFragmentShader(): string; setFragmentShader(s: string): void }
  e.setFragmentShader(patchCloudShadowShader(e.getFragmentShader()))
  return effect
}
