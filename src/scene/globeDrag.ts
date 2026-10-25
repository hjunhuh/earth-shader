import { Vector3, type Ray } from 'three'

/**
 * Where a globe drag puts the grabbed point, for a cursor ray in the sphere's
 * frame (sphere of `radius` at the origin, ray origin at the camera).
 *
 * On the sphere it is simply the hit: the grabbed point stays under the
 * cursor. Past the limb, 3d-tiles-renderer's GlobeControls clamps to the
 * horizon point, so the globe stops turning however far the cursor goes. Here
 * the target keeps going along the same great circle, at the drag's average
 * rate over the visible disk: crossing the disk from its center to the limb
 * (view angle α, the globe's angular radius) turns the surface 90° − α, so
 * each further α of view angle past the limb turns it about as much again.
 * The mapping is continuous at the limb.
 *
 * Returns a unit direction from the center.
 */
export function dragTargetDirection(ray: Ray, radius: number, result = new Vector3()): Vector3 {
  const { origin, direction } = ray
  const distance = origin.length()
  // Hit on the near side.
  const b = origin.dot(direction)
  const c = distance * distance - radius * radius
  const discriminant = b * b - c
  if (discriminant >= 0 && distance > radius) {
    const t = -b - Math.sqrt(discriminant)
    if (t >= 0) return result.copy(origin).addScaledVector(direction, t).normalize()
  }
  if (distance <= radius) return result.copy(direction).normalize() // inside: nothing sensible to grab

  // The horizon point at the cursor's azimuth around the camera axis.
  const axis = new Vector3().copy(origin).divideScalar(distance)
  const azimuth = new Vector3().copy(direction).addScaledVector(axis, -axis.dot(direction))
  if (azimuth.lengthSq() < 1e-24) {
    // Pointing straight along the axis: any azimuth will do.
    azimuth.set(-axis.y, axis.x, 0)
    if (azimuth.lengthSq() < 1e-12) azimuth.set(0, -axis.z, axis.y)
  }
  azimuth.normalize()
  const sinAlpha = radius / distance // angular radius of the globe seen from the camera
  const alpha = Math.asin(sinAlpha)
  const cosAlpha = Math.cos(alpha)
  // Horizon direction from the center: axis·sinα + azimuth·cosα.
  result.copy(axis).multiplyScalar(sinAlpha).addScaledVector(azimuth, cosAlpha)

  // How far past the limb the cursor points (view angle), and the matching extra turn.
  const toCenter = new Vector3().copy(axis).negate()
  const offAxis = Math.acos(Math.min(1, Math.max(-1, direction.dot(toCenter))))
  const overshoot = Math.max(0, offAxis - alpha)
  const gain = (Math.PI / 2 - alpha) / Math.max(alpha, 1e-6)
  const extra = overshoot * gain
  // Carry on away from the camera axis, toward the far side.
  const turnAxis = new Vector3().crossVectors(axis, azimuth).normalize()
  return result.applyAxisAngle(turnAxis, extra).normalize()
}

/**
 * A drag re-anchors once it has turned the globe this far: the arcball
 * rotation from the grab to the cursor is the shortest one, so past 180° it
 * would flip. Re-anchoring is seamless (the mapping is relative to the camera).
 */
export const DRAG_REANCHOR_ANGLE = Math.PI / 2
