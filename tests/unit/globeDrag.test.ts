import { Ray, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { dragTargetDirection } from '../../src/scene/globeDrag'

const R = 6_371_000
const deg = Math.PI / 180

/** A camera on +z at `distance` from the center, cursor ray tilted `angle` off the center toward +x. */
function rayAt(distance: number, angle: number): Ray {
  return new Ray(new Vector3(0, 0, distance), new Vector3(Math.sin(angle), 0, -Math.cos(angle)))
}

/** Angle of a direction from the sub-camera point (+z), radians. */
const fromAxis = (v: Vector3) => Math.acos(Math.min(1, v.z))

describe('dragTargetDirection', () => {
  it('on the globe it is the hit point under the cursor', () => {
    const ray = rayAt(3 * R, 5 * deg)
    const hit = new Vector3()
    ray.intersectSphere({ center: new Vector3(), radius: R } as never, hit)
    expect(dragTargetDirection(ray, R).distanceTo(hit.normalize())).toBeLessThan(1e-12)
  })

  it('is continuous at the limb', () => {
    for (const distance of [1.2 * R, 3 * R, 30 * R]) {
      const alpha = Math.asin(R / distance)
      // Inside, the hit races to the horizon (√ε near grazing), so ε must be tiny.
      const inside = dragTargetDirection(rayAt(distance, alpha - 1e-12), R)
      const outside = dragTargetDirection(rayAt(distance, alpha + 1e-12), R)
      expect(inside.angleTo(outside)).toBeLessThan(1e-4)
      expect(fromAxis(outside)).toBeCloseTo(Math.PI / 2 - alpha, 3)
    }
  })

  it('keeps turning past the limb, about another (90° − α) per α of view angle', () => {
    for (const distance of [1.5 * R, 3 * R, 30 * R]) {
      const alpha = Math.asin(R / distance)
      let previous = fromAxis(dragTargetDirection(rayAt(distance, alpha), R))
      for (const k of [0.25, 0.5, 0.75]) {
        const angle = fromAxis(dragTargetDirection(rayAt(distance, alpha * (1 + k)), R))
        expect(angle, 'monotonic').toBeGreaterThan(previous)
        previous = angle
        expect(angle).toBeCloseTo((Math.PI / 2 - alpha) * (1 + k), 6)
      }
    }
  })

  it('stays in the plane of the camera axis and the cursor', () => {
    const v = dragTargetDirection(rayAt(3 * R, 40 * deg), R)
    expect(v.y).toBeCloseTo(0, 12)
    expect(v.x).toBeGreaterThan(0)
  })
})
