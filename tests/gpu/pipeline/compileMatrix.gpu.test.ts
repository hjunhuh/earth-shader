import { afterAll, describe, expect, it } from 'vitest'
import { EarthApp } from '../../../src/app/EarthApp'
import { QUALITIES, createDefaultState, type WeatherOverride } from '../../../src/app/state'

/**
 * Every shader program the pipeline can build must compile and link: all
 * quality presets × clouds on/off × weather modes × physical/shadow flags.
 */
const canvas = document.createElement('canvas')
document.body.appendChild(canvas)
const app = new EarthApp({ canvas, state: createDefaultState(), test: { enabled: true, frames: 1, size: { width: 96, height: 64 }, ui: false } })
const errors: string[] = []
app.renderer.debug.onShaderError = (gl, program, vs, fs) => {
  errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join('\n').slice(0, 2000))
}
afterAll(() => {
  app.dispose()
  app.renderer.forceContextLoss()
})

const weathers: WeatherOverride[] = [
  { kind: 'procedural' },
  { kind: 'clear' },
  { kind: 'slab', tau: 10, bottom: 1000, top: 2000 },
  { kind: 'blob', lat: 0, lon: 0, bottom: 1000, top: 2500, radius: 2000 },
]

describe('shader compile matrix', () => {
  it('compiles and links every program for all presets, cloud toggles, weather modes and flags', () => {
    const gl = app.renderer.getContext()
    for (const weather of weathers) {
      app.pipeline.setWeather(weather)
      for (const quality of QUALITIES) {
        for (const enabled of [true, false]) {
          for (const physical of [false, true]) {
            for (const shadows of [true, false]) {
              app.state = {
                ...app.state,
                cloud: { ...app.state.cloud, quality, enabled },
                debug: { ...app.state.debug, physical, shadows, weather },
              }
              app.renderFrame(1 / 60)
              expect(gl.getError(), `${weather.kind}/${quality}/${enabled}/${physical}/${shadows}`).toBe(gl.NO_ERROR)
            }
          }
        }
      }
    }
    expect(errors).toEqual([])
  })
})
