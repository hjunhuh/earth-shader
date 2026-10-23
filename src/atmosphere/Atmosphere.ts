import { FloatType, HalfFloatType, Uniform, type Texture, type WebGLRenderer } from 'three'
import { ReadbackPass } from '../render/ReadbackPass'
import { AtmosphereCpu } from './AtmosphereCpu'
import { AtmospherePrecompute } from './AtmospherePrecompute'
import { createEarthAtmosphere, type AtmosphereOptions, type AtmosphereParameters } from './AtmosphereParams'
import {
  IRRADIANCE_TEXTURE_HEIGHT,
  IRRADIANCE_TEXTURE_WIDTH,
  TRANSMITTANCE_TEXTURE_HEIGHT,
  TRANSMITTANCE_TEXTURE_WIDTH,
} from './constants'

/**
 * Owns the precomputed atmosphere: GPU tables, the generated GLSL chunk,
 * shared sampler uniforms for materials, and a CPU mirror for exposure.
 */
export class Atmosphere {
  readonly params: AtmosphereParameters
  readonly precompute: AtmospherePrecompute
  readonly chunks: Record<string, string>
  /** Sampler uniforms to spread into materials that include atmosphere/runtime. */
  readonly uniforms = {
    transmittance_texture: new Uniform<Texture | null>(null),
    scattering_texture: new Uniform<Texture | null>(null),
    single_mie_scattering_texture: new Uniform<Texture | null>(null),
    irradiance_texture: new Uniform<Texture | null>(null),
  }
  cpu: AtmosphereCpu | null = null

  constructor(
    private readonly renderer: WebGLRenderer,
    options: AtmosphereOptions = {},
  ) {
    const gl = renderer.getContext() as WebGL2RenderingContext
    const floatLinear = gl.getExtension('OES_texture_float_linear') !== null
    this.params = createEarthAtmosphere({ ...options, maxSunZenithDeg: floatLinear ? 120 : 102 })
    this.precompute = new AtmospherePrecompute(renderer, this.params, { type: floatLinear ? FloatType : HalfFloatType })
    this.chunks = this.precompute.chunks
  }

  get ready(): boolean {
    return this.cpu !== null
  }

  /** Synchronous (tests, fast GPUs). */
  initSync(): void {
    this.precompute.runAll()
    this.finish()
  }

  /** Spread over animation frames. */
  async init(stepsPerFrame = 24): Promise<void> {
    await this.precompute.run(stepsPerFrame)
    this.finish()
  }

  private finish(): void {
    const t = this.precompute.textures
    this.uniforms.transmittance_texture.value = t.transmittance
    this.uniforms.scattering_texture.value = t.scattering
    this.uniforms.single_mie_scattering_texture.value = t.singleMieScattering
    this.uniforms.irradiance_texture.value = t.irradiance
    const rb = new ReadbackPass()
    const transmittance = rb.read2D(this.renderer, t.transmittance, TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT)
    const irradiance = rb.read2D(this.renderer, t.irradiance, IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT)
    rb.dispose()
    this.cpu = new AtmosphereCpu(this.params, transmittance, irradiance)
  }

  dispose(): void {
    this.precompute.dispose()
  }
}
