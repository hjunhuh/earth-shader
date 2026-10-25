import {
  BufferAttribute,
  BufferGeometry,
  GLSL3,
  Matrix4,
  Mesh,
  ShaderMaterial,
  Uniform,
  Vector3,
  type PerspectiveCamera,
} from 'three'
import { OCEAN_ALBEDO } from '../app/defaults'
import { createGlobalMapUniforms, globalMapGLSL, type GlobalMapUniforms } from './globalMap'
import { oceanCTerm, WGS84_A, Z_SCALE } from './oceanMath'

const vertexShader = /* glsl */ `
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Kept in sync with intersectOcean() in oceanMath.ts.
const fragmentShader = /* glsl */ `
uniform mat4 projectionMatrix; // three declares it for the vertex stage only.
uniform mat4 inverseProjection;
uniform vec3 cameraShading;
uniform float cTerm;
uniform vec3 shadingScale;
uniform vec3 albedo;
${globalMapGLSL}
in vec2 vNdc;
layout(location = 0) out vec4 outputColor;

void main() {
  vec4 nearPoint = inverseProjection * vec4(vNdc, -1.0, 1.0);
  vec3 viewDirection = normalize(nearPoint.xyz / nearPoint.w);
  // World direction = transpose(view rotation) * view direction.
  vec3 worldDirection = viewDirection * mat3(viewMatrix);
  vec3 d = shadingScale * worldDirection;
  float A = dot(d, d);
  float B = dot(cameraShading, d);
  float disc = B * B - A * cTerm;
  if (disc < 0.0) discard;
  float s = sqrt(disc);
  float t;
  if (cTerm > 0.0) {
    if (B >= 0.0) discard;
    t = cTerm / (s - B);
  } else {
    t = (s - B) / A;
  }
  vec4 clip = projectionMatrix * vec4(viewDirection * t, 1.0);
  float ndcZ = clip.z / clip.w;
  if (ndcZ > 1.0) discard; // Beyond the far plane, like a clipped mesh.
  gl_FragDepth = ndcZ * 0.5 + 0.5;
  vec3 hit = cameraPosition + worldDirection * t;
  #ifdef NORMAL_OUTPUT
  // The radial normal takram uses when it has no normal buffer, in view space.
  outputColor = vec4(0.5 * normalize(mat3(viewMatrix) * normalize(hit)) + 0.5, 1.0);
  #else
  // With the terrain on, the whole-Earth map stands in until its tiles load.
  outputColor = vec4(mix(albedo, globalMapColor(hit), globalMapEnabled), 1.0);
  #endif
}
`

export interface OceanUniforms extends GlobalMapUniforms {
  [key: string]: Uniform
  inverseProjection: Uniform<Matrix4>
  cameraShading: Uniform<Vector3>
  cTerm: Uniform<number>
  shadingScale: Uniform<Vector3>
  albedo: Uniform<Vector3>
}

/**
 * Plain ocean: a screen-filling triangle that ray-traces the WGS84 ellipsoid
 * and writes the exact hit depth. Its color is the surface albedo; takram's
 * AerialPerspectiveEffect then lights it (sunLight + skyLight, radial normal),
 * applies cloud shadows and aerial perspective, exactly as for any geometry.
 */
export class Ocean extends Mesh<BufferGeometry, ShaderMaterial> {
  declare material: ShaderMaterial & { uniforms: OceanUniforms }
  /** Same surface, writing its view-space normal (0.5·n + 0.5) for the normal pass. */
  readonly normalMaterial: ShaderMaterial

  constructor(albedo: readonly [number, number, number] = OCEAN_ALBEDO) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    const uniforms: OceanUniforms = {
      inverseProjection: new Uniform(new Matrix4()),
      cameraShading: new Uniform(new Vector3()),
      cTerm: new Uniform(0),
      shadingScale: new Uniform(new Vector3(1, 1, Z_SCALE)),
      albedo: new Uniform(new Vector3(...albedo)),
      ...createGlobalMapUniforms(),
    }
    const material = new ShaderMaterial({
      name: 'Ocean',
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      uniforms,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    })
    super(geometry, material)
    this.normalMaterial = material.clone()
    this.normalMaterial.name = 'OceanNormal'
    this.normalMaterial.uniforms = uniforms // Shared, so update() drives both.
    this.normalMaterial.defines = { NORMAL_OUTPUT: '' }
    this.name = 'Ocean'
    this.frustumCulled = false
    this.renderOrder = -1
  }

  /** Call after the camera's matrices are final for the frame. */
  update(camera: PerspectiveCamera): void {
    const u = this.material.uniforms
    u.inverseProjection.value.copy(camera.projectionMatrixInverse)
    const p = camera.position
    u.cameraShading.value.set(p.x, p.y, p.z * Z_SCALE)
    u.cTerm.value = oceanCTerm([p.x, p.y, p.z])
  }

  static readonly RADIUS = WGS84_A
}
