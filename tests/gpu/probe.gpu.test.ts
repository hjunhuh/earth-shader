import { afterAll, describe, expect, it } from 'vitest'
import {
  ClampToEdgeWrapping,
  Data3DTexture,
  FloatType,
  LinearFilter,
  NearestFilter,
  RGBAFormat,
  WebGL3DRenderTarget,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
} from 'three'
import { FullscreenPass, createFullscreenMaterial } from '../../src/render/FullscreenPass'
import { ReadbackPass } from '../../src/render/ReadbackPass'
import { captureShaderErrors, createTestRenderer, disposeTestRenderer, getGpuInfo } from './harness/context'

const renderer = createTestRenderer()
const shaderErrors = captureShaderErrors(renderer)
const readback = new ReadbackPass()

afterAll(() => {
  readback.dispose()
  disposeTestRenderer(renderer)
})

describe('GPU probe', () => {
  it('runs on the expected GPU backend with required extensions', () => {
    const info = getGpuInfo(renderer)
    console.info('[gpu-probe]', JSON.stringify({ ...info, extensions: info.extensions.join(',') }))
    expect(renderer.capabilities.isWebGL2 ?? true).toBe(true)
    if (!import.meta.env.CI) {
      // Local runs must hit the real GPU, not a software fallback.
      expect(info.renderer).toMatch(/Apple|Metal/)
    }
    expect(info.extensions).toContain('EXT_color_buffer_float')
    expect(info.max3DTextureSize).toBeGreaterThanOrEqual(256)
  })
})

describe('float render targets', () => {
  it('round-trips RGBA32F values exactly through a fullscreen pass', () => {
    const target = new WebGLRenderTarget(8, 4, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
    })
    const pass = new FullscreenPass(
      createFullscreenMaterial({
        fragmentShader: /* glsl */ `
          layout(location = 0) out vec4 o;
          void main() {
            vec2 p = floor(gl_FragCoord.xy);
            o = vec4(p.x * 1.25e5, p.y - 3.5e-4, 6378137.0, -p.x * p.y * 0.125);
          }`,
      }),
    )
    pass.render(renderer, target)
    const out = readback.read2D(renderer, target.texture, 8, 4)
    expect(shaderErrors.errors).toEqual([])
    for (let y = 0; y < 4; ++y) {
      for (let x = 0; x < 8; ++x) {
        const i = (y * 8 + x) * 4
        expect(out[i]).toBe(Math.fround(x * 1.25e5))
        expect(out[i + 1]).toBe(Math.fround(y - 3.5e-4))
        expect(out[i + 2]).toBe(6378137)
        expect(out[i + 3]).toBe(Math.fround(-x * y * 0.125))
      }
    }
    pass.dispose()
    target.dispose()
  })

  it('renders into individual layers of a 3D target', () => {
    const size = 4
    const depth = 6
    const target = new WebGL3DRenderTarget(size, size, depth, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    })
    target.texture.wrapR = ClampToEdgeWrapping
    const pass = new FullscreenPass(
      createFullscreenMaterial({
        uniforms: { layer: { value: 0 } },
        fragmentShader: /* glsl */ `
          uniform int layer;
          layout(location = 0) out vec4 o;
          void main() {
            o = vec4(gl_FragCoord.xy, float(layer), float(layer) * 10.0 + gl_FragCoord.x);
          }`,
      }),
    )
    for (let z = 0; z < depth; ++z) {
      pass.material.uniforms.layer!.value = z
      pass.render(renderer, target, z)
    }
    expect(shaderErrors.errors).toEqual([])
    for (let z = 0; z < depth; ++z) {
      const out = readback.read3DLayer(renderer, target.texture, size, size, z)
      for (let y = 0; y < size; ++y) {
        for (let x = 0; x < size; ++x) {
          const i = (y * size + x) * 4
          expect([out[i], out[i + 1], out[i + 2], out[i + 3]]).toEqual([
            x + 0.5,
            y + 0.5,
            z,
            z * 10 + x + 0.5,
          ])
        }
      }
    }
    pass.dispose()
    target.dispose()
  })

  it('reads back uploaded Data3DTexture voxels', () => {
    const n = 4
    const data = new Float32Array(n * n * n * 4)
    for (let i = 0; i < data.length; ++i) data[i] = i * 0.5
    const tex = new Data3DTexture(data, n, n, n)
    tex.type = FloatType
    tex.format = RGBAFormat
    tex.minFilter = NearestFilter
    tex.magFilter = NearestFilter
    tex.unpackAlignment = 1
    tex.needsUpdate = true
    const layer2 = readback.read3DLayer(renderer, tex, n, n, 2)
    expect(Array.from(layer2)).toEqual(Array.from(data.subarray(2 * n * n * 4, 3 * n * n * 4)))
    tex.dispose()
  })

  it('renders cube faces with GL major-axis convention and samples them back by direction', () => {
    const size = 8
    const cube = new WebGLCubeRenderTarget(size, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    })
    const pass = new FullscreenPass(
      createFullscreenMaterial({
        uniforms: { face: { value: 0 }, size: { value: size } },
        fragmentShader: /* glsl */ `
          #include "common/cubemap"
          uniform int face;
          uniform float size;
          layout(location = 0) out vec4 o;
          void main() {
            vec2 st = gl_FragCoord.xy / size;
            o = vec4(normalize(cubeFaceDirection(face, st * 2.0 - 1.0)), float(face));
          }`,
      }),
    )
    for (let f = 0; f < 6; ++f) {
      pass.material.uniforms.face!.value = f
      pass.render(renderer, cube, f)
    }
    expect(shaderErrors.errors).toEqual([])
    for (let f = 0; f < 6; ++f) {
      const out = readback.readCubeFace(renderer, cube.texture, size, f)
      for (let i = 0; i < size * size; ++i) {
        // Sampling the cube with the direction stored in a texel returns that texel.
        expect(out[i * 4 + 3]).toBe(f)
        const len = Math.hypot(out[i * 4]!, out[i * 4 + 1]!, out[i * 4 + 2]!)
        expect(len).toBeCloseTo(1, 5)
      }
    }
    pass.dispose()
    cube.dispose()
  })
})
