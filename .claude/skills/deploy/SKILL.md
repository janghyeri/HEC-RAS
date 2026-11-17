---
name: deploy
description: 웹(Next.js)·데이터·DB 변경을 배포하고 배포 화면에서 확인한다 (Vercel GitHub 연동, Supabase 마이그레이션). 코드나 web/public/data를 바꾼 뒤 사용.
---

# 배포와 확인

1. 커밋 전
   - 키·비밀값·HEC-RAS 원자료(*.hdf, *.dss, *.tif)가 들어가지 않았는지 `git status`로 본다 (.gitignore, `web/.env.local`, `worker/.env`).
   - 셰이더(`web/public/view3d/*.js`)를 고쳤으면 `node --check`로 문법을 보고, 가능하면 배포 화면에 같은 셰이더를 시험으로 넣어 그리기 오류가 없는지 먼저 본다.
2. 배포
   - `main`에 push하면 Vercel이 배포한다 (Root Directory `web`, 프로젝트 `hinnamno-flood`). 환경 변수(브이월드 키, Supabase 공개 키)는 Vercel에만 있다.
   - DB: `supabase/migrations/`에 **새 파일**을 더해 push (이미 적용된 파일은 고치지 않는다).
   - `web/public/data`의 결과를 바꿨으면 `index.json`의 해당 결과 `generated_at`을 바꿔 브라우저 캐시를 넘긴다 (`/data`는 1시간 캐시).
3. 배포 확인 (배포 주소)
   - `/3d` HTML의 `view3d.js?v=<커밋 앞 8자>`가 새 커밋인지 확인한 뒤 새로 고친다.
   - `/3d`: 그리기 오류(`scene.renderError`) 없음, 최대 침수심·시간대별 재생, 물 높이 3D, 건물. 숨은 브라우저 창에서는 `viewer.render()`를 직접 불러야 그려진다.
   - `/`: 최대 수심 타일·시간 재생, `/analysis`: 비교·표, `/run`: 계산 서버 표시.
   - 웹 계산 결과(`/?run=<번호>`)는 Supabase Storage에서 읽는다.
4. 기록: `../../1. 과정/02_AI 활용 기록.md`에 한 줄, 설계가 바뀌면 `docs/GUIDE.md`와 로컬 '00_프로젝트 가이드라인.md' 둘 다.
