import { Effect } from 'postprocessing'
import { Color, Matrix3, Matrix4, Uniform, Vector3, type PerspectiveCamera, type Texture } from 'three'
import { AtmosphereParameters, getSunLightColor } from '@takram/three-atmosphere'
import { Ellipsoid } from '@takram/three-geospatial'
import type { Moon } from './Moon'
import { ALBEDO_SCALE, EARTH_SHADOW_RADIUS, earthshineRatio, PHASE_STEP, PHASE_TABLE, UMBRA_GLOW } from './moonModel'
import { oceanCTerm, Z_SCALE } from './oceanMath'

/**
 * Renders the Moon (see Moon.ts) as a true-scale sphere, after the
 * atmosphere and before the sun:
 *
 * - Geometry: per-pixel ray–sphere intersection against the Moon's center
 *   relative to the camera (formed in float64 on the CPU), with the limb
 *   area-sampled like the sun disk. The Earth's ellipsoid (the same exact
 *   intersection as Ocean.ts) and the atmosphere's outer sphere decide what is
 *   in front: the Earth hides the Moon, the Moon hides the Earth when seen
 *   from beyond it.
 * - Surface: LRO WAC albedo × LOLA terrain normals, lit with the Lunar-Lambert
 *   photometric function of moonModel.ts, so phases, the opposition surge and
 *   the brightness (full moon ≈ 2.5e−6 of the sun) come out of the geometry.
 * - Eclipses: the fraction of the solar disk hidden by the Earth's shadow
 *   (penumbra/umbra, with a dim reddened umbral glow), and earthshine on the
 *   night side.
 * - Seen through the atmosphere: L = inscatter (already in the sky color) +
 *   T · L_moon · (1 − cloud overlay); from space in front of the atmosphere
 *   the Moon simply covers what is behind it.
 */

const phaseTable = `const float PHASE_TABLE[${PHASE_TABLE.length}] = float[${PHASE_TABLE.length}](${PHASE_TABLE.map((v) => v.toFixed(6)).join(', ')});`

const fragmentShader = /* glsl */ `
uniform vec3 moonCenter;      // camera-relative ECEF, meters
uniform float moonRadius;
uniform mat3 ecefToFixed;
uniform vec3 sunDirection;
uniform float sunAngularRadius;
uniform vec3 sunIrradiance;    // top of the atmosphere, relative luminance
uniform vec3 viewTransmittance;
uniform vec3 earthCenter;      // camera-relative ECEF
uniform vec3 earthshineIrradiance;
uniform float earthShadowRadius;
uniform vec3 cameraShading;
uniform float cTerm;
uniform vec3 shadingScale;
uniform float atmosphereCTerm; // |camera|² − topRadius², ≤ 0 inside the atmosphere
uniform float albedoScale;
uniform mat4 inverseProjection;
uniform mat4 cameraMatrixWorld;
uniform sampler2D colorMap;
uniform sampler2D slopeEastMap;
uniform sampler2D slopeNorthMap;
#ifdef HAS_OVERLAY
uniform sampler2D overlayBuffer;
#endif

${phaseTable}
#define PHASE_STEP ${PHASE_STEP.toFixed(1)}
#define UMBRA_GLOW vec3(${UMBRA_GLOW.map((v) => v.toExponential(3)).join(', ')})
#define PI_ 3.14159265359

float angleBetween(const vec3 a, const vec3 b) {
  return 2.0 * asin(clamp(length(a - b) * 0.5, 0.0, 1.0));
}

vec3 viewRay(const vec2 uv) {
  vec4 p = inverseProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(mat3(cameraMatrixWorld) * (p.xyz / p.w));
}

// Outward normal where ray d meets the Moon, and the distance; rays that miss
// are clamped to the limb. perp = center − closest point is small, so the
// result keeps full precision at any distance.
vec3 moonHit(const vec3 d, out float t) {
  float b = dot(d, moonCenter);
  vec3 perp = moonCenter - d * b;
  float s = sqrt(max(0.0, moonRadius * moonRadius - dot(perp, perp)));
  t = b - s;
  return normalize(-perp - d * s);
}

vec2 surfaceUv(const vec3 n) {
  vec3 f = ecefToFixed * n;
  return vec2(atan(f.y, f.x) / (2.0 * PI_) + 0.5, asin(clamp(f.z, -1.0, 1.0)) / PI_ + 0.5);
}

float decodeSlope(const float e) {
  float s = e * 2.0 - 1.0;
  return sign(s) * s * s;
}

float phaseCorrection(const float alphaDeg) {
  float x = clamp(alphaDeg, 0.0, 180.0) / PHASE_STEP;
  int i = min(int(x), ${PHASE_TABLE.length - 2});
  return mix(PHASE_TABLE[i], PHASE_TABLE[i + 1], x - float(i));
}

float lunarLambert(const float mu0, const float mu, const float alphaDeg) {
  float L = clamp(1.0 - 0.019 * alphaDeg + 2.42e-4 * alphaDeg * alphaDeg - 1.46e-6 * alphaDeg * alphaDeg * alphaDeg, 0.0, 1.0);
  return 2.0 * L * mu0 / (mu0 + mu) + (1.0 - L) * mu0;
}

float diskOverlap(const float a, const float b, const float c) {
  if (c >= a + b) return 0.0;
  if (c <= abs(a - b)) return PI_ * min(a, b) * min(a, b);
  float alpha = acos(clamp((c * c + a * a - b * b) / (2.0 * c * a), -1.0, 1.0));
  float beta = acos(clamp((c * c + b * b - a * a) / (2.0 * c * b), -1.0, 1.0));
  return a * a * (alpha - 0.5 * sin(2.0 * alpha)) + b * b * (beta - 0.5 * sin(2.0 * beta));
}

// Fraction of the solar disk not hidden by the Earth, seen from point p.
float sunVisible(const vec3 p) {
  vec3 toEarth = earthCenter - p;
  float distance = length(toEarth);
  float earthRadius = asin(min(1.0, earthShadowRadius / distance));
  float separation = angleBetween(toEarth / distance, sunDirection);
  float covered = diskOverlap(sunAngularRadius, earthRadius, separation);
  return max(0.0, 1.0 - covered / (PI_ * sunAngularRadius * sunAngularRadius));
}

// Distance to the WGS84 surface along d (Ocean.ts), or −1.
float earthDistance(const vec3 d) {
  vec3 e = shadingScale * d;
  float A = dot(e, e);
  float B = dot(cameraShading, e);
  float disc = B * B - A * cTerm;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  if (cTerm > 0.0) return B >= 0.0 ? -1.0 : cTerm / (s - B);
  return (s - B) / A;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
  vec3 direction = viewRay(uv);
  vec3 ddx = dFdx(direction);
  vec3 ddy = dFdy(direction);
  float pixelAngle = max(length(ddx), length(ddy));

  float distance = length(moonCenter);
  vec3 toMoon = moonCenter / distance;
  float angularRadius = asin(min(1.0, moonRadius / distance));
  float theta = angleBetween(direction, toMoon);
  if (theta > angularRadius + 2.0 * pixelAngle) return;

  // Coverage: area-sampled near the limb.
  float coverage = 1.0;
  if (theta > angularRadius - 2.0 * pixelAngle) {
    int n = angularRadius < 1.5 * pixelAngle ? 8 : 4;
    float hits = 0.0;
    for (int j = 0; j < 8; ++j) {
      if (j >= n) break;
      for (int i = 0; i < 8; ++i) {
        if (i >= n) break;
        vec2 o = (vec2(float(i), float(j)) + 0.5) / float(n) - 0.5;
        hits += angleBetween(normalize(direction + ddx * o.x + ddy * o.y), toMoon) < angularRadius ? 1.0 : 0.0;
      }
    }
    coverage = hits / float(n * n);
    if (coverage == 0.0) return;
  }

  float t;
  vec3 normal = moonHit(direction, t);
  float earth = earthDistance(direction);
  if (earth >= 0.0 && earth < t) return; // the Earth is in front

  // Texture coordinates and their screen derivatives (explicit: this branch
  // is not uniform, so no dFdx here). The longitude seam wraps.
  vec2 st = surfaceUv(normal);
  float tx;
  float ty;
  vec2 dx = surfaceUv(moonHit(normalize(direction + ddx), tx)) - st;
  vec2 dy = surfaceUv(moonHit(normalize(direction + ddy), ty)) - st;
  dx.x -= floor(dx.x + 0.5);
  dy.x -= floor(dy.x + 0.5);

  vec3 albedo = textureGrad(colorMap, st, dx, dy).rgb * albedoScale;
  float se = decodeSlope(textureGrad(slopeEastMap, st, dx, dy).r);
  float sn = decodeSlope(textureGrad(slopeNorthMap, st, dx, dy).r);

  // Terrain normal in the body-fixed (east, north, up) frame, back to ECEF.
  vec3 up = ecefToFixed * normal;
  float lon = atan(up.y, up.x);
  vec3 east = vec3(-sin(lon), cos(lon), 0.0);
  vec3 north = cross(up, east);
  vec3 terrain = normalize(se * east + sn * north + sqrt(max(0.0, 1.0 - se * se - sn * sn)) * up) * ecefToFixed;

  vec3 view = -direction;
  float mu0 = dot(terrain, sunDirection);
  float mu = max(dot(terrain, view), 1e-3);
  float alpha = degrees(acos(clamp(dot(sunDirection, view), -1.0, 1.0)));
  // Terrain normals light the slopes, the sphere decides day and night.
  float daylight = smoothstep(-0.03, 0.01, dot(normal, sunDirection));
  float lit = mu0 > 0.0 ? lunarLambert(mu0, mu, alpha) * phaseCorrection(alpha) * daylight : 0.0;

  vec3 point = direction * t;
  float visible = sunVisible(point);
  vec3 irradiance = sunIrradiance * (visible + (1.0 - visible) * UMBRA_GLOW);
  vec3 toEarth = normalize(earthCenter - point);
  vec3 radiance = albedo / PI_ * (irradiance * lit + earthshineIrradiance * max(dot(terrain, toEarth), 0.0));

  // In front of everything (from space) or seen through the atmosphere.
  vec3 camera = -earthCenter;
  float bA = dot(camera, direction);
  float discA = bA * bA - atmosphereCTerm;
  bool throughAtmosphere = atmosphereCTerm <= 0.0 ||
    (discA > 0.0 && bA < 0.0 && atmosphereCTerm / (sqrt(discA) - bA) < t);
  if (throughAtmosphere) {
    float clouds = 0.0;
    #ifdef HAS_OVERLAY
    clouds = texture(overlayBuffer, uv).a;
    #endif
    outputColor.rgb += coverage * (1.0 - clouds) * viewTransmittance * radiance;
  } else {
    outputColor.rgb = mix(outputColor.rgb, radiance, coverage);
  }
}
`

export interface MoonEffectOptions {
  ellipsoid?: Ellipsoid
  correctAltitude?: boolean
}

const color = new Color()
const vector = new Vector3()
const space = new Vector3()

export class MoonEffect extends Effect {
  ellipsoid: Ellipsoid
  correctAltitude: boolean
  readonly sunDirection = new Vector3()
  transmittanceTexture: Texture | null = null
  overlayMap: Texture | null = null
  /** Atmospheric transmittance toward the Moon's center this frame (tests). */
  readonly transmittance = new Vector3(1, 1, 1)

  constructor(
    private camera: PerspectiveCamera,
    readonly moon: Moon,
    { ellipsoid = Ellipsoid.WGS84, correctAltitude = true }: MoonEffectOptions = {},
    private readonly atmosphere = AtmosphereParameters.DEFAULT,
  ) {
    super('MoonEffect', fragmentShader, {
      uniforms: new Map<string, Uniform>([
        ['moonCenter', new Uniform(new Vector3())],
        ['moonRadius', new Uniform(moon.radius)],
        ['ecefToFixed', new Uniform(new Matrix3())],
        ['sunDirection', new Uniform(new Vector3())],
        ['sunAngularRadius', new Uniform(atmosphere.sunAngularRadius)],
        ['sunIrradiance', new Uniform(new Vector3())],
        ['viewTransmittance', new Uniform(new Vector3(1, 1, 1))],
        ['earthCenter', new Uniform(new Vector3())],
        ['earthshineIrradiance', new Uniform(new Vector3())],
        ['earthShadowRadius', new Uniform(EARTH_SHADOW_RADIUS)],
        ['cameraShading', new Uniform(new Vector3())],
        ['cTerm', new Uniform(0)],
        ['shadingScale', new Uniform(new Vector3(1, 1, Z_SCALE))],
        ['atmosphereCTerm', new Uniform(0)],
        ['albedoScale', new Uniform(ALBEDO_SCALE)],
        ['inverseProjection', new Uniform(new Matrix4())],
        ['cameraMatrixWorld', new Uniform(new Matrix4())],
        ['colorMap', new Uniform(null)],
        ['slopeEastMap', new Uniform(null)],
        ['slopeNorthMap', new Uniform(null)],
        ['overlayBuffer', new Uniform(null)],
      ]),
    })
    this.ellipsoid = ellipsoid
    this.correctAltitude = correctAltitude
  }

  override get mainCamera(): PerspectiveCamera {
    return this.camera
  }

  override set mainCamera(value: PerspectiveCamera) {
    this.camera = value
  }

  setMaps(color: Texture, slopeEast: Texture, slopeNorth: Texture): void {
    this.uniforms.get('colorMap')!.value = color
    this.uniforms.get('slopeEastMap')!.value = slopeEast
    this.uniforms.get('slopeNorthMap')!.value = slopeNorth
  }

  /** Top-of-atmosphere solar irradiance in takram's relative luminance. */
  get solarIrradiance(): Vector3 {
    return space.copy(this.atmosphere.solarIrradiance).multiply(this.atmosphere.sunRadianceToRelativeLuminance)
  }

  override update(): void {
    const camera = this.camera
    const moon = this.moon
    const u = this.uniforms
    camera.updateMatrixWorld()
    const p = camera.position

    // Camera-relative positions in float64, then float32 uniforms.
    const center = u.get('moonCenter')!.value as Vector3
    center.subVectors(moon.position, p)
    ;(u.get('ecefToFixed')!.value as Matrix3).copy(moon.ecefToFixed)
    u.get('sunDirection')!.value.copy(this.sunDirection)
    u.get('earthCenter')!.value.copy(p).negate()
    u.get('cameraShading')!.value.set(p.x, p.y, p.z * Z_SCALE)
    u.get('cTerm')!.value = oceanCTerm([p.x, p.y, p.z])
    const r = p.length()
    const top = this.ellipsoid.maximumRadius + (this.atmosphere.topRadius - this.atmosphere.bottomRadius)
    u.get('atmosphereCTerm')!.value = (r - top) * (r + top)
    u.get('inverseProjection')!.value.copy(camera.projectionMatrixInverse)
    u.get('cameraMatrixWorld')!.value.copy(camera.matrixWorld)

    const solar = this.solarIrradiance
    u.get('sunIrradiance')!.value.copy(solar)

    // Earthshine: the Earth's phase seen from the Moon.
    const moonDistance = moon.position.length()
    const toMoon = vector.copy(moon.position).divideScalar(moonDistance)
    const beta = Math.acos(Math.min(1, Math.max(-1, toMoon.dot(this.sunDirection))))
    u.get('earthshineIrradiance')!.value.copy(solar).multiplyScalar(earthshineRatio(beta, moonDistance))

    // Transmittance along the view ray to the Moon's center (constant over a 0.5° disk).
    this.updateTransmittance(center, solar)
    u.get('viewTransmittance')!.value.copy(this.transmittance)

    const has = this.overlayMap != null
    if (has !== this.defines.has('HAS_OVERLAY')) {
      if (has) this.defines.set('HAS_OVERLAY', '1')
      else this.defines.delete('HAS_OVERLAY')
      this.setChanged()
    }
    u.get('overlayBuffer')!.value = this.overlayMap
  }

  private updateTransmittance(center: Vector3, solar: Vector3): void {
    if (this.transmittanceTexture == null) {
      this.transmittance.set(1, 1, 1)
      return
    }
    const options = { ellipsoid: this.ellipsoid, correctAltitude: this.correctAltitude }
    const direction = vector.copy(center).normalize()
    getSunLightColor(this.transmittanceTexture, this.camera.position, direction, color, options, this.atmosphere)
    if (color.r + color.g + color.b === 0) {
      // Center below the horizon: the upper limb may still be above it.
      const up = vector.copy(this.camera.position).normalize()
      const d = center.clone().normalize()
      const limb = up.addScaledVector(d, -up.dot(d)).normalize()
      limb.multiplyScalar(Math.asin(Math.min(1, this.moon.radius / center.length()))).add(d).normalize()
      getSunLightColor(this.transmittanceTexture, this.camera.position, limb, color, options, this.atmosphere)
    }
    this.transmittance.set(color.r / solar.x, color.g / solar.y, color.b / solar.z)
  }
}
