import { EarthApp } from './app/EarthApp'
import { createTestApi } from './app/testApi'
import { parseUrl } from './app/urlState'
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
  window.__earth = api
  scene.ready
    .then(() => {
      app.renderFrames(parsed.test.frames)
      api.ready = true
    })
    .catch((error: unknown) => errors.push(String(error)))
} else {
  app.start()
}
