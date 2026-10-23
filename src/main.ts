import { EarthApp } from './app/EarthApp'
import { installTestHooks } from './app/testHooks'
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

function checkWebGL2(): void {
  const probe = document.createElement('canvas').getContext('webgl2')
  if (!probe) fail('WebGL2 is not available in this browser.')
  if (!probe.getExtension('EXT_color_buffer_float')) fail('EXT_color_buffer_float is required.')
}

checkWebGL2()
const parsed = parseUrl(window.location.search)
if (parsed.errors.length > 0) console.warn('[url]', parsed.errors.join('; '))

const canvas = document.getElementById('earth') as HTMLCanvasElement
const app = new EarthApp({
  canvas,
  uiContainer: parsed.test.enabled && !parsed.test.ui ? undefined : (document.getElementById('ui') ?? undefined),
  state: parsed.state,
  test: parsed.test,
})

if (parsed.test.enabled) {
  installTestHooks(app, parsed.test.frames, parsed.errors)
} else {
  app.start()
}
