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
import {
  HalfFloatType,
  Matrix4,
  NoToneMapping,
  PerspectiveCamera,
  Quaternion,
  Ray,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
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
import { Ellipsoid, Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import { DitheringEffect, LensFlareEffect } from '@takram/three-geospatial-effects'
import { applyLocation } from '../app/applyLocation'
import {
  CAMERA,
  CLOUD_SHADOW_MAX_FAR,
  CONTROLS,
  GLOBE,
  TERRAIN,
  type EarthControlsName,
  type Quality,
  type ToneMappingName,
} from '../app/defaults'
import { localDateMs } from '../app/localDate'
import { Spring } from '../app/spring'
import type { AppState } from '../app/state'
import { loadCloudAssets, loadMoonAssets, type CloudAssets, type MoonAssets } from './assets'
import { applyCloudShadowFade } from './cloudShadowFade'
import { EarthGlobeControls } from './EarthGlobeControls'
import { Moon } from './Moon'
import { MoonEffect } from './MoonEffect'
import { MOON_RADIUS } from './moonModel'
import {
  createPose,
  earthNadirPose,
  flightPose,
  lookQuaternion,
  MoonControls,
  moonPoseToECEF,
  moonViewFromECEF,
  moonViewPoseFixed,
  type FlightEnds,
  type Focus,
  type MoonView,
  type Pose,
} from './navigation'
import { SceneNormalPass } from './NormalPass'
import { Ocean } from './Ocean'
import { clipPlanes, WGS84_A } from './oceanMath'
import { groupEffects } from './passes'
import { applyScatteringLutFix } from './scatteringLutFix'
import { applySpaceViewFix } from './spaceViewFix'
import { SunEffect } from './SunEffect'
import { liftAboveGround, Terrain } from './Terrain'

export const TONE_MAPPING: Record<ToneMappingName, ToneMappingMode> = {
  AgX: ToneMappingMode.AGX,
  Reinhard: ToneMappingMode.REINHARD,
  Cineon: ToneMappingMode.CINEON,
  'ACES Filmic': ToneMappingMode.ACES_FILMIC,
  Linear: ToneMappingMode.LINEAR,
}

export interface FlyToOptions {
  /** Jump there without the flight animation. */
  instant?: boolean
  /** Seconds (default 7). */
  duration?: number
  /** Moon only: the view to arrive at (degrees / meters); defaults to the sunlit side from 2 radii up. */
  longitude?: number
  latitude?: number
  altitude?: number
  heading?: number
  tilt?: number
}

interface Flight {
  to: Focus
  t: number
  duration: number
  ends: () => FlightEnds
  arrive: () => void
}

const DEG = Math.PI / 180

export interface EarthSceneOptions {
  canvas: HTMLCanvasElement
  state: AppState
  /** Deterministic test mode: springs jump, readable canvas. */
  test?: boolean
  /** Device pixel ratio; defaults to min(devicePixelRatio, 2) like R3F (1 in test mode). */
  pixelRatio?: number
  /** How the camera moves around the Earth (default 'globe'). */
  earthControls?: EarthControlsName
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
  /** The story's orbit controls (Earth focus with earthControls 'orbit'). */
  readonly controls: OrbitControls
  /** Google Earth style controls (Earth focus with earthControls 'globe'). */
  readonly globeControls: EarthGlobeControls
  readonly earthControls: EarthControlsName
  readonly scene = new Scene()
  readonly ocean = new Ocean()
  /** OpenStreetMap on real elevation; lit by the aerial perspective through `normalPass`. */
  readonly terrain: Terrain
  readonly normalPass: SceneNormalPass
  readonly composer: EffectComposer
  readonly generator: PrecomputedTexturesGenerator
  readonly aerialPerspective: AerialPerspectiveEffect
  readonly sun: SunEffect
  /** The Moon at its true position and size, and its renderer. */
  readonly moon = new Moon()
  readonly moonEffect: MoonEffect
  readonly moonControls: MoonControls
  readonly lensFlare = new LensFlareEffect()
  readonly toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX })
  readonly smaa = new SMAAEffect()
  readonly dithering = new DitheringEffect()
  clouds: CloudsEffect | null = null

  readonly sunDirection = new Vector3()
  readonly moonDirection = new Vector3()
  readonly inertialToECEF = new Matrix4()
  private readonly worldToECEF = new Matrix4() // World space is ECEF.

  private state: AppState
  private readonly test: boolean
  private readonly exposure: Spring
  private readonly dayOfYear: Spring
  private readonly timeOfDay: Spring
  private assets: CloudAssets | null = null
  private moonAssets: MoonAssets | null = null
  private effectPasses: EffectPass[] = []
  private appliedQuality: Quality | null = null
  private appliedSunModel: AppState['sun']['model'] | null = null
  private appliedMoonModel: AppState['moon']['model'] | null = null
  private focusBody: Focus = 'earth'
  private flight: Flight | null = null
  /** Where the camera left the Earth, to return to. */
  private earthPose: (Pose & { target: Vector3 }) | null = null
  private readonly canvas: HTMLCanvasElement
  private readonly onDoubleClick = (event: MouseEvent) => this.pick(event)
  private disposed = false

  /** Resolves when the atmosphere LUTs and cloud textures are ready. */
  readonly ready: Promise<void>
  frame = 0

  constructor({ canvas, state, test = false, pixelRatio, earthControls = 'globe' }: EarthSceneOptions) {
    this.state = state
    this.earthControls = earthControls
    this.test = test
    this.canvas = canvas

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
    if (earthControls === 'orbit') this.controls.connect(canvas)
    else this.controls.enabled = false

    this.scene.add(this.ocean)
    this.terrain = new Terrain({ heightScale: state.terrain.heightScale, brightness: state.terrain.brightness })
    this.scene.add(this.terrain.group)

    this.globeControls = new EarthGlobeControls(this.camera, earthControls === 'globe' ? canvas : null, this.terrain)
    this.globeControls.enabled = earthControls === 'globe'
    if (test) this.globeControls.enableDamping = false // No inertia: inputs land in the frame they're given.
    this.scene.add(this.moon)

    this.moonControls = new MoonControls(MOON_RADIUS, () => this.camera.fov * DEG)
    if (test) this.moonControls.smoothing = Infinity
    this.moonControls.connect(canvas)
    canvas.addEventListener('dblclick', this.onDoubleClick)

    this.composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType, multisampling: 0 })
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.normalPass = new SceneNormalPass(this.scene, this.camera, (object) => {
      if (object === this.ocean) return this.ocean.normalMaterial
      if (this.terrain.isTerrainMesh(object)) return this.terrain.normalMaterial(object)
      return null
    })
    this.composer.addPass(this.normalPass)

    this.generator = applyScatteringLutFix(new PrecomputedTexturesGenerator(this.renderer))
    this.aerialPerspective = applyCloudShadowFade(
      applySpaceViewFix(
        new AerialPerspectiveEffect(this.camera, {
          ...aerialPerspectiveEffectOptionsDefaults,
          ...this.generator.textures,
          sky: true,
          sunLight: true,
          skyLight: true,
          correctAltitude: state.atmosphere.correctAltitude,
        }),
      ),
    )

    this.sun = new SunEffect(this.camera, {
      glare: state.sun.glare,
      corona: state.sun.corona,
      correctAltitude: state.atmosphere.correctAltitude,
    })
    this.sun.transmittanceTexture = this.generator.textures.transmittanceTexture

    this.moonEffect = new MoonEffect(this.camera, this.moon, { correctAltitude: state.atmosphere.correctAltitude })
    this.moonEffect.transmittanceTexture = this.generator.textures.transmittanceTexture

    this.exposure = new Spring(state.toneMapping.exposure)
    this.dayOfYear = new Spring(state.date.dayOfYear)
    this.timeOfDay = new Spring(state.date.timeOfDay)
    this.renderer.toneMappingExposure = state.toneMapping.exposure

    applyLocation(this.camera, this.controls.target, this.locationLike())
    if (earthControls === 'globe') this.applyPose(this.locationNadirPose(GLOBE.initialAltitude))
    this.applyState(state, true)
    this.updateEphemeris()

    this.ready = Promise.all([
      this.generator.update(),
      loadCloudAssets().then((assets) => {
        this.assets = assets
        if (this.clouds) this.assignCloudAssets(this.clouds)
        this.aerialPerspective.stbnTexture = assets.stbnTexture
      }),
      loadMoonAssets().then((assets: MoonAssets) => {
        if (this.disposed) return
        this.moonEffect.setMaps(assets.colorTexture, assets.slopeEastTexture, assets.slopeNorthTexture)
        this.moonAssets = assets
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
      if (this.focusBody === 'earth' && this.flight == null) {
        const altitude = this.altitude('earth')
        applyLocation(this.camera, this.controls.target, this.locationLike())
        // Globe: look straight down at the new location from the same height.
        if (this.earthControls === 'globe') this.applyPose(this.locationNadirPose(altitude))
      } else {
        this.earthPose = null // Return to the new location instead.
      }
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
    // Without terrain the ocean's normal is the radial one takram falls back
    // to, so the normal pass is skipped and the render is exactly the story's.
    this.terrain.enabled = state.terrain.enabled
    this.terrain.heightScale = state.terrain.heightScale
    this.terrain.brightness = state.terrain.brightness
    this.normalPass.enabled = state.terrain.enabled
    this.aerialPerspective.normalBuffer = state.terrain.enabled ? this.normalPass.texture : null
    this.aerialPerspective.correctAltitude = state.atmosphere.correctAltitude
    this.sun.correctAltitude = state.atmosphere.correctAltitude
    this.moonEffect.correctAltitude = state.atmosphere.correctAltitude
    this.sun.glare = state.sun.glare
    this.sun.corona = state.sun.corona
    // The realistic sun replaces takram's sky disk.
    this.aerialPerspective.sun = state.sun.model === 'takram'
    // The true-scale Moon replaces takram's fixed-size sky disk.
    this.aerialPerspective.moon = state.moon.model === 'takram'
    this.sun.moonRadius = state.moon.model === 'realistic' ? MOON_RADIUS : 0
    const sunModelChanged = this.appliedSunModel !== state.sun.model || this.appliedMoonModel !== state.moon.model
    this.appliedSunModel = state.sun.model
    this.appliedMoonModel = state.moon.model

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
    const atmosphere: Effect[] = [...(this.clouds ? [this.clouds] : []), this.aerialPerspective]
    const rest: Effect[] = [
      ...(this.state.moon.model === 'realistic' ? [this.moonEffect] : []),
      ...(this.state.sun.model === 'realistic' ? [this.sun] : []),
      this.lensFlare,
      this.toneMapping,
      this.smaa,
      this.dithering,
    ]
    // The atmosphere's LUTs leave too few texture units for the Moon's maps in
    // one shader, so the Moon starts a new pass (the composite is the same).
    const groups =
      this.state.moon.model === 'realistic'
        ? [...groupEffects(atmosphere), ...groupEffects(rest)]
        : groupEffects([...atmosphere, ...rest])
    this.effectPasses = groups.map((group) => new EffectPass(this.camera, ...group))
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
    const exposure = this.exposure.step(delta)
    this.dayOfYear.step(delta)
    this.timeOfDay.step(delta)
    this.updateEphemeris()
    this.updateCamera(delta)
    this.keepAboveGround()
    this.updateClipPlanes()
    this.terrain.update(this.camera, this.renderer)
    this.ocean.visible = !this.terrain.covering

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
    this.sun.moonPosition.copy(this.moon.position)
    this.moonEffect.sunDirection.copy(this.sunDirection)
    this.moonEffect.overlayMap = this.sun.overlayMap
    this.renderer.toneMappingExposure = exposure

    this.ocean.update(this.camera)
    this.composer.render(delta)
    this.frame++
  }

  private readonly groundUp = new Vector3()

  /** Earth focus: never let the camera sink into the terrain. */
  private keepAboveGround(): void {
    if (!this.terrain.enabled || this.focusBody !== 'earth' || this.flight) return
    let height: number
    try {
      height = this.geodetic.setFromECEF(this.camera.position).height
    } catch {
      return
    }
    const ground = this.terrain.elevationAt(this.geodetic.latitude, this.geodetic.longitude)
    if (ground == null) return
    Ellipsoid.WGS84.getSurfaceNormal(this.camera.position, this.groundUp)
    if (liftAboveGround(this.camera.position, this.groundUp, height, ground, TERRAIN.minClearance)) {
      this.camera.updateMatrixWorld()
    }
  }

  /** Sun (takram's) and Moon (true position, same frame; see moonModel.ts) for the current date, ECEF. */
  private updateEphemeris(): void {
    const date = this.currentDate()
    getECIToECEFRotationMatrix(date, this.inertialToECEF)
    getSunDirectionECI(date, this.sunDirection).applyMatrix4(this.inertialToECEF)
    getMoonDirectionECI(date, this.moonDirection).applyMatrix4(this.inertialToECEF) // takram's sky disk
    this.moon.update(date, this.inertialToECEF)
  }

  // --- navigation --------------------------------------------------------------

  /** The body the camera orbits ('earth': OrbitControls around the location; 'moon': MoonControls). */
  get focus(): Focus {
    return this.focusBody
  }

  get flying(): boolean {
    return this.flight != null
  }

  /** Meters above the surface of the focused body. */
  altitude(body: Focus = this.focusBody): number {
    if (body === 'moon') return this.moon.altitudeOf(this.camera.position)
    try {
      return this.geodetic.setFromECEF(this.camera.position).height
    } catch {
      return this.camera.position.length() - WGS84_A
    }
  }

  private cameraPose(result = createPose()): Pose {
    result.position.copy(this.camera.position)
    result.quaternion.copy(this.camera.quaternion)
    result.up.copy(this.camera.up)
    return result
  }

  private applyPose(pose: Pose): void {
    this.camera.position.copy(pose.position)
    this.camera.quaternion.copy(pose.quaternion)
    this.camera.up.copy(pose.up)
    this.camera.updateMatrixWorld()
  }

  /** Straight down at the panel's location from `altitude` meters, north up. */
  private locationNadirPose(altitude: number): Pose {
    const { longitude, latitude } = this.state.location
    return earthNadirPose(longitude * DEG, latitude * DEG, altitude)
  }

  /** The default view of the panel's location (what the app starts with). */
  private defaultEarthPose(): Pose & { target: Vector3 } {
    if (this.earthControls === 'globe') {
      const target = new Vector3()
      applyLocation(new PerspectiveCamera(), target, this.locationLike())
      return { ...this.locationNadirPose(GLOBE.initialAltitude), target }
    }
    const camera = new PerspectiveCamera()
    camera.position.set(...CAMERA.initialPosition)
    const target = new Vector3()
    applyLocation(camera, target, this.locationLike())
    const offset = camera.position.clone().sub(target)
    if (offset.length() < CONTROLS.minDistance) offset.setLength(CONTROLS.minDistance)
    camera.position.copy(target).add(offset)
    camera.lookAt(target)
    return { position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(), target }
  }

  /** Default Moon view: above the point halfway between the sub-solar and sub-Earth points. */
  defaultMoonView(altitude = 2 * MOON_RADIUS): MoonView {
    const toSun = this.sunDirection.clone().applyMatrix3(this.moon.ecefToFixed)
    const toEarth = this.moon.position.clone().negate().normalize().applyMatrix3(this.moon.ecefToFixed)
    const d = toSun.add(toEarth)
    if (d.lengthSq() < 1e-6) d.copy(toEarth)
    d.normalize()
    return { longitude: Math.atan2(d.y, d.x), latitude: Math.asin(d.z), altitude, heading: 0, tilt: 0 }
  }

  /** Fly the camera to a body; it then orbits that body. */
  flyTo(body: Focus, options: FlyToOptions = {}): void {
    const leavingEarth = this.focusBody === 'earth' && this.flight == null
    if (leavingEarth && body === 'moon') this.earthPose = { ...this.cameraPose(), target: this.controls.target.clone() }
    this.controls.enabled = false
    this.globeControls.enabled = false
    this.moonControls.enabled = false

    let end: () => Pose
    let arrive: () => void
    if (body === 'moon') {
      const base = this.defaultMoonView(options.altitude)
      const view: MoonView = {
        longitude: options.longitude != null ? options.longitude * DEG : base.longitude,
        latitude: options.latitude != null ? options.latitude * DEG : base.latitude,
        altitude: base.altitude,
        heading: (options.heading ?? 0) * DEG,
        tilt: (options.tilt ?? 0) * DEG,
      }
      const fixed = moonViewPoseFixed(view, MOON_RADIUS)
      end = () => moonPoseToECEF(fixed, this.moon)
      arrive = () => {
        this.moonControls.set(view)
        this.moonControls.enabled = true
      }
    } else {
      const pose = this.earthPose ?? this.defaultEarthPose()
      end = () => pose
      arrive = () => {
        this.controls.target.copy(pose.target)
        this.applyPose(pose)
        if (this.earthControls === 'globe') {
          this.globeControls.resetState()
          this.globeControls.enabled = true
        } else {
          this.controls.enabled = true
          this.controls.update()
        }
      }
    }

    const start = this.cameraPose()
    const fromMoon = this.moon.altitudeOf(start.position) < this.altitude('earth')
    const ends = (): FlightEnds => ({
      start,
      originCenter: fromMoon ? this.moon.position.clone() : new Vector3(),
      originRadius: fromMoon ? MOON_RADIUS : WGS84_A,
      targetCenter: body === 'moon' ? this.moon.position.clone() : new Vector3(),
      end: end(),
    })
    const finish = () => {
      this.flight = null
      this.focusBody = body
      this.applyPose(end())
      arrive()
    }
    if (options.instant || this.test && options.duration == null) {
      finish()
      return
    }
    this.flight = { to: body, t: 0, duration: options.duration ?? 7, ends, arrive: finish }
  }

  private updateCamera(delta: number): void {
    const flight = this.flight
    if (flight) {
      flight.t = Math.min(1, flight.t + delta / flight.duration)
      if (flight.t >= 1) flight.arrive()
      else this.applyPose(flightPose(flight.ends(), flight.t))
      return
    }
    if (this.focusBody === 'earth') {
      if (this.earthControls === 'globe') this.globeControls.update(delta)
      else this.controls.update()
    } else {
      const view = this.moonControls.update(delta)
      this.applyPose(moonPoseToECEF(moonViewPoseFixed(view, MOON_RADIUS), this.moon))
    }
  }

  /**
   * Turn the camera to look along an ECEF direction without moving it (Earth
   * focus: the orbit target moves in front of the camera).
   */
  aim(direction: Vector3): void {
    if (this.focusBody !== 'earth' || this.flight) return
    const d = direction.clone().normalize()
    this.controls.target.copy(this.camera.position).addScaledVector(d, CONTROLS.minDistance)
    if (this.earthControls === 'globe') {
      const up = Ellipsoid.WGS84.getSurfaceNormal(this.camera.position, new Vector3())
      lookQuaternion(d, up, this.camera.quaternion)
      this.camera.up.copy(up)
      this.camera.updateMatrixWorld()
    } else {
      this.controls.update()
    }
  }

  /** Current Moon view (when orbiting the Moon), e.g. to hand a flight over. */
  moonView(): MoonView {
    return moonViewFromECEF(this.camera.position, this.camera.quaternion, this.moon, MOON_RADIUS)
  }

  /** Double-click a body to fly to it. */
  private pick(event: MouseEvent): void {
    if (this.flight) return
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    const body = this.bodyAt(ndc)
    if (body != null && body !== this.focusBody) this.flyTo(body)
  }

  /** The nearest body under a point in normalized device coordinates. */
  bodyAt(ndc: Vector2): Focus | null {
    this.camera.updateMatrixWorld()
    const direction = new Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize()
    const ray = new Ray(this.camera.position.clone(), direction)
    const hit = new Vector3()
    const moon = ray.intersectSphere(new Sphere(this.moon.position, MOON_RADIUS), hit) ? hit.distanceTo(ray.origin) : Infinity
    const earth = ray.intersectSphere(new Sphere(new Vector3(), WGS84_A), hit) ? hit.distanceTo(ray.origin) : Infinity
    if (moon === Infinity && earth === Infinity) return null
    return moon < earth ? 'moon' : 'earth'
  }

  dispose(): void {
    this.disposed = true
    this.canvas.removeEventListener('dblclick', this.onDoubleClick)
    this.moonControls.dispose()
    this.moonEffect.dispose()
    if (this.moonAssets) for (const t of Object.values(this.moonAssets)) t.dispose()
    this.controls.dispose()
    this.globeControls.dispose()
    this.clouds?.dispose()
    this.terrain.dispose()
    this.normalPass.dispose()
    this.sun.dispose()
    this.composer.dispose()
    this.generator.dispose()
    this.renderer.dispose()
  }
}
