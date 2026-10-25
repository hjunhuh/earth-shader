import GUI from 'lil-gui'
import {
  DATE_LIMITS,
  EXPOSURE_LIMITS,
  CORONA_LIMITS,
  GLARE_LIMITS,
  LOCATION_LIMITS,
  MOON_MODELS,
  QUALITIES,
  SUN_MODELS,
  TERRAIN_LIMITS,
  TONE_MAPPING_MODES,
} from './defaults'
import type { AppState, StatePatch } from './state'

/** Camera navigation hooks (not part of the app state: the camera never writes back). */
export interface NavigationHooks {
  flyTo(body: 'earth' | 'moon'): void
  /** Live readout, polled by the panel. */
  readonly info: { focus: string; altitude: string; moonDistance: string }
}

/**
 * Control panel. One-way: edits here change the app state; moving the camera
 * never touches these values (same as the takram story's leva panel).
 */
export class ControlPanel {
  readonly gui: GUI
  private readonly model: AppState

  constructor(container: HTMLElement, state: AppState, onChange: (patch: StatePatch) => void, navigation?: NavigationHooks) {
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

    const terrain = this.gui.addFolder('terrain')
    terrain.add(m.terrain, 'enabled').onChange(() => onChange({ terrain: { enabled: m.terrain.enabled } }))
    terrain.add(m.terrain, 'heightScale', TERRAIN_LIMITS.heightScale.min, TERRAIN_LIMITS.heightScale.max, 0.1)
      .name('exaggeration')
      .onChange(() => onChange({ terrain: { heightScale: m.terrain.heightScale } }))
    terrain.add(m.terrain, 'brightness', TERRAIN_LIMITS.brightness.min, TERRAIN_LIMITS.brightness.max, 0.01)
      .name('map brightness')
      .onChange(() => onChange({ terrain: { brightness: m.terrain.brightness } }))

    const sun = this.gui.addFolder('sun').close()
    sun.add(m.sun, 'model', [...SUN_MODELS]).onChange(() => onChange({ sun: { model: m.sun.model } }))
    sun.add(m.sun, 'glare', GLARE_LIMITS.min, GLARE_LIMITS.max, 0.01).onChange(() => onChange({ sun: { glare: m.sun.glare } }))
    sun.add(m.sun, 'corona', CORONA_LIMITS.min, CORONA_LIMITS.max, 0.01).onChange(() => onChange({ sun: { corona: m.sun.corona } }))

    const moon = this.gui.addFolder('moon').close()
    moon.add(m.moon, 'model', [...MOON_MODELS]).onChange(() => onChange({ moon: { model: m.moon.model } }))

    if (navigation) {
      const camera = this.gui.addFolder('camera')
      const actions = {
        'fly to moon': () => navigation.flyTo('moon'),
        'fly to earth': () => navigation.flyTo('earth'),
      }
      camera.add(actions, 'fly to moon')
      camera.add(actions, 'fly to earth')
      camera.add(navigation.info, 'focus').listen().disable()
      camera.add(navigation.info, 'altitude').listen().disable()
      camera.add(navigation.info, 'moonDistance').name('moon distance').listen().disable()
    }

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
    Object.assign(this.model.moon, state.moon)
    Object.assign(this.model.toneMapping, state.toneMapping)
    Object.assign(this.model.atmosphere, state.atmosphere)
    Object.assign(this.model.terrain, state.terrain)
    for (const c of this.gui.controllersRecursive()) c.updateDisplay()
  }

  dispose(): void {
    this.gui.destroy()
  }
}
