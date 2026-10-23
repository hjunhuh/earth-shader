import { afterAll, describe, expect, it } from 'vitest'
import {
  BufferAttribute,
  BufferGeometry,
  DepthTexture,
  FloatType,
  GLSL3,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import { Ocean } from '../../src/scene/Ocean'
import { clipPlanes, intersectOcean, type Vec3 } from '../../src/scene/oceanMath'

const SIZE = 96
const canvas = document.createElement('canvas')
canvas.width = SIZE
canvas.height = SIZE
const renderer = new WebGLRenderer({ canvas, depth: true })
renderer.setPixelRatio(1)
afterAll(() => {
  renderer.dispose()
  renderer.forceContextLoss()
})

const target = new WebGLRenderTarget(SIZE, SIZE, { type: FloatType, format: RGBAFormat, depthBuffer: true })
target.depthTexture = new DepthTexture(SIZE, SIZE, FloatType)
const copyTarget = new WebGLRenderTarget(SIZE, SIZE, { type: FloatType, format: RGBAFormat, depthBuffer: false })

const quad = new BufferGeometry()
quad.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
const copy = new Mesh(
  quad,
  new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { depthTexture: { value: target.depthTexture }, colorTexture: { value: target.texture } },
    vertexShader: 'out vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D depthTexture; uniform sampler2D colorTexture; in vec2 vUv; layout(location = 0) out vec4 o;
      void main() { o = vec4(texture(depthTexture, vUv).r, texture(colorTexture, vUv).a, 0.0, 1.0); }`,
  }),
)
copy.frustumCulled = false
const copyScene = new Scene().add(copy)
const copyCamera = new OrthographicCamera()

function setup(longitude: number, latitude: number, height: number, heading: number, pitch: number, distance: number) {
  const camera = new PerspectiveCamera(75, 1, 1, 4e5)
  const t = new Geodetic(radians(longitude), radians(latitude), height).toECEF()
  const q = new Quaternion()
  new PointOfView(distance, radians(heading), radians(pitch)).decompose(t, camera.position, q, camera.up)
  camera.quaternion.copy(q)
  const altitude = new Geodetic().setFromECEF(camera.position).height
  const planes = clipPlanes(altitude)
  camera.near = planes.near
  camera.far = planes.far
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  return camera
}

/** Render the ocean, return per-pixel [depth, alpha] (bottom-left origin). */
function renderOcean(camera: PerspectiveCamera): Float32Array {
  const ocean = new Ocean()
  ocean.update(camera)
  const scene = new Scene().add(ocean)
  renderer.setRenderTarget(target)
  renderer.setClearColor(0x000000, 0)
  renderer.clear()
  renderer.render(scene, camera)
  renderer.setRenderTarget(copyTarget)
  renderer.render(copyScene, copyCamera)
  const out = new Float32Array(SIZE * SIZE * 4)
  renderer.readRenderTargetPixels(copyTarget, 0, 0, SIZE, SIZE, out)
  renderer.setRenderTarget(null)
  ocean.geometry.dispose()
  ocean.material.dispose()
  return out
}

/** Expected [depth or null] per pixel from the float64 TypeScript intersection. */
function expected(camera: PerspectiveCamera, px: number, py: number): number | null {
  const ndc = new Vector3(((px + 0.5) / SIZE) * 2 - 1, ((py + 0.5) / SIZE) * 2 - 1, -1)
  const viewDir = ndc.applyMatrix4(camera.projectionMatrixInverse).normalize()
  const worldDir = viewDir.clone().transformDirection(camera.matrixWorld)
  const t = intersectOcean(camera.position.toArray() as Vec3, worldDir.toArray() as Vec3)
  if (t === null) return null
  const clip = viewDir.clone().multiplyScalar(t).applyMatrix4(camera.projectionMatrix)
  return clip.z > 1 ? null : clip.z * 0.5 + 0.5
}

const views: Record<string, [number, number, number, number, number, number]> = {
  'story view, 300 m, looking down 20°': [30, 35, 300, 160, -20, 1000],
  'grazing horizon, 300 m': [30, 35, 300, 160, -2, 1000],
  'from 30 km': [127, 37.5, 0, 90, -30, 30_000],
  'from orbit, 2,000 km': [0, 0, 0, 0, -89, 2_000_000],
}

describe('ocean shader writes the exact surface depth', () => {
  for (const [name, args] of Object.entries(views)) {
    it(name, () => {
      const camera = setup(...args)
      const out = renderOcean(camera)
      let hits = 0
      let mismatched = 0
      let maxErr = 0
      for (let y = 0; y < SIZE; ++y) {
        for (let x = 0; x < SIZE; ++x) {
          const i = (y * SIZE + x) * 4
          const depth = out[i]!
          const alpha = out[i + 1]!
          const want = expected(camera, x, y)
          const hit = alpha > 0.5
          if (hit !== (want !== null)) {
            mismatched++
            continue
          }
          if (want === null) {
            expect(depth).toBe(1) // Sky keeps the cleared depth.
            continue
          }
          hits++
          maxErr = Math.max(maxErr, Math.abs(depth - want))
        }
      }
      // Hit/miss can only disagree on the horizon row.
      expect(mismatched).toBeLessThanOrEqual(SIZE)
      expect(hits).toBeGreaterThan(SIZE * 4)
      // A few float32 ulps of depth around 1.0.
      expect(maxErr).toBeLessThan(5e-7)
    })
  }
})
