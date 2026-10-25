import { Timer } from 'three'
import { EarthScene } from '../scene/EarthScene'
import { applyPatch, type AppState, type StatePatch } from './state'
import { ControlPanel, type NavigationHooks } from './ui'
import type { StartView, TestConfig } from './urlState'

/** 1234 m, 12.3 km, 384,400 km. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '–'
  if (Math.abs(meters) < 1e4) return `${meters.toFixed(0)} m`
  if (Math.abs(meters) < 1e6) return `${(meters / 1000).toFixed(1)} km`
  return `${Math.round(meters / 1000).toLocaleString('en-US')} km`
}

export interface EarthAppOptions {
  canvas: HTMLCanvasElement
  state: AppState
  test: TestConfig
  view?: StartView
  uiContainer?: HTMLElement
}

/** Owns the scene, the panel and the render loop. */
export class EarthApp {
  readonly scene: EarthScene
  readonly panel: ControlPanel | null
  private readonly canvas: HTMLCanvasElement
  private readonly test: TestConfig
  private readonly timer = new Timer()
  private running = false
  private readonly resizeObserver: ResizeObserver
  private readonly compass: HTMLButtonElement | null
  private readonly needle: SVGElement | null
  private shownHeading = Number.NaN
  private readonly onCompass = () => this.scene.resetNorth()

  constructor({ canvas, state, test, view, uiContainer }: EarthAppOptions) {
    this.canvas = canvas
    this.test = test
    if (test.size) {
      canvas.style.width = `${test.size.width}px`
      canvas.style.height = `${test.size.height}px`
    }
    this.scene = new EarthScene({
      canvas,
      state,
      test: test.enabled,
      earthControls: view?.earthControls ?? 'globe',
      ...(test.enabled ? { pixelRatio: test.dpr } : {}),
    })
    const scene = this.scene
    const navigation: NavigationHooks = {
      flyTo: (body) => scene.flyTo(body),
      info: {
        get focus() {
          return scene.flying ? 'flying…' : scene.focus
        },
        get altitude() {
          return formatDistance(scene.altitude())
        },
        get moonDistance() {
          return formatDistance(scene.camera.position.distanceTo(scene.moon.position))
        },
      },
    }
    this.panel = uiContainer ? new ControlPanel(uiContainer, state, (patch) => this.update(patch), navigation) : null
    if (view?.focus === 'moon') {
      const { altitude, longitude, latitude, heading, tilt } = view
      scene.flyTo('moon', { instant: true, altitude, longitude, latitude, heading, tilt })
    }
    this.showAttribution()
    // The compass: its needle points north on screen; a click turns north up.
    this.compass = document.getElementById('compass') as HTMLButtonElement | null
    this.needle = this.compass?.querySelector<SVGElement>('.needle') ?? null
    this.compass?.addEventListener('click', this.onCompass)
    this.updateCompass()
    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
  }

  get state(): AppState {
    return this.scene.getState()
  }

  update(patch: StatePatch): void {
    this.scene.setState(applyPatch(this.scene.getState(), patch))
    this.showAttribution()
  }

  /** The map and elevation credits, required by their licenses while the terrain shows. */
  private showAttribution(): void {
    const el = document.getElementById('attribution')
    if (el) el.hidden = !this.state.terrain.enabled
  }

  /** Programmatic change that the panel should also show. */
  set(patch: StatePatch): void {
    this.update(patch)
    this.panel?.sync(this.state)
  }

  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth)
    const height = Math.max(1, this.canvas.clientHeight)
    this.scene.setSize(width, height)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.timer.connect(document) // Pauses the delta while the tab is hidden.
    this.timer.reset()
    this.scene.renderer.setAnimationLoop((timestamp) => {
      this.timer.update(timestamp)
      this.scene.render(this.timer.getDelta())
      this.updateCompass()
    })
  }

  stop(): void {
    this.running = false
    this.scene.renderer.setAnimationLoop(null)
    this.timer.disconnect()
  }

  /** Deterministic frames for tests (fixed 60 Hz delta). */
  renderFrames(count: number, delta = 1 / 60): void {
    for (let i = 0; i < count; ++i) this.scene.render(delta)
    this.updateCompass()
  }

  private updateCompass(): void {
    if (!this.compass || !this.needle) return
    this.compass.disabled = this.scene.flying
    const degrees = (this.scene.heading() * 180) / Math.PI
    if (Math.abs(degrees - this.shownHeading) < 0.05) return
    this.shownHeading = degrees
    // Heading is clockwise from north, so north sits that far counterclockwise from screen-up.
    this.needle.style.transform = `rotate(${-degrees}deg)`
  }

  get testConfig(): TestConfig {
    return this.test
  }

  dispose(): void {
    this.stop()
    this.resizeObserver.disconnect()
    this.compass?.removeEventListener('click', this.onCompass)
    this.panel?.dispose()
    this.scene.dispose()
  }
}
