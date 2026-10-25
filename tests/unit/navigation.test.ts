import { describe, expect, it } from 'vitest'
import { Quaternion, Ray, Vector3 } from 'three'
import { getECIToECEFRotationMatrix } from '@takram/three-atmosphere'
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial'
import { Moon } from '../../src/scene/Moon'
import { MOON_RADIUS } from '../../src/scene/moonModel'
import {
  aroundCenter,
  createPose,
  earthNadirPose,
  flightPose,
  geodeticUp,
  lookQuaternion,
  rotatePoseAbout,
  viewHeading,
  flightPosition,
  MOON_ALTITUDE_LIMITS,
  MoonControls,
  moonPoseToECEF,
  moonViewFromECEF,
  moonViewPoseFixed,
  type FlightEnds,
} from '../../src/scene/navigation'
import { WGS84_A } from '../../src/scene/oceanMath'

const DATE = Date.UTC(2026, 0, 2, 6)

function moonAt(date: number): Moon {
  const moon = new Moon()
  moon.update(date, getECIToECEFRotationMatrix(date))
  return moon
}

describe('aroundCenter', () => {
  it('hits both ends exactly and interpolates the distance in log space', () => {
    const c = new Vector3(1, 2, 3)
    const a = new Vector3(11, 2, 3)
    const b = new Vector3(1, 2, 1003)
    expect(aroundCenter(c, a, b, 0).distanceTo(a)).toBeLessThan(1e-9)
    expect(aroundCenter(c, a, b, 1).distanceTo(b)).toBeLessThan(1e-9)
    expect(aroundCenter(c, a, b, 0.5).distanceTo(c)).toBeCloseTo(100, 6) // √(10·1000)
  })

  it('handles antipodal ends', () => {
    const p = aroundCenter(new Vector3(), new Vector3(0, 0, 5), new Vector3(0, 0, -5), 0.5)
    expect(p.length()).toBeCloseTo(5, 9)
    expect(Math.abs(p.z)).toBeLessThan(1e-9)
  })
})

describe('flights', () => {
  const moon = moonAt(DATE)

  function earthToMoon(groundDirection: Vector3): FlightEnds {
    const start = createPose()
    start.position.copy(groundDirection).normalize().multiplyScalar(WGS84_A + 300)
    const end = moonPoseToECEF(
      moonViewPoseFixed({ longitude: 2, latitude: 0.3, altitude: 2 * MOON_RADIUS, heading: 0, tilt: 0 }, MOON_RADIUS),
      moon,
    )
    return { start, originCenter: new Vector3(), originRadius: WGS84_A, targetCenter: moon.position.clone(), end }
  }

  it('starts at the start pose and ends at the end pose', () => {
    const ends = earthToMoon(new Vector3(1, 0, 0))
    expect(flightPosition(ends, 0).distanceTo(ends.start.position)).toBeLessThan(1e-3)
    expect(flightPosition(ends, 1).distanceTo(ends.end.position)).toBeLessThan(1e-3)
    const last = flightPose(ends, 1)
    expect(Math.abs(last.quaternion.dot(ends.end.quaternion))).toBeCloseTo(1, 9)
  })

  it('never passes through the Earth or the Moon, from anywhere on the Earth', () => {
    const dirs = [
      new Vector3(1, 0, 0),
      new Vector3(-1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, -1, 0),
      new Vector3(0, 0, 1),
      moon.position.clone().negate(), // the Moon straight below the horizon
      moon.position.clone(),
    ]
    for (const dir of dirs) {
      const ends = earthToMoon(dir)
      let previous = flightPosition(ends, 0)
      for (let i = 1; i <= 2000; ++i) {
        const p = flightPosition(ends, i / 2000)
        // The straight segment between samples stays clear too.
        for (const s of [0, 0.5, 1]) {
          const q = previous.clone().lerp(p, s)
          expect(q.length()).toBeGreaterThan(WGS84_A)
          expect(q.distanceTo(moon.position)).toBeGreaterThan(MOON_RADIUS)
        }
        previous = p
      }
    }
  })

  it('moves monotonically away from the Earth while climbing, then toward the Moon', () => {
    const ends = earthToMoon(new Vector3(0, 0, 1))
    let earth = 0
    let toMoon = Infinity
    for (let i = 0; i <= 400; ++i) {
      const t = i / 1000 // climb: t ≤ 0.4
      const d = flightPosition(ends, t).length()
      expect(d).toBeGreaterThanOrEqual(earth - 1e-6)
      earth = d
    }
    for (let i = 401; i <= 1000; ++i) {
      const d = flightPosition(ends, i / 1000).distanceTo(moon.position)
      expect(d).toBeLessThanOrEqual(toMoon + 1e-6)
      toMoon = d
    }
  })
})

describe('earthNadirPose', () => {
  it('sits at the geodetic point and altitude, looking along the ellipsoid normal, north up', () => {
    for (const [lon, lat] of [[30, 35], [127, 37.5], [-70, -50], [0, 89]] as const) {
      const pose = earthNadirPose(radians(lon), radians(lat), 1e7)
      const g = new Geodetic().setFromECEF(pose.position)
      // Looking straight down lands on the point itself.
      const below = Ellipsoid.WGS84.getIntersection(new Ray(pose.position, new Vector3(0, 0, -1).applyQuaternion(pose.quaternion)))!
      const foot = new Geodetic().setFromECEF(below)
      expect(foot.longitude).toBeCloseTo(radians(lon), 9)
      expect(foot.latitude).toBeCloseTo(radians(lat), 9)
      expect(g.longitude).toBeCloseTo(radians(lon), 9)
      expect(g.latitude).toBeCloseTo(radians(lat), 9)
      expect(g.height).toBeCloseTo(1e7, 0)
      // The geodetic frame of the point below (not the gradient at the camera).
      const [l, p] = [radians(lon), radians(lat)]
      const up = new Vector3(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p))
      const east = new Vector3(-Math.sin(l), Math.cos(l), 0)
      const north = new Vector3().crossVectors(up, east)
      const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion)
      const screenUp = new Vector3(0, 1, 0).applyQuaternion(pose.quaternion)
      const screenRight = new Vector3(1, 0, 0).applyQuaternion(pose.quaternion)
      expect(forward.dot(up)).toBeCloseTo(-1, 9)
      expect(screenUp.dot(north)).toBeCloseTo(1, 9)
      expect(screenRight.dot(east)).toBeCloseTo(1, 9)
      expect(pose.up.dot(up)).toBeCloseTo(1, 9)
    }
  })
})

describe('viewHeading / rotatePoseAbout', () => {
  const deg = Math.PI / 180

  it('reads the heading of straight-down and tilted views, clockwise from north', () => {
    const base = earthNadirPose(radians(127), radians(37.5), 5000)
    const up = geodeticUp(base.position)
    expect(viewHeading(base.quaternion, up)).toBeCloseTo(0, 9)
    for (const heading of [30, 90, -120, 179]) {
      // Turning the rig counterclockwise by θ turns the view's heading to −θ.
      const turned = rotatePoseAbout(base, base.position, up, -heading * deg)
      expect(viewHeading(turned.quaternion, up) / deg).toBeCloseTo(heading, 6)
      // Tilted toward the horizon (forward 80° from straight down), same heading.
      const east = new Vector3(-up.y, up.x, 0).normalize()
      const north = new Vector3().crossVectors(up, east)
      const horizontal = north.multiplyScalar(Math.cos(heading * deg)).addScaledVector(east, Math.sin(heading * deg))
      const tilt = 80 * deg
      const forward = up.clone().multiplyScalar(-Math.cos(tilt)).addScaledVector(horizontal, Math.sin(tilt))
      const screenUp = up.clone().multiplyScalar(Math.sin(tilt)).addScaledVector(horizontal, Math.cos(tilt))
      expect(viewHeading(lookQuaternion(forward, screenUp), up) / deg).toBeCloseTo(heading, 6)
    }
  })

  it('turning by the heading brings north up and keeps the pivot, distance and tilt', () => {
    const start = earthNadirPose(radians(10), radians(45), 20000)
    const pivotUp = geodeticUp(start.position)
    const pivot = start.position.clone().addScaledVector(pivotUp, -20000)
    // Tilt 50° about an east-west axis through the pivot, then turn to heading 140°.
    const east = new Vector3(-pivotUp.y, pivotUp.x, 0).normalize()
    const tiltRotation = new Quaternion().setFromAxisAngle(east, 50 * deg)
    const tilted = createPose()
    tilted.position.copy(start.position).sub(pivot).applyQuaternion(tiltRotation).add(pivot)
    tilted.quaternion.copy(tiltRotation).multiply(start.quaternion)
    const pose = rotatePoseAbout(tilted, pivot, pivotUp, -140 * deg)
    const heading = viewHeading(pose.quaternion, pivotUp)
    expect(heading / deg).toBeCloseTo(140, 6)
    const north = rotatePoseAbout(pose, pivot, pivotUp, heading)
    expect(viewHeading(north.quaternion, pivotUp)).toBeCloseTo(0, 9)
    expect(north.position.distanceTo(pivot)).toBeCloseTo(pose.position.distanceTo(pivot), 6)
    const forward = (p: typeof pose) => new Vector3(0, 0, -1).applyQuaternion(p.quaternion)
    expect(forward(north).dot(pivotUp)).toBeCloseTo(forward(pose).dot(pivotUp), 9)
  })
})

describe('MoonControls', () => {
  it('zooms the altitude multiplicatively within its limits', () => {
    const c = new MoonControls(MOON_RADIUS, () => 1)
    c.smoothing = Infinity
    c.set({ longitude: 0, latitude: 0, altitude: 1000, heading: 0, tilt: 0 })
    c.zoom(0.5)
    expect(c.update(0).altitude).toBeCloseTo(500, 9)
    for (let i = 0; i < 100; ++i) c.zoom(0.5)
    expect(c.update(0).altitude).toBe(MOON_ALTITUDE_LIMITS.min)
    for (let i = 0; i < 200; ++i) c.zoom(2)
    expect(c.update(0).altitude).toBe(MOON_ALTITUDE_LIMITS.max)
  })

  it('eases toward the goal and takes the short way around in longitude', () => {
    const c = new MoonControls(MOON_RADIUS, () => 1)
    c.set({ longitude: Math.PI - 0.1, latitude: 0, altitude: 1e6, heading: 0, tilt: 0 })
    c.goal.longitude = -Math.PI + 0.1 // 0.2 rad east across the date line
    for (let i = 0; i < 200; ++i) c.update(1 / 60)
    const lon = c.view.longitude
    expect(Math.abs(Math.atan2(Math.sin(lon - c.goal.longitude), Math.cos(lon - c.goal.longitude)))).toBeLessThan(1e-6)
    expect(Math.abs(lon)).toBeGreaterThan(3) // never swept through 0
  })

  it('a view → ECEF pose → view round trip', () => {
    const moon = moonAt(DATE)
    const view = { longitude: 0.7, latitude: -0.4, altitude: 12345, heading: 1.1, tilt: 0.9 }
    const pose = moonPoseToECEF(moonViewPoseFixed(view, MOON_RADIUS), moon)
    expect(moon.altitudeOf(pose.position)).toBeCloseTo(view.altitude, 3)
    const back = moonViewFromECEF(pose.position, pose.quaternion, moon, MOON_RADIUS)
    for (const k of ['longitude', 'latitude', 'heading', 'tilt'] as const) expect(back[k]).toBeCloseTo(view[k], 9)
    expect(back.altitude).toBeCloseTo(view.altitude, 3)
  })

  it('looking straight down has north at the top of the screen and east to the right', () => {
    const pose = moonViewPoseFixed({ longitude: 0, latitude: 0, altitude: 1e5, heading: 0, tilt: 0 }, MOON_RADIUS)
    const right = new Vector3(1, 0, 0).applyQuaternion(pose.quaternion)
    const up = new Vector3(0, 1, 0).applyQuaternion(pose.quaternion)
    const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion)
    expect(forward.distanceTo(new Vector3(-1, 0, 0))).toBeLessThan(1e-12) // down at 0°, 0°
    expect(up.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-12) // north
    expect(right.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-12) // east (+90°)
  })

  it('the camera rides along with the Moon when the date changes', () => {
    const view = { longitude: 0.2, latitude: 0.1, altitude: 50_000, heading: 0, tilt: 0.5 }
    const fixed = moonViewPoseFixed(view, MOON_RADIUS)
    for (const hours of [0, 6, 24, 24 * 14]) {
      const date = DATE + hours * 3600e3
      const moon = moonAt(date)
      const pose = moonPoseToECEF(fixed, moon)
      expect(moon.altitudeOf(pose.position)).toBeCloseTo(view.altitude, 2)
      const back = moonViewFromECEF(pose.position, pose.quaternion, moon, MOON_RADIUS)
      expect(back.longitude).toBeCloseTo(view.longitude, 9)
      expect(back.latitude).toBeCloseTo(view.latitude, 9)
    }
    expect(new Quaternion().angleTo(new Quaternion())).toBe(0)
  })
})
