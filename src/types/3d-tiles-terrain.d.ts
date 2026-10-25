// 3d-tiles-renderer 0.5.3 exports the terrain plugins without type declarations.
// These cover the part of TerrainRGBMeshPlugin.js this app uses.
import type { ImageOverlay } from '3d-tiles-renderer/three/plugins'

declare module '3d-tiles-renderer/three/plugins' {
  export interface TerrainRGBMeshPluginOptions {
    url: string
    tileDimension?: number
    maxZoom?: number
    heightScale?: number
    overlay?: ImageOverlay | null
    applyOverlayTexture?: boolean
    unlit?: boolean
    projection?: 'ellipsoid' | 'source' | string
    endCaps?: boolean
    useRecommendedSettings?: boolean
  }

  export class TerrainRGBMeshPlugin {
    constructor(options: TerrainRGBMeshPluginOptions)
    name: string
    heightScale: number
    overlay: ImageOverlay | null
    applyOverlayTexture: boolean
    unlit: boolean
    /** Latitude / longitude in radians; meters × heightScale, or null when nothing covering it is loaded. */
    sampleCartographicElevation(lat: number, lon: number): number | null
    decodeElevation(r: number, g: number, b: number): number
    dispose(): void
  }

  /** Terrarium encoding: h = R·256 + G + B/256 − 32768. */
  export class TerrariumMeshPlugin extends TerrainRGBMeshPlugin {}
}
