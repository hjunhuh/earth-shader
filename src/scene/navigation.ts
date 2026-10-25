import { Matrix4, Quaternion, Vector3 } from 'three'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'
import type { Moon } from './Moon'

/**
 * Navigation between true-scale bodies.
 *
 * - MoonControls: orbit the Moon in its body-fixed frame (like OrbitControls
 *   does for the Earth in ECEF): selenographic longitude/latitude, altitude
 *   above the surface, heading and tilt. The wheel zooms the *altitude*
 *   logarithmically, so the same gesture works from 400,000 km down to 10 m.
 *   Because the frame is body-fixed the camera rides along with the Moon when
 *   the date changes.
 * - Flight: a smooth transfer between two poses that never passes through a
 *   body: it climbs away from the origin body (log altitude, direction
 *   slerped about its center), then approaches the target the same way.
 */

export type Focus = 'earth' | 'moon'

export const MOON_ALTITUDE_LIMITS = { min: 10, max: 2e9 } as const
export const MAX_TILT = (85 * Math.PI) / 180

export interface Pose {
  position: Vector3
  quaternion: Quaternion
  up: Vector3
}

export const createPose = (): Pose => ({ position: new Vector3(), quaternion: new Quaternion(), up: new Vector3(0, 1, 0) })

export function copyPose(target: Pose, source: Pose): Pose {
  target.position.copy(source.position)
  target.quaternion.copy(source.quaternion)
  target.up.copy(source.up)
  return target
}

/** Camera-looks-down-−Z quaternion facing `forward` with `up` as the screen's up. */
export function lookQuaternion(forward: Vector3, up: Vector3, result = new Quaternion()): Quaternion {
  const z = new Vector3().copy(forward).negate().normalize()
  const x = new Vector3().crossVectors(up, z)
  if (x.lengthSq() < 1e-12) {
    // up ∥ forward: any perpendicular will do.
    x.crossVectors(Math.abs(z.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0), z)
  }
  x.normalize()
  const y = new Vector3().crossVectors(z, x)
  return result.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z))
}

/**
 * Earth camera looking straight down at a geodetic point (radians, meters
 * above the ellipsoid), north at the top of the screen.
 */
export function earthNadirPose(longitude: number, latitude: number, altitude: number, result = createPose()): Pose {
  // The local frame of the point on the surface: its normal is "down" from
  // any height above it (the gradient at the camera itself is not, far up).
  const surface = new Geodetic(longitude, latitude, 0).toECEF()
  const east = new Vector3()
  const north = new Vector3()
  const up = new Vector3()
  Ellipsoid.WGS84.getEastNorthUpVectors(surface, east, north, up)
  result.position.copy(surface).addScaledVector(up, altitude)
  lookQuaternion(up.clone().negate(), north, result.quaternion)
  result.up.copy(up)
  return result
}

// --- Moon orbit controls ------------------------------------------------------

export interface MoonView {
  /** Selenographic longitude/latitude of the point below the camera (radians). */
  longitude: number
  latitude: number
  /** Meters above the mean sphere. */
  altitude: number
  /** Radians clockwise from lunar north. */
  heading: number
  /** 0 = looking straight down, up to MAX_TILT toward the horizon. */
  tilt: number
}

/** Camera pose for a view, in body-fixed coordinates relative to the Moon's center. */
export function moonViewPoseFixed(view: MoonView, radius: number, result = createPose()): Pose {
  const { longitude: lon, latitude: lat } = view
  const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat))
  const east = new Vector3(-Math.sin(lon), Math.cos(lon), 0)
  const north = new Vector3().crossVectors(up, east)
  const horizontal = north.multiplyScalar(Math.cos(view.heading)).addScaledVector(east, Math.sin(view.heading))
  const forward = up.clone().multiplyScalar(-Math.cos(view.tilt)).addScaledVector(horizontal, Math.sin(view.tilt))
  const screenUp = up.clone().multiplyScalar(Math.sin(view.tilt)).addScaledVector(horizontal, Math.cos(view.tilt))
  result.position.copy(up).multiplyScalar(radius + view.altitude)
  lookQuaternion(forward, screenUp, result.quaternion)
  result.up.copy(up)
  return result
}

/** Body-fixed pose → ECEF pose for the Moon's current placement. */
export function moonPoseToECEF(fixed: Pose, moon: Moon, result = createPose()): Pose {
  const rotation = new Quaternion().setFromRotationMatrix(moon.fixedToECEF)
  result.position.copy(fixed.position).applyQuaternion(rotation).add(moon.position)
  result.quaternion.copy(rotation).multiply(fixed.quaternion)
  result.up.copy(fixed.up).applyQuaternion(rotation)
  return result
}

/** The view whose pose is closest to an ECEF camera pose (used when a flight hands over). */
export function moonViewFromECEF(position: Vector3, quaternion: Quaternion, moon: Moon, radius: number): MoonView {
  const local = position.clone().sub(moon.position).applyMatrix3(moon.ecefToFixed)
  const distance = local.length()
  const up = local.divideScalar(distance)
  const longitude = Math.atan2(up.y, up.x)
  const latitude = Math.asin(Math.min(1, Math.max(-1, up.z)))
  const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion).applyMatrix3(moon.ecefToFixed)
  const east = new Vector3(-Math.sin(longitude), Math.cos(longitude), 0)
  const north = new Vector3().crossVectors(up, east)
  const down = -forward.dot(up)
  const tilt = Math.min(MAX_TILT, Math.acos(Math.min(1, Math.max(-1, down))))
  const heading = tilt > 1e-3 ? Math.atan2(forward.dot(east), forward.dot(north)) : 0
  return { longitude, latitude, altitude: distance - radius, heading, tilt }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export class MoonControls {
  enabled = false
  /** The view being shown and the view it eases toward (inputs move the goal). */
  readonly view: MoonView = { longitude: 0, latitude: 0, altitude: 2 * 1737400, heading: 0, tilt: 0 }
  readonly goal: MoonView = { ...this.view }
  /** Smoothing rate (1/s); Infinity = no easing (tests). */
  smoothing = 12
  rotateSpeed = 1
  zoomSpeed = 1

  private element: HTMLElement | null = null
  private pointer: { id: number; x: number; y: number; look: boolean } | null = null
  private readonly listeners: [string, EventListener][] = []

  constructor(
    private readonly radius: number,
    private readonly fov: () => number,
  ) {}

  set(view: MoonView): void {
    Object.assign(this.view, view)
    Object.assign(this.goal, view)
  }

  connect(element: HTMLElement): void {
    this.element = element
    const on = (type: string, listener: EventListener) => {
      element.addEventListener(type, listener, { passive: false })
      this.listeners.push([type, listener])
    }
    on('pointerdown', ((e: PointerEvent) => {
      if (!this.enabled || this.pointer) return
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, look: e.button === 2 || e.shiftKey || e.ctrlKey }
      element.setPointerCapture?.(e.pointerId)
    }) as EventListener)
    on('pointermove', ((e: PointerEvent) => {
      if (!this.enabled || !this.pointer || e.pointerId !== this.pointer.id) return
      const dx = e.clientX - this.pointer.x
      const dy = e.clientY - this.pointer.y
      this.pointer.x = e.clientX
      this.pointer.y = e.clientY
      if (this.pointer.look) this.look(dx, dy)
      else this.drag(dx, dy)
    }) as EventListener)
    const up = ((e: PointerEvent) => {
      if (this.pointer?.id === e.pointerId) this.pointer = null
    }) as EventListener
    on('pointerup', up)
    on('pointercancel', up)
    on('contextmenu', ((e: Event) => {
      if (this.enabled) e.preventDefault()
    }) as EventListener)
    on('wheel', ((e: WheelEvent) => {
      if (!this.enabled) return
      e.preventDefault()
      const lines = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
      this.zoom(Math.exp(lines * 0.0015 * this.zoomSpeed))
    }) as EventListener)
  }

  dispose(): void {
    for (const [type, listener] of this.listeners) this.element?.removeEventListener(type, listener)
    this.listeners.length = 0
    this.element = null
  }

  private get height(): number {
    return this.element?.clientHeight || 1
  }

  /** Move over the surface: a drag across the screen moves about one screen-width of ground. */
  drag(dx: number, dy: number): void {
    const g = this.goal
    const perPixel = (Math.min(Math.PI, (this.fov() * g.altitude) / this.radius) / this.height) * this.rotateSpeed
    // Screen axes → heading-relative surface axes.
    const forward = dy * perPixel
    const right = -dx * perPixel
    const north = forward * Math.cos(g.heading) - right * Math.sin(g.heading)
    const east = forward * Math.sin(g.heading) + right * Math.cos(g.heading)
    g.latitude = clamp(g.latitude + north, -Math.PI / 2 + 1e-4, Math.PI / 2 - 1e-4)
    g.longitude += east / Math.max(Math.cos(g.latitude), 1e-3)
  }

  /** Turn and tilt the view around the point below. */
  look(dx: number, dy: number): void {
    const g = this.goal
    g.heading -= (dx / this.height) * Math.PI * this.rotateSpeed
    g.tilt = clamp(g.tilt - (dy / this.height) * Math.PI * this.rotateSpeed, 0, MAX_TILT)
  }

  /** Multiply the altitude. */
  zoom(factor: number): void {
    const g = this.goal
    g.altitude = clamp(g.altitude * factor, MOON_ALTITUDE_LIMITS.min, MOON_ALTITUDE_LIMITS.max)
  }

  /** Ease the view toward the goal. */
  update(delta: number): MoonView {
    const v = this.view
    const g = this.goal
    const k = Number.isFinite(this.smoothing) ? 1 - Math.exp(-this.smoothing * Math.max(0, delta)) : 1
    if (k === 1) return Object.assign(v, g)
    // Unwrap longitude/heading so they take the short way.
    const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
    v.longitude += wrap(g.longitude - v.longitude) * k
    v.latitude += (g.latitude - v.latitude) * k
    v.altitude = Math.exp(Math.log(v.altitude) + (Math.log(g.altitude) - Math.log(v.altitude)) * k)
    v.heading += wrap(g.heading - v.heading) * k
    v.tilt += (g.tilt - v.tilt) * k
    return v
  }
}

// --- flights -------------------------------------------------------------------

export interface FlightEnds {
  start: Pose
  /** Center and radius of the body the flight leaves. */
  originCenter: Vector3
  originRadius: number
  /** Center of the body the flight goes to and the pose to arrive at. */
  targetCenter: Vector3
  end: Pose
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

function slerpUnit(a: Vector3, b: Vector3, t: number, result: Vector3): Vector3 {
  const dot = clamp(a.dot(b), -1, 1)
  const omega = Math.acos(dot)
  if (omega < 1e-9) return result.copy(b)
  if (Math.PI - omega < 1e-6) {
    // Antipodal: go around any perpendicular.
    const axis = new Vector3().crossVectors(a, Math.abs(a.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize()
    return result.copy(a).applyAxisAngle(axis, Math.PI * t)
  }
  const s = Math.sin(omega)
  return result
    .copy(a)
    .multiplyScalar(Math.sin((1 - t) * omega) / s)
    .addScaledVector(b, Math.sin(t * omega) / s)
}

/**
 * Point on a path from `from` to `to` around `center`: the direction from the
 * center is slerped and the distance interpolated in log space, so the path
 * never comes closer to the center than the nearer end.
 */
export function aroundCenter(center: Vector3, from: Vector3, to: Vector3, t: number, result = new Vector3()): Vector3 {
  const a = from.clone().sub(center)
  const b = to.clone().sub(center)
  const da = a.length()
  const db = b.length()
  const distance = Math.exp(Math.log(da) + (Math.log(db) - Math.log(da)) * t)
  return slerpUnit(a.divideScalar(da), b.divideScalar(db), t, result).multiplyScalar(distance).add(center)
}

/** Where the climb from the origin ends: well clear of it, between "up" and the target. */
export function flightWaypoint({ start, originCenter, originRadius, targetCenter }: FlightEnds, result = new Vector3()): Vector3 {
  const up = start.position.clone().sub(originCenter).normalize()
  const toTarget = targetCenter.clone().sub(originCenter)
  const separation = toTarget.length()
  const direction = up.clone().add(toTarget.divideScalar(separation))
  if (direction.lengthSq() < 1e-6) direction.copy(up)
  direction.normalize()
  const height = Math.max(3 * originRadius, 0.3 * separation)
  return result.copy(originCenter).addScaledVector(direction, originRadius + height)
}

/** Share of the flight spent climbing away from the origin. */
export const CLIMB = 0.4

/** Position along a flight at t ∈ [0, 1]. */
export function flightPosition(ends: FlightEnds, t: number, result = new Vector3()): Vector3 {
  const waypoint = flightWaypoint(ends)
  if (t <= CLIMB) {
    const x = t / CLIMB
    return aroundCenter(ends.originCenter, ends.start.position, waypoint, 1 - Math.cos((x * Math.PI) / 2), result)
  }
  const x = (t - CLIMB) / (1 - CLIMB)
  return aroundCenter(ends.targetCenter, waypoint, ends.end.position, Math.sin((x * Math.PI) / 2), result)
}

/** Full pose along a flight: turns to face the target early, settles into the end pose late. */
export function flightPose(ends: FlightEnds, t: number, result = createPose()): Pose {
  flightPosition(ends, t, result.position)
  const up = ends.start.up.clone().lerp(ends.end.up, smoothstep(0, 1, t))
  if (up.lengthSq() < 1e-6) up.copy(ends.end.up)
  up.normalize()
  const forward = ends.targetCenter.clone().sub(result.position)
  const look = lookQuaternion(forward, up)
  result.quaternion.copy(ends.start.quaternion).slerp(look, smoothstep(0, 0.25, t)).slerp(ends.end.quaternion, smoothstep(0.75, 1, t))
  result.up.copy(up)
  return result
}
