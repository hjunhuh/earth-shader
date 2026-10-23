import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  Uniform,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGL3DRenderTarget,
  WebGLCubeRenderTarget,
  type RawShaderMaterial,
  type Texture,
  type WebGLRenderer,
} from 'three'
import type { WeatherOverride } from '../app/state'
import { directionToShading } from '../geo/shadingSpace'
import { FullscreenPass, createFullscreenMaterial } from '../render/FullscreenPass'
import { applyDefines, shaderChunks } from '../render/shaderLib'
import { DEFAULT_LAYERS, packIntervals, packLayers, type CloudLayer } from './layers'
import { syntheticWeatherUniforms, weatherMode } from './weather'

/** Shared uniforms of clouds/density.glsl (same Uniform objects in every material). */
export function createDensityUniforms() {
  return {
    uWeather: new Uniform<Texture | null>(null),
    uCoverage: new Uniform(0.5),
    uMinHeights: new Uniform(new Vector4()),
    uMaxHeights: new Uniform(new Vector4()),
    uDensityScales: new Uniform(new Vector4()),
    uShapeAmounts: new Uniform(new Vector4()),
    uDetailAmounts: new Uniform(new Vector4()),
    uWeatherExponents: new Uniform(new Vector4()),
    uShapeAlteringBiases: new Uniform(new Vector4()),
    uCoverageFilterWidths: new Uniform(new Vector4()),
    uProfileExpTerms: new Uniform(new Vector4()),
    uProfileExponents: new Uniform(new Vector4()),
    uProfileLinearTerms: new Uniform(new Vector4()),
    uProfileConstantTerms: new Uniform(new Vector4()),
    uShadowMask: new Uniform(new Vector4()),
    uShell: new Uniform(new Vector2()),
    uSynthParams: new Uniform(new Vector4()),
    uSynthCenter: new Uniform(new Vector3()),
    /** Merged layer intervals (min0, max0, min1, max1) for gap skipping. */
    uGroups: new Uniform(new Vector4()),
    uGroupCount: new Uniform(1),
    uShape: new Uniform<Texture | null>(null),
    uDetail: new Uniform<Texture | null>(null),
    uShapePeriod: new Uniform(SHAPE_PERIOD),
    uDetailPeriod: new Uniform(DETAIL_PERIOD),
    uShapeOffset: new Uniform(new Vector3()),
    uDetailOffset: new Uniform(new Vector3()),
    uCameraShadingDensity: new Uniform(new Vector3()),
  }
}

/** Shape noise period: cells of ~1.5–3 km (cumulus scale). */
export const SHAPE_PERIOD = 12_000
/** Detail noise period: ~0.2–0.5 km features. */
export const DETAIL_PERIOD = 1_800

/** fract(v / period) per component in float64 (keeps GPU noise coordinates small). */
export function noiseOffset(v: Vector3, period: number, out = new Vector3()): Vector3 {
  const f = (x: number) => {
    const q = x / period
    return q - Math.floor(q)
  }
  return out.set(f(v.x), f(v.y), f(v.z))
}
export type DensityUniforms = ReturnType<typeof createDensityUniforms>

export const OD_HEIGHTS_DEFAULT = new Vector4(0, 750, 2200, 7500)

/**
 * GPU resources for clouds: the global weather cubemap, 3D shape/detail
 * noise, and the sun optical depth cubemap (re-baked when the sun moves
 * more than 0.05° or the weather changes).
 */
export class CloudResources {
  readonly density = createDensityUniforms()
  readonly sunOD = { uSunOD: new Uniform<Texture | null>(null), uOdHeights: new Uniform(OD_HEIGHTS_DEFAULT.clone()) }
  weather: WebGLCubeRenderTarget
  shape: WebGL3DRenderTarget
  detail: WebGL3DRenderTarget
  sunODTarget: WebGLCubeRenderTarget
  mode: 0 | 1 | 2 | 3 = 0
  private readonly pass: FullscreenPass
  private readonly materials: Record<string, RawShaderMaterial>
  private lastSun = new Vector3()
  private sunODDirty = true
  private weatherSize: number
  private odSize: number
  private baked = false

  constructor(
    private readonly renderer: WebGLRenderer,
    options: { weatherSize?: number; sunOpticalDepthSize?: number; layers?: readonly CloudLayer[] } = {},
  ) {
    this.weatherSize = options.weatherSize ?? 1024
    this.odSize = options.sunOpticalDepthSize ?? 256
    this.weather = this.createWeatherTarget(this.weatherSize)
    this.sunODTarget = this.createODTarget(this.odSize)
    const mk3d = (size: number) => {
      const t = new WebGL3DRenderTarget(size, size, size, {
        type: UnsignedByteType,
        format: RGBAFormat,
        // Mip chain generated manually after baking (see generate3DMipmaps).
        minFilter: LinearMipmapLinearFilter,
        magFilter: LinearFilter,
        depthBuffer: false,
        generateMipmaps: false,
      })
      t.texture.wrapS = RepeatWrapping
      t.texture.wrapT = RepeatWrapping
      t.texture.wrapR = RepeatWrapping
      return t
    }
    this.shape = mk3d(128)
    this.detail = mk3d(32)
    const common = { uFace: { value: 0 }, uLayer: { value: 0 }, uSize: { value: 1 }, uSeed: { value: 1 } }
    this.materials = {
      weather: createFullscreenMaterial({ name: 'WeatherBake', fragmentShader: shaderChunks['bake/weatherCube']!, uniforms: { ...common } }),
      shape: createFullscreenMaterial({ name: 'ShapeBake', fragmentShader: shaderChunks['bake/shape']!, uniforms: { ...common } }),
      detail: createFullscreenMaterial({ name: 'DetailBake', fragmentShader: shaderChunks['bake/detail']!, uniforms: { ...common } }),
      sunOD: createFullscreenMaterial({
        name: 'SunODBake',
        fragmentShader: shaderChunks['bake/sunOpticalDepth']!,
        uniforms: {
          ...common,
          ...this.density,
          uSunDirection: new Uniform(new Vector3(1, 0, 0)),
          uHeights: this.sunOD.uOdHeights,
          uSteps: new Uniform(16),
        },
      }),
    }
    this.pass = new FullscreenPass(this.materials.weather!)
    this.setLayers(options.layers ?? DEFAULT_LAYERS)
    this.density.uWeather.value = this.weather.texture
    this.density.uShape.value = this.shape.texture
    this.density.uDetail.value = this.detail.texture
    this.sunOD.uSunOD.value = this.sunODTarget.texture
  }

  /** Builds the 3D mip chains (shape/detail) so distant erosion averages out. */
  private generate3DMipmaps(): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext
    for (const t of [this.shape.texture, this.detail.texture]) {
      const handle = (this.renderer.properties.get(t) as { __webglTexture?: WebGLTexture }).__webglTexture
      if (!handle) continue
      gl.bindTexture(gl.TEXTURE_3D, handle)
      gl.generateMipmap(gl.TEXTURE_3D)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.bindTexture(gl.TEXTURE_3D, null)
    }
    this.renderer.resetState()
  }

  /** Updates the float64 noise offsets for the current camera (shading space). */
  setCamera(cameraShading: Vector3): void {
    noiseOffset(cameraShading, SHAPE_PERIOD, this.density.uShapeOffset.value)
    noiseOffset(cameraShading, DETAIL_PERIOD, this.density.uDetailOffset.value)
    this.density.uCameraShadingDensity.value.copy(cameraShading)
  }

  private createWeatherTarget(size: number): WebGLCubeRenderTarget {
    return new WebGLCubeRenderTarget(size, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    })
  }

  private createODTarget(size: number): WebGLCubeRenderTarget {
    return new WebGLCubeRenderTarget(size, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    })
  }

  setLayers(layers: readonly CloudLayer[]): void {
    const p = packLayers(layers)
    const d = this.density
    d.uMinHeights.value.copy(p.minHeights)
    d.uMaxHeights.value.copy(p.maxHeights)
    d.uDensityScales.value.copy(p.densityScales)
    d.uShapeAmounts.value.copy(p.shapeAmounts)
    d.uDetailAmounts.value.copy(p.detailAmounts)
    d.uWeatherExponents.value.copy(p.weatherExponents)
    d.uShapeAlteringBiases.value.copy(p.shapeAlteringBiases)
    d.uCoverageFilterWidths.value.copy(p.coverageFilterWidths)
    d.uProfileExpTerms.value.copy(p.profileExpTerms)
    d.uProfileExponents.value.copy(p.profileExponents)
    d.uProfileLinearTerms.value.copy(p.profileLinearTerms)
    d.uProfileConstantTerms.value.copy(p.profileConstantTerms)
    d.uShadowMask.value.copy(p.shadowMask)
    d.uShell.value.set(p.shellMin, p.shellMax)
    // Groups = merged intervals; with one gap there are two groups.
    const { shell, gaps } = packIntervals(layers)
    if (gaps.length === 0) {
      d.uGroups.value.set(shell.min, shell.max, shell.max, shell.max)
      d.uGroupCount.value = 1
    } else {
      d.uGroups.value.set(shell.min, gaps[0]!.min, gaps[0]!.max, shell.max)
      d.uGroupCount.value = 2
    }
    this.sunODDirty = true
  }

  /** Synthetic weather for measured tests; adjusts the shell and OD reference heights. */
  setWeather(w: WeatherOverride): void {
    this.mode = weatherMode(w)
    const { params, center } = syntheticWeatherUniforms(w)
    this.density.uSynthParams.value.copy(params)
    this.density.uSynthCenter.value.copy(directionToShading(new Vector3(center.x, center.y, center.z)))
    if (w.kind === 'slab' || w.kind === 'blob') {
      this.density.uShell.value.set(w.bottom, w.top)
      this.density.uGroups.value.set(w.bottom, w.top, w.top, w.top)
      this.density.uGroupCount.value = 1
      this.density.uShadowMask.value.set(1, 0, 0, 0)
      this.sunOD.uOdHeights.value.set(0, w.bottom, (w.bottom + w.top) / 2, w.top)
    } else {
      this.setLayers(DEFAULT_LAYERS)
      this.sunOD.uOdHeights.value.copy(OD_HEIGHTS_DEFAULT)
    }
    applyDefines(this.materials.sunOD!, { WEATHER_MODE: this.mode })
    this.sunODDirty = true
  }

  setCoverage(coverage: number): void {
    if (this.density.uCoverage.value !== coverage) {
      this.density.uCoverage.value = coverage
      this.sunODDirty = true
    }
  }

  private renderFace(name: string, target: WebGLCubeRenderTarget | WebGL3DRenderTarget, layer: number, size: number, extra: Record<string, unknown> = {}): void {
    const mat = this.materials[name]!
    mat.uniforms.uFace!.value = layer
    mat.uniforms.uLayer!.value = layer
    mat.uniforms.uSize!.value = size
    for (const [k, v] of Object.entries(extra)) mat.uniforms[k]!.value = v
    this.pass.setMaterial(mat)
    this.pass.render(this.renderer, target as never, layer)
  }

  /** Bakes weather and noise textures (once). */
  bakeStatic(seed = 1): void {
    for (let f = 0; f < 6; ++f) this.renderFace('weather', this.weather, f, this.weatherSize, { uSeed: seed })
    for (let z = 0; z < 128; ++z) this.renderFace('shape', this.shape, z, 128)
    for (let z = 0; z < 32; ++z) this.renderFace('detail', this.detail, z, 32)
    this.generate3DMipmaps()
    this.baked = true
    this.sunODDirty = true
  }

  /** Re-bakes the sun optical depth cubemap when the sun moved > 0.05° or settings changed. */
  updateSunOpticalDepth(sunShading: Vector3, force = false): boolean {
    if (!this.baked) return false
    const moved = this.lastSun.lengthSq() === 0 || this.lastSun.angleTo(sunShading) > (0.05 * Math.PI) / 180
    if (!force && !moved && !this.sunODDirty) return false
    this.materials.sunOD!.uniforms.uSunDirection!.value.copy(sunShading)
    for (let f = 0; f < 6; ++f) this.renderFace('sunOD', this.sunODTarget, f, this.odSize)
    this.lastSun.copy(sunShading)
    this.sunODDirty = false
    return true
  }

  setResolution(weatherSize: number, odSize: number): void {
    if (weatherSize !== this.weatherSize) {
      this.weather.dispose()
      this.weatherSize = weatherSize
      this.weather = this.createWeatherTarget(weatherSize)
      this.density.uWeather.value = this.weather.texture
      if (this.baked) for (let f = 0; f < 6; ++f) this.renderFace('weather', this.weather, f, weatherSize)
      this.sunODDirty = true
    }
    if (odSize !== this.odSize) {
      this.sunODTarget.dispose()
      this.odSize = odSize
      this.sunODTarget = this.createODTarget(odSize)
      this.sunOD.uSunOD.value = this.sunODTarget.texture
      this.sunODDirty = true
    }
  }

  get weatherTexelLength(): number {
    return (6378137 * (Math.PI / 2)) / this.weatherSize
  }

  dispose(): void {
    this.pass.dispose()
    for (const m of Object.values(this.materials)) m.dispose()
    this.weather.dispose()
    this.shape.dispose()
    this.detail.dispose()
    this.sunODTarget.dispose()
  }
}
