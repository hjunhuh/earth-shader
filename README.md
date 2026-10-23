# earth-shader

Three.js(WebGL2)로 만든 3D 지구 렌더러입니다. 구글어스처럼 조작합니다. 지표는 전부 바다이며, 다음을 물리 기반으로 렌더합니다.

- 시간에 따라 변하는 대기 효과: 노을, 박명, 지구 그림자와 Belt of Venus, 명암 경계선
- 해가 비치는 구름: 스스로 그늘지고(self-shadowing), 바다에 그림자를 드리우며, 빛내림을 만듭니다.

우주(40,000 km)부터 해수면 50 m까지 하나의 렌더 경로를 씁니다. 지구, 하늘, 구름은 모두 풀스크린 패스에서 해석적으로 레이 트레이싱하며 래스터 메시는 없습니다.

런타임 의존성은 `three`와 `lil-gui`뿐입니다. 대기(Bruneton 2017 포팅)와 구름은 모두 직접 구현했습니다.

## 빠른 시작

```bash
npm install
npx playwright install chromium   # GPU / e2e 테스트용
npm run dev                       # http://localhost:5173
```

WebGL2와 `EXT_color_buffer_float`가 필요합니다. 첫 로딩 때 대기 LUT를 GPU에서 사전계산합니다(진행률 표시).

## 제어

### 패널 (lil-gui)

| 폴더 | 항목 | 설명 |
|---|---|---|
| location | `long`, `lat`, `altitude (m)` | 카메라 위치(측지 경위도, 타원체 기준 눈높이 50 m – 40,000 km). 값을 바꾸면 그 지점으로 이동합니다 |
| date | `timeofday` (0.0–24.0) | 현재 경도의 현지 시태양시(12.0 = 남중). 기본 8.0 |
| cloud | `enabled`, `quality` | 구름 켜기/끄기, `low / medium / high / ultra` (기본 high) |
| debug (접힘) | heading, tilt, autoExposure / EV100, coverage, wind (m/s), physical only, fps | 개발용 |

### 마우스와 키보드

| 입력 | 동작 |
|---|---|
| 왼쪽 드래그 | 잡은 지점이 커서 아래에 머무는 grab-pan(관성 포함) |
| 휠 / 핀치 | 커서 지점을 향한 줌 |
| 더블클릭 | 커서 지점으로 줌인 |
| 오른쪽·Ctrl·Shift 드래그 | 화면 중앙 지점을 축으로 tilt와 heading 회전(고도가 높을수록 tilt 한계가 줄어듦) |
| `N` | 북쪽 정렬 |
| `R` | tilt 0(수직 내려보기)으로 복귀 |

### URL 파라미터

`?lon=127&lat=37.5&alt=60&heading=270&tilt=86&tod=17.9&clouds=1&quality=high`

- 그 밖의 파라미터: `date=YYYY-MM-DD`, `coverage=0..1`, `exposure=EV100`, `seed=`, `wind=`
- 테스트 전용:
  - `test=1&frames=N&size=WxH&ui=1`
  - `physical=1`(미적 보정 항 끔), `ozone=0`, `shadows=0`
  - `weather=clear | slab:τ,bottom,top | blob:lat,lon,bottom,top,radius`

## 시간 모델 (가정)

- **내부 상태는 절대 UTC 시각**입니다. `timeofday`는 카메라 경도의 현지 시태양시로 표시되는 파생값입니다.
- `timeofday`를 편집하면 UTC가 바뀝니다.
- 지구를 드래그하면 UTC는 그대로이고, 명암 경계선은 지구에 고정된 채 표시값만 바뀝니다. 예를 들어 동쪽으로 15° 이동하면 표시가 1시간 늘어납니다.
- 날짜는 2026-03-20(춘분)으로 고정이며 UI에 노출하지 않습니다. URL `date=`로만 바꿀 수 있습니다.
- 태양 위치는 NOAA 알고리즘으로 계산합니다(NREL SPA 테스트 케이스와 0.05° 이내). 별은 GMST로 회전합니다.

## 아키텍처

```
[초기화]   Bruneton LUT: transmittance 256×64 · scattering 256×128×32 · irradiance 256×16 (RGBA32F, 태양 천정각 120°까지)
           구름 텍스처: 날씨 큐브맵 1024²(equi-angular) · Perlin-Worley shape 128³ · Worley detail 32³ (밉맵)
[태양 이동 시] 태양 광학깊이 큐브맵 256² (레이어 그룹별)
[매 프레임]
  1. LightShafts  1/4 해상도   그늘진 공기 비율 → Bruneton shadow_length
  2. Clouds       저해상도 + Bayer 지터   레이어 그룹별 세그먼트 마칭, 근거리 라이트 마칭 + 광학깊이 큐브맵
  3. Resolve      재투영 + variance clipping + 픽셀별 샘플 수 누적
  4. Background   바다(GGX 글린트, 하늘 반사, 구름 반사, 픽셀별 구름 그림자 마칭) / 하늘 / 태양 / 별
  5. Composite    HDR 합성 → GPU 노출 측광 → bloom → 태양 백색점 → AgX → dither
```

정밀도 설계:

- **Shading space** `M = diag(1, 1, a/b)`: WGS84 타원체를 반지름 a인 구로 정확히 펴서 광선이 직선으로 남습니다. 그래서 바다, 구름 구각, 대기가 지구 전역에서 일관되게 교차합니다.
- **카메라 상대 좌표**: CPU(float64)에서 카메라 위치와 ray–sphere `c` 항 `(|o|−R)(|o|+R)`를 계산해 넘깁니다. 셰이더의 광선 원점은 항상 0입니다.

| 경로 | 내용 |
|---|---|
| `src/geo/` | WGS84, shading space, 안정적 ray–sphere 교차 |
| `src/time/` | 태양 위치(NOAA), timeofday ↔ UTC |
| `src/camera/` | pose 기반 카메라 수학(pan/zoom/orbit/level), GlobeControls |
| `src/atmosphere/` | 대기 파라미터(3파장, 청명일 에어로졸), 휘도 변환 상수, LUT 사전계산, CPU 미러 |
| `src/clouds/` | 레이어 패킹, 품질 프리셋 → defines(순수 함수), 날씨, 지터, GPU 텍스처 굽기 |
| `src/render/` | 파이프라인, 풀스크린 패스, readback, 노출, bloom, `#include` 해석기 |
| `src/shaders/` | GLSL3: `common/`, `atmosphere/`, `clouds/`, `bake/`, `passes/`, `post/` |
| `src/app/` | 상태, URL, UI, 테스트 훅(`window.__earth`, test 모드에서만) |

## 품질 프리셋

| | low | medium | high | ultra |
|---|---|---|---|---|
| 구름 해상도 × 시간 업스케일 | 0.5 × 4×4 | 0.75 × 4×4 | 1 × 4×4 | 1 × 2×2 |
| 최대 1차 스텝 | 64 | 128 | 256 | 384 |
| 근거리 라이트 스텝 / 다중산란 옥타브 | 2 / 3 | 3 / 4 | 4 / 6 | 6 / 8 |
| 3D detail · 난류 | 끔 | 근거리만 | 켬 | 켬 |
| 바다 그림자 스텝 | 4 | 8 | 12 | 16 |
| 빛내림 샘플 | 끔 | 끔 | 64 | 128 |

## 테스트

```bash
npm run typecheck && npm test   # L1 unit (node)
npm run test:gpu                # L2 GPU unit (Vitest browser 모드, Chromium + ANGLE Metal)
npm run test:e2e                # L3 실측 (vite build + preview :4174 + Playwright)
npm run bench                   # L4 성능 (1080p)
npm run test:all                # L1–L3 전체
npm run test:e2e:ci             # SwiftShader(GPU 없는 CI)
```

| 계층 | 수 | 내용 |
|---|---|---|
| L1 unit | 138 | 측지·태양·시간·카메라·상태 수학, fast-check 속성 테스트, Bruneton CPU 적분기, 대기 몬테카를로, 구름 조명 레퍼런스 |
| L2 GPU | 27 | GLSL–TS parity, LUT를 CPU 적분과 몬테카를로로 대조, 절차 텍스처, 광학깊이 큐브맵 해석해, 셰이더 컴파일 매트릭스(프리셋 × 날씨 × 플래그) |
| L3 실측 | 44 | 아래 표, 조작, 안정성, UI, 골든 이미지 12장(SSIM ≥ 0.98, 음성 대조 포함) |
| L4 성능 | 4 | 프리셋별 최악 장면 예산 |

### 실측 검증 (렌더 결과 vs 관측값과 해석해)

| 측정 | 기준 |
|---|---|
| 해수면 수평 조도(태양고도 60°/30°/10°/5°) | 일광 표 대역 ±0.15 dex |
| 박명 조도(−0.83°/−6°/−12°) | AMS 값 ±0.4 dex |
| 천정 휘도 | Krochmann–Seidl과 Preetham(T = 2.5) 사이, ×/÷1.5 |
| 직달광 CCT | 태양 60°: 4,800–6,200 K, 10°: 2,800–4,500 K, 2°: 1,500–2,800 K |
| 박명 천정 청색화 | `ozone=0`이면 실패(음성 대조) |
| 노을 지평선 R/B > 1.5, 일몰 후 반태양 쪽 지구 그림자와 분홍 띠 | 렌더 프레임 측정 |
| 명암 경계선 | 렌더 휘도와 CPU 조도 모델의 일관성 |
| 정지궤도에서 본 바다(글린트 밖) | TOA 반사율 0.03–0.12 |
| 구름 반사율(슬랩 τ = 5…50) | Lacis–Hansen ±0.1 |
| 8 km / 1.5 km 구름 꼭대기 잔광 | 기하학적 dip −√(2h/R) 근처까지 붉게 빛남 |
| 구름 그림자 위치 | `h / tan e` 거리, 반태양 방위. `shadows=0`이면 실패(음성 대조) |
| 빛내림 | 그늘진 공기의 산란 감소. 맑은 하늘이 음성 대조 |
| 셀프섀도 / silver lining | 태양 쪽 면 ≥ 2× 반대쪽 / 역광 가장자리 > 중심 |
| 시간 안정성 / 고스팅 | 정지 시 프레임 간 < 0.5%, 이동 16프레임 후 콜드 스타트 수준 |

### 성능 (1920×1080, Apple M3 Pro, readPixels 동기화 벽시계)

| 프리셋 | 우주 | 궤도 | 구름 위 | 저고도 노을 | 구름층 안 | 예산 |
|---|---|---|---|---|---|---|
| low | 2.0 | 2.8 | 3.8 | 3.1 | 3.2 | 8 ms |
| medium | 2.9 | 4.3 | 5.7 | 4.5 | 5.0 | 11 ms |
| high | 4.0 | 6.4 | 8.8 | 10.1 | 12.0 | 16.7 ms |
| ultra | 5.1 | 11.1 | 15.6 | 23.7 | 27.4 | 33 ms |

구름을 끄면 모든 장면이 1.2–1.8 ms입니다. ANGLE/Metal에서는 타이머 쿼리가 패스를 분리하지 못하므로 측정에 벽시계를 씁니다.

### 골든 이미지 갱신

의도한 시각 변경 후에는 `UPDATE_GOLDEN=1 npx playwright test --project=metal tests/e2e/golden.spec.ts`를 실행합니다. 실패하면 `tests/e2e/__golden__/*.actual.png`가 남습니다.

## 보정과 알려진 한계

- **대기**:
  - Bruneton 기본 에어로졸은 관측보다 지나치게 맑습니다. 그래서 청명일 프리셋(Ångström β = 0.04, α = 1.3, g = 0.76)으로 보정했습니다.
  - 휘도 변환은 Bruneton 데모의 approximate 상수를 CIE 1931과 ASTM G-173으로 재현해 씁니다.
- **구름 조명**: 다중산란 옥타브와 확산 항의 상수(msA 0.1, diffusion 0.80)는 Lacis–Hansen 슬랩 반사율에 맞춰 보정했습니다. `physical=1`이면 Beer-Powder 같은 미적 항이 꺼집니다.
- **노출**: 자동 노출은 장면 휘도 측광과 입사광 기준을 섞습니다. 우주 시점에서는 낮 EV 범위로 고정합니다.
- **알려진 현상**:
  - 우주에서 본 sun glint 근처의 작은 어두운 점은 작은 구름의 그림자입니다.
  - 흐린 날 노을의 지평선에 보이는 가는 선은 물리적으로 맞는 결과입니다.
- **그 밖의 한계**:
  - 날짜는 고정입니다.
  - 날씨는 절차적 기후대 모델이며 실제 기상 데이터가 아닙니다.
  - 바람에 따른 구름 이동은 debug 항목입니다.

## 라이선스

대기 산란 코드는 Eric Bruneton의 *Precomputed Atmospheric Scattering*(BSD-3-Clause)을 포팅했습니다. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.
