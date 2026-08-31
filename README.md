# Notion Paper Roadmap

Notion 팀스페이스에 임베드하여 사용하는 논문·개념 로드맵입니다.

이 프로젝트는 Notion 전용으로 제작되었으며, Vercel을 통해 배포 중입니다.

- 배포 사이트: [https://notion-paper-roadmap.vercel.app](https://notion-paper-roadmap.vercel.app)

## 전문가 정적 로드맵

- 정적 웹: [`expert-paper-roadmap.html`](./expert-paper-roadmap.html)
- 구성: 13개 분야, 103개 개념 노드, 112개 방향성 관계
- 논문: 제목 표기 210개를 원문 식별자로 다시 합쳐 실제 논문 209편을 arXiv·DOI·공식 출판사 링크로 연결
- 동작: 분야별 탐색, 점선 포털, 노드 이동, AI 추천 배치, 원문 바로가기
- 데이터는 기본적으로 읽기 전용 스냅샷이며 개인 노드 위치만 브라우저에 저장됩니다.

## 전문가 로드맵 → Notion 가져오기

배포된 전문가 로드맵의 상단 메뉴에서 `Notion으로 보내기`를 누르면 선택 노드, 현재 분야, 전체 로드맵 중 하나를 고를 수 있습니다.

1. `미리보기`가 논문·개념·개념 관계 DB 전체를 읽고 신규·재사용·검토 보류를 계산합니다.
2. 사용자가 `후보 데이터 생성 승인`을 눌러야 실제 쓰기가 시작됩니다.
3. 논문 → 개념 → 관계 → 논문 매칭 상태 순서로 작은 배치가 처리됩니다.
4. 중단 지점은 브라우저에 저장되어 같은 화면에서 이어갈 수 있습니다.
5. 생성된 항목은 전부 `후보`이며 승인·병합·삭제는 자동으로 수행하지 않습니다.

관계는 대표 논문을 근거로 가장하지 않습니다. 처음에는 `근거 유형=로드맵 편집 판단`, `근거 검토 상태=미검토`로 기록됩니다. 가져오기가 끝나면 노드와 연결 논문 목록에 각 Notion 페이지 바로가기가 추가됩니다.

- 가져오기 명세: [`expert-paper-import-manifest-2026-09-01.json`](./expert-paper-import-manifest-2026-09-01.json)
- 미리보기 API: `POST /api/import/preview`
- 적용 API: `POST /api/import/apply`
- 재생성: `npm run build:import-manifest`

Notion 토큰은 HTML이나 저장소에 넣지 않고 Vercel의 `NOTION_TOKEN` 환경 변수에만 둡니다. 두 API 모두 기존 `ROADMAP_WRITE_KEY`를 요구합니다.
