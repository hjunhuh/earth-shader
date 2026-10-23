import { Quaternion, Vector3, type Camera } from 'three'
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial'

export interface LocationLike {
  longitude: number // degrees
  latitude: number // degrees
  height: number // meters
}

const geodetic = new Geodetic()
const position = new Vector3()
const up = new Vector3()
const offset = new Vector3()
const rotation = new Quaternion()

/**
 * Port of takram's storybook `useApplyLocation`: moves the orbit target to the
 * location and carries the camera along, rotating its current offset so the
 * view relative to the local horizon is preserved.
 */
export function applyLocation(camera: Camera, target: Vector3, { longitude, latitude, height }: LocationLike): Vector3 {
  geodetic.set(radians(longitude), radians(latitude), height)
  geodetic.toECEF(position)
  Ellipsoid.WGS84.getSurfaceNormal(position, up)

  rotation.setFromUnitVectors(camera.up, up)
  offset.copy(camera.position).sub(target)
  offset.applyQuaternion(rotation)
  camera.up.copy(up)
  camera.position.copy(position).add(offset)
  target.copy(position)
  return target
}
