import {
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  RGFormat,
  RGBAFormat,
  Uniform,
  Vector2,
  Matrix3,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import type { CameraUniforms } from '../camera/CameraUniforms'
import type { Atmosphere } from '../atmosphere/Atmosphere'
import { SOLAR_WHITE_POINT } from '../atmosphere/luminance'
import { CloudResources } from '../clouds/CloudResources'
import { QUALITY_PRESETS, presetToDefines, type QualityPreset } from '../clouds/presets'
import type { Quality, WeatherOverride } from '../app/state'
import { FullscreenPass, createFullscreenMaterial } from './FullscreenPass'
import { applyDefines, shaderChunks } from './shaderLib'
import { frameSampleOffset } from '../clouds/jitter'
import { gmstDegrees } from '../time/solar'
import { GpuTimer } from './GpuTimer'
import { ExposurePass } from './ExposurePass'
import { BloomPass } from './BloomPass'
import { SHADING_EARTH_RADIUS } from '../geo/shadingSpace'

export { LUMINANCE_UNIT } from './units'

export interface CloudSettings {
  enabled: boolean
  quality: Quality
  coverage: number
  physical: boolean
  shadows: boolean
}

export interface FrameInputs {
  camera: CameraUniforms
  /** Sun direction in shading space (unit). */
  sunDirection: Vector3
  /** Manual EV100, or null for GPU auto-exposure. */
  ev100: number | null
  /** Auto-exposure clamp range [EV100]. */
  evRange: [number, number]
  /** Incident-light EV100 (CPU illuminance at the look-at point). */
  incidentEv: number
  dt: number
  frame: number
  /** UTC instant (for the star field rotation). */
  utcMs: number
  clouds: CloudSettings
}

export interface PipelineTargets {
  /** MRT: [0] HDR color RGBA16F, [1] ocean distance R32F (-1 = sky). */
  background: WebGLRenderTarget
  /** Low-res MRT: [0] premultiplied cloud luminance + alpha, [1] mean cloud distance. */
  clouds: WebGLRenderTarget
  /** Resolved (temporal) cloud buffers at cloud resolution, ping-pong. */
  cloudHistory: [WebGLRenderTarget, WebGLRenderTarget]
  /** Final HDR (background + clouds) before exposure. */
  hdr: WebGLRenderTarget
  /** Light shaft shadow length [km], quarter resolution. */
  shafts: WebGLRenderTarget
}

function hdrTarget(width: number, height: number, count = 1): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, {
    count,
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  })
}

function makeDistanceAttachment(target: WebGLRenderTarget): void {
  const t = target.textures[1]!
  t.type = FloatType
  t.format = RedFormat
  t.minFilter = NearestFilter
  t.magFilter = NearestFilter
}

export class Pipeline {
  readonly targets: PipelineTargets
  readonly timer: GpuTimer
  readonly exposure: ExposurePass
  readonly bloom: BloomPass
  /** Fraction of light spread by the lens (glare). */
  bloomStrength = 0.04
  readonly clouds: CloudResources
  private readonly backgroundPass: FullscreenPass
  private readonly cloudsPass: FullscreenPass
  private readonly hdrPass: FullscreenPass
  private readonly resolvePass: FullscreenPass
  private readonly shaftsPass: FullscreenPass
  private shaftsEnabled = false
  private historyIndex = 0
  private historyValid = false
  /** Resolved cloud buffer size (screen × resolution scale). */
  cloudFullWidth = 1
  cloudFullHeight = 1
  private upscale: 1 | 2 | 4 = 4
  private readonly compositePass: FullscreenPass
  /** Linear water-leaving albedo ("basic ocean color"). */
  readonly oceanAlbedo = new Vector3(0.004, 0.016, 0.045)
  oceanRoughness = 0.2
  width = 1
  height = 1
  cloudWidth = 1
  cloudHeight = 1
  private preset: QualityPreset = QUALITY_PRESETS.high
  private weather: WeatherOverride = { kind: 'procedural' }

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly camera: CameraUniforms,
    private readonly atmosphere: Atmosphere,
  ) {
    this.timer = new GpuTimer(renderer)
    this.exposure = new ExposurePass(renderer)
    this.bloom = new BloomPass(renderer)
    this.clouds = new CloudResources(renderer)
    const background = hdrTarget(1, 1, 2)
    makeDistanceAttachment(background)
    const clouds = hdrTarget(1, 1, 2)
    makeDistanceAttachment(clouds)
    const history = [hdrTarget(1, 1, 2), hdrTarget(1, 1, 2)] as [WebGLRenderTarget, WebGLRenderTarget]
    for (const t of history) {
      // (distance, accumulated sample count)
      makeDistanceAttachment(t)
      t.textures[1]!.format = RGFormat
    }
    const shafts = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RedFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    })
    this.targets = { background, clouds, cloudHistory: history, hdr: hdrTarget(1, 1), shafts }

    this.backgroundPass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'Background',
        fragmentShader: shaderChunks['passes/background']!,
        chunks: atmosphere.chunks,
        uniforms: {
          ...camera.uniforms,
          ...atmosphere.uniforms,
          ...this.clouds.sunOD,
          ...this.clouds.density,
          uShadowWeatherTexel: new Uniform(this.clouds.weatherTexelLength),
          uSunDirection: new Uniform(new Vector3(1, 0, 0)),
          uShadowLength: new Uniform(shafts.texture),
          uCloudsResolved: new Uniform(history[0].textures[0]),
          uEcefToCelestial: new Uniform(new Matrix3()),
          uShaftDistance: new Uniform(150_000),
          uOceanAlbedo: new Uniform(this.oceanAlbedo),
          uOceanRoughness: new Uniform(this.oceanRoughness),
        },
      }),
    )
    this.cloudsPass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'Clouds',
        fragmentShader: shaderChunks['passes/clouds']!,
        chunks: atmosphere.chunks,
        uniforms: {
          ...camera.uniforms,
          ...atmosphere.uniforms,
          ...this.clouds.density,
          ...this.clouds.sunOD,
          uSunDirection: new Uniform(new Vector3(1, 0, 0)),
          uGroupC: new Uniform(new Vector4()),
          uStepScale: new Uniform(0.01),
          uMinStep: new Uniform(50),
          uMaxStep: new Uniform(600),
          uMinTransmittance: new Uniform(0.01),
          uWeatherTexel: new Uniform(this.clouds.weatherTexelLength),
          uFrame: new Uniform(0),
          uJitterAmount: new Uniform(1),
          uFullResolution: new Uniform(new Vector2(1, 1)),
          uSampleOffset: new Uniform(new Vector2(0.5, 0.5)),
          uUpscale: new Uniform(4),
        },
      }),
    )
    this.shaftsPass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'LightShafts',
        fragmentShader: shaderChunks['passes/lightShafts']!,
        uniforms: {
          ...camera.uniforms,
          ...this.clouds.density,
          uResolution: new Uniform(new Vector2(1, 1)),
          uSunDirection: new Uniform(new Vector3(1, 0, 0)),
          // Long enough to reach the sea horizon from low altitude, so the
          // shadowed fraction covers whole ocean rays (no band at the range end).
          uMaxDistance: new Uniform(150_000),
          uFrame: new Uniform(0),
        },
      }),
    )
    this.resolvePass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'CloudsResolve',
        fragmentShader: shaderChunks['clouds/resolve']!,
        uniforms: {
          ...camera.uniforms,
          // The resolve runs at cloud resolution, not screen resolution.
          uResolution: new Uniform(new Vector2(1, 1)),
          uCurrent: new Uniform(clouds.textures[0]),
          uCurrentDepth: new Uniform(clouds.textures[1]),
          uHistory: new Uniform(history[0].textures[0]),
          uHistoryDepth: new Uniform(history[0].textures[1]),
          uPrevShadingToView: new Uniform(new Matrix3()),
          uCameraDelta: new Uniform(new Vector3()),
          uUpscale: new Uniform(4),
          uSampleOffset: new Uniform(new Vector2(0.5, 0.5)),
          uBlend: new Uniform(0.1),
          uFreshBlend: new Uniform(0.35),
          uGamma: new Uniform(2),
          uHistoryValid: new Uniform(0),
        },
      }),
    )
    this.hdrPass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'CompositeHdr',
        fragmentShader: shaderChunks['passes/compositeHdr']!,
        uniforms: {
          uBackground: new Uniform(background.textures[0]),
          uClouds: new Uniform(clouds.textures[0]),
          uCloudsEnabled: new Uniform(1),
          uSize: new Uniform(new Vector2(1, 1)),
        },
      }),
    )
    this.compositePass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'Composite',
        fragmentShader: shaderChunks['passes/composite']!,
        uniforms: {
          uHdr: new Uniform(this.targets.hdr.texture),
          uExposureEv: new Uniform(this.exposure.texture),
          uManualEv: new Uniform(15),
          uAutoExposure: new Uniform(1),
          uWhitePoint: new Uniform(new Vector3(...SOLAR_WHITE_POINT)),
          uOutputSize: new Uniform(new Vector2(1, 1)),
          uFrame: new Uniform(0),
          uBloom: new Uniform<import('three').Texture | null>(null),
          uBloomStrength: new Uniform(0.04),
        },
      }),
    )
  }

  /** Bakes procedural cloud textures; call once after construction. */
  init(seed = 1): void {
    this.clouds.bakeStatic(seed)
  }

  setWeather(w: WeatherOverride): void {
    this.weather = w
    this.clouds.setWeather(w)
    this.historyValid = false
  }

  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.targets.background.setSize(width, height)
    this.targets.hdr.setSize(width, height)
    this.targets.shafts.setSize(Math.max(1, Math.ceil(width / 4)), Math.max(1, Math.ceil(height / 4)))
    this.bloom.setSize(width, height)
    this.resizeClouds()
  }

  private resizeClouds(): void {
    const k = this.preset.temporalUpscale
    this.upscale = k
    this.cloudFullWidth = Math.max(1, Math.round(this.width * this.preset.resolutionScale))
    this.cloudFullHeight = Math.max(1, Math.round(this.height * this.preset.resolutionScale))
    this.cloudWidth = Math.ceil(this.cloudFullWidth / k)
    this.cloudHeight = Math.ceil(this.cloudFullHeight / k)
    this.targets.clouds.setSize(this.cloudWidth, this.cloudHeight)
    for (const t of this.targets.cloudHistory) t.setSize(this.cloudFullWidth, this.cloudFullHeight)
    this.historyValid = false
  }

  /** Invalidates temporal history (e.g. after a teleport or settings change). */
  resetHistory(): void {
    this.historyValid = false
  }

  /** Resolved cloud buffer of the latest frame. */
  get resolvedClouds(): WebGLRenderTarget {
    return this.targets.cloudHistory[this.historyIndex]!
  }

  private applyCloudSettings(s: CloudSettings): void {
    const preset = QUALITY_PRESETS[s.quality]
    if (preset !== this.preset) {
      this.preset = preset
      this.resizeClouds()
      this.clouds.setResolution(preset.weatherSize, preset.sunOpticalDepthSize)
      this.cloudsPass.material.uniforms.uWeatherTexel!.value = this.clouds.weatherTexelLength
    }
    this.clouds.setCoverage(s.coverage)
    applyDefines(
      this.cloudsPass.material,
      presetToDefines(preset, { enabled: s.enabled, physical: s.physical, shadows: s.shadows, weatherMode: this.clouds.mode }),
    )
    this.shaftsEnabled = s.enabled && s.shadows && preset.lightShaftSamples > 0 && this.weather.kind !== 'clear'
    applyDefines(this.backgroundPass.material, {
      CLOUD_REFLECTIONS: s.enabled,
      CLOUD_SHADOWS: s.enabled && s.shadows && this.weather.kind !== 'clear',
      OCEAN_SHADOW_STEPS: preset.oceanShadowSteps,
      WEATHER_MODE: this.clouds.mode,
      LIGHT_SHAFTS: this.shaftsEnabled,
    })
    applyDefines(this.shaftsPass.material, {
      WEATHER_MODE: this.clouds.mode,
      LIGHT_SHAFT_SAMPLES: Math.max(1, preset.lightShaftSamples),
    })
    this.backgroundPass.material.uniforms.uShadowWeatherTexel!.value = this.clouds.weatherTexelLength
    const u = this.cloudsPass.material.uniforms
    u.uStepScale!.value = preset.stepScale
    u.uMinStep!.value = preset.minStep
    u.uMaxStep!.value = preset.maxStep
    u.uMinTransmittance!.value = preset.minTransmittance
  }

  render(inputs: FrameInputs): void {
    const { renderer } = this
    if (!this.atmosphere.ready) {
      renderer.setRenderTarget(null)
      renderer.setClearColor(0x000000)
      renderer.clear()
      return
    }
    this.applyCloudSettings(inputs.clouds)
    const cloudsOn = inputs.clouds.enabled

    this.clouds.setCamera(this.camera.cameraShading)
    if (cloudsOn) {
      this.timer.begin('sunOpticalDepth')
      this.clouds.updateSunOpticalDepth(inputs.sunDirection)
      this.timer.end()
    }

    if (this.shaftsEnabled) {
      this.timer.begin('lightShafts')
      const l = this.shaftsPass.material.uniforms
      l.uSunDirection!.value.copy(inputs.sunDirection)
      l.uResolution!.value.set(this.targets.shafts.width, this.targets.shafts.height)
      l.uFrame!.value = inputs.frame % 1024
      this.shaftsPass.render(renderer, this.targets.shafts)
      this.timer.end()
    }

    if (cloudsOn) {
      this.timer.begin('clouds')
      const u = this.cloudsPass.material.uniforms
      u.uSunDirection!.value.copy(inputs.sunDirection)
      const g = this.clouds.density.uGroups.value
      u.uGroupC!.value.set(
        this.camera.cTerm(SHADING_EARTH_RADIUS + g.x),
        this.camera.cTerm(SHADING_EARTH_RADIUS + g.y),
        this.camera.cTerm(SHADING_EARTH_RADIUS + g.z),
        this.camera.cTerm(SHADING_EARTH_RADIUS + g.w),
      )
      u.uFrame!.value = inputs.frame % 1024
      const [ox, oy] = frameSampleOffset(inputs.frame, this.upscale)
      u.uFullResolution!.value.set(this.cloudFullWidth, this.cloudFullHeight)
      u.uSampleOffset!.value.set(ox, oy)
      u.uUpscale!.value = this.upscale
      this.cloudsPass.render(renderer, this.targets.clouds)
      this.timer.end()

      this.timer.begin('cloudsResolve')
      const prev = this.targets.cloudHistory[this.historyIndex]!
      const next = this.targets.cloudHistory[1 - this.historyIndex]!
      const r = this.resolvePass.material.uniforms
      r.uResolution!.value.set(this.cloudFullWidth, this.cloudFullHeight)
      r.uHistory!.value = prev.textures[0]
      r.uHistoryDepth!.value = prev.textures[1]
      r.uPrevShadingToView!.value.copy(this.camera.prevViewToShading).invert()
      r.uCameraDelta!.value.subVectors(this.camera.cameraShading, this.camera.prevCameraShading)
      r.uUpscale!.value = this.upscale
      r.uSampleOffset!.value.set(ox, oy)
      r.uGamma!.value = this.upscale > 1 ? 2 : 1
      r.uHistoryValid!.value = this.historyValid ? 1 : 0
      this.resolvePass.render(renderer, next)
      this.historyIndex = 1 - this.historyIndex
      this.historyValid = true
      this.timer.end()
      this.hdrPass.material.uniforms.uClouds!.value = next.textures[0]
    } else {
      this.historyValid = false
    }

    // Background after clouds: the sea reflects the resolved clouds.
    this.timer.begin('background')
    const bg = this.backgroundPass.material.uniforms
    bg.uCloudsResolved!.value = this.resolvedClouds.textures[0]
    const theta = (gmstDegrees(inputs.utcMs) * Math.PI) / 180
    const ct = Math.cos(theta)
    const st = Math.sin(theta)
    bg.uEcefToCelestial!.value.set(ct, -st, 0, st, ct, 0, 0, 0, 1)
    bg.uSunDirection!.value.copy(inputs.sunDirection)
    bg.uOceanRoughness!.value = this.oceanRoughness
    this.backgroundPass.render(renderer, this.targets.background)
    this.timer.end()

    this.timer.begin('compositeHdr')
    const h = this.hdrPass.material.uniforms
    h.uCloudsEnabled!.value = cloudsOn ? 1 : 0
    h.uSize!.value.set(this.width, this.height)
    this.hdrPass.render(renderer, this.targets.hdr)
    this.timer.end()

    this.timer.begin('exposure')
    this.exposure.evMin = inputs.evRange[0]
    this.exposure.evMax = inputs.evRange[1]
    this.exposure.incidentEv = inputs.incidentEv
    this.exposure.update(this.targets.hdr.texture, inputs.dt)
    this.timer.end()

    this.timer.begin('bloom')
    const bloomTexture = this.bloom.render(this.targets.hdr.texture, this.width, this.height)
    this.timer.end()

    this.timer.begin('composite')
    const c = this.compositePass.material.uniforms
    c.uBloom!.value = bloomTexture
    c.uBloomStrength!.value = this.bloomStrength
    c.uExposureEv!.value = this.exposure.texture
    c.uAutoExposure!.value = inputs.ev100 === null ? 1 : 0
    c.uManualEv!.value = inputs.ev100 ?? 15
    c.uOutputSize!.value.set(this.width, this.height)
    c.uFrame!.value = inputs.frame % 1024
    this.compositePass.render(renderer, null)
    this.timer.end()
    this.timer.poll()
  }

  dispose(): void {
    this.backgroundPass.dispose()
    this.cloudsPass.dispose()
    this.hdrPass.dispose()
    this.resolvePass.dispose()
    this.shaftsPass.dispose()
    this.compositePass.dispose()
    this.exposure.dispose()
    this.bloom.dispose()
    this.clouds.dispose()
    this.targets.background.dispose()
    this.targets.clouds.dispose()
    this.targets.cloudHistory.forEach((t) => t.dispose())
    this.targets.hdr.dispose()
    this.targets.shafts.dispose()
    this.timer.dispose()
  }
}
