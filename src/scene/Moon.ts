import { Matrix3, Matrix4, Object3D, Vector3 } from 'three'
import { getMoonFixedToECEF, getMoonPositionECEF, MOON_RADIUS } from './moonModel'

/**
 * The Moon as a scene object at true scale: position = its center in ECEF
 * meters (world space is ECEF), rotation = its IAU body-fixed frame, scale =
 * its radius. MoonEffect ray-traces the sphere this object describes.
 *
 * `position` is a float64 Vector3; everything sent to the GPU is made
 * camera-relative first (see MoonEffect), so the ~4e8 m offset never costs
 * precision near the surface.
 */
export class Moon extends Object3D {
  readonly radius = MOON_RADIUS
  /** Body-fixed → ECEF rotation. */
  readonly fixedToECEF = new Matrix4()
  /** ECEF → body-fixed rotation (3×3). */
  readonly ecefToFixed = new Matrix3()
  /** The Moon's north pole in ECEF. */
  readonly north = new Vector3()

  constructor() {
    super()
    this.name = 'Moon'
    this.scale.setScalar(MOON_RADIUS)
    this.matrixAutoUpdate = false
  }

  /** Place the Moon for a date (ms since epoch). `eciToECEF` is the same matrix the atmosphere uses. */
  update(date: number, eciToECEF: Matrix4): void {
    getMoonPositionECEF(date, this.position, eciToECEF)
    getMoonFixedToECEF(date, this.fixedToECEF, eciToECEF)
    this.quaternion.setFromRotationMatrix(this.fixedToECEF)
    this.ecefToFixed.setFromMatrix4(this.fixedToECEF).transpose()
    this.north.setFromMatrixColumn(this.fixedToECEF, 2).normalize()
    this.updateMatrix()
    this.updateMatrixWorld(true)
  }

  /** Distance from `point` to the surface (negative inside). */
  altitudeOf(point: Vector3): number {
    return point.distanceTo(this.position) - this.radius
  }
}
