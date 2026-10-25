import { Object3D, type PerspectiveCamera, type Intersection, type Raycaster } from 'three'
import { EnvironmentControls, GlobeControls } from '3d-tiles-renderer/three'
import { GLOBE } from '../app/defaults'
import type { Terrain } from './Terrain'

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

  override adjustCamera(camera: PerspectiveCamera): void {
    EnvironmentControls.prototype.adjustCamera.call(this, camera)
  }
}
