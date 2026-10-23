import { Vector3, WebGLRenderer } from 'three'
import { Atmosphere } from '../atmosphere/Atmosphere'
import { autoEv100, autoEvRange } from '../render/exposure'
import { pickEllipsoid } from '../geo/intersect'
import { ecefToGeodetic, surfaceNormalAt } from '../geo/wgs84'
import { CameraUniforms } from '../camera/CameraUniforms'
import { GlobeControls } from '../camera/GlobeControls'
import { clonePose, poseToState, stateToPose, type CameraPose, type Viewport } from '../camera/pose'
import { directionToShading } from '../geo/shadingSpace'
import { Pipeline } from '../render/Pipeline'
import { ReadbackPass } from '../render/ReadbackPass'
import { sunDirectionEcef } from '../time/solar'
import { AppUI } from './ui'
import { createDefaultState, withCamera, withCloud, withTimeOfDay, type AppState } from './state'
import type { TestConfig } from './urlState'

export const FOV_Y = 50

export interface EarthAppOptions {
  canvas: HTMLCanvasElement
  uiContainer?: HTMLElement
  state?: AppState
  test?: TestConfig
}

export class EarthApp {
  readonly renderer: WebGLRenderer
  readonly pipeline: Pipeline
  readonly atmosphere: Atmosphere
  /** Last EV100 used (auto or manual). */
  ev100 = 15
  readonly cameraUniforms = new CameraUniforms()
  readonly controls: GlobeControls
  readonly ui: AppUI | null
  readonly testMode: boolean
  state: AppState
  pose: CameraPose
  frame = 0
  private readonly readback = new ReadbackPass()
  private readonly sunEcef = new Vector3()
  private readonly sunShading = new Vector3()
  private rafId = 0
  private lastTime = 0
  private uiSyncDue = 0
  private fpsFrames = 0
  private fpsTime = 0
  private readonly fixedSize: TestConfig['size']
  private resizeObserver: ResizeObserver | null = null

  constructor(private readonly opts: EarthAppOptions) {
    this.state = opts.state ?? createDefaultState()
    this.pose = stateToPose(this.state.camera)
    this.testMode = opts.test?.enabled ?? false
    this.fixedSize = opts.test?.size ?? null
    this.renderer = new WebGLRenderer({
      canvas: opts.canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: this.testMode,
    })
    this.renderer.debug.checkShaderErrors = this.testMode || import.meta.env.DEV
    this.atmosphere = new Atmosphere(this.renderer, { ozone: this.state.debug.ozone })
    if (this.testMode) this.atmosphere.initSync()
    else void this.atmosphere.init()
    this.pipeline = new Pipeline(this.renderer, this.cameraUniforms, this.atmosphere)
    this.pipeline.setWeather(this.state.debug.weather)
    this.pipeline.init(this.state.debug.seed)
    this.controls = new GlobeControls({
      element: opts.canvas,
      getPose: () => this.pose,
      getViewport: () => this.viewport,
      setPose: (p) => this.setPose(p),
    })
    this.ui = opts.uiContainer
      ? new AppUI(opts.uiContainer, {
          setLocation: (lon, lat, alt) => this.flyToLocation(lon, lat, alt),
          setView: (heading, tilt) => this.setCameraState({ ...this.state.camera, heading, tilt }),
          setTimeOfDay: (tod) => this.setTimeOfDay(tod),
          setCloud: (enabled, quality, coverage) => {
            this.state = withCloud(this.state, { enabled, quality, coverage })
          },
          setDebug: (patch) => {
            this.state = { ...this.state, debug: { ...this.state.debug, ...patch } }
          },
        })
      : null
    this.ui?.sync(this.state)
    this.resize()
    if (!this.fixedSize) {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(opts.canvas)
    }
  }

  get viewport(): Viewport {
    return { width: this.pipeline.width, height: this.pipeline.height, fovY: FOV_Y }
  }

  resize(): void {
    const canvas = this.opts.canvas
    let width: number
    let height: number
    if (this.fixedSize) {
      width = this.fixedSize.width
      height = this.fixedSize.height
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      this.renderer.setPixelRatio(1)
    } else {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      this.renderer.setPixelRatio(dpr)
      width = Math.max(1, Math.round(canvas.clientWidth * dpr))
      height = Math.max(1, Math.round(canvas.clientHeight * dpr))
    }
    this.renderer.setSize(width, height, false)
    this.pipeline.setSize(width, height)
  }

  setPose(pose: CameraPose): void {
    this.pose = clonePose(pose)
    this.state = withCamera(this.state, poseToState(this.pose))
  }

  setCameraState(camera: AppState['camera']): void {
    this.controls.stopAnimations()
    this.state = withCamera(this.state, camera)
    this.pose = stateToPose(this.state.camera)
    this.ui?.sync(this.state)
  }

  /** Google-Earth-style flight to a typed location (instant in test mode). */
  flyToLocation(lon: number, lat: number, alt: number): void {
    const target = { ...this.state.camera, lon, lat, alt }
    if (this.testMode) {
      this.setCameraState(target)
      return
    }
    const from = poseToState(this.pose)
    const dist = Math.hypot(target.lon - from.lon, target.lat - from.lat)
    const duration = Math.min(3, 0.8 + dist / 60 + Math.abs(Math.log10(Math.max(alt, 1) / Math.max(from.alt, 1))) * 0.3)
    this.controls.flyTo(stateToPose(withCamera(this.state, target).camera), duration)
  }

  setTimeOfDay(tod: number): void {
    this.state = withTimeOfDay(this.state, tod)
  }

  /** Renders one frame (also used by test hooks for deterministic stepping). */
  renderFrame(dt = 1 / 60): void {
    this.controls.update(dt)
    const vp = this.viewport
    this.cameraUniforms.update(this.pose, vp, vp.width, vp.height)
    sunDirectionEcef(this.state.utcMs, this.sunEcef)
    directionToShading(this.sunEcef, this.sunShading)
    // Incident-light EV (CPU) is shown in the UI; the image uses GPU metering.
    this.ev100 = this.state.debug.exposure ?? this.autoExposure()
    this.pipeline.exposure.tau = this.testMode ? 0 : 0.6
    this.pipeline.render({
      camera: this.cameraUniforms,
      sunDirection: this.sunShading,
      ev100: this.state.debug.exposure,
      evRange: autoEvRange(this.state.camera.alt),
      incidentEv: this.state.debug.exposure ?? this.autoExposure(),
      dt,
      frame: this.frame,
      utcMs: this.state.utcMs,
      clouds: {
        enabled: this.state.cloud.enabled,
        quality: this.state.cloud.quality,
        coverage: this.state.cloud.coverage,
        physical: this.state.debug.physical,
        shadows: this.state.debug.shadows,
      },
    })
    this.frame++
  }

  /** Sun elevation (sin) at the point the camera looks at (or its nadir). */
  sunSinElevationAtTarget(): number {
    const hit = pickEllipsoid(this.pose.position, this.pose.forward)
    const p = hit ?? this.pose.position
    const g = ecefToGeodetic(p)
    const n = g ? surfaceNormalAt(p) : p.clone().normalize()
    return n.dot(this.sunEcef)
  }

  private autoExposure(): number {
    const cpu = this.atmosphere.cpu
    if (!cpu) return 15
    return autoEv100(cpu, this.sunSinElevationAtTarget(), this.state.camera.alt)
  }

  start(): void {
    const loop = (time: number) => {
      const dt = this.lastTime ? Math.min(0.1, (time - this.lastTime) / 1000) : 1 / 60
      this.lastTime = time
      this.renderFrame(dt)
      if (time > this.uiSyncDue) {
        this.ui?.sync(this.state, this.ev100)
        this.uiSyncDue = time + 100
      }
      this.fpsFrames++
      if (time - this.fpsTime > 500) {
        const fps = (this.fpsFrames * 1000) / (time - this.fpsTime)
        this.ui?.setFps(`${fps.toFixed(0)} fps`)
        this.fpsFrames = 0
        this.fpsTime = time
      }
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  stop(): void {
    cancelAnimationFrame(this.rafId)
  }

  /**
   * Reads a rect of a pipeline texture (top-left origin, rows top-to-bottom).
   * 'hdr' = final HDR before exposure, 'background' = ocean+sky only,
   * 'distance' = ocean distance, 'clouds' = cloud buffer (cloud resolution).
   */
  readTexture(which: 'hdr' | 'background' | 'distance' | 'clouds', x: number, y: number, w: number, h: number): Float32Array {
    const t = this.pipeline.targets
    const isCloud = which === 'clouds'
    const tex =
      which === 'hdr'
        ? t.hdr.texture
        : which === 'background'
          ? t.background.textures[0]!
          : which === 'distance'
            ? t.background.textures[1]!
            : this.pipeline.resolvedClouds.textures[0]!
    const W = isCloud ? this.pipeline.cloudFullWidth : this.pipeline.width
    const H = isCloud ? this.pipeline.cloudFullHeight : this.pipeline.height
    const raw = this.readback.read2D(this.renderer, tex, W, H, { x, y: H - y - h, width: w, height: h })
    const out = new Float32Array(raw.length)
    const row = w * 4
    for (let r = 0; r < h; ++r) out.set(raw.subarray((h - 1 - r) * row, (h - r) * row), r * row)
    return out
  }

  dispose(): void {
    this.stop()
    this.resizeObserver?.disconnect()
    this.controls.dispose()
    this.ui?.dispose()
    this.readback.dispose()
    this.pipeline.dispose()
    this.atmosphere.dispose()
    this.renderer.dispose()
  }
}
