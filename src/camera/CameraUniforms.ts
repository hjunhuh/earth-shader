import { Matrix3, Uniform, Vector2, Vector3 } from 'three'
import { SHADING_EARTH_RADIUS, SHADING_Z_SCALE, ecefToShading, sphereCTerm } from '../geo/shadingSpace'
import { poseRight, type CameraPose, type Viewport } from './pose'

const DEG = Math.PI / 180

/**
 * CPU (float64) side of shaders/common/camera.glsl. Matrices map
 * camera-space directions straight to shading space, so the GPU never sees
 * large absolute world coordinates except the camera position itself.
 */
export class CameraUniforms {
  readonly uniforms = {
    uViewToShading: new Uniform(new Matrix3()),
    uShadingToView: new Uniform(new Matrix3()),
    uTanHalfFov: new Uniform(new Vector2()),
    uResolution: new Uniform(new Vector2(1, 1)),
    uJitter: new Uniform(new Vector2()),
    uCameraShading: new Uniform(new Vector3()),
    uCameraRadius: new Uniform(0),
    uCameraHeight: new Uniform(0),
    uEarthC: new Uniform(0),
    uPixelAngle: new Uniform(0),
  }

  /** Shading-space camera position in float64. */
  readonly cameraShading = new Vector3()
  /** Previous frame (for reprojection). */
  readonly prevViewToShading = new Matrix3()
  readonly prevCameraShading = new Vector3()
  private hasPrev = false

  private readonly right = new Vector3()

  update(pose: CameraPose, vp: Viewport, renderWidth: number, renderHeight: number): void {
    const u = this.uniforms
    if (this.hasPrev) {
      this.prevViewToShading.copy(u.uViewToShading.value)
      this.prevCameraShading.copy(this.cameraShading)
    }
    const r = poseRight(pose, this.right)
    const f = pose.forward
    const up = pose.up
    // Columns: right, up, -forward (camera space -> ECEF), rows scaled by M.
    u.uViewToShading.value.set(
      r.x, up.x, -f.x,
      r.y, up.y, -f.y,
      r.z * SHADING_Z_SCALE, up.z * SHADING_Z_SCALE, -f.z * SHADING_Z_SCALE,
    )
    u.uShadingToView.value.copy(u.uViewToShading.value).invert()
    const tanY = Math.tan((vp.fovY * DEG) / 2)
    u.uTanHalfFov.value.set(tanY * (vp.width / vp.height), tanY)
    u.uResolution.value.set(renderWidth, renderHeight)
    ecefToShading(pose.position, this.cameraShading)
    u.uCameraShading.value.copy(this.cameraShading)
    const radius = this.cameraShading.length()
    u.uCameraRadius.value = radius
    u.uCameraHeight.value = radius - SHADING_EARTH_RADIUS
    u.uEarthC.value = sphereCTerm(radius, SHADING_EARTH_RADIUS)
    u.uPixelAngle.value = (2 * tanY) / renderHeight
    if (!this.hasPrev) {
      this.prevViewToShading.copy(u.uViewToShading.value)
      this.prevCameraShading.copy(this.cameraShading)
      this.hasPrev = true
    }
  }

  /** c-term for an arbitrary sphere radius around the planet center. */
  cTerm(radius: number): number {
    return sphereCTerm(this.cameraShading.length(), radius)
  }
}
