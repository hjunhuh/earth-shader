import { Timer } from 'three'
import { EarthScene } from '../scene/EarthScene'
import { applyPatch, type AppState, type StatePatch } from './state'
import { ControlPanel } from './ui'
import type { TestConfig } from './urlState'

export interface EarthAppOptions {
  canvas: HTMLCanvasElement
  state: AppState
  test: TestConfig
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

  constructor({ canvas, state, test, uiContainer }: EarthAppOptions) {
    this.canvas = canvas
    this.test = test
    if (test.size) {
      canvas.style.width = `${test.size.width}px`
      canvas.style.height = `${test.size.height}px`
    }
    this.scene = new EarthScene({ canvas, state, test: test.enabled, ...(test.enabled ? { pixelRatio: test.dpr } : {}) })
    this.panel = uiContainer ? new ControlPanel(uiContainer, state, (patch) => this.update(patch)) : null
    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
  }

  get state(): AppState {
    return this.scene.getState()
  }

  update(patch: StatePatch): void {
    this.scene.setState(applyPatch(this.scene.getState(), patch))
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
  }

  get testConfig(): TestConfig {
    return this.test
  }

  dispose(): void {
    this.stop()
    this.resizeObserver.disconnect()
    this.panel?.dispose()
    this.scene.dispose()
  }
}
