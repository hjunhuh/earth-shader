import {
  ClampToEdgeWrapping,
  FloatType,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  WebGL3DRenderTarget,
  WebGLRenderTarget,
  type Data3DTexture,
  type RawShaderMaterial,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { FullscreenPass, createFullscreenMaterial } from '../render/FullscreenPass'
import { shaderChunks } from '../render/shaderLib'
import { atmosphereChunks, type AtmosphereParameters } from './AtmosphereParams'
import {
  IRRADIANCE_TEXTURE_HEIGHT,
  IRRADIANCE_TEXTURE_WIDTH,
  SCATTERING_TEXTURE_DEPTH,
  SCATTERING_TEXTURE_HEIGHT,
  SCATTERING_TEXTURE_WIDTH,
  TRANSMITTANCE_TEXTURE_HEIGHT,
  TRANSMITTANCE_TEXTURE_WIDTH,
} from './constants'

export interface AtmosphereTextures {
  transmittance: Texture
  scattering: Data3DTexture
  singleMieScattering: Data3DTexture
  irradiance: Texture
}

type Target2D = WebGLRenderTarget
type Target3D = WebGL3DRenderTarget

function create2D(width: number, height: number, type: typeof FloatType | typeof HalfFloatType, count = 1): Target2D {
  const t = new WebGLRenderTarget(width, height, {
    count,
    type,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  })
  return t
}

function create3D(type: typeof FloatType | typeof HalfFloatType): Target3D {
  const t = new WebGL3DRenderTarget(SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, SCATTERING_TEXTURE_DEPTH, {
    type,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  })
  t.texture.wrapS = ClampToEdgeWrapping
  t.texture.wrapT = ClampToEdgeWrapping
  t.texture.wrapR = ClampToEdgeWrapping
  return t
}

export interface PrecomputeOptions {
  /** Highest scattering order (Bruneton uses 4). */
  scatteringOrders?: number
  /** Float32 (default when float linear filtering is available) or half floats. */
  type?: typeof FloatType | typeof HalfFloatType
}

/**
 * Bruneton 2017 precomputation as a list of small GPU steps (one draw per
 * 2D table or per 3D layer), so it can be spread over frames without
 * tripping GPU watchdogs. Accumulation uses ping-pong targets, not blending.
 */
export class AtmospherePrecompute {
  readonly chunks: Record<string, string>
  private readonly type: typeof FloatType | typeof HalfFloatType
  private readonly orders: number

  // Results
  readonly transmittance: Target2D
  readonly irradianceSum: [Target2D, Target2D] // MRT [delta, sum] ping-pong
  private irradianceIndex = 0
  readonly scatteringSum: [Target3D, Target3D]
  private scatteringIndex = 0
  readonly singleMie: Target3D

  // Scratch
  private readonly deltaIrradiance: Target2D
  private readonly deltaRayleigh: Target3D
  private readonly deltaDensity: Target3D
  private readonly deltaMultiple: Target3D

  private readonly pass: FullscreenPass
  private readonly materials: Record<string, RawShaderMaterial> = {}
  private steps: (() => void)[] = []
  private stepIndex = 0
  private disposedScratch = false

  constructor(
    private readonly renderer: WebGLRenderer,
    readonly params: AtmosphereParameters,
    options: PrecomputeOptions = {},
  ) {
    this.type = options.type ?? FloatType
    this.orders = options.scatteringOrders ?? 4
    this.chunks = atmosphereChunks(params)
    this.transmittance = create2D(TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT, this.type)
    this.deltaIrradiance = create2D(IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT, this.type)
    this.irradianceSum = [
      create2D(IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT, this.type, 2),
      create2D(IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT, this.type, 2),
    ]
    this.scatteringSum = [create3D(this.type), create3D(this.type)]
    this.singleMie = create3D(this.type)
    this.deltaRayleigh = create3D(this.type)
    this.deltaDensity = create3D(this.type)
    this.deltaMultiple = create3D(this.type)

    const names = [
      'transmittance',
      'directIrradiance',
      'singleScattering',
      'scatteringDensity',
      'indirectIrradiance',
      'multipleScattering',
      'accumulateScattering',
    ]
    const uniformNames = [
      'transmittance_texture',
      'single_rayleigh_scattering_texture',
      'single_mie_scattering_texture',
      'multiple_scattering_texture',
      'irradiance_texture',
      'scattering_density_texture',
      'previous_irradiance_texture',
      'previous_sum_texture',
      'delta_texture',
      'layer',
      'component',
      'scattering_order',
      'first',
    ]
    for (const name of names) {
      this.materials[name] = createFullscreenMaterial({
        name: `atmosphere/${name}`,
        fragmentShader: shaderChunks[`atmosphere/precompute/${name}`]!,
        chunks: this.chunks,
        uniforms: Object.fromEntries(uniformNames.map((u) => [u, { value: null }])),
      })
    }
    this.pass = new FullscreenPass(this.materials.transmittance!)
    this.buildSteps()
  }

  private draw(name: string, target: Target2D | Target3D, layer: number, uniforms: Record<string, unknown>): void {
    const mat = this.materials[name]!
    for (const [k, v] of Object.entries(uniforms)) mat.uniforms[k]!.value = v
    this.pass.setMaterial(mat)
    this.pass.render(this.renderer, target, layer)
  }

  private buildSteps(): void {
    const s: (() => void)[] = []
    const layers = Array.from({ length: SCATTERING_TEXTURE_DEPTH }, (_, i) => i)
    const irr = () => this.irradianceSum[this.irradianceIndex]!
    const sum = () => this.scatteringSum[this.scatteringIndex]!

    s.push(() => this.draw('transmittance', this.transmittance, 0, {}))
    s.push(() => this.draw('directIrradiance', this.deltaIrradiance, 0, { transmittance_texture: this.transmittance.texture }))
    for (const layer of layers) {
      s.push(() =>
        this.draw('singleScattering', this.deltaRayleigh, layer, {
          transmittance_texture: this.transmittance.texture,
          layer,
          component: 0,
        }),
      )
      s.push(() =>
        this.draw('singleScattering', this.singleMie, layer, {
          transmittance_texture: this.transmittance.texture,
          layer,
          component: 1,
        }),
      )
    }
    // scattering sum = single Rayleigh
    for (const layer of layers) {
      s.push(() =>
        this.draw('accumulateScattering', this.scatteringSum[1 - this.scatteringIndex]!, layer, {
          previous_sum_texture: sum().texture,
          delta_texture: this.deltaRayleigh.texture,
          layer,
          first: 1,
        }),
      )
    }
    s.push(() => {
      this.scatteringIndex = 1 - this.scatteringIndex
    })

    for (let order = 2; order <= this.orders; ++order) {
      // The irradiance used by the density pass is the delta of the previous order
      // (direct irradiance for order 2).
      for (const layer of layers) {
        s.push(() =>
          this.draw('scatteringDensity', this.deltaDensity, layer, {
            transmittance_texture: this.transmittance.texture,
            single_rayleigh_scattering_texture: this.deltaRayleigh.texture,
            single_mie_scattering_texture: this.singleMie.texture,
            multiple_scattering_texture: this.deltaMultiple.texture,
            irradiance_texture: order === 2 ? this.deltaIrradiance.texture : irr().textures[0],
            scattering_order: order,
            layer,
          }),
        )
      }
      s.push(() => {
        const next = this.irradianceSum[1 - this.irradianceIndex]!
        this.draw('indirectIrradiance', next, 0, {
          single_rayleigh_scattering_texture: this.deltaRayleigh.texture,
          single_mie_scattering_texture: this.singleMie.texture,
          multiple_scattering_texture: this.deltaMultiple.texture,
          previous_irradiance_texture: order === 2 ? null : irr().textures[1],
          first: order === 2 ? 1 : 0,
          scattering_order: order - 1,
        })
        this.irradianceIndex = 1 - this.irradianceIndex
      })
      for (const layer of layers) {
        s.push(() =>
          this.draw('multipleScattering', this.deltaMultiple, layer, {
            transmittance_texture: this.transmittance.texture,
            scattering_density_texture: this.deltaDensity.texture,
            layer,
          }),
        )
      }
      for (const layer of layers) {
        s.push(() =>
          this.draw('accumulateScattering', this.scatteringSum[1 - this.scatteringIndex]!, layer, {
            previous_sum_texture: sum().texture,
            delta_texture: this.deltaMultiple.texture,
            layer,
            first: 0,
          }),
        )
      }
      s.push(() => {
        this.scatteringIndex = 1 - this.scatteringIndex
      })
    }
    this.steps = s
  }

  get progress(): number {
    return this.steps.length === 0 ? 1 : this.stepIndex / this.steps.length
  }

  get done(): boolean {
    return this.stepIndex >= this.steps.length
  }

  get stepCount(): number {
    return this.steps.length
  }

  /** Runs up to `maxSteps` steps; returns true when finished. */
  step(maxSteps = 16): boolean {
    const end = Math.min(this.steps.length, this.stepIndex + maxSteps)
    while (this.stepIndex < end) this.steps[this.stepIndex++]!()
    ;(this.renderer.getContext() as WebGL2RenderingContext).flush()
    if (this.done) this.disposeScratch()
    return this.done
  }

  runAll(): void {
    while (!this.step(64));
  }

  /** Runs over several animation frames to keep the page responsive. */
  async run(stepsPerFrame = 12): Promise<void> {
    while (!this.step(stepsPerFrame)) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }

  get textures(): AtmosphereTextures {
    return {
      transmittance: this.transmittance.texture,
      scattering: this.scatteringSum[this.scatteringIndex]!.texture,
      singleMieScattering: this.singleMie.texture,
      // Irradiance sum (sky only): the second attachment of the latest MRT target.
      irradiance: this.irradianceSum[this.irradianceIndex]!.textures[1]!,
    }
  }

  /** Intermediate textures exposed for validation tests (valid until done). */
  get debugTextures(): Record<string, Texture> {
    return {
      deltaRayleigh: this.deltaRayleigh.texture,
      deltaIrradiance: this.deltaIrradiance.texture,
      deltaMultiple: this.deltaMultiple.texture,
      deltaDensity: this.deltaDensity.texture,
    }
  }

  /** Keep scratch targets alive (tests inspect them after completion). */
  keepScratch = false

  private disposeScratch(): void {
    if (this.disposedScratch || this.keepScratch) return
    this.disposedScratch = true
    this.deltaIrradiance.dispose()
    this.deltaRayleigh.dispose()
    this.deltaDensity.dispose()
    this.deltaMultiple.dispose()
    this.scatteringSum[1 - this.scatteringIndex]!.dispose()
    for (const m of Object.values(this.materials)) m.dispose()
  }

  dispose(): void {
    this.keepScratch = false
    this.disposeScratch()
    this.transmittance.dispose()
    this.irradianceSum.forEach((t) => t.dispose())
    this.scatteringSum[this.scatteringIndex]!.dispose()
    this.singleMie.dispose()
  }
}
