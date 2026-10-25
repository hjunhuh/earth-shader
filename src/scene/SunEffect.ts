import { Effect, EffectAttribute, ShaderPass } from 'postprocessing'
import {
  Color,
  GLSL3,
  FloatType,
  Matrix4,
  NearestFilter,
  ShaderMaterial,
  Uniform,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { AtmosphereParameters, getSunLightColor } from '@takram/three-atmosphere'
import { Ellipsoid } from '@takram/three-geospatial'
import { glareFraction, LIMB_DARKENING, SPENCER, sunDiskSolidAngle } from './sunModel'

/**
 * Physically based sun, replacing takram's one-pixel-wide sky disk:
 *
 * 1. Disk: area-integrated per pixel (4×4 subsamples) with wavelength-dependent
 *    limb darkening, so its edge is anti-aliased at any resolution. Drawn only
 *    where the pixel sees the sky (depth = far) and attenuated by the clouds in
 *    front of it (overlay alpha), so the horizon and clouds occlude it.
 * 2. Glare: the scattered-light tail of the human-eye point spread function of
 *    Spencer et al. 1995 ("Physically-Based Glare Effects for Digital Images"),
 *    weighted by the visible fraction of the disk (measured each frame on the
 *    GPU into a 1×1 texture). It spreads the sun's energy into a smooth round
 *    bloom, which is what makes a saturated sun look like a sun rather than a
 *    blocky white square once tone mapped.
 *
 * Energy: the disk and the glare share the sun's illuminance E at the camera
 * (takram's getSunLightColor: solar irradiance × transmittance, in takram's
 * relative luminance units). The glare takes `glare × 0.616` of it (the PSF's
 * scattered fraction) and the disk keeps the rest.
 */

const fragmentShader = /* glsl */ `
uniform vec3 sunDirection;
uniform vec3 diskRadiance;
uniform vec3 glareIlluminance;
uniform float angularRadius;
uniform vec3 limbDarkening;
uniform mat4 inverseProjection;
uniform mat4 cameraMatrixWorld;
uniform sampler2D visibilityBuffer;
uniform vec3 moonCenter; // camera-relative, meters
uniform float moonRadius;
#ifdef HAS_OVERLAY
uniform sampler2D overlayBuffer;
#endif

// Robust small angles: 2·asin(|a − b| / 2).
float angleBetween(const vec3 a, const vec3 b) {
  return 2.0 * asin(clamp(length(a - b) * 0.5, 0.0, 1.0));
}

vec3 viewRay(const vec2 uv) {
  vec4 p = inverseProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(mat3(cameraMatrixWorld) * (p.xyz / p.w));
}

// The Moon is always in front of the Sun: a solar eclipse.
bool behindMoon(const vec3 d) {
  if (moonRadius <= 0.0) return false;
  float distance = length(moonCenter);
  return angleBetween(d, moonCenter / distance) < asin(min(1.0, moonRadius / distance));
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

// Periodic value noise over the angle around the sun (n cells per turn).
float angularNoise(const float phi, const float n) {
  float x = phi / 6.28318530718 * n;
  float i = floor(x);
  float f = x - i;
  float a = hash11(mod(i, n));
  float b = hash11(mod(i + 1.0, n));
  return mix(a, b, f * f * (3.0 - 2.0 * f));
}

// Scattered part of the photopic PSF, per steradian, angle in degrees. The
// ocular-scattering term carries the ciliary corona: fine radial streaks that
// redistribute it around the circle without changing its total.
float glarePsf(const float degrees, const float phi) {
  float t = degrees + ${SPENCER.offset.toFixed(4)};
  float f1 = ${SPENCER.w1.toFixed(4)} * ${SPENCER.a1.toFixed(4)} / (t * t * t);
  float f2 = ${SPENCER.w2.toFixed(4)} * ${SPENCER.a2.toFixed(4)} / (t * t);
  #ifdef CORONA
  float streaks = 0.6 * angularNoise(phi, 157.0) + 0.4 * angularNoise(phi + 1.3, 61.0);
  f1 *= 1.0 + CORONA_AMOUNT * (2.0 * streaks - 1.0) * smoothstep(0.3, 1.2, degrees);
  #endif
  return f1 + f2;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 direction = viewRay(uv);
  // Derivatives before any branch.
  vec3 ddx = dFdx(direction);
  vec3 ddy = dFdy(direction);
  float pixelAngle = max(length(ddx), length(ddy));
  float theta = angleBetween(direction, sunDirection);
  vec3 color = inputColor.rgb;

  if (theta < angularRadius + 2.0 * pixelAngle && depth >= 1.0 - 1e-7) {
    // Box-filtered limb-darkened disk: n×n subsamples, more when the disk is
    // only a pixel or two wide, so the energy per pixel is exact at any size.
    int n = angularRadius < 0.75 * pixelAngle ? 16 : angularRadius < 1.5 * pixelAngle ? 8 : 4;
    vec3 intensity = vec3(0.0);
    for (int j = 0; j < 16; ++j) {
      if (j >= n) break;
      for (int i = 0; i < 16; ++i) {
        if (i >= n) break;
        vec2 o = (vec2(float(i), float(j)) + 0.5) / float(n) - 0.5;
        vec3 d = normalize(direction + ddx * o.x + ddy * o.y);
        float t = angleBetween(d, sunDirection) / angularRadius;
        if (t < 1.0 && !behindMoon(d)) {
          float mu = sqrt(1.0 - t * t);
          intensity += 1.0 - limbDarkening * (1.0 - mu);
        }
      }
    }
    float transmittance = 1.0;
    #ifdef HAS_OVERLAY
    transmittance = 1.0 - texture(overlayBuffer, uv).a;
    #endif
    color += diskRadiance * (intensity / float(n * n)) * transmittance;
  }

  float visibility = texture(visibilityBuffer, vec2(0.5)).r;
  float effective = sqrt(theta * theta + angularRadius * angularRadius); // disk-averaged near the core
  // Angle around the sun in the camera's frame (the corona is fixed to the eye).
  vec3 offset = direction - sunDirection;
  float phi = atan(dot(offset, cameraMatrixWorld[1].xyz), dot(offset, cameraMatrixWorld[0].xyz));
  color += glareIlluminance * visibility * glarePsf(degrees(effective), phi);
  outputColor = vec4(color, inputColor.a);
}
`

/** Visible fraction of the disk: depth = far (sky) and cloud transmittance, weighted by limb-darkened coverage. */
const visibilityShader = /* glsl */ `
#define MAX_HALF_WINDOW 24
uniform sampler2D depthBuffer;
#ifdef HAS_OVERLAY
uniform sampler2D overlayBuffer;
#endif
uniform vec2 center;     // drawing-buffer pixels, origin bottom-left
uniform float radius;    // disk radius in pixels
uniform vec2 size;       // drawing-buffer size
uniform int halfWindow;
uniform mat4 inverseProjection;
uniform mat4 cameraMatrixWorld;
uniform vec3 moonCenter;
uniform float moonRadius;
layout(location = 0) out vec4 outputColor;

bool behindMoon(const vec2 p) {
  if (moonRadius <= 0.0) return false;
  vec4 v = inverseProjection * vec4(p / size * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(mat3(cameraMatrixWorld) * (v.xyz / v.w));
  float distance = length(moonCenter);
  vec3 m = moonCenter / distance;
  return 2.0 * asin(clamp(length(d - m) * 0.5, 0.0, 1.0)) < asin(min(1.0, moonRadius / distance));
}

void main() {
  float visible = 0.0;
  float total = 0.0;
  vec2 base = floor(center);
  int w = min(halfWindow, MAX_HALF_WINDOW);
  for (int j = -w; j <= w; ++j) {
    for (int i = -w; i <= w; ++i) {
      vec2 p = base + vec2(float(i), float(j)) + 0.5;
      if (p.x < 0.0 || p.y < 0.0 || p.x >= size.x || p.y >= size.y) continue;
      float weight = 0.0;
      float unoccluded = 0.0;
      for (int s = 0; s < 4; ++s) {
        vec2 o = vec2(float(s & 1), float(s >> 1)) * 0.5 - 0.25;
        float t = length(p + o - center) / radius;
        if (t < 1.0) {
          float w = 0.4 + 0.6 * sqrt(1.0 - t * t);
          weight += w;
          if (!behindMoon(p + o)) unoccluded += w;
        }
      }
      if (weight == 0.0) continue;
      vec2 uv = p / size;
      float v = texture(depthBuffer, uv).r >= 1.0 - 1e-7 ? unoccluded / weight : 0.0;
      #ifdef HAS_OVERLAY
      v *= 1.0 - texture(overlayBuffer, uv).a;
      #endif
      visible += weight * v;
      total += weight;
    }
  }
  outputColor = vec4(total > 0.0 ? visible / total : 0.0, total, 0.0, 1.0);
}
`

export interface SunEffectOptions {
  /** Glare strength: 0 = none, 1 = the human-eye PSF of Spencer et al. */
  glare?: number
  /** Ciliary corona streak contrast (0 = smooth glare). */
  corona?: number
  ellipsoid?: Ellipsoid
  correctAltitude?: boolean
}

const vector = new Vector3()
const color = new Color()

export class SunEffect extends Effect {
  readonly sunDirection = new Vector3()
  glare: number
  private _corona = 0
  ellipsoid: Ellipsoid
  correctAltitude: boolean
  transmittanceTexture: Texture | null = null
  /** Clouds composited over the sky (CloudsEffect.atmosphereOverlay.map). */
  overlayMap: Texture | null = null
  /** The Moon's center (ECEF) and radius; it eclipses the disk. Radius 0 = no Moon. */
  readonly moonPosition = new Vector3()
  moonRadius = 0

  /** Sun illuminance at the camera after atmospheric transmittance (relative luminance). */
  readonly illuminance = new Vector3()
  /** Tests: use this illuminance instead of the atmosphere's. */
  illuminanceOverride: Vector3 | null = null
  /** Sun center in CSS-independent drawing-buffer pixels (origin bottom-left) and radius, for tests. */
  readonly screen = { x: 0, y: 0, radius: 0, inFront: false, fade: 0 }

  private readonly visibilityTarget = new WebGLRenderTarget(1, 1, {
    type: FloatType,
    depthBuffer: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  })
  private readonly visibilityMaterial: ShaderMaterial
  private readonly visibilityPass: ShaderPass
  private readonly drawingSize = new Vector2(1, 1)

  constructor(
    private camera: PerspectiveCamera,
    { glare = 0.1, corona = 0.5, ellipsoid = Ellipsoid.WGS84, correctAltitude = true }: SunEffectOptions = {},
    private readonly atmosphere = AtmosphereParameters.DEFAULT,
  ) {
    super('SunEffect', fragmentShader, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['sunDirection', new Uniform(new Vector3())],
        ['diskRadiance', new Uniform(new Vector3())],
        ['glareIlluminance', new Uniform(new Vector3())],
        ['angularRadius', new Uniform(atmosphere.sunAngularRadius)],
        ['limbDarkening', new Uniform(new Vector3(...LIMB_DARKENING))],
        ['inverseProjection', new Uniform(new Matrix4())],
        ['cameraMatrixWorld', new Uniform(new Matrix4())],
        ['visibilityBuffer', new Uniform(null)],
        ['moonCenter', new Uniform(new Vector3(0, 0, 1e10))],
        ['moonRadius', new Uniform(0)],
        ['overlayBuffer', new Uniform(null)],
      ]),
    })
    this.glare = glare
    this.corona = corona
    this.ellipsoid = ellipsoid
    this.correctAltitude = correctAltitude
    this.uniforms.get('visibilityBuffer')!.value = this.visibilityTarget.texture

    this.visibilityMaterial = new ShaderMaterial({
      name: 'SunVisibility',
      glslVersion: GLSL3,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: visibilityShader,
      uniforms: {
        depthBuffer: new Uniform(null),
        overlayBuffer: new Uniform(null),
        center: new Uniform(new Vector2()),
        radius: new Uniform(1),
        size: new Uniform(new Vector2(1, 1)),
        halfWindow: new Uniform(0),
        inverseProjection: new Uniform(new Matrix4()),
        cameraMatrixWorld: new Uniform(new Matrix4()),
        moonCenter: new Uniform(new Vector3(0, 0, 1e10)),
        moonRadius: new Uniform(0),
      },
      depthTest: false,
      depthWrite: false,
    })
    this.visibilityPass = new ShaderPass(this.visibilityMaterial)
  }

  get corona(): number {
    return this._corona
  }

  set corona(value: number) {
    if (value === this._corona) return
    this._corona = value
    if (value > 0) {
      this.defines.set('CORONA', '1')
      this.defines.set('CORONA_AMOUNT', value.toFixed(3))
    } else {
      this.defines.delete('CORONA')
      this.defines.delete('CORONA_AMOUNT')
    }
    this.setChanged()
  }

  override get mainCamera(): PerspectiveCamera {
    return this.camera
  }

  override set mainCamera(value: PerspectiveCamera) {
    this.camera = value
  }

  override setDepthTexture(depthTexture: Texture): void {
    this.visibilityMaterial.uniforms.depthBuffer!.value = depthTexture
  }

  override setSize(width: number, height: number): void {
    this.drawingSize.set(width, height)
  }

  override update(renderer: WebGLRenderer): void {
    const camera = this.camera
    const u = this.uniforms
    camera.updateMatrixWorld()
    u.get('sunDirection')!.value.copy(this.sunDirection)
    u.get('inverseProjection')!.value.copy(camera.projectionMatrixInverse)
    u.get('cameraMatrixWorld')!.value.copy(camera.matrixWorld)
    const moonCenter = (u.get('moonCenter')!.value as Vector3).subVectors(this.moonPosition, camera.position)
    u.get('moonRadius')!.value = this.moonRadius
    const vm = this.visibilityMaterial.uniforms
    vm.inverseProjection!.value.copy(camera.projectionMatrixInverse)
    vm.cameraMatrixWorld!.value.copy(camera.matrixWorld)
    vm.moonCenter!.value.copy(moonCenter)
    vm.moonRadius!.value = this.moonRadius

    this.updateOverlay()
    this.updateIlluminance()

    // Sun disk on screen (drawing-buffer pixels, bottom-left origin).
    const view = vector.copy(this.sunDirection).transformDirection(camera.matrixWorldInverse)
    const inFront = view.z < 0
    const { x: width, y: height } = this.drawingSize
    const focal = height / 2 / Math.tan((camera.fov * Math.PI) / 360)
    const sx = width / 2 + (focal * view.x) / -view.z
    const sy = height / 2 + (focal * view.y) / -view.z
    const radius = (focal * this.atmosphere.sunAngularRadius) / (view.z * view.z)
    // Fade the glare out near the screen edge, where the disk can no longer be measured.
    const inside = Math.min(sx, sy, width - sx, height - sy)
    const fadeWidth = Math.max(4 * radius, 0.03 * height)
    const fade = inFront ? Math.min(1, Math.max(0, inside / fadeWidth)) : 0
    Object.assign(this.screen, { x: sx, y: sy, radius, inFront, fade })

    const m = this.visibilityMaterial.uniforms
    m.center!.value.set(sx, sy)
    m.radius!.value = Math.max(radius, 0.5)
    m.size!.value.copy(this.drawingSize)
    m.halfWindow!.value = inFront && fade > 0 ? Math.min(24, Math.ceil(radius + 1)) : -1
    this.visibilityPass.render(renderer, null as never, this.visibilityTarget)

    // Energy split between the glare and the disk.
    const scattered = glareFraction(this.glare)
    const omega = sunDiskSolidAngle(this.atmosphere.sunAngularRadius)
    const disk = u.get('diskRadiance')!.value as Vector3
    disk.set(
      this.illuminance.x / (omega * (1 - LIMB_DARKENING[0] / 3)),
      this.illuminance.y / (omega * (1 - LIMB_DARKENING[1] / 3)),
      this.illuminance.z / (omega * (1 - LIMB_DARKENING[2] / 3)),
    ).multiplyScalar(1 - scattered)
    ;(u.get('glareIlluminance')!.value as Vector3).copy(this.illuminance).multiplyScalar(this.glare * fade)
  }

  private updateIlluminance(): void {
    const options = { ellipsoid: this.ellipsoid, correctAltitude: this.correctAltitude }
    if (this.illuminanceOverride != null) {
      this.illuminance.copy(this.illuminanceOverride)
      return
    }
    if (this.transmittanceTexture == null) {
      this.illuminance.setScalar(0)
      return
    }
    getSunLightColor(this.transmittanceTexture, this.camera.position, this.sunDirection, color, options, this.atmosphere)
    if (color.r + color.g + color.b === 0) {
      // The center is below the atmosphere's horizon: use the disk's top edge,
      // which can still be above it while the sun is setting.
      const up = vector.copy(this.camera.position).normalize()
      const top = up.addScaledVector(this.sunDirection, -up.dot(this.sunDirection)).normalize()
      top.multiplyScalar(this.atmosphere.sunAngularRadius).add(this.sunDirection).normalize()
      getSunLightColor(this.transmittanceTexture, this.camera.position, top, color, options, this.atmosphere)
    }
    this.illuminance.set(color.r, color.g, color.b)
  }

  private updateOverlay(): void {
    const has = this.overlayMap != null
    if (has !== this.defines.has('HAS_OVERLAY')) {
      if (has) this.defines.set('HAS_OVERLAY', '1')
      else this.defines.delete('HAS_OVERLAY')
      this.setChanged()
      if (has) this.visibilityMaterial.defines.HAS_OVERLAY = '1'
      else delete this.visibilityMaterial.defines.HAS_OVERLAY
      this.visibilityMaterial.needsUpdate = true
    }
    this.uniforms.get('overlayBuffer')!.value = this.overlayMap
    this.visibilityMaterial.uniforms.overlayBuffer!.value = this.overlayMap
  }

  override dispose(): void {
    super.dispose()
    this.visibilityTarget.dispose()
    this.visibilityMaterial.dispose()
    this.visibilityPass.dispose()
  }
}
