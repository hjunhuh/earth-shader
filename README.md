# earth-shader

three.js로 만든 3D 지구입니다. 렌더링과 조작은 takram [three-geospatial](https://github.com/takram-design-engineering/three-geospatial)의 `clouds/Clouds/Basic` 예제와 같습니다. 예제에 없는 것은 기본 바다색 지표 하나입니다.

- **렌더링**: `@takram/three-atmosphere`(Bruneton 대기), `@takram/three-clouds`(볼류메트릭 구름, 구름 그림자, 빛내림), `@takram/three-geospatial-effects`(LensFlare, Dithering)를 React 없이 순수 three.js로 씁니다. 효과 순서와 노출(10, AgX)은 예제와 같습니다.
- **조작**: drei `<OrbitControls minDistance={1000} />`와 같은 three-stdlib `OrbitControls`를 같은 설정(감쇠 켬)으로 씁니다.
- **값 고정**: 패널의 location·date·cloud 값은 입력값입니다. 마우스로 시점을 움직여도 바뀌지 않습니다.

## 빠른 시작

```bash
npm install
npx playwright install chromium   # GPU / e2e 테스트용
npm run dev                       # http://localhost:5173
```

WebGL2와 `EXT_color_buffer_float`가 필요합니다. 대기 LUT는 시작할 때 GPU에서 생성합니다(takram `PrecomputedTexturesGenerator`). 구름 텍스처는 takram 기본 URL의 파일과 같은 사본을 `public/takram/`에서 읽습니다.

## 조작

### 패널

| 폴더 | 항목 | 기본값 |
|---|---|---|
| location | `longitude`, `latitude`, `altitude`(m, 0–30,000): 시점이 회전하는 중심 지점 | 30, 35, 300 |
| date | `timeOfDay`(0–24, 위치 경도의 지방 평균시), `dayOfYear` | 8.0, 1 |
| cloud | `enabled`, `quality`(low/medium/high/ultra), `coverage`, `animate` | on, high, 0.3, off |
| tone mapping(접힘) | `mode`, `exposure` | AgX, 10 |
| atmosphere(접힘) | `correctAltitude` | on |

`dayOfYear` 기본값이 1인 이유: 예제 코드는 `dayOfYear: 0`을 넘기지만 leva가 최솟값 1로 고정하므로, 실제로 렌더되는 값은 1입니다. 시각 계산식은 예제의 `useLocalDateControls`와 같습니다(`UTC = 1월 1일 + dayOfYear일 + timeOfDay − 경도/15`). 연도는 2026으로 고정했습니다.

값을 바꾸면 시간과 노출은 예제처럼 스프링(질량 1, 감쇠 20)으로 부드럽게 따라갑니다. location을 바꾸면 카메라가 지역 지평선에 대한 상대 자세를 유지한 채 새 지점으로 이동합니다(예제의 `useApplyLocation`).

### 마우스

| 입력 | 동작 |
|---|---|
| 왼쪽 드래그 | location 지점을 중심으로 회전(감쇠) |
| 오른쪽 드래그 | 화면 평면 이동 |
| 휠 | 거리 조절(최소 1,000 m, 최대 제한 없음) |

### URL

`?lon=127&lat=37.5&alt=1000&doy=170&tod=17.5&clouds=1&quality=high&coverage=0.3&exposure=10`

- 테스트 전용: `test=1&frames=N&size=WxH&ui=1`
- 테스트 모드의 동작:
  - `window.__earth` 훅을 노출합니다.
  - 고정 1/60초 간격으로 프레임을 렌더합니다.
  - 스프링 애니메이션 없이 값이 바로 적용됩니다.

## 구성

```
RenderPass (Ocean)                            해석적 바다 표면, 정확한 깊이 기록
EffectPass [CloudsEffect, AerialPerspective]  구름 + 하늘·태양·달 + 조명(sunLight, skyLight) + 구름 그림자·빛내림
EffectPass [LensFlare]
EffectPass [ToneMapping(AgX)]
EffectPass [SMAA]
EffectPass [Dithering]
```

패스는 takram storybook이 쓰는 `@react-three/postprocessing` 3.0.4와 같은 규칙으로 나눕니다. 컨볼루션 효과는 각자 별도 패스이고, 나머지는 이어지는 효과끼리 하나로 합칩니다.

| 경로 | 내용 |
|---|---|
| [src/scene/EarthScene.ts](src/scene/EarthScene.ts) | 렌더러, 카메라, OrbitControls, 컴포저, takram 효과, 프레임 순서 |
| [src/scene/Ocean.ts](src/scene/Ocean.ts) | WGS84 타원체를 레이 트레이싱해 깊이를 쓰는 바다(알베도만 출력하고, 조명은 takram이 계산) |
| [src/scene/oceanMath.ts](src/scene/oceanMath.ts) | 교차 계산의 TS 쌍둥이, CPU float64 c항, 클립 평면 정책 |
| [src/scene/spaceViewFix.ts](src/scene/spaceViewFix.ts) | 대기권 밖 시점 보정(아래 참고) |
| [src/app/](src/app/) | 상태, URL, lil-gui 패널, `applyLocation`·`localDate`(예제 포팅), 스프링, 테스트 훅 |
| [tests/reference/takram.tsx](tests/reference/takram.tsx) | **실제** takram 예제를 React/R3F로 띄우는 비교 기준 페이지(테스트 빌드 전용) |

### 예제와 다른 점

1. **바다**: 예제에는 지오메트리가 없습니다. 바다는 깊이를 기록하므로, takram AerialPerspective가 바다를 일반 지오메트리로 보고 조명·구름 그림자·대기 원근을 적용합니다. 바다는 `OCEAN_ALBEDO`의 Lambert 표면입니다.
2. **클립 평면**: 예제는 near 1 / far 4e5로 고정합니다. 여기서는 카메라 고도 약 8.7 km까지 같은 값을 쓰고, 그보다 높으면 far를 수평선 거리의 1.2배로 늘려 바다가 잘리지 않게 합니다.
3. **우주 시점 보정**: takram 0.19.1은 `GetSkyRadiance`에서 `sqrt`를 `SafeSqrt`로 바꿨습니다(three-geospatial PR #26). 그 결과 카메라가 대기권(약 60 km) 위에 있으면 검어야 할 우주가 파란 하늘로 칠해집니다. 이 경우에만 0을 반환하는 조기 반환을 셰이더 문자열에 삽입합니다. 대기권 안 시점에는 영향이 없으며, 예제의 모든 시점이 여기에 해당합니다.

## 테스트

```bash
npm run typecheck && npm test   # 단위 (node)
npm run test:gpu                # GPU 단위 (Vitest 브라우저 모드, Chromium + ANGLE Metal)
npm run test:e2e                # e2e (앱 + takram 기준 페이지 빌드 → vite preview :4174 → Playwright)
npm run bench                   # 1080p 성능
npm run test:all
```

| 계층 | 수 | 내용 |
|---|---|---|
| 단위 | 34 | 시각 공식(astronomy-engine으로 남중 검증), `applyLocation`(예제 첫 화면 재현), 스프링(ODE 대조), 바다 교차(float32 안정성), 상태·URL, 패스 분할, 우주 보정 |
| GPU | 5 | 바다 셰이더가 쓴 깊이가 TS float64 해석해와 일치(4개 시점, 오차 < 5e-7) |
| e2e | 36 | 아래 항목 |
| 성능 | 4 | 품질별 1080p 프레임 시간 예산 |

e2e 항목:

- **렌더링 일치**: 앱과 takram 기준 페이지가 같은 입력으로 렌더한 8비트 화면을 비교합니다.
  - 10개 장면: 시각, 해를 향한 시점, 구름 끔, 품질 4종, coverage, 서울/하지
  - 모든 장면에서 평균 차이 ≤ 0.0007/255, 최대 차이 4/255
  - 음성 대조: 6분 시각 이동과 0.5 EV 노출 변화는 차이로 잡아냅니다.
- **조작 일치**: 같은 마우스 입력(회전, 이동, 휠, 최소 거리, 혼합)을 프레임 단위로 재생합니다. 카메라 위치·타깃이 1 µm, 회전이 1e-9 이내로 같습니다.
- **값 고정**: 드래그와 휠 뒤에도 패널 값, 노출, 시각, 태양 방향이 그대로입니다.
- **태양**:
  - 방향이 astronomy-engine과 0.25° 이내로 맞습니다.
  - 시작 화면에 보이고, 포화된 원반과 글레어가 있습니다.
  - 밤에는 사라지고, 시각에 따라 뜨고 집니다.
- **구름**:
  - 바다에 그림자를 드리웁니다(coverage 0이면 없음).
  - 런타임에 켜고 끈 결과가 처음부터 그 상태로 시작한 결과와 같습니다.
  - 품질 4종이 모두 렌더됩니다.
- **안정성**: 궤도 고도에서 바다가 보이고 우주는 검습니다. 보정 전 takram은 파랗게 나오며, 이것이 음성 대조입니다.
- **패널**: 필수 컨트롤이 있고, 편집이 장면에 반영되며, 일반 모드로 부팅했을 때 오류가 없습니다.

### 성능 (1920×1080, Apple M3 Pro, readPixels 동기화 벽시계, 단위 ms)

| 품질 | 기본 시점 | 정오 | 내려다보기(coverage 0.6) | 일몰(해 방향) | 예산 |
|---|---|---|---|---|---|
| low | 4.4 | 4.1 | 4.0 | 4.1 | 8 |
| medium | 5.4 | 4.7 | 5.1 | 5.4 | 11 |
| high | 9.6 | 7.5 | 7.9 | 9.2 | 16.7 |
| ultra | 18.5 | 12.7 | 15.0 | 16.9 | 33 |

## 이전 구현

직접 구현했던 이전 렌더러(자체 Bruneton 포팅, 구름, 컨트롤)는 커밋 `3f9fd45`에 있습니다. 같은 내용을 `.backup/custom-renderer-2026-10-23.tar.gz`에도 보관했습니다. 이 파일은 git에 포함되지 않습니다.

## 라이선스

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요. takram three-geospatial은 MIT이고, Bruneton 대기 모델은 BSD-3입니다.
