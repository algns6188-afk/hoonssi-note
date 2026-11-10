# 훈씨노트

팀 업무를 한곳에서 정리하는 PC 프로그램 (Windows · Mac)

- **회의록**: 녹음 → 텍스트 변환 → AI 요약·분석 → Slack / Teams / 카카오톡으로 결과 전송
- **업무 노트**: 메모, 거래처, 프로젝트 노트 (태그 · 검색)
- **할 일**: 회의에서 나온 할 일이 담당자·기한과 함께 자동 등록
- **홈**: 진행 중·기한 지난 할 일, 최근 회의를 한눈에

![홈](docs/home.png)
![회의록](docs/meeting.png)

## 실행 방법

[Node.js](https://nodejs.org) 20 이상을 설치한 뒤:

```bash
npm install
npm run dev        # 개발 모드로 실행
npm run dist:win   # Windows 설치 파일 만들기 (release 폴더)
npm run dist:mac   # Mac 설치 파일 만들기 (Mac에서 실행)
```

GitHub의 main 에 코드가 올라갈 때마다 Windows·Mac 설치 파일이 자동으로 만들어져
**Releases** 페이지에 올라갑니다 (`.github/workflows/build.yml`). 릴리스 이름은 `package.json` 의 `version` 을 따릅니다.

> 설치 파일은 아직 코드 서명이 없어서 처음 실행할 때 경고가 뜹니다.
> - Windows: "Windows의 PC 보호" → **추가 정보** → **실행**
> - Mac: 앱을 **우클릭 → 열기** (또는 시스템 설정 → 개인정보 보호 및 보안 → "확인 없이 열기")

## 처음 설정 (설정·연동 메뉴)

| 항목 | 용도 | 받는 곳 |
|---|---|---|
| Claude API 키 | 회의 요약·분석 | console.anthropic.com |
| OpenAI API 키 | 녹음 → 텍스트 변환 | platform.openai.com |
| AI 모델 선택 | 정확도와 비용 조절 (Opus / Sonnet / Haiku, 음성 인식 모델) | 설정 화면 |
| Slack 웹훅 | 채널로 결과 전송 | Slack 앱 → Incoming Webhooks |
| Teams 웹훅 | 채널로 결과 전송 | Teams 채널 → 워크플로 → "웹후크 요청이 수신되면 채널에 게시" |
| 카카오 액세스 토큰 | 카카오톡 나에게 보내기 | developers.kakao.com (카카오톡 메시지 동의 항목) |

각 연동에 "AI 정리가 끝나면 자동 전송"을 켜 두면 분석이 끝나자마자 바로 보내집니다.

## 구조

```
src/
  main/            Electron 메인 프로세스
    index.ts       창, IPC, 시스템 소리 캡처
    store.ts       저장소 (지금: PC 안 JSON, 다음: 공유 서버) · 키 암호화
    services/
      transcribe.ts  OpenAI 음성 인식 (10분 단위 파일)
      analyze.ts     Claude 회의 분석 (구조화된 JSON 결과)
      send.ts        Slack / Teams / 카카오톡 전송
  preload/         화면 ↔ 메인 연결 (window.api)
  renderer/        React 화면 (홈, 회의록, 업무 노트, 할 일, 설정)
  shared/types.ts  공통 데이터 형식
```

## 로드맵

- [x] 1단계: 업무 노트 · 할 일 · 홈
- [x] 2단계: 녹음 → 텍스트 변환 → AI 요약·분석
- [x] 3단계: Slack / Teams / 카카오톡(나에게) 전송
- [ ] 4단계: 팀 공유 서버(Supabase) · 로그인 · 권한
- [ ] 카카오 알림톡(팀원에게 전송), 화자 구분, 기존 녹음 파일 불러오기, 일정 연동
