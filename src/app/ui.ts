import GUI, { type Controller } from 'lil-gui'
import { QUALITIES, getTimeOfDay, type AppState, type Quality } from './state'

export interface UiCallbacks {
  setLocation(lon: number, lat: number, altitude: number): void
  setView(heading: number, tilt: number): void
  setTimeOfDay(tod: number): void
  setCloud(enabled: boolean, quality: Quality, coverage: number): void
  setDebug(patch: { exposure?: number | null; wind?: number; physical?: boolean }): void
}

/**
 * lil-gui panels: location {long, lat, altitude}, date {timeofday},
 * cloud {enabled, quality}, plus a collapsed debug folder. Two-way bound:
 * edits call back into the app, and sync() refreshes the displayed values.
 */
export class AppUI {
  readonly gui: GUI
  private readonly model = {
    location: { long: 0, lat: 0, altitude: 0 },
    date: { timeofday: 8 },
    cloud: { enabled: true, quality: 'high' as Quality },
    debug: { heading: 0, tilt: 0, autoExposure: true, ev: 15, coverage: 0.5, wind: 0, physical: false, fps: '' },
  }
  private readonly controllers: Controller[] = []
  private syncing = false
  private readonly fpsController: Controller

  constructor(container: HTMLElement, cb: UiCallbacks) {
    this.gui = new GUI({ container, title: 'Earth' })
    const m = this.model
    const guard = (fn: () => void) => () => {
      if (!this.syncing) fn()
    }

    const loc = this.gui.addFolder('location')
    const setLoc = guard(() => cb.setLocation(m.location.long, m.location.lat, m.location.altitude))
    this.controllers.push(
      loc.add(m.location, 'long', -180, 180, 0.0001).onFinishChange(setLoc),
      loc.add(m.location, 'lat', -89.9, 89.9, 0.0001).onFinishChange(setLoc),
      loc.add(m.location, 'altitude').name('altitude (m)').onFinishChange(setLoc),
    )

    const date = this.gui.addFolder('date')
    this.controllers.push(
      date.add(m.date, 'timeofday', 0, 24, 0.01).onChange(guard(() => cb.setTimeOfDay(m.date.timeofday))),
    )

    const cloud = this.gui.addFolder('cloud')
    const setCloud = guard(() => cb.setCloud(m.cloud.enabled, m.cloud.quality, m.debug.coverage))
    this.controllers.push(
      cloud.add(m.cloud, 'enabled').onChange(setCloud),
      cloud.add(m.cloud, 'quality', [...QUALITIES]).onChange(setCloud),
    )

    const debug = this.gui.addFolder('debug').close()
    const setView = guard(() => cb.setView(m.debug.heading, m.debug.tilt))
    const setExposure = guard(() => cb.setDebug({ exposure: m.debug.autoExposure ? null : m.debug.ev }))
    this.controllers.push(
      debug.add(m.debug, 'heading', 0, 360, 0.1).onChange(setView),
      debug.add(m.debug, 'tilt', 0, 88, 0.1).onChange(setView),
      debug.add(m.debug, 'autoExposure').onChange(setExposure),
      debug.add(m.debug, 'ev', -6, 20, 0.1).name('EV100').onChange(setExposure),
      debug.add(m.debug, 'coverage', 0, 1, 0.01).onChange(setCloud),
      debug.add(m.debug, 'wind', 0, 100, 1).name('wind (m/s)').onChange(guard(() => cb.setDebug({ wind: m.debug.wind }))),
      debug.add(m.debug, 'physical').name('physical only').onChange(guard(() => cb.setDebug({ physical: m.debug.physical }))),
    )
    this.fpsController = debug.add(m.debug, 'fps').disable()
  }

  sync(state: AppState, ev?: number): void {
    this.syncing = true
    const m = this.model
    m.location.long = Number(state.camera.lon.toFixed(5))
    m.location.lat = Number(state.camera.lat.toFixed(5))
    m.location.altitude = Math.round(state.camera.alt)
    m.date.timeofday = Number(getTimeOfDay(state).toFixed(3))
    m.cloud.enabled = state.cloud.enabled
    m.cloud.quality = state.cloud.quality
    m.debug.heading = Number(state.camera.heading.toFixed(2))
    m.debug.tilt = Number(state.camera.tilt.toFixed(2))
    m.debug.coverage = state.cloud.coverage
    m.debug.wind = state.debug.wind
    m.debug.physical = state.debug.physical
    m.debug.autoExposure = state.debug.exposure === null
    if (state.debug.exposure !== null) m.debug.ev = state.debug.exposure
    else if (ev !== undefined) m.debug.ev = Number(ev.toFixed(2))
    for (const c of this.controllers) c.updateDisplay()
    this.syncing = false
  }

  setFps(text: string): void {
    this.model.debug.fps = text
    this.fpsController.updateDisplay()
  }

  dispose(): void {
    this.gui.destroy()
  }
}
