import { DataTexture, FloatType, NearestFilter, RGBAFormat, WebGLRenderTarget, type WebGLRenderer } from 'three'
import { FullscreenPass, createFullscreenMaterial } from '../render/FullscreenPass'
import { ReadbackPass } from '../render/ReadbackPass'
import type { Atmosphere } from './Atmosphere'

export interface SkyProbeQuery {
  /** Observer altitude above the ocean [m]. */
  altitude: number
  /** Cosine of the view zenith angle. */
  mu: number
  /** Cosine of the sun zenith angle. */
  muS: number
  /** Cosine of the view–sun angle. */
  nu: number
}

/**
 * Evaluates the runtime sky model (same GLSL as rendering) for arbitrary
 * view/sun geometries, e.g. zenith luminance for measured tests where the
 * camera cannot look straight up. Output: luminance RGB in cd/m².
 */
export class SkyProbe {
  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly atmosphere: Atmosphere,
  ) {}

  evaluate(queries: SkyProbeQuery[]): [number, number, number][] {
    const n = queries.length
    const data = new Float32Array(n * 4)
    queries.forEach((q, i) => data.set([q.altitude, q.mu, q.muS, q.nu], i * 4))
    const input = new DataTexture(data, n, 1, RGBAFormat, FloatType)
    input.minFilter = NearestFilter
    input.magFilter = NearestFilter
    input.needsUpdate = true
    const target = new WebGLRenderTarget(n, 1, { type: FloatType, format: RGBAFormat, depthBuffer: false })
    const pass = new FullscreenPass(
      createFullscreenMaterial({
        name: 'SkyProbe',
        chunks: this.atmosphere.chunks,
        uniforms: { ...this.atmosphere.uniforms, uInput: { value: input } },
        fragmentShader: /* glsl */ `
          #include "atmosphere/runtime"
          uniform sampler2D uInput;
          layout(location = 0) out vec4 outValue;
          void main() {
            vec4 q = texelFetch(uInput, ivec2(gl_FragCoord.xy), 0);
            float mu = q.y; float muS = q.z; float nu = q.w;
            vec3 camera = vec3(0.0, 0.0, ATMOSPHERE.bottom_radius + q.x * METER_TO_KM);
            vec3 view = vec3(sqrt(max(0.0, 1.0 - mu * mu)), 0.0, mu);
            float sx = view.x < 1e-6 ? 0.0 : (nu - mu * muS) / view.x;
            vec3 sun = vec3(sx, sqrt(max(0.0, 1.0 - sx * sx - muS * muS)), muS);
            bool ground = RayIntersectsGround(ATMOSPHERE, length(camera), mu);
            vec3 transmittance;
            vec3 L = GetSkyLuminanceClassified(camera, view, 0.0, sun, ground, transmittance);
            outValue = vec4(L * 1000.0, 1.0); // kcd/m² -> cd/m²
          }`,
      }),
    )
    pass.render(this.renderer, target)
    const rb = new ReadbackPass()
    const out = rb.read2D(this.renderer, target.texture, n, 1)
    rb.dispose()
    pass.dispose()
    target.dispose()
    input.dispose()
    return queries.map((_, i) => [out[i * 4]!, out[i * 4 + 1]!, out[i * 4 + 2]!])
  }
}
