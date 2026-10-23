import {
  BufferGeometry,
  Float32BufferAttribute,
  GLSL3,
  Mesh,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  type IUniform,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three'
import { buildShader, normalizeDefines, shaderChunks, type DefineInput, type ShaderChunks } from './shaderLib'

export const FULLSCREEN_VERTEX = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

let sharedGeometry: BufferGeometry | null = null

/** One triangle covering clip space (no diagonal seam). */
export function getFullscreenTriangle(): BufferGeometry {
  if (sharedGeometry === null) {
    sharedGeometry = new BufferGeometry()
    sharedGeometry.setAttribute(
      'position',
      new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    )
  }
  return sharedGeometry
}

export interface FullscreenMaterialOptions {
  fragmentShader: string
  vertexShader?: string
  uniforms?: Record<string, IUniform>
  defines?: DefineInput
  name?: string
  /** Extra (generated) chunks merged over the static registry. */
  chunks?: ShaderChunks
}

export function createFullscreenMaterial(options: FullscreenMaterialOptions): RawShaderMaterial {
  return new RawShaderMaterial({
    name: options.name ?? 'FullscreenMaterial',
    glslVersion: GLSL3,
    vertexShader: buildShader(options.vertexShader ?? FULLSCREEN_VERTEX),
    fragmentShader: buildShader(options.fragmentShader, options.chunks ? { ...shaderChunks, ...options.chunks } : shaderChunks),
    uniforms: options.uniforms ?? {},
    defines: normalizeDefines(options.defines ?? {}),
    depthTest: false,
    depthWrite: false,
  })
}

/** Renders a material over the full viewport of a target (or a 3D layer / cube face). */
export class FullscreenPass {
  readonly scene = new Scene()
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  readonly mesh: Mesh<BufferGeometry, RawShaderMaterial>

  constructor(public material: RawShaderMaterial) {
    this.mesh = new Mesh(getFullscreenTriangle(), material)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  setMaterial(material: RawShaderMaterial): void {
    this.material = material
    this.mesh.material = material
  }

  /**
   * @param layer 3D/array layer or cube face index (three uses activeCubeFace for both).
   */
  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null, layer = 0): void {
    const prevTarget = renderer.getRenderTarget()
    const prevFace = renderer.getActiveCubeFace()
    const prevMip = renderer.getActiveMipmapLevel()
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(target, layer)
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(prevTarget, prevFace, prevMip)
    renderer.autoClear = prevAutoClear
  }

  dispose(): void {
    this.material.dispose()
  }
}
