# .claude/skills — 반복 절차

> **역할** 개발에 쓴 AI 코딩 도구(Claude Code)가 같은 작업을 같은 방법으로 하도록 적어 둔 절차서. 사람이 읽어도 작업 순서를 알 수 있습니다.

| 절차 | 하는 일 |
|---|---|
| [`hdf-to-web`](hdf-to-web/SKILL.md) | HEC-RAS 결과(HDF)를 웹 자료로 변환하고 기준값과 대조 |
| [`hecras-run`](hecras-run/SKILL.md) | HEC-RAS 계산 1건 실행(입력 배율·조위 반영 → Ras.exe → 변환·업로드)과 결과 확인 |
| [`deploy`](deploy/SKILL.md) | 웹·데이터·DB 변경 배포(Vercel, Supabase)와 배포 화면 확인 |
| [`ai-log`](ai-log/SKILL.md) | 작업 단계가 끝날 때 AI 활용 기록과 진행 현황 갱신 |

작업 전체의 지침은 저장소 루트의 `CLAUDE.md`에 있습니다.
