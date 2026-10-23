import {
  Data3DTexture,
  LinearFilter,
  LinearMipMapLinearFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  TextureLoader,
  type Texture,
} from 'three'
import { CLOUD_SHAPE_DETAIL_TEXTURE_SIZE, CLOUD_SHAPE_TEXTURE_SIZE } from '@takram/three-clouds'
import { DataTextureLoader, parseUint8Array, STBNLoader } from '@takram/three-geospatial'

/**
 * The exact files takram loads by default (DEFAULT_*_URL in the installed
 * packages), served locally from public/takram so the app works offline.
 */
const base = `${import.meta.env.BASE_URL}takram/`
export const ASSET_URLS = {
  localWeather: `${base}local_weather.png`,
  shape: `${base}shape.bin`,
  shapeDetail: `${base}shape_detail.bin`,
  turbulence: `${base}turbulence.png`,
  stbn: `${base}stbn.bin`,
} as const

export interface CloudAssets {
  localWeatherTexture: Texture
  shapeTexture: Data3DTexture
  shapeDetailTexture: Data3DTexture
  turbulenceTexture: Texture
  stbnTexture: Data3DTexture
}

// Texture settings copied from @takram/three-clouds/r3f Clouds (useLoadTexture,
// useLoad3DTexture) and AerialPerspective (STBNLoader).
function load2D(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    new TextureLoader().load(
      url,
      (texture) => {
        texture.minFilter = LinearMipMapLinearFilter
        texture.magFilter = LinearFilter
        texture.wrapS = RepeatWrapping
        texture.wrapT = RepeatWrapping
        texture.colorSpace = NoColorSpace
        texture.needsUpdate = true
        resolve(texture)
      },
      undefined,
      reject,
    )
  })
}

function load3D(url: string, size: number): Promise<Data3DTexture> {
  return new Promise((resolve, reject) => {
    new DataTextureLoader(Data3DTexture, parseUint8Array, {
      width: size,
      height: size,
      depth: size,
      format: RedFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: RepeatWrapping,
      wrapT: RepeatWrapping,
      wrapR: RepeatWrapping,
      colorSpace: NoColorSpace,
    }).load(url, resolve, undefined, reject)
  })
}

function loadSTBN(url: string): Promise<Data3DTexture> {
  return new Promise((resolve, reject) => {
    new STBNLoader().load(url, resolve, undefined, reject)
  })
}

export async function loadCloudAssets(): Promise<CloudAssets> {
  const [localWeatherTexture, shapeTexture, shapeDetailTexture, turbulenceTexture, stbnTexture] = await Promise.all([
    load2D(ASSET_URLS.localWeather),
    load3D(ASSET_URLS.shape, CLOUD_SHAPE_TEXTURE_SIZE),
    load3D(ASSET_URLS.shapeDetail, CLOUD_SHAPE_DETAIL_TEXTURE_SIZE),
    load2D(ASSET_URLS.turbulence),
    loadSTBN(ASSET_URLS.stbn),
  ])
  return { localWeatherTexture, shapeTexture, shapeDetailTexture, turbulenceTexture, stbnTexture }
}
