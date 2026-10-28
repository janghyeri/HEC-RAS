# web — 힌남노 침수 다시보기 (Next.js)

- 배포: https://hinnamno-flood.vercel.app (Vercel 프로젝트 `hinnamno-flood`, Root Directory `web`, `vercel.json`에서 framework = nextjs)
- 화면: `/` 2D 최대 침수심 지도 (docs/PRD.md F-01). 이후 `/replay`, `/analysis`, `/run`, `/compare` (docs/GUIDE.md §4.2.2)
- 지도: MapLibre GL + 브이월드 WMTS(항공사진·지명·일반지도). 키가 없으면 OpenStreetMap
- 자료: `public/data/<모형 버전>/` — `python -m pipeline.publish_web --src data/out --dst web/public/data --model-version v1`로 만든다 (저장소 루트에서). 코드에 모형 값을 넣지 않고 `index.json`·`mesh.json`·`meta.json`에서 읽는다
- 휴대폰: 아래 시트 화면, PWA(`app/manifest.ts`, `public/icons/`) — "홈 화면에 추가"로 앱처럼 연다

## 로컬 실행

```
cd web
copy .env.example .env.local      # NEXT_PUBLIC_VWORLD_KEY= 에 개발용 키 (서비스 URL http://localhost:3000)
npm install
npm run dev                       # http://localhost:3000
npm run check-data                # 셀 찾기·셀 값이 원자료와 같은지 (data/out 필요)
```

## 남은 정리

- 첫 코드는 npm 설치가 막힌 환경에서 작성해 `next.config.mjs`에서 타입 오류 무시(`ignoreBuildErrors`)를 임시로 켰다.
  로컬에서 `npx tsc --noEmit`이 통과하면 끈다.
- shadcn/ui는 로컬에서 CLI로 추가한다 (대시보드 Step 6).
