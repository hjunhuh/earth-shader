import {
  EffectComposer,
  EffectMaterial,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  type Effect,
} from 'postprocessing'
import { HalfFloatType, Matrix4, NoToneMapping, PerspectiveCamera, Quaternion, Scene, Vector3, WebGLRenderer } from 'three'
import { OrbitControls } from 'three-stdlib'
import {
  AerialPerspectiveEffect,
  aerialPerspectiveEffectOptionsDefaults,
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI,
  PrecomputedTexturesGenerator,
} from '@takram/three-atmosphere'
import { CloudsEffect, type CloudsEffectChangeEvent } from '@takram/three-clouds'
import { Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import { DitheringEffect, LensFlareEffect } from '@takram/three-geospatial-effects'
import { applyLocation } from '../app/applyLocation'
import { CAMERA, CLOUD_SHADOW_MAX_FAR, CONTROLS, type Quality, type ToneMappingName } from '../app/defaults'
import { localDateMs } from '../app/localDate'
import { Spring } from '../app/spring'
import type { AppState } from '../app/state'
import { loadCloudAssets, type CloudAssets } from './assets'
import { Ocean } from './Ocean'
import { clipPlanes } from './oceanMath'
import { groupEffects } from './passes'
import { applySpaceViewFix } from './spaceViewFix'
import { SunEffect } from './SunEffect'

export const TONE_MAPPING: Record<ToneMappingName, ToneMappingMode> = {
  AgX: ToneMappingMode.AGX,
  Reinhard: ToneMappingMode.REINHARD,
  Cineon: ToneMappingMode.CINEON,
  'ACES Filmic': ToneMappingMode.ACES_FILMIC,
  Linear: ToneMappingMode.LINEAR,
}

export interface EarthSceneOptions {
  canvas: HTMLCanvasElement
  state: AppState
  /** Deterministic test mode: springs jump, readable canvas. */
  test?: boolean
  /** Device pixel ratio; defaults to min(devicePixelRatio, 2) like R3F (1 in test mode). */
  pixelRatio?: number
}

/**
 * Vanilla three.js rendition of takram's "clouds/Clouds/Basic" story:
 *   <Canvas gl={{ depth: false }} camera={{ near: 1, far: 4e5 }}>
 *     <OrbitControls minDistance={1000} />            (drei → three-stdlib, damping on)
 *     <Atmosphere correctAltitude>                     (runtime-generated LUTs)
 *       <EffectComposer multisampling={0} enableNormalPass>
 *         <Clouds shadow-maxFar={1e5} coverage qualityPreset />
 *         <AerialPerspective sky sunLight skyLight />
 *         <LensFlare /> <ToneMapping mode={AGX} /> <SMAA /> <Dithering />
 * plus a plain ocean surface. Exposure 10 via renderer.toneMappingExposure.
 */
export class EarthScene {
  readonly renderer: WebGLRenderer
  readonly camera: PerspectiveCamera
  readonly controls: OrbitControls
  readonly scene = new Scene()
  readonly ocean = new Ocean()
  readonly composer: EffectComposer
  readonly generator: PrecomputedTexturesGenerator
  readonly aerialPerspective: AerialPerspectiveEffect
  readonly sun: SunEffect
  readonly lensFlare = new LensFlareEffect()
  readonly toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX })
  readonly smaa = new SMAAEffect()
  readonly dithering = new DitheringEffect()
  clouds: CloudsEffect | null = null

  readonly sunDirection = new Vector3()
  readonly moonDirection = new Vector3()
  private readonly inertialToECEF = new Matrix4()
  private readonly worldToECEF = new Matrix4() // World space is ECEF.

  private state: AppState
  private readonly test: boolean
  private readonly exposure: Spring
  private readonly dayOfYear: Spring
  private readonly timeOfDay: Spring
  private assets: CloudAssets | null = null
  private effectPasses: EffectPass[] = []
  private appliedQuality: Quality | null = null
  private appliedSunModel: AppState['sun']['model'] | null = null
  private disposed = false

  /** Resolves when the atmosphere LUTs and cloud textures are ready. */
  readonly ready: Promise<void>
  frame = 0

  constructor({ canvas, state, test = false, pixelRatio }: EarthSceneOptions) {
    this.state = state
    this.test = test

    // R3F Canvas defaults with gl={{ depth: false }}.
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      depth: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: test,
    })
    this.renderer.setPixelRatio(pixelRatio ?? (test ? 1 : Math.min(window.devicePixelRatio, 2)))
    this.renderer.toneMapping = NoToneMapping // Set by @react-three/postprocessing.

    this.camera = new PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far)
    this.camera.position.set(...CAMERA.initialPosition)

    // drei <OrbitControls> = three-stdlib OrbitControls with damping enabled.
    this.controls = new OrbitControls(this.camera)
    this.controls.enableDamping = CONTROLS.enableDamping
    this.controls.minDistance = CONTROLS.minDistance
    this.controls.connect(canvas)

    this.scene.add(this.ocean)

    this.composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType, multisampling: 0 })
    this.composer.addPass(new RenderPass(this.scene, this.camera))

    this.generator = new PrecomputedTexturesGenerator(this.renderer)
    this.aerialPerspective = applySpaceViewFix(
      new AerialPerspectiveEffect(this.camera, {
        ...aerialPerspectiveEffectOptionsDefaults,
        ...this.generator.textures,
        sky: true,
        sunLight: true,
        skyLight: true,
        correctAltitude: state.atmosphere.correctAltitude,
      }),
    )

    this.sun = new SunEffect(this.camera, {
      glare: state.sun.glare,
      corona: state.sun.corona,
      correctAltitude: state.atmosphere.correctAltitude,
    })
    this.sun.transmittanceTexture = this.generator.textures.transmittanceTexture

    this.exposure = new Spring(state.toneMapping.exposure)
    this.dayOfYear = new Spring(state.date.dayOfYear)
    this.timeOfDay = new Spring(state.date.timeOfDay)
    this.renderer.toneMappingExposure = state.toneMapping.exposure

    applyLocation(this.camera, this.controls.target, this.locationLike())
    this.applyState(state, true)

    this.ready = Promise.all([
      this.generator.update(),
      loadCloudAssets().then((assets) => {
        this.assets = assets
        if (this.clouds) this.assignCloudAssets(this.clouds)
        this.aerialPerspective.stbnTexture = assets.stbnTexture
      }),
    ]).then(() => undefined)
  }

  private locationLike() {
    const { longitude, latitude, altitude } = this.state.location
    return { longitude, latitude, height: altitude }
  }

  getState(): AppState {
    return this.state
  }

  /** Apply new panel values. Location changes move the orbit target (takram's useApplyLocation). */
  setState(next: AppState): void {
    const prev = this.state
    this.state = next
    const l0 = prev.location
    const l1 = next.location
    if (l0.longitude !== l1.longitude || l0.latitude !== l1.latitude || l0.altitude !== l1.altitude) {
      applyLocation(this.camera, this.controls.target, this.locationLike())
    }
    this.applyState(next, false)
  }

  private applyState(state: AppState, initial: boolean): void {
    const { cloud, toneMapping, date } = state
    const snap = initial || this.test
    for (const [spring, value] of [
      [this.exposure, toneMapping.exposure],
      [this.dayOfYear, date.dayOfYear],
      [this.timeOfDay, date.timeOfDay],
    ] as const) {
      if (snap) spring.snap(value)
      else spring.set(value)
    }
    this.toneMapping.mode = TONE_MAPPING[toneMapping.mode]
    this.aerialPerspective.correctAltitude = state.atmosphere.correctAltitude
    this.sun.correctAltitude = state.atmosphere.correctAltitude
    this.sun.glare = state.sun.glare
    this.sun.corona = state.sun.corona
    // The realistic sun replaces takram's sky disk.
    this.aerialPerspective.sun = state.sun.model === 'takram'
    const sunModelChanged = this.appliedSunModel !== state.sun.model
    this.appliedSunModel = state.sun.model

    // Toggling clouds remounts the effect in the story (new instance, fresh history).
    if (cloud.enabled && this.clouds == null) {
      this.clouds = this.createClouds()
      this.appliedQuality = null
      this.rebuildPasses()
    } else if (!cloud.enabled && this.clouds != null) {
      this.clouds.dispose()
      this.clouds = null
      this.aerialPerspective.overlay = null
      this.aerialPerspective.shadow = null
      this.aerialPerspective.shadowLength = null
      this.rebuildPasses()
    } else if (initial || sunModelChanged) {
      this.rebuildPasses()
    }
    if (this.clouds) {
      const clouds = this.clouds
      // The preset is a write-only setter that R3F applies only when the prop changes.
      if (this.appliedQuality !== cloud.quality) {
        clouds.qualityPreset = cloud.quality
        this.appliedQuality = cloud.quality
      }
      clouds.coverage = cloud.coverage
      clouds.correctAltitude = state.atmosphere.correctAltitude
      clouds.localWeatherVelocity.set(cloud.animate ? 0.001 : 0, 0)
    }
  }

  private createClouds(): CloudsEffect {
    const clouds = new CloudsEffect(this.camera)
    Object.assign(clouds, this.generator.textures)
    clouds.shadow.maxFar = CLOUD_SHADOW_MAX_FAR
    clouds.events.addEventListener('change', (event: CloudsEffectChangeEvent) => {
      if (this.clouds !== clouds) return
      switch (event.property) {
        case 'atmosphereOverlay':
          this.aerialPerspective.overlay = clouds.atmosphereOverlay
          break
        case 'atmosphereShadow':
          this.aerialPerspective.shadow = clouds.atmosphereShadow
          break
        case 'atmosphereShadowLength':
          this.aerialPerspective.shadowLength = clouds.atmosphereShadowLength
          break
        default:
      }
    })
    if (this.assets) this.assignCloudAssets(clouds)
    return clouds
  }

  private assignCloudAssets(clouds: CloudsEffect): void {
    const a = this.assets!
    clouds.localWeatherTexture = a.localWeatherTexture
    clouds.shapeTexture = a.shapeTexture
    clouds.shapeDetailTexture = a.shapeDetailTexture
    clouds.turbulenceTexture = a.turbulenceTexture
    clouds.stbnTexture = a.stbnTexture
  }

  private rebuildPasses(): void {
    for (const pass of this.effectPasses) {
      this.composer.removePass(pass)
      // Detach the effects first: EffectPass.dispose() would dispose them too.
      ;(pass as unknown as { setEffects(effects: Effect[]): void }).setEffects([])
      pass.dispose()
    }
    const effects: Effect[] = [
      ...(this.clouds ? [this.clouds] : []),
      this.aerialPerspective,
      ...(this.state.sun.model === 'realistic' ? [this.sun] : []),
      this.lensFlare,
      this.toneMapping,
      this.smaa,
      this.dithering,
    ]
    this.effectPasses = groupEffects(effects).map((group) => new EffectPass(this.camera, ...group))
    for (const pass of this.effectPasses) this.composer.addPass(pass)
  }

  setSize(width: number, height: number): void {
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.composer.setSize(width, height)
  }

  /** The story's PointOfView: heading/pitch in degrees around the orbit target. */
  setPointOfView(headingDeg: number, pitchDeg: number, distance: number): void {
    const quaternion = new Quaternion()
    new PointOfView(distance, radians(headingDeg), radians(pitchDeg)).decompose(
      this.controls.target,
      this.camera.position,
      quaternion,
      this.camera.up,
    )
    this.camera.quaternion.copy(quaternion)
    this.controls.update()
  }

  /** The date fed to the atmosphere this frame (ms since epoch). */
  currentDate(): number {
    return localDateMs(this.state.location.longitude, this.dayOfYear.value, this.timeOfDay.value)
  }

  private readonly geodetic = new Geodetic()

  private updateClipPlanes(): void {
    let altitude = 0
    try {
      altitude = this.geodetic.setFromECEF(this.camera.position).height
    } catch {
      altitude = 0
    }
    const { near, far } = clipPlanes(altitude, CAMERA)
    if (near !== this.camera.near || far !== this.camera.far) {
      this.camera.near = near
      this.camera.far = far
      this.camera.updateProjectionMatrix()
      for (const pass of this.effectPasses) {
        if (pass.fullscreenMaterial instanceof EffectMaterial) pass.fullscreenMaterial.adoptCameraSettings(this.camera)
      }
    }
  }

  /** One frame in the story's useFrame order: controls, atmosphere/date, exposure, composer. */
  render(delta: number): void {
    if (this.disposed) return
    this.controls.update()
    this.updateClipPlanes()

    const exposure = this.exposure.step(delta)
    this.dayOfYear.step(delta)
    this.timeOfDay.step(delta)

    const date = this.currentDate()
    getECIToECEFRotationMatrix(date, this.inertialToECEF)
    getSunDirectionECI(date, this.sunDirection).applyMatrix4(this.inertialToECEF)
    getMoonDirectionECI(date, this.moonDirection).applyMatrix4(this.inertialToECEF)

    const ap = this.aerialPerspective
    ap.sunDirection.copy(this.sunDirection)
    ap.moonDirection.copy(this.moonDirection)
    ap.worldToECEFMatrix.copy(this.worldToECEF)
    if (this.clouds) {
      this.clouds.sunDirection.copy(this.sunDirection)
      this.clouds.worldToECEFMatrix.copy(this.worldToECEF)
    }
    this.sun.sunDirection.copy(this.sunDirection)
    this.sun.overlayMap = this.clouds?.atmosphereOverlay?.map ?? null
    this.renderer.toneMappingExposure = exposure

    this.ocean.update(this.camera)
    this.composer.render(delta)
    this.frame++
  }

  dispose(): void {
    this.disposed = true
    this.controls.dispose()
    this.clouds?.dispose()
    this.sun.dispose()
    this.composer.dispose()
    this.generator.dispose()
    this.renderer.dispose()
  }
}
