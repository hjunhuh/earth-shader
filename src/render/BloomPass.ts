import { HalfFloatType, LinearFilter, RGBAFormat, Uniform, Vector2, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three'
import { FullscreenPass, createFullscreenMaterial } from './FullscreenPass'
import { shaderChunks } from './shaderLib'

const LEVELS = 6

/** Mip-chain HDR bloom (energy-preserving blur; strength applied when tone mapping). */
export class BloomPass {
  private readonly down: WebGLRenderTarget[] = []
  private readonly up: WebGLRenderTarget[] = []
  private readonly downPass: FullscreenPass
  private readonly upPass: FullscreenPass

  constructor(private readonly renderer: WebGLRenderer) {
    const mk = () =>
      new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false })
    for (let i = 0; i < LEVELS; ++i) {
      this.down.push(mk())
      this.up.push(mk())
    }
    this.downPass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'BloomDown',
        fragmentShader: shaderChunks['post/bloomDown']!,
        uniforms: { uSource: new Uniform<Texture | null>(null), uSourceTexel: new Uniform(new Vector2()), uTargetSize: new Uniform(new Vector2()), uKaris: new Uniform(0) },
      }),
    )
    this.upPass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'BloomUp',
        fragmentShader: shaderChunks['post/bloomUp']!,
        uniforms: { uCoarse: new Uniform<Texture | null>(null), uFine: new Uniform<Texture | null>(null), uCoarseTexel: new Uniform(new Vector2()), uTargetSize: new Uniform(new Vector2()) },
      }),
    )
  }

  setSize(width: number, height: number): void {
    let w = width
    let h = height
    for (let i = 0; i < LEVELS; ++i) {
      w = Math.max(1, Math.ceil(w / 2))
      h = Math.max(1, Math.ceil(h / 2))
      this.down[i]!.setSize(w, h)
      this.up[i]!.setSize(w, h)
    }
  }

  /** Returns the blurred texture (half resolution of the source). */
  render(source: Texture, sourceWidth: number, sourceHeight: number): Texture {
    const d = this.downPass.material.uniforms
    let srcW = sourceWidth
    let srcH = sourceHeight
    let src: Texture = source
    for (let i = 0; i < LEVELS; ++i) {
      const t = this.down[i]!
      d.uSource!.value = src
      d.uSourceTexel!.value.set(1 / srcW, 1 / srcH)
      d.uTargetSize!.value.set(t.width, t.height)
      d.uKaris!.value = i === 0 ? 1 : 0
      this.downPass.render(this.renderer, t)
      src = t.texture
      srcW = t.width
      srcH = t.height
    }
    const u = this.upPass.material.uniforms
    let coarse = this.down[LEVELS - 1]!
    for (let i = LEVELS - 2; i >= 0; --i) {
      const t = this.up[i]!
      u.uCoarse!.value = coarse.texture
      u.uFine!.value = this.down[i]!.texture
      u.uCoarseTexel!.value.set(1 / coarse.width, 1 / coarse.height)
      u.uTargetSize!.value.set(t.width, t.height)
      this.upPass.render(this.renderer, t)
      coarse = t
    }
    return coarse.texture
  }

  dispose(): void {
    this.downPass.dispose()
    this.upPass.dispose()
    for (const t of [...this.down, ...this.up]) t.dispose()
  }
}
