import { Pass } from 'postprocessing'
import {
  Color,
  HalfFloatType,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three'

type Renderable = Object3D & { material: Material | Material[] }

const isRenderable = (object: Object3D): object is Renderable => 'material' in object

/**
 * Renders the scene's view-space normals (0.5·n + 0.5) for takram's
 * AerialPerspectiveEffect `normalBuffer`. Each object supplies its own normal
 * material through `resolve` (so GPU-displaced terrain and the ray-traced
 * ocean stay exact); objects without one are skipped. Cleared to zero, which
 * takram reads as "no normal".
 *
 * postprocessing's NormalPass can't be used: its override material drops the
 * terrain's displacement and can't ray-trace the ocean.
 */
export class SceneNormalPass extends Pass {
  readonly renderTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true })
  private readonly clearColor = new Color()
  private readonly swaps: [Renderable, Material | Material[], Material][] = []
  private readonly hidden: Object3D[] = []

  constructor(
    scene: Scene,
    camera: Camera,
    private readonly resolve: (object: Renderable) => Material | null,
  ) {
    super('SceneNormalPass', scene, camera)
    this.needsSwap = false
    this.renderTarget.texture.name = 'SceneNormalPass.Normal'
  }

  get texture(): Texture {
    return this.renderTarget.texture
  }

  override render(renderer: WebGLRenderer): void {
    const scene = this.scene as Scene
    scene.traverseVisible((object) => {
      if (!isRenderable(object)) return
      const material = this.resolve(object)
      if (material) this.swaps.push([object, object.material, material])
      else this.hidden.push(object)
    })
    for (const [object, , material] of this.swaps) object.material = material
    for (const object of this.hidden) object.visible = false

    renderer.getClearColor(this.clearColor)
    const clearAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.renderTarget)
    renderer.clear()
    renderer.render(scene, this.camera!)
    renderer.setClearColor(this.clearColor, clearAlpha)

    for (const [object, material] of this.swaps) object.material = material
    for (const object of this.hidden) object.visible = true
    this.swaps.length = 0
    this.hidden.length = 0
  }

  override setSize(width: number, height: number): void {
    this.renderTarget.setSize(width, height)
  }

  override dispose(): void {
    this.renderTarget.dispose()
    super.dispose()
  }
}
