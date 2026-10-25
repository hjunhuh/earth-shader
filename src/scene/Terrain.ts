import {
  Mesh,
  MeshNormalMaterial,
  Vector3,
  type MeshBasicMaterial,
  type Object3D,
  type PerspectiveCamera,
  type Texture,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin, XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { TERRAIN } from '../app/defaults'

export interface TerrainOptions {
  heightScale: number
  brightness: number
  imageryUrl?: string
  elevationUrl?: string
}

/** The plugin's TerrainBasicMaterial: MeshBasicMaterial plus injected displacement. */
type TileMaterial = MeshBasicMaterial & { displacementMap: Texture | null; displacementScale: number; displacementBias: number }

/**
 * Terrain heights are clamped to sea level: the sea becomes a flat surface of
 * the terrain itself (Terrarium includes bathymetry), and land below sea level
 * (Dead Sea, polders) stays dry instead of sinking under the ocean.
 */
const SEA_LEVEL_CLAMP = 'max(texture2D(displacementMap, DISPLACEMENT_UV).x, 0.0)'

function replaceOnce(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) throw new Error(`Terrain shader patch: "${search}" not found`)
  return source.replace(search, replacement)
}

// Height-map bump normals from 3d-tiles-renderer's TerrainLambertMaterial
// (Apache-2.0): central differences at one texel so the gradient interpolates
// across texels and resolves to the physical slope, with a fallback to the
// surface normal for edge-on geometry such as the tile skirts.
const bumpChunk = /* glsl */ `
#ifdef USE_BUMPMAP
  uniform sampler2D bumpMap;
  uniform float bumpScale;
  const float DEGENERATE_DET_EPSILON = 1e-3;
  vec2 dHdxy_fwd() {
    vec2 dSTdx = dFdx(vBumpMapUv);
    vec2 dSTdy = dFdy(vBumpMapUv);
    vec2 texelSize = 1.0 / vec2(textureSize(bumpMap, 0));
    vec2 dx = vec2(texelSize.x, 0.0);
    vec2 dy = vec2(0.0, texelSize.y);
    // Clamped to sea level like the displacement, so the sea is flat.
    float gradU = (max(texture2D(bumpMap, vBumpMapUv + dx).x, 0.0) - max(texture2D(bumpMap, vBumpMapUv - dx).x, 0.0)) / (2.0 * texelSize.x);
    float gradV = (max(texture2D(bumpMap, vBumpMapUv + dy).x, 0.0) - max(texture2D(bumpMap, vBumpMapUv - dy).x, 0.0)) / (2.0 * texelSize.y);
    return bumpScale * vec2(gradU * dSTdx.x + gradV * dSTdx.y, gradU * dSTdy.x + gradV * dSTdy.y);
  }
  vec3 perturbNormalArb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
    vec3 vSigmaX = dFdx(surf_pos.xyz);
    vec3 vSigmaY = dFdy(surf_pos.xyz);
    vec3 R1 = cross(vSigmaY, surf_norm);
    vec3 R2 = cross(surf_norm, vSigmaX);
    float fDet = dot(vSigmaX, R1) * faceDirection;
    if (abs(fDet) < DEGENERATE_DET_EPSILON * length(vSigmaX) * length(vSigmaY)) return surf_norm;
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    return normalize(abs(fDet) * surf_norm - vGrad);
  }
#endif
`

function patchAlbedo(material: MeshBasicMaterial): void {
  const base = material.onBeforeCompile.bind(material)
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {
    base(shader, renderer)
    shader.vertexShader = replaceOnce(
      shader.vertexShader,
      'texture2D( displacementMap, uv ).x',
      SEA_LEVEL_CLAMP.replace('DISPLACEMENT_UV', 'uv'),
    )
  }
  material.customProgramCacheKey = () => 'earth-terrain-albedo'
  material.needsUpdate = true
}

function patchNormal(material: MeshNormalMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = replaceOnce(
      shader.vertexShader,
      '#include <displacementmap_vertex>',
      /* glsl */ `#ifdef USE_DISPLACEMENTMAP
        transformed += normalize(objectNormal) *
          (${SEA_LEVEL_CLAMP.replace('DISPLACEMENT_UV', 'vDisplacementMapUv')} * displacementScale + displacementBias);
      #endif`,
    )
    shader.fragmentShader = replaceOnce(shader.fragmentShader, '#include <bumpmap_pars_fragment>', bumpChunk)
  }
  material.customProgramCacheKey = () => 'earth-terrain-normal'
}

/**
 * Satellite imagery draped on Terrarium elevation tiles, on the WGS84
 * ellipsoid in ECEF meters (the world space). 3d-tiles-renderer does the
 * quadtree LOD, skirts, pole caps and GPU displacement; each tile mesh sits at
 * its own origin, so three's float64 model-view keeps it precise.
 *
 * The meshes are unlit: they write the imagery color as albedo and takram's
 * AerialPerspectiveEffect lights them. Their slopes reach it through the
 * normal pass, which draws each mesh with `normalMaterial(mesh)`.
 */
export class Terrain {
  readonly tiles: TilesRenderer
  readonly plugin: TerrariumMeshPlugin
  readonly overlay: XYZTilesOverlay
  private readonly meshes = new Set<Mesh>()
  private readonly normalMaterials = new WeakMap<Mesh, MeshNormalMaterial>()
  private _enabled = true
  private _covering = false
  private _brightness: number

  constructor({ heightScale, brightness, imageryUrl = TERRAIN.imageryUrl, elevationUrl = TERRAIN.elevationUrl }: TerrainOptions) {
    this._brightness = brightness
    this.overlay = new XYZTilesOverlay({ url: imageryUrl, levels: TERRAIN.imageryLevels })
    this.plugin = new TerrariumMeshPlugin({
      url: elevationUrl,
      maxZoom: TERRAIN.elevationMaxZoom,
      heightScale,
      overlay: this.overlay,
      applyOverlayTexture: true,
      unlit: true,
    })
    this.tiles = new TilesRenderer()
    this.tiles.registerPlugin(this.plugin)
    this.tiles.errorTarget = TERRAIN.errorTarget // After registering: the plugin sets its own.
    this.tiles.group.name = 'Terrain'
    this.tiles.addEventListener('load-model', ({ scene }) => this.onLoad(scene))
    this.tiles.addEventListener('tiles-load-end', () => {
      if (this.meshes.size > 0) this._covering = true
    })
    this.tiles.addEventListener('dispose-model', ({ scene }) => this.onDispose(scene))
  }

  get group(): Object3D {
    return this.tiles.group
  }

  get enabled(): boolean {
    return this._enabled
  }

  set enabled(value: boolean) {
    this._enabled = value
    this.tiles.group.visible = value
  }

  get heightScale(): number {
    return this.plugin.heightScale
  }

  set heightScale(value: number) {
    this.plugin.heightScale = value
  }

  get brightness(): number {
    return this._brightness
  }

  set brightness(value: number) {
    this._brightness = value
    for (const mesh of this.meshes) (mesh.material as MeshBasicMaterial).color.setScalar(value)
  }

  /**
   * True once the first tiles have loaded: from then on the terrain covers the
   * globe, sea included, and replaces the ray-traced ocean. (Coarse tiles sag
   * below the ellipsoid between their vertices, up to ~30 km for the
   * whole-world tile, so the exact ocean would cover them.)
   */
  get covering(): boolean {
    return this._enabled && this._covering
  }

  /** 0–1 share of the requested tiles that have loaded. */
  get loadProgress(): number {
    return this.tiles.loadProgress
  }

  isTerrainMesh(object: Object3D): object is Mesh {
    return this.meshes.has(object as Mesh)
  }

  /** Ground height (meters × heightScale, sea level at least) under a geodetic point in radians, if loaded. */
  elevationAt(latitude: number, longitude: number): number | null {
    const height = this.plugin.sampleCartographicElevation(latitude, longitude)
    return height == null ? null : Math.max(0, height)
  }

  /** The mesh's normal-pass material, kept in step with its displacement. */
  normalMaterial(mesh: Mesh): MeshNormalMaterial {
    const source = mesh.material as TileMaterial
    let material = this.normalMaterials.get(mesh)
    if (!material) {
      material = new MeshNormalMaterial()
      patchNormal(material)
      this.normalMaterials.set(mesh, material)
    }
    if (material.displacementMap !== source.displacementMap) {
      material.displacementMap = source.displacementMap
      material.bumpMap = source.displacementMap
      material.needsUpdate = true
    }
    material.displacementScale = source.displacementScale
    material.displacementBias = source.displacementBias
    material.bumpScale = source.displacementScale
    return material
  }

  /** Call once per frame after the camera moved. */
  update(camera: PerspectiveCamera, renderer: WebGLRenderer): void {
    if (!this._enabled) return
    if (!this.tiles.hasCamera(camera)) this.tiles.setCamera(camera)
    this.tiles.setResolutionFromRenderer(camera, renderer)
    camera.updateMatrixWorld()
    this.tiles.update()
  }

  private onLoad(scene: Object3D): void {
    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return
      const material = object.material as MeshBasicMaterial
      material.color.setScalar(this._brightness)
      patchAlbedo(material)
      this.meshes.add(object)
    })
  }

  private onDispose(scene: Object3D): void {
    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return
      this.meshes.delete(object)
      this.normalMaterials.get(object)?.dispose()
      this.normalMaterials.delete(object)
    })
  }

  dispose(): void {
    this.tiles.dispose()
    this.meshes.clear()
  }
}

/** Raise `position` (ECEF) so it is at least `clearance` above `ground` along `up`. Returns true if moved. */
export function liftAboveGround(position: Vector3, up: Vector3, height: number, ground: number, clearance: number): boolean {
  const lift = ground + clearance - height
  if (!(lift > 0)) return false
  position.addScaledVector(up, lift)
  return true
}
