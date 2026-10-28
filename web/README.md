# web — Next.js 웹앱

- Step 4에서 생성 (Next.js App Router + TypeScript + shadcn/ui + MapLibre GL)
- Vercel 배포 대상: 프로젝트 설정의 **Root Directory = `web`**
- 화면 구성: docs/GUIDE.md §4.2.2 (`/`, `/replay`, `/analysis`, `/run`, `/compare`, `/validation`, `/about`)
- 환경변수는 `web/.env.local` (커밋 금지), 예시는 `.env.example`

## 지금 상태 (2026-10-28)

- 배포 주소를 먼저 확보하려고 임시 정적 페이지 `index.html`만 두고 Vercel 프리셋 **Other**로 첫 배포한다.
- Next.js 앱을 이 폴더에 만들면: `index.html`을 지우고, Vercel 프로젝트 Settings → Build and Deployment → Framework Preset을 **Next.js**로 바꾼다.
