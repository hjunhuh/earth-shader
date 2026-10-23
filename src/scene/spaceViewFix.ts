import type { Effect } from 'postprocessing'

/**
 * Fix for viewing the sky from above the atmosphere (camera higher than
 * ~60 km) in @takram/three-atmosphere 0.19.1.
 *
 * takram replaced Bruneton's `sqrt` with `SafeSqrt` in GetSkyRadiance
 * (three-geospatial PR #26). When the camera is in space and a view ray
 * misses the atmosphere, the discriminant is negative; Bruneton relied on the
 * resulting NaN to fall through to "return 0", but SafeSqrt yields
 * −dot(camera, ray) > 0 for every ray pointing toward the planet's side, so
 * the camera is moved to a point that is not on the atmosphere and black
 * space renders as blue sky with a dark band.
 *
 * The patch returns zero radiance for exactly that case and changes nothing
 * else: whenever the camera is inside the atmosphere (all of the Clouds/Basic
 * story's views) the condition is false and the shader behaves as before.
 */
const ANCHOR = `atmosphere.top_radius * atmosphere.top_radius);
  // If the viewer is in space and the view ray intersects the atmosphere, move
  // the viewer to the top atmosphere boundary (along the view ray):
  if (distance_to_top_atmosphere_boundary > 0.0 * m) {
    camera = camera + view_ray * distance_to_top_atmosphere_boundary;
    r = atmosphere.top_radius;
    rmu += distance_to_top_atmosphere_boundary;
  } else if (r > atmosphere.top_radius) {`

const FIX = `atmosphere.top_radius * atmosphere.top_radius);
  // earth-shader: a ray from space that misses the atmosphere sees nothing.
  if (r > atmosphere.top_radius &&
      rmu * rmu - r * r + atmosphere.top_radius * atmosphere.top_radius < 0.0) {
    transmittance = DimensionlessSpectrum(1.0);
    return RadianceSpectrum(0.0 * watt_per_square_meter_per_sr_per_nm);
  }
  // If the viewer is in space and the view ray intersects the atmosphere, move
  // the viewer to the top atmosphere boundary (along the view ray):
  if (distance_to_top_atmosphere_boundary > 0.0 * m) {
    camera = camera + view_ray * distance_to_top_atmosphere_boundary;
    r = atmosphere.top_radius;
    rmu += distance_to_top_atmosphere_boundary;
  } else if (r > atmosphere.top_radius) {`

export function patchSkyRadianceShader(source: string): string {
  const first = source.indexOf(ANCHOR)
  if (first < 0) throw new Error('spaceViewFix: GetSkyRadiance not found (takram shader changed?)')
  if (source.indexOf(ANCHOR, first + 1) >= 0) throw new Error('spaceViewFix: anchor is not unique')
  return source.replace(ANCHOR, FIX)
}

/** Apply to an effect whose fragment shader includes Bruneton's GetSkyRadiance (AerialPerspectiveEffect). */
export function applySpaceViewFix<T extends Effect>(effect: T): T {
  const e = effect as unknown as { getFragmentShader(): string; setFragmentShader(s: string): void }
  e.setFragmentShader(patchSkyRadianceShader(e.getFragmentShader()))
  return effect
}
