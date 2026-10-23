/**
 * Test-only reference: takram's "clouds/Clouds/Basic" story rendered with the
 * real React stack (R3F + drei OrbitControls + @react-three/postprocessing +
 * the takram R3F components), with leva replaced by fixed values from the URL.
 * e2e tests drive this page and the app with identical inputs and compare the
 * camera and the pixels.
 *
 * Differences from the story, both needed for an apples-to-apples comparison:
 * - The app's Ocean mesh is added (the story has no geometry at all).
 * - enableNormalPass is off: it only matters for geometry, and the ocean's
 *   normal is the radial one AerialPerspective uses without a normal buffer.
 * - The atmosphere LUTs come from the same PrecomputedTexturesGenerator that
 *   <Atmosphere> uses internally, but awaited so no frame renders before
 *   they exist; textures load from the local copies of takram's default URLs.
 *
 * Story source: storybook/src/clouds/Clouds-Basic.tsx and helpers
 * (useApplyLocation, useLocalDateControls, useToneMappingControls). MIT, takram.
 */
import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, SMAA, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { Fragment, useEffect, useMemo, useReducer, useRef, type ComponentRef, type FC } from 'react'
import { createRoot } from 'react-dom/client'
import { DefaultLoadingManager, Quaternion, Vector3, type Camera, type PerspectiveCamera } from 'three'
import { PrecomputedTexturesGenerator, type PrecomputedTextures } from '@takram/three-atmosphere'
import { AerialPerspective, Atmosphere, type AtmosphereApi } from '@takram/three-atmosphere/r3f'
import { Clouds } from '@takram/three-clouds/r3f'
import { Ellipsoid, Geodetic, radians, STBNLoader, type GeodeticLike } from '@takram/three-geospatial'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import { localDateMs } from '../../src/app/localDate'
import { createTestApi, type EarthTestApi } from '../../src/app/testApi'
import { parseUrl } from '../../src/app/urlState'
import { ASSET_URLS } from '../../src/scene/assets'
import { Ocean } from '../../src/scene/Ocean'

const TONE: Record<string, ToneMappingMode> = {
  AgX: ToneMappingMode.AGX,
  Reinhard: ToneMappingMode.REINHARD,
  Cineon: ToneMappingMode.CINEON,
  'ACES Filmic': ToneMappingMode.ACES_FILMIC,
  Linear: ToneMappingMode.LINEAR,
}

// --- storybook/src/helpers/useApplyLocation.tsx ---
const geodetic = new Geodetic()
const position = new Vector3()
const up = new Vector3()
const offset = new Vector3()
const rotation = new Quaternion()

function applyLocation(
  camera: Camera,
  controls: ComponentRef<typeof OrbitControls>,
  { longitude, latitude, height }: GeodeticLike,
): void {
  geodetic.set(radians(longitude), radians(latitude), height)
  geodetic.toECEF(position)
  Ellipsoid.WGS84.getSurfaceNormal(position, up)
  rotation.setFromUnitVectors(camera.up, up)
  offset.copy(camera.position).sub(controls.target)
  offset.applyQuaternion(rotation)
  camera.up.copy(up)
  camera.position.copy(position).add(offset)
  controls.target.copy(position)
}

function useApplyLocation({ longitude, latitude, height }: GeodeticLike) {
  const ref = useRef<ComponentRef<typeof OrbitControls>>(null)
  const camera = useThree(({ camera }) => camera)
  useEffect(() => {
    const controls = ref.current
    if (controls != null) applyLocation(camera, controls, { longitude, latitude, height })
  }, [longitude, latitude, height, camera])
  return ref
}
// ---

const { state, test, errors: urlErrors } = parseUrl(window.location.search)
const errors: string[] = [...urlErrors]
window.addEventListener('error', (e) => errors.push(String(e.message)))

// Count every texture request (three loaders report to DefaultLoadingManager).
const loads = { started: 0, finished: 0 }
const itemStart = DefaultLoadingManager.itemStart.bind(DefaultLoadingManager)
const itemEnd = DefaultLoadingManager.itemEnd.bind(DefaultLoadingManager)
DefaultLoadingManager.itemStart = (url: string) => {
  loads.started++
  itemStart(url)
}
DefaultLoadingManager.itemEnd = (url: string) => {
  loads.finished++
  itemEnd(url)
}

const ocean = new Ocean()
// AerialPerspective loads STBN lazily after the first shadowed frame when given
// a URL; a preloaded texture (same loader) keeps frame counts identical.
const stbn = new STBNLoader().load(ASSET_URLS.stbn)
let api: EarthTestApi | null = null

const Scene: FC<{ textures: PrecomputedTextures }> = ({ textures }) => {
  const { longitude, latitude, altitude } = state.location
  const controlsRef = useApplyLocation({ longitude, latitude, height: altitude })
  const atmosphereRef = useRef<AtmosphereApi>(null)
  const dateMs = useMemo(
    () => localDateMs(longitude, state.date.dayOfYear, state.date.timeOfDay),
    [longitude],
  )
  const { gl, camera, advance } = useThree()

  useFrame(({ gl }) => {
    gl.toneMappingExposure = state.toneMapping.exposure
  })
  useFrame(() => {
    atmosphereRef.current?.updateByDate(new Date(dateMs))
  })
  useFrame(({ camera }) => {
    ocean.update(camera as PerspectiveCamera)
  })

  useEffect(() => {
    let time = 0
    api = createTestApi(
      {
        gl,
        camera: camera as PerspectiveCamera,
        target: controlsRef.current!.target,
        render: () => advance((time += 1 / 60)),
        update: () => controlsRef.current!.update(),
        sunDirection: () => atmosphereRef.current!.sunDirection,
        dateMs: () => dateMs,
      },
      errors,
    )
  }, [gl, camera, advance, controlsRef, dateMs])

  const { enabled, coverage, quality } = state.cloud
  return (
    <>
      <OrbitControls ref={controlsRef} minDistance={1000} />
      <primitive object={ocean} />
      <Atmosphere ref={atmosphereRef} textures={textures} correctAltitude={state.atmosphere.correctAltitude}>
        <EffectComposer multisampling={0}>
          <Fragment key={JSON.stringify([enabled, true])}>
            {enabled && (
              <Clouds
                shadow-maxFar={1e5}
                coverage={coverage}
                qualityPreset={quality}
                localWeatherVelocity={state.cloud.animate ? [0.001, 0] : [0, 0]}
                localWeatherTexture={ASSET_URLS.localWeather}
                shapeTexture={ASSET_URLS.shape}
                shapeDetailTexture={ASSET_URLS.shapeDetail}
                turbulenceTexture={ASSET_URLS.turbulence}
                stbnTexture={ASSET_URLS.stbn}
              />
            )}
            <AerialPerspective sky sunLight skyLight stbnTexture={stbn} />
            <LensFlare />
            <ToneMapping mode={TONE[state.toneMapping.mode]} />
            <SMAA />
            <Dithering />
          </Fragment>
        </EffectComposer>
      </Atmosphere>
    </>
  )
}

const WithAtmosphereTextures: FC = () => {
  const gl = useThree(({ gl }) => gl)
  const generator = useMemo(() => new PrecomputedTexturesGenerator(gl), [gl])
  const [generated, markGenerated] = useReducer(() => true, false)
  useEffect(() => {
    generator
      .update()
      .then(() => markGenerated())
      .catch((e: unknown) => errors.push(String(e)))
  }, [generator])
  return generated ? <Scene textures={generator.textures} /> : null
}

createRoot(document.getElementById('root')!).render(
  <Canvas
    gl={{ depth: false, preserveDrawingBuffer: true }}
    camera={{ near: 1, far: 4e5 }}
    dpr={1}
    frameloop="never"
    style={test.size ? { width: test.size.width, height: test.size.height } : { width: '100vw', height: '100vh' }}
  >
    <WithAtmosphereTextures />
  </Canvas>,
)

// Ready once the LUTs exist and every texture has loaded (STBN for the aerial
// perspective, plus 4 cloud textures and the clouds' STBN when clouds are on);
// then render `frames`.
const expectedLoads = state.cloud.enabled ? 6 : 1
function poll(): void {
  const stbnLoaded = (stbn.image as { data?: unknown } | undefined)?.data != null
  if (api && stbnLoaded && loads.started >= expectedLoads && loads.finished === loads.started) {
    api.renderFrames(test.frames)
    api.ready = true
    window.__earth = api
    return
  }
  requestAnimationFrame(poll)
}
requestAnimationFrame(poll)
