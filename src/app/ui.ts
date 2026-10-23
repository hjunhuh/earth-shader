import GUI from 'lil-gui'
import {
  DATE_LIMITS,
  EXPOSURE_LIMITS,
  CORONA_LIMITS,
  GLARE_LIMITS,
  LOCATION_LIMITS,
  QUALITIES,
  SUN_MODELS,
  TONE_MAPPING_MODES,
} from './defaults'
import type { AppState, StatePatch } from './state'

/**
 * Control panel. One-way: edits here change the app state; moving the camera
 * never touches these values (same as the takram story's leva panel).
 */
export class ControlPanel {
  readonly gui: GUI
  private readonly model: AppState

  constructor(container: HTMLElement, state: AppState, onChange: (patch: StatePatch) => void) {
    this.gui = new GUI({ container, title: 'Earth', width: 300 })
    this.model = structuredClone(state)
    const m = this.model

    const location = this.gui.addFolder('location')
    location.add(m.location, 'longitude', LOCATION_LIMITS.longitude.min, LOCATION_LIMITS.longitude.max)
      .onChange(() => onChange({ location: { longitude: m.location.longitude } }))
    location.add(m.location, 'latitude', LOCATION_LIMITS.latitude.min, LOCATION_LIMITS.latitude.max)
      .onChange(() => onChange({ location: { latitude: m.location.latitude } }))
    location.add(m.location, 'altitude', LOCATION_LIMITS.altitude.min, LOCATION_LIMITS.altitude.max)
      .onChange(() => onChange({ location: { altitude: m.location.altitude } }))

    const date = this.gui.addFolder('date')
    date.add(m.date, 'timeOfDay', DATE_LIMITS.timeOfDay.min, DATE_LIMITS.timeOfDay.max, DATE_LIMITS.timeOfDay.step)
      .onChange(() => onChange({ date: { timeOfDay: m.date.timeOfDay } }))
    date.add(m.date, 'dayOfYear', DATE_LIMITS.dayOfYear.min, DATE_LIMITS.dayOfYear.max, DATE_LIMITS.dayOfYear.step)
      .onChange(() => onChange({ date: { dayOfYear: m.date.dayOfYear } }))

    const cloud = this.gui.addFolder('cloud')
    cloud.add(m.cloud, 'enabled').onChange(() => onChange({ cloud: { enabled: m.cloud.enabled } }))
    cloud.add(m.cloud, 'quality', [...QUALITIES]).onChange(() => onChange({ cloud: { quality: m.cloud.quality } }))
    cloud.add(m.cloud, 'coverage', 0, 1, 0.01).onChange(() => onChange({ cloud: { coverage: m.cloud.coverage } }))
    cloud.add(m.cloud, 'animate').onChange(() => onChange({ cloud: { animate: m.cloud.animate } }))

    const sun = this.gui.addFolder('sun').close()
    sun.add(m.sun, 'model', [...SUN_MODELS]).onChange(() => onChange({ sun: { model: m.sun.model } }))
    sun.add(m.sun, 'glare', GLARE_LIMITS.min, GLARE_LIMITS.max, 0.01).onChange(() => onChange({ sun: { glare: m.sun.glare } }))
    sun.add(m.sun, 'corona', CORONA_LIMITS.min, CORONA_LIMITS.max, 0.01).onChange(() => onChange({ sun: { corona: m.sun.corona } }))

    const tone = this.gui.addFolder('tone mapping').close()
    tone.add(m.toneMapping, 'mode', [...TONE_MAPPING_MODES]).onChange(() => onChange({ toneMapping: { mode: m.toneMapping.mode } }))
    tone.add(m.toneMapping, 'exposure', EXPOSURE_LIMITS.min, EXPOSURE_LIMITS.max)
      .onChange(() => onChange({ toneMapping: { exposure: m.toneMapping.exposure } }))

    const atmosphere = this.gui.addFolder('atmosphere').close()
    atmosphere.add(m.atmosphere, 'correctAltitude')
      .onChange(() => onChange({ atmosphere: { correctAltitude: m.atmosphere.correctAltitude } }))
  }

  /** Reflect values changed programmatically (URL, test hooks). */
  sync(state: AppState): void {
    Object.assign(this.model.location, state.location)
    Object.assign(this.model.date, state.date)
    Object.assign(this.model.cloud, state.cloud)
    Object.assign(this.model.sun, state.sun)
    Object.assign(this.model.toneMapping, state.toneMapping)
    Object.assign(this.model.atmosphere, state.atmosphere)
    for (const c of this.gui.controllersRecursive()) c.updateDisplay()
  }

  dispose(): void {
    this.gui.destroy()
  }
}
