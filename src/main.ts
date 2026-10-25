import { EarthApp } from './app/EarthApp'
import { createTestApi, projectPoint } from './app/testApi'
import { parseUrl } from './app/urlState'
import { Ray, Vector3 } from 'three'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'
import './style.css'

function fail(message: string): never {
  const el = document.getElementById('error')
  if (el) {
    el.textContent = message
    el.hidden = false
  }
  throw new Error(message)
}

const probe = document.createElement('canvas').getContext('webgl2')
if (!probe) fail('WebGL2 is not available in this browser.')
if (!probe.getExtension('EXT_color_buffer_float')) fail('EXT_color_buffer_float is required.')

const parsed = parseUrl(window.location.search)
if (parsed.errors.length > 0) console.warn('[url]', parsed.errors.join('; '))

const canvas = document.getElementById('earth') as HTMLCanvasElement
const showUi = !parsed.test.enabled || parsed.test.ui
const app = new EarthApp({
  canvas,
  state: parsed.state,
  test: parsed.test,
  view: parsed.view,
  uiContainer: showUi ? (document.getElementById('ui') ?? undefined) : undefined,
})

if (parsed.test.enabled) {
  const errors = [...parsed.errors]
  window.addEventListener('error', (e) => errors.push(String(e.message)))
  const { scene } = app
  const api = createTestApi(
    {
      gl: scene.renderer,
      camera: scene.camera,
      target: scene.controls.target,
      render: () => app.renderFrames(1),
      update: () => scene.controls.update(),
      sunDirection: () => scene.sunDirection,
      dateMs: () => scene.currentDate(),
    },
    errors,
  )
  api.getState = () => structuredClone(app.state)
  api.setState = (patch) => app.set(patch)
  api.flyTo = (body, options) => scene.flyTo(body, options)
  api.focus = () => scene.focus
  api.moonPosition = () => scene.moon.position.toArray()
  api.moonView = () => scene.moonView()
  api.aim = (direction) => scene.aim(new Vector3(...(direction as [number, number, number])))
  api.projectMoon = () => projectPoint(scene.camera, scene.moon.position, api.size())
  api.terrainProgress = () => scene.terrain.loadProgress
  api.elevationAt = (lon, lat) => scene.terrain.elevationAt((lat * Math.PI) / 180, (lon * Math.PI) / 180)
  api.earthControls = () => scene.earthControls
  api.surfacePointAt = (x, y) => {
    const { width, height } = api.size()
    const c = scene.camera
    c.updateMatrixWorld()
    const direction = new Vector3((x / width) * 2 - 1, 1 - (y / height) * 2, 0.5).unproject(c).sub(c.position).normalize()
    const hit = Ellipsoid.WGS84.getIntersection(new Ray(c.position.clone(), direction))
    if (!hit) return null
    const g = new Geodetic().setFromECEF(hit)
    return [(g.longitude * 180) / Math.PI, (g.latitude * 180) / Math.PI]
  }
  window.__earth = api
  ;(window as unknown as { __earthApp: EarthApp }).__earthApp = app // internals, for debugging probes
  scene.ready
    .then(() => {
      app.renderFrames(parsed.test.frames)
      api.ready = true
    })
    .catch((error: unknown) => errors.push(String(error)))
} else {
  app.start()
}
