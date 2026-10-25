import {
  Matrix4,
  Object3D,
  Quaternion,
  Ray,
  Vector2,
  Vector3,
  type Intersection,
  type PerspectiveCamera,
  type Raycaster,
} from 'three'
import { EnvironmentControls, GlobeControls } from '3d-tiles-renderer/three'
import { GLOBE } from '../app/defaults'
import { DRAG_REANCHOR_ANGLE, dragTargetDirection } from './globeDrag'
import type { Terrain } from './Terrain'

/** GlobeControls internals the drag override uses (untyped in the package). */
interface DragInternals {
  state: number
  camera: PerspectiveCamera
  domElement: HTMLElement
  pivotPoint: Vector3
  pointerTracker: { getCenterPoint(target: Vector2): Vector2; getMoveDistance(): number }
  inertiaStableFrames: number
  globeInertia: Quaternion
  globeInertiaFactor: number
  _dragMode: number
  _dragBaselineSet: boolean
  _dragBaselineMatrix: Matrix4
  _dragBaselineRotation: Quaternion
  _isNearControls(): boolean
}

const DRAG = 1 // EnvironmentControls' DRAG state
const _pointer = new Vector2()
const _ray = new Ray()
const _saved = new Matrix4()
const _rotation = new Matrix4()
const _toCenter = new Matrix4()
const _center = new Vector3()
const _target = new Vector3()
const _pivotDir = new Vector3()
const _newDir = new Vector3()
const _total = new Quaternion()
const _step = new Quaternion()

/**
 * Google Earth style controls (3d-tiles-renderer's GlobeControls):
 * - left drag: the globe turns so the grabbed point stays under the cursor;
 * - wheel / pinch: zoom toward the cursor;
 * - right drag, shift + left drag or two fingers: tilt and turn around the
 *   point under the cursor.
 *
 * Differences from the stock controls:
 * - The clip planes stay the app's (clipPlanes() in oceanMath.ts), which the
 *   atmosphere's depth precision is tuned for; only the height adjustment of
 *   the base class runs.
 * - It raycasts the terrain only (or, with the terrain off, nothing, so it
 *   falls back to the WGS84 ellipsoid), and its pivot marker is never drawn.
 * - A drag never hits a wall: the stock drag clamps the grabbed point to the
 *   horizon once the cursor leaves the globe, so a drag turned it at most
 *   ~90° and then stopped. See _updatePosition.
 */
export class EarthGlobeControls extends GlobeControls {
  constructor(camera: PerspectiveCamera, canvas: HTMLElement | null, terrain: Terrain) {
    // A stand-in root: the controls add their pivot marker to it, so the
    // marker stays out of the rendered scene.
    const root = new Object3D()
    root.raycast = (raycaster: Raycaster, intersects: Intersection[]) => {
      if (terrain.enabled) terrain.group.raycast(raycaster, intersects)
    }
    super(root, camera, canvas ?? undefined)
    ;(this as unknown as { pivotMesh: Object3D }).pivotMesh.raycast = () => {}
    this.enableDamping = true
    this.maxDistance = GLOBE.maxDistance
  }

  /** Stop any coasting from the last drag (before moving the camera programmatically). */
  stopInertia(): void {
    // The same resets GlobeControls does when a zoom moves the camera (untyped fields).
    const self = this as unknown as {
      dragInertia: { set(x: number, y: number, z: number): void }
      rotationInertia: { set(x: number, y: number): void }
      globeInertia: { identity(): void }
      globeInertiaFactor: number
      _dragBaselineSet: boolean
    }
    self.dragInertia.set(0, 0, 0)
    self.rotationInertia.set(0, 0)
    self.globeInertia.identity()
    self.globeInertiaFactor = 0
    self._dragBaselineSet = false
  }

  /**
   * GlobeControls' drag step (3d-tiles-renderer 0.5.3, Apache-2.0) with two
   * changes: past the limb the grabbed point keeps going (dragTargetDirection)
   * instead of stopping at the horizon, and the drag re-anchors to the current
   * pose every DRAG_REANCHOR_ANGLE of turn, so it can spin on indefinitely.
   * The rest is as upstream: an arcball rotation from the grab to the cursor
   * ray, cast from the pose at the drag's start (path-independent, no roll),
   * feeding the globe inertia.
   */
  _updatePosition(deltaTime: number): void {
    const self = this as unknown as DragInternals
    if (self.state !== DRAG) return
    if (self._dragMode === 0) self._dragMode = self._isNearControls() ? 1 : -1
    const { camera, domElement, pivotPoint, pointerTracker } = self
    const frame = this.ellipsoidFrame
    const frameInverse = this.ellipsoidFrameInverse

    if (!self._dragBaselineSet) {
      self._dragBaselineMatrix.copy(camera.matrixWorld)
      self._dragBaselineRotation.identity()
      self._dragBaselineSet = true
    }

    // The cursor ray from the drag's starting pose, in the ellipsoid frame.
    pointerTracker.getCenterPoint(_pointer)
    _pointer.set((_pointer.x / domElement.clientWidth) * 2 - 1, -(_pointer.y / domElement.clientHeight) * 2 + 1)
    _saved.copy(camera.matrixWorld)
    camera.matrixWorld.copy(self._dragBaselineMatrix)
    _ray.origin.set(_pointer.x, _pointer.y, -1).unproject(camera)
    _ray.direction.set(_pointer.x, _pointer.y, 1).unproject(camera).sub(_ray.origin).normalize()
    camera.matrixWorld.copy(_saved)
    _ray.applyMatrix4(frameInverse)

    // Where the grabbed point goes, on a sphere through it (so the grab is exact).
    const pivotRadius = _target.copy(pivotPoint).applyMatrix4(frameInverse).length()
    dragTargetDirection(_ray, pivotRadius, _target).multiplyScalar(pivotRadius).applyMatrix4(frame)

    _center.setFromMatrixPosition(frame)
    _pivotDir.subVectors(pivotPoint, _center).normalize()
    _newDir.subVectors(_target, _center).normalize()
    _total.setFromUnitVectors(_newDir, _pivotDir)
    // This frame's share, for the inertia.
    _step.copy(self._dragBaselineRotation).invert().premultiply(_total)
    self._dragBaselineRotation.copy(_total)

    // Turn the starting pose about the center.
    _rotation.makeTranslation(-_center.x, -_center.y, -_center.z)
    _rotation.premultiply(_toCenter.makeRotationFromQuaternion(_total))
    _rotation.premultiply(_toCenter.makeTranslation(_center.x, _center.y, _center.z))
    camera.matrixWorld.copy(self._dragBaselineMatrix).premultiply(_rotation)
    camera.matrixWorld.decompose(camera.position, camera.quaternion, _target)

    if (pointerTracker.getMoveDistance() / deltaTime < 2 * window.devicePixelRatio) {
      self.inertiaStableFrames++
    } else {
      self.globeInertia.copy(_step)
      self.globeInertiaFactor = 1 / deltaTime
      self.inertiaStableFrames = 0
    }

    // Re-anchor before the arcball nears 180° (where the shortest rotation flips).
    // Seamless: from the new pose the cursor maps to the grabbed point itself.
    if (_pivotDir.angleTo(_newDir) > DRAG_REANCHOR_ANGLE) {
      self._dragBaselineMatrix.copy(camera.matrixWorld)
      self._dragBaselineRotation.identity()
    }
  }

  override adjustCamera(camera: PerspectiveCamera): void {
    EnvironmentControls.prototype.adjustCamera.call(this, camera)
  }
}
