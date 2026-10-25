import { Quaternion, Vector3, type PerspectiveCamera, type WebGLRenderer } from 'three'
import { PointOfView, radians } from '@takram/three-geospatial'
import type { FlyToOptions } from '../scene/EarthScene'
import type { Focus, MoonView } from '../scene/navigation'
import type { AppState, StatePatch } from './state'

/**
 * `window.__earth` in test mode. The takram reference page (tests/reference)
 * exposes the same interface so e2e tests can drive both identically.
 */
export interface EarthTestApi {
  ready: boolean
  errors: string[]
  /** Render n frames synchronously with a fixed 1/60 s delta. */
  renderFrames(n: number): void
  size(): { width: number; height: number }
  camera(): {
    position: number[]
    quaternion: number[]
    up: number[]
    target: number[]
    near: number
    far: number
    fov: number
  }
  setPointOfView(headingDeg: number, pitchDeg: number, distance: number): void
  sunDirection(): number[]
  /** Sun position in CSS pixels (top-left origin); inFront is false when behind the camera. */
  projectSun(): { x: number; y: number; inFront: boolean }
  /** RGBA8 of the last frame, top-left origin. The rectangle is in CSS pixels; the result has (w·dpr)×(h·dpr) pixels. */
  readPixels(x: number, y: number, w: number, h: number): number[]
  exposure(): number
  dateMs(): number
  pixelRatio(): number
  getState?(): AppState
  setState?(patch: StatePatch): void
  /** The app only: true-scale Moon and navigation. */
  flyTo?(body: Focus, options?: FlyToOptions): void
  focus?(): Focus
  /** Moon's center in ECEF meters. */
  moonPosition?(): number[]
  moonView?(): MoonView
  /** Earth focus: look along an ECEF direction from where the camera is. */
  aim?(direction: number[]): void
  /** Moon's center and apparent radius in CSS pixels. */
  projectMoon?(): { x: number; y: number; radius: number; inFront: boolean }
  /** The app only: 0–1 share of requested terrain tiles loaded. */
  terrainProgress?(): number
  /** Loaded ground height (m × exaggeration) at a point in degrees, or null. */
  elevationAt?(longitude: number, latitude: number): number | null
  /** View heading in degrees clockwise from north (the compass). */
  heading?(): number
  /** 'globe' or 'orbit' (`?nav=`). */
  earthControls?(): string
  /** Longitude/latitude (degrees) of the WGS84 ellipsoid under a CSS pixel, or null off the globe. */
  surfacePointAt?(x: number, y: number): [number, number] | null
}

/** Project an ECEF point (float64, camera-relative) to CSS pixels; radius is the Moon's apparent radius. */
export function projectPoint(
  camera: PerspectiveCamera,
  point: Vector3,
  size: { width: number; height: number },
  bodyRadius = 1737400,
): { x: number; y: number; radius: number; inFront: boolean } {
  camera.updateMatrixWorld()
  const view = point.clone().sub(camera.position).applyQuaternion(camera.quaternion.clone().invert())
  const inFront = view.z < 0
  const focal = size.height / 2 / Math.tan((camera.fov * Math.PI) / 360)
  const distance = view.length()
  return {
    x: size.width / 2 + (focal * view.x) / -view.z,
    y: size.height / 2 - (focal * view.y) / -view.z,
    radius: focal * Math.tan(Math.asin(Math.min(1, bodyRadius / distance))),
    inFront,
  }
}

export interface TestTarget {
  gl: WebGLRenderer
  camera: PerspectiveCamera
  target: Vector3
  render(): void
  update(): void
  sunDirection(): Vector3
  dateMs(): number
}

export function createTestApi(t: TestTarget, errors: string[]): EarthTestApi {
  return {
    ready: false,
    errors,
    renderFrames(n) {
      for (let i = 0; i < n; ++i) t.render()
    },
    size() {
      const c = t.gl.domElement
      return { width: c.clientWidth, height: c.clientHeight }
    },
    camera() {
      const c = t.camera
      return {
        position: c.position.toArray(),
        quaternion: c.quaternion.toArray(),
        up: c.up.toArray(),
        target: t.target.toArray(),
        near: c.near,
        far: c.far,
        fov: c.fov,
      }
    },
    setPointOfView(heading, pitch, distance) {
      const q = new Quaternion()
      new PointOfView(distance, radians(heading), radians(pitch)).decompose(t.target, t.camera.position, q, t.camera.up)
      t.camera.quaternion.copy(q)
      t.update()
    },
    sunDirection() {
      return t.sunDirection().toArray()
    },
    projectSun() {
      const c = t.camera
      c.updateMatrixWorld()
      const far = t.sunDirection().clone().multiplyScalar(1e6).add(c.position)
      const inFront = far.clone().applyMatrix4(c.matrixWorldInverse).z < 0
      const ndc = far.project(c)
      const { width, height } = this.size()
      return { x: (ndc.x * 0.5 + 0.5) * width, y: (0.5 - ndc.y * 0.5) * height, inFront }
    },
    readPixels(x0, y0, w0, h0) {
      const gl = t.gl.getContext()
      const pr = t.gl.getPixelRatio()
      const [x, y, w, h] = [x0, y0, w0, h0].map((v) => Math.round(v * pr)) as [number, number, number, number]
      const buffer = new Uint8Array(w * h * 4)
      const height = gl.drawingBufferHeight
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.readPixels(x, height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buffer)
      // Flip rows to top-left origin.
      const out = new Array<number>(w * h * 4)
      for (let row = 0; row < h; ++row) {
        const src = (h - 1 - row) * w * 4
        for (let i = 0; i < w * 4; ++i) out[row * w * 4 + i] = buffer[src + i]!
      }
      return out
    },
    exposure() {
      return t.gl.toneMappingExposure
    },
    dateMs() {
      return t.dateMs()
    },
    pixelRatio() {
      return t.gl.getPixelRatio()
    },
  }
}

declare global {
  interface Window {
    __earth?: EarthTestApi
  }
}

