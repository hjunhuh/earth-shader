import {
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RGBAFormat,
  Uniform,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { SOLAR_WHITE_POINT } from '../atmosphere/luminance'
import { FullscreenPass, createFullscreenMaterial } from './FullscreenPass'
import { shaderChunks } from './shaderLib'

const METER_SIZE = 128

/**
 * GPU auto-exposure: log-luminance moments via a mip chain combined with the
 * incident-light EV (see post/adapt.glsl), then a 1x1 ping-pong adaptation
 * target holding EV100 (texelFetch'd by the tone-mapping pass). Pixel-identical for a fixed number of frames, so
 * screenshots stay reproducible; measured tests read the HDR buffer anyway.
 */
export class ExposurePass {
  private readonly meterTarget: WebGLRenderTarget
  private readonly adaptTargets: [WebGLRenderTarget, WebGLRenderTarget]
  private index = 0
  private readonly meter: FullscreenPass
  private readonly adapt: FullscreenPass
  evMin = 1
  evMax = 16
  /** Incident-light EV100 from the CPU illuminance model. */
  incidentEv = 15
  /** Adaptation time constant [s]; 0 = instant. */
  tau = 0.6

  constructor(private readonly renderer: WebGLRenderer) {
    this.meterTarget = new WebGLRenderTarget(METER_SIZE, METER_SIZE, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    })
    const mk = () =>
      new WebGLRenderTarget(1, 1, {
        type: FloatType,
        format: RGBAFormat,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: false,
      })
    this.adaptTargets = [mk(), mk()]
    this.meter = new FullscreenPass(
      createFullscreenMaterial({
        name: 'ExposureMeter',
        fragmentShader: shaderChunks['post/meter']!,
        uniforms: {
          uHdr: new Uniform<Texture | null>(null),
          uWhitePoint: new Uniform(new Vector3(...SOLAR_WHITE_POINT)),
          uSize: new Uniform(new Vector2(METER_SIZE, METER_SIZE)),
        },
      }),
    )
    this.adapt = new FullscreenPass(
      createFullscreenMaterial({
        name: 'ExposureAdapt',
        fragmentShader: shaderChunks['post/adapt']!,
        uniforms: {
          uMeter: new Uniform(this.meterTarget.texture),
          uPrevious: new Uniform<Texture | null>(null),
          uMeterLod: new Uniform(Math.log2(METER_SIZE)),
          uBlend: new Uniform(1),
          uEvMin: new Uniform(1),
          uEvMax: new Uniform(16),
          uIncidentEv: new Uniform(15),
        },
      }),
    )
    // Mark history as empty (ev <= -100 means "no previous value").
    for (const t of this.adaptTargets) {
      renderer.setRenderTarget(t)
      renderer.setClearColor(0x000000, 1)
      renderer.clearColor()
      ;(renderer.getContext() as WebGL2RenderingContext).clearBufferfv(
        (renderer.getContext() as WebGL2RenderingContext).COLOR,
        0,
        [-1000, -1000, 0, 1],
      )
    }
    renderer.setRenderTarget(null)
  }

  /** Current EV100 texture (R = smoothed EV, G = target EV). */
  get texture(): Texture {
    return this.adaptTargets[this.index]!.texture
  }

  update(hdr: Texture, dt: number): void {
    this.meter.material.uniforms.uHdr!.value = hdr
    this.meter.render(this.renderer, this.meterTarget)
    const prev = this.adaptTargets[this.index]!
    const next = this.adaptTargets[1 - this.index]!
    const u = this.adapt.material.uniforms
    u.uPrevious!.value = prev.texture
    u.uBlend!.value = this.tau <= 0 ? 1 : 1 - Math.exp(-dt / this.tau)
    u.uEvMin!.value = this.evMin
    u.uEvMax!.value = this.evMax
    u.uIncidentEv!.value = this.incidentEv
    this.adapt.render(this.renderer, next)
    this.index = 1 - this.index
  }

  dispose(): void {
    this.meter.dispose()
    this.adapt.dispose()
    this.meterTarget.dispose()
    this.adaptTargets.forEach((t) => t.dispose())
  }
}
