# worker — HEC-RAS 실행 워커 (Windows)

- Step 5에서 작성. HEC-RAS 6.6이 설치된 Windows PC에서 실행
- 흐름: Supabase 대기 작업 조회 → `Pohang_web` 구조째 작업 폴더 복사 → `u01` 배율 적용 → HEC-RAS 계산 → `pipeline` 변환 → 업로드
- 설계: docs/GUIDE.md §4.3.1–4.3.2
- 작업 폴더(`worker/jobs/`)와 HEC-RAS 원자료는 커밋하지 않음
