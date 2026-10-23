import {
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  WebGLRenderTarget,
  type IUniform,
  type WebGLRenderer,
} from 'three'
import { FullscreenPass, createFullscreenMaterial } from '../../../src/render/FullscreenPass'
import { ReadbackPass } from '../../../src/render/ReadbackPass'

/**
 * Runs a GLSL function over N inputs on the GPU and returns the outputs.
 *
 *   const out = runKernel(renderer, {
 *     includes: ['common/intersect'],
 *     body: 'vec4 kernel(vec4 a, vec4 b, vec4 c, vec4 d) { return vec4(raySphereStable(a.x, a.y), 0, 0); }',
 *     inputs: [Float32Array(N*4), ...up to 4],
 *   })
 *
 * Inputs are RGBA32F texels (4 floats per item); output is 4 floats per item.
 */
export interface KernelSpec {
  includes?: string[]
  /** Must define `vec4 kernel(vec4 a, vec4 b, vec4 c, vec4 d)`. */
  body: string
  inputs: Float32Array[]
  uniforms?: Record<string, IUniform>
  defines?: Record<string, number | boolean | string>
  /** Extra declarations placed before includes (e.g. uniform declarations). */
  prelude?: string
  /** Generated chunks (e.g. atmosphere/parameters). */
  chunks?: Record<string, string>
}

const WIDTH = 256

const readbacks = new WeakMap<WebGLRenderer, ReadbackPass>()

export function runKernel(renderer: WebGLRenderer, spec: KernelSpec): Float32Array {
  const count = spec.inputs[0]!.length / 4
  const height = Math.ceil(count / WIDTH)
  const width = Math.min(WIDTH, count)
  const textures = [0, 1, 2, 3].map((i) => {
    const data = new Float32Array(width * height * 4)
    const src = spec.inputs[i]
    if (src) data.set(src)
    const tex = new DataTexture(data, width, height, RGBAFormat, FloatType)
    tex.minFilter = NearestFilter
    tex.magFilter = NearestFilter
    tex.needsUpdate = true
    return tex
  })
  const includes = (spec.includes ?? []).map((n) => `#include "${n}"`).join('\n')
  const material = createFullscreenMaterial({
    name: 'Kernel',
    chunks: spec.chunks,
    uniforms: {
      in0: { value: textures[0] },
      in1: { value: textures[1] },
      in2: { value: textures[2] },
      in3: { value: textures[3] },
      ...spec.uniforms,
    },
    defines: spec.defines ?? {},
    fragmentShader: /* glsl */ `
      uniform sampler2D in0;
      uniform sampler2D in1;
      uniform sampler2D in2;
      uniform sampler2D in3;
      layout(location = 0) out vec4 outValue;
      ${spec.prelude ?? ''}
      ${includes}
      ${spec.body}
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        outValue = kernel(texelFetch(in0, p, 0), texelFetch(in1, p, 0), texelFetch(in2, p, 0), texelFetch(in3, p, 0));
      }
    `,
  })
  const target = new WebGLRenderTarget(width, height, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
  })
  const pass = new FullscreenPass(material)
  pass.render(renderer, target)
  let rb = readbacks.get(renderer)
  if (!rb) {
    rb = new ReadbackPass()
    readbacks.set(renderer, rb)
  }
  const out = rb.read2D(renderer, target.texture, width, height)
  pass.dispose()
  target.dispose()
  textures.forEach((t) => t.dispose())
  return out.subarray(0, count * 4)
}

/** Packs per-item tuples (≤ 4 numbers) into an RGBA float array. */
export function pack(items: readonly (readonly number[])[]): Float32Array {
  const out = new Float32Array(items.length * 4)
  items.forEach((v, i) => v.forEach((x, j) => (out[i * 4 + j] = x)))
  return out
}

export function relErr(a: number, b: number, floor = 1e-30): number {
  return Math.abs(a - b) / Math.max(Math.abs(b), floor)
}
