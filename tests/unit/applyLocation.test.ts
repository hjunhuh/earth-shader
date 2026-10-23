import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { PerspectiveCamera, Vector3 } from 'three'
import { OrbitControls } from 'three-stdlib'
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial'
import { applyLocation } from '../../src/app/applyLocation'
import { CAMERA, CONTROLS, DEFAULTS } from '../../src/app/defaults'

function enu(position: Vector3) {
  const up = Ellipsoid.WGS84.getSurfaceNormal(position, new Vector3())
  const east = new Vector3(0, 0, 1).cross(up).normalize()
  const north = up.clone().cross(east)
  return { up, east, north }
}

/** The story's start: R3F default camera at (0, 0, 5), target at the origin, then useApplyLocation and OrbitControls. */
function storyStart(loc = DEFAULTS.location) {
  const camera = new PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far)
  camera.position.set(...CAMERA.initialPosition)
  const controls = new OrbitControls(camera)
  controls.enableDamping = CONTROLS.enableDamping
  controls.minDistance = CONTROLS.minDistance
  applyLocation(camera, controls.target, { longitude: loc.longitude, latitude: loc.latitude, height: loc.altitude })
  controls.update()
  return { camera, controls }
}

describe('applyLocation (takram useApplyLocation)', () => {
  it('puts the orbit target on the location and the camera up on the surface normal', () => {
    const { camera, controls } = storyStart()
    const expected = new Geodetic(radians(30), radians(35), 300).toECEF()
    expect(controls.target.distanceTo(expected)).toBeLessThan(1e-6)
    const { up } = enu(expected)
    expect(camera.up.distanceTo(up)).toBeLessThan(1e-12)
  })

  it('reproduces the story’s first view: 1000 m from the target (minDistance), level, looking SSE', () => {
    const { camera, controls } = storyStart()
    const offset = camera.position.clone().sub(controls.target)
    expect(offset.length()).toBeCloseTo(1000, 6)
    const { up, east, north } = enu(controls.target)
    expect(Math.abs(offset.dot(up))).toBeLessThan(1e-6) // horizontal
    const view = offset.clone().negate()
    const bearing = (Math.atan2(view.dot(east), view.dot(north)) * 180) / Math.PI
    expect(bearing).toBeCloseTo(159.3, 0)
  })

  it('moving the location keeps the camera’s pose relative to the local horizon', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -85, max: 85, noNaN: true }),
        fc.double({ min: 0, max: 30000, noNaN: true }),
        (longitude, latitude, height) => {
          const { camera, controls } = storyStart()
          // Raise the camera 30° above the horizon so the check is non-trivial.
          const o = camera.position.clone().sub(controls.target)
          o.applyAxisAngle(o.clone().cross(camera.up).normalize(), radians(30))
          camera.position.copy(controls.target).add(o)
          const before = camera.position.clone().sub(controls.target)
          const upBefore = camera.up.clone()
          const elevationBefore = before.clone().normalize().dot(upBefore)
          const distanceBefore = before.length()
          applyLocation(camera, controls.target, { longitude, latitude, height })
          const after = camera.position.clone().sub(controls.target)
          expect(after.length()).toBeCloseTo(distanceBefore, 6)
          expect(Math.abs(elevationBefore)).toBeGreaterThan(0.45)
          expect(after.clone().normalize().dot(camera.up)).toBeCloseTo(elevationBefore, 9)
          expect(controls.target.distanceTo(new Geodetic(radians(longitude), radians(latitude), height).toECEF())).toBeLessThan(1e-6)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('is idempotent for the same location', () => {
    const { camera, controls } = storyStart()
    const p = camera.position.clone()
    applyLocation(camera, controls.target, { longitude: 30, latitude: 35, height: 300 })
    expect(camera.position.distanceTo(p)).toBeLessThan(1e-6)
  })
})
