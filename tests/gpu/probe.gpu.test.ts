import { describe, expect, it } from 'vitest'

describe('GPU probe', () => {
  it('runs on a real GPU (Apple/Metal) unless on CI, with float render targets', () => {
    const gl = document.createElement('canvas').getContext('webgl2')!
    expect(gl).toBeTruthy()
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown'
    console.info('[gpu]', renderer)
    if (!import.meta.env.CI) expect(renderer).toMatch(/Apple|Metal/)
    expect(gl.getExtension('EXT_color_buffer_float')).toBeTruthy()
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  })
})
