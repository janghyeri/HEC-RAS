# web — 힌남노 침수 다시보기 웹앱

Next.js(App Router, TypeScript)로 만든 웹앱입니다. 배포 주소는 https://hinnamno-flood.vercel.app 이고,
GitHub의 `main`에 올리면 Vercel이 이 폴더(`web`)를 빌드해 자동으로 배포합니다.

## 화면

| 주소 | 화면 | 코드 |
|---|---|---|
| `/` | 침수 지도 — 최대 침수심, 10분 재생, 주소 검색, 지점 수심 그래프, 주요 결과 표 | `components/FloodMapApp.tsx` |
| `/run` | 조건 설정·실행 — 계산 요청, 진행 상태·로그, 계산 서버 상태 | `components/RunApp.tsx`, `lib/supabase.ts` |
| `/analysis` | 분석·비교 — 두 결과 비교, 증감표, 원인 지도, 기간·단면별 그래프 | `components/AnalysisApp.tsx` |
| `/3d` | 3D 재현 — 물 높이, 건물 잠김, 흐름 보기 | `app/3d/route.ts`, `public/view3d/` |
| `/validation` | 검증 — 하천 흔적수위 비교, 변환·재현성 표 | `components/ValidationApp.tsx` |

`/3d`는 브이월드 3D 지도의 초기화 스크립트가 `document.write`를 써서 React 페이지가 아니라 HTML을 직접 돌려줍니다.
3D 화면을 고치면 배포 화면에서 그리기 오류가 없는지 꼭 확인합니다(오류가 나면 3D 화면이 갱신을 멈춥니다).

## 로컬에서 실행

Node.js 20 이상이 필요합니다.

```
cd web
npm install
npm run dev            # http://localhost:3000
```

환경 변수는 `.env.example`을 `.env.local`로 복사해 넣습니다. 없어도 지도·비교·검증 화면은 미리 계산한 자료로 동작합니다.

| 변수 | 쓰는 곳 | 없으면 |
|---|---|---|
| `NEXT_PUBLIC_VWORLD_KEY` | 항공사진 배경지도, 3D 지도, 주소 검색 | 배경지도가 OpenStreetMap으로 바뀌고 3D·주소 검색이 안 됨 |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 계산 요청, 웹 계산 결과 목록 | 계산 요청 화면이 동작하지 않음 |

브이월드 키는 발급할 때 등록한 주소에서만 동작하므로 개발용(`http://localhost:3000`)과 배포용 키를 따로 받습니다.
Supabase 공개(anon) 키는 브라우저에 보여도 되는 키이고, 무엇을 할 수 있는지는 DB 권한 규칙이 정합니다.

## 결과 자료

미리 계산한 결과는 `public/data/v1/`에 들어 있습니다(외수만 `S0-E`, 외수 + 내수 `S0-C`, 맨홀 ×0.5 `S2-mh050`, 맨홀 ×1.5 `S2-mh150`).
웹에서 새로 계산한 결과는 Supabase Storage의 `results/v1/run-<번호>/`에서 읽고, 지도에서는 `/?run=<번호>`로 엽니다.
화면은 셀 수·시각·조건 범위를 코드에 적지 않고 `index.json`, `mesh.json`, `meta.json`, `model.json`에서 읽습니다.

자료를 다시 만들 때는 저장소 루트에서 `pipeline/`을 씁니다([`pipeline/README.md`](../pipeline/README.md)).
결과 자료를 바꾼 뒤에는 `public/data/index.json`의 `generated_at`을 올려야 배포된 화면에서 예전 자료가 캐시로 남지 않습니다.

## 그 밖에

- 휴대폰에서는 지도 아래에서 올라오는 시트 화면으로 바뀌고, '홈 화면에 추가'로 앱처럼 열 수 있습니다(`app/manifest.ts`).
- 계산 요청의 조건 해시는 계산 PC의 `worker/hecras_job.py`와 같은 규칙으로 만듭니다(`lib/runConfig.ts`). 한쪽을 바꾸면 다른 쪽도 바꿔야 같은 조건을 알아봅니다.
- 첫 코드를 패키지 설치가 막힌 환경에서 작성해 `next.config.mjs`에서 빌드 중 타입 검사를 건너뛰게 해 두었습니다. `npx tsc --noEmit`으로 따로 확인합니다.
