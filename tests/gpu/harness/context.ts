import { WebGLRenderer } from 'three'

export interface GpuInfo {
  vendor: string
  renderer: string
  extensions: string[]
  maxTextureSize: number
  max3DTextureSize: number
}

/** One renderer per test file; dispose in afterAll to stay under Chrome's context limit. */
export function createTestRenderer(width = 256, height = 256): WebGLRenderer {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  })
  renderer.debug.checkShaderErrors = true
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  return renderer
}

export function disposeTestRenderer(renderer: WebGLRenderer): void {
  renderer.dispose()
  renderer.forceContextLoss()
}

export function getGpuInfo(renderer: WebGLRenderer): GpuInfo {
  const gl = renderer.getContext() as WebGL2RenderingContext
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
    renderer: String(
      dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    ),
    extensions: gl.getSupportedExtensions() ?? [],
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    max3DTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number,
  }
}

/** Collects program link/compile failures reported through three's debug hook. */
export function captureShaderErrors(renderer: WebGLRenderer): { errors: string[] } {
  const sink = { errors: [] as string[] }
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = [
      gl.getProgramInfoLog(program),
      gl.getShaderInfoLog(vs),
      gl.getShaderInfoLog(fs),
    ]
      .filter(Boolean)
      .join('\n')
    sink.errors.push(log)
  }
  return sink
}
