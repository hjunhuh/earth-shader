import {
  FloatType,
  NearestFilter,
  RGBAFormat,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { FullscreenPass, createFullscreenMaterial } from './FullscreenPass'

const FRAG = /* glsl */ `
uniform sampler2D tex2D;
uniform sampler3D tex3D;
uniform samplerCube texCube;
uniform int mode;      // 0 = 2D, 1 = 3D layer, 2 = cube face
uniform int layer;
uniform vec2 size;
layout(location = 0) out vec4 outColor;

#include "common/cubemap"

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (mode == 0) {
    outColor = texelFetch(tex2D, p, 0);
  } else if (mode == 1) {
    outColor = texelFetch(tex3D, ivec3(p, layer), 0);
  } else {
    vec2 st = (vec2(p) + 0.5) / size;
    outColor = texture(texCube, cubeFaceDirection(layer, st * 2.0 - 1.0));
  }
}
`

export interface ReadbackRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Copies any texture (2D, one 3D layer, one cube face, an MRT attachment)
 * into an RGBA32F 2D target and reads it back. RGBA/FLOAT is the only
 * combination guaranteed to be readable in WebGL2 with EXT_color_buffer_float.
 */
export class ReadbackPass {
  private readonly pass: FullscreenPass
  private target: WebGLRenderTarget | null = null

  constructor() {
    this.pass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'Readback',
        fragmentShader: FRAG,
        uniforms: {
          tex2D: { value: null },
          tex3D: { value: null },
          texCube: { value: null },
          mode: { value: 0 },
          layer: { value: 0 },
          size: { value: [1, 1] },
        },
      }),
    )
  }

  private ensureTarget(width: number, height: number): WebGLRenderTarget {
    if (this.target === null || this.target.width !== width || this.target.height !== height) {
      this.target?.dispose()
      this.target = new WebGLRenderTarget(width, height, {
        type: FloatType,
        format: RGBAFormat,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: false,
        generateMipmaps: false,
      })
    }
    return this.target
  }

  read2D(
    renderer: WebGLRenderer,
    texture: Texture,
    width: number,
    height: number,
    region?: ReadbackRegion,
  ): Float32Array {
    return this.run(renderer, 0, 0, width, height, { tex2D: texture }, region)
  }

  read3DLayer(
    renderer: WebGLRenderer,
    texture: Texture,
    width: number,
    height: number,
    layer: number,
    region?: ReadbackRegion,
  ): Float32Array {
    return this.run(renderer, 1, layer, width, height, { tex3D: texture }, region)
  }

  readCubeFace(
    renderer: WebGLRenderer,
    texture: Texture,
    size: number,
    face: number,
    region?: ReadbackRegion,
  ): Float32Array {
    return this.run(renderer, 2, face, size, size, { texCube: texture }, region)
  }

  private run(
    renderer: WebGLRenderer,
    mode: number,
    layer: number,
    width: number,
    height: number,
    textures: Record<string, Texture>,
    region?: ReadbackRegion,
  ): Float32Array {
    const u = this.pass.material.uniforms
    u.tex2D!.value = null
    u.tex3D!.value = null
    u.texCube!.value = null
    for (const [k, v] of Object.entries(textures)) u[k]!.value = v
    u.mode!.value = mode
    u.layer!.value = layer
    u.size!.value = [width, height]
    const target = this.ensureTarget(width, height)
    this.pass.render(renderer, target)
    const r = region ?? { x: 0, y: 0, width, height }
    const out = new Float32Array(r.width * r.height * 4)
    renderer.readRenderTargetPixels(target, r.x, r.y, r.width, r.height, out)
    for (const k of Object.keys(textures)) u[k]!.value = null
    return out
  }

  dispose(): void {
    this.pass.dispose()
    this.target?.dispose()
  }
}
