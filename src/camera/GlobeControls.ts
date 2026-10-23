import { Quaternion, Vector3 } from 'three'
import { interpolatePose, orbitPose, panPose, pickAt, poseAltitude, zoomPose } from './controlsMath'
import { clonePose, pixelsToNdc, poseToState, rayDirection, stateToPose, type CameraPose, type Viewport } from './pose'
import { closestPointToCenter } from '../geo/intersect'
import { WGS84_A } from '../geo/wgs84'

export interface GlobeControlsOptions {
  element: HTMLElement
  getPose: () => CameraPose
  getViewport: () => Viewport
  setPose: (pose: CameraPose) => void
}

type DragMode = 'none' | 'pan' | 'orbit'

const ORBIT_DEG_PER_PX = 0.25
const WHEEL_ZOOM_RATE = 0.0016
const INERTIA_TAU = 0.25 // s

/**
 * Pointer/wheel/keyboard -> pure camera operations (controlsMath).
 * Left drag: grab-pan. Right drag or Ctrl/Shift+left: orbit (heading/tilt).
 * Wheel / pinch: zoom to cursor. Double click: animated zoom-in. N: north up.
 */
export class GlobeControls {
  enabled = true
  private mode: DragMode = 'none'
  private grab: Vector3 | null = null
  private lastX = 0
  private lastY = 0
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private pinchDistance = 0

  // Inertia: angular velocity about the planet center [rad/s].
  private readonly spinAxis = new Vector3()
  private spinRate = 0
  private lastMoveTime = 0
  private readonly lastRotation = new Quaternion()

  // Smooth wheel zoom: pending log-factor applied over a few frames.
  private zoomLog = 0
  private zoomNdc = { x: 0, y: 0 }

  private flight: { from: CameraPose; to: CameraPose; t: number; duration: number } | null = null

  constructor(private readonly opts: GlobeControlsOptions) {
    const el = opts.element
    el.style.touchAction = 'none'
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointercancel', this.onPointerUp)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('dblclick', this.onDoubleClick)
    el.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('keydown', this.onKeyDown)
  }

  dispose(): void {
    const el = this.opts.element
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('pointercancel', this.onPointerUp)
    el.removeEventListener('wheel', this.onWheel)
    el.removeEventListener('dblclick', this.onDoubleClick)
    el.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('keydown', this.onKeyDown)
  }

  /** True while an animation (inertia, smooth zoom, flight) is running. */
  get animating(): boolean {
    return this.spinRate > 1e-6 || Math.abs(this.zoomLog) > 1e-4 || this.flight !== null
  }

  stopAnimations(): void {
    this.spinRate = 0
    this.zoomLog = 0
    this.flight = null
  }

  flyTo(target: CameraPose, duration = 1.2): void {
    this.stopAnimations()
    this.flight = { from: clonePose(this.opts.getPose()), to: clonePose(target), t: 0, duration }
  }

  /** Advances animations; returns true when the pose changed. */
  update(dt: number): boolean {
    if (!this.enabled) return false
    let changed = false
    if (this.flight) {
      const f = this.flight
      f.t = Math.min(1, f.t + dt / f.duration)
      this.opts.setPose(interpolatePose(f.from, f.to, f.t))
      if (f.t >= 1) this.flight = null
      return true
    }
    if (this.mode === 'none' && this.spinRate > 1e-6) {
      const pose = clonePose(this.opts.getPose())
      const h = poseAltitude(pose)
      const q = new Quaternion().setFromAxisAngle(this.spinAxis, this.spinRate * dt)
      pose.position.applyQuaternion(q)
      pose.forward.applyQuaternion(q)
      pose.up.applyQuaternion(q)
      const s = poseToState(pose)
      const restored = stateToPose({ ...s, alt: h })
      pose.position.copy(restored.position)
      this.opts.setPose(pose)
      this.spinRate *= Math.exp(-dt / INERTIA_TAU)
      if (this.spinRate < 1e-6) this.spinRate = 0
      changed = true
    }
    if (Math.abs(this.zoomLog) > 1e-4) {
      const step = this.zoomLog * Math.min(1, dt * 12)
      this.zoomLog -= step
      this.opts.setPose(zoomPose(this.opts.getPose(), this.opts.getViewport(), this.zoomNdc.x, this.zoomNdc.y, Math.exp(step)))
      changed = true
    }
    return changed
  }

  private ndc(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.opts.element.getBoundingClientRect()
    return pixelsToNdc(
      { width: rect.width, height: rect.height, fovY: 0 },
      e.clientX - rect.left,
      e.clientY - rect.top,
    )
  }

  private pickGrab(x: number, y: number): Vector3 {
    const pose = this.opts.getPose()
    const vp = this.opts.getViewport()
    const hit = pickAt(pose, vp, x, y)
    if (hit) return hit
    // Off the globe: grab a point at sea-level radius on the ray's closest approach.
    const dir = rayDirection(pose, vp, x, y)
    return closestPointToCenter(pose.position, dir).setLength(WGS84_A)
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return
    this.opts.element.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this.stopAnimations()
    if (this.pointers.size === 2) {
      this.mode = 'none'
      this.pinchDistance = this.currentPinchDistance()
      return
    }
    const { x, y } = this.ndc(e)
    this.lastX = e.clientX
    this.lastY = e.clientY
    if (e.button === 2 || e.ctrlKey || e.shiftKey) {
      this.mode = 'orbit'
    } else if (e.button === 0) {
      this.mode = 'pan'
      this.grab = this.pickGrab(x, y)
      this.lastMoveTime = performance.now()
      this.spinRate = 0
    }
  }

  private currentPinchDistance(): number {
    const [a, b] = [...this.pointers.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.enabled || !this.pointers.has(e.pointerId)) return
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.pointers.size === 2) {
      const d = this.currentPinchDistance()
      if (this.pinchDistance > 0 && d > 0) {
        const [a, b] = [...this.pointers.values()]
        const mid = this.ndc({ clientX: (a!.x + b!.x) / 2, clientY: (a!.y + b!.y) / 2 })
        this.opts.setPose(zoomPose(this.opts.getPose(), this.opts.getViewport(), mid.x, mid.y, this.pinchDistance / d))
      }
      this.pinchDistance = d
      return
    }
    const vp = this.opts.getViewport()
    if (this.mode === 'pan' && this.grab) {
      const { x, y } = this.ndc(e)
      const before = this.opts.getPose()
      const after = panPose(before, vp, this.grab, x, y)
      // Track angular velocity about the center for inertia.
      const now = performance.now()
      const dt = Math.max(1e-3, (now - this.lastMoveTime) / 1000)
      this.lastMoveTime = now
      const a = before.position.clone().normalize()
      const b = after.position.clone().normalize()
      this.lastRotation.setFromUnitVectors(a, b)
      const angle = 2 * Math.acos(Math.min(1, Math.abs(this.lastRotation.w)))
      if (angle > 1e-9) {
        this.spinAxis.set(this.lastRotation.x, this.lastRotation.y, this.lastRotation.z).normalize()
        this.spinRate = angle / dt
      } else this.spinRate = 0
      this.opts.setPose(after)
    } else if (this.mode === 'orbit') {
      const dx = e.clientX - this.lastX
      const dy = e.clientY - this.lastY
      this.lastX = e.clientX
      this.lastY = e.clientY
      this.opts.setPose(orbitPose(this.opts.getPose(), vp, dx * ORBIT_DEG_PER_PX, -dy * ORBIT_DEG_PER_PX))
    }
  }

  private readonly onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId)
    if (this.opts.element.hasPointerCapture(e.pointerId)) this.opts.element.releasePointerCapture(e.pointerId)
    if (this.pointers.size === 0) {
      // Only keep inertia if the pointer was still moving at release.
      if (this.mode !== 'pan' || performance.now() - this.lastMoveTime > 60) this.spinRate = 0
      this.mode = 'none'
      this.grab = null
    }
  }

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.enabled) return
    e.preventDefault()
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1
    this.zoomLog += e.deltaY * scale * WHEEL_ZOOM_RATE
    this.zoomLog = Math.max(-3, Math.min(3, this.zoomLog))
    this.zoomNdc = this.ndc(e)
    this.spinRate = 0
  }

  private readonly onDoubleClick = (e: MouseEvent) => {
    if (!this.enabled) return
    const { x, y } = this.ndc(e)
    this.zoomNdc = { x, y }
    this.zoomLog += Math.log(0.35)
  }

  private readonly onContextMenu = (e: Event) => e.preventDefault()

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || (e.target as HTMLElement | null)?.closest?.('input, textarea, .lil-gui')) return
    if (e.key === 'n' || e.key === 'N') {
      const s = poseToState(this.opts.getPose())
      this.flyTo(stateToPose({ ...s, heading: 0 }), 0.6)
    } else if (e.key === 'r' || e.key === 'R') {
      const s = poseToState(this.opts.getPose())
      this.flyTo(stateToPose({ ...s, tilt: 0 }), 0.6)
    }
  }
}
