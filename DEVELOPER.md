# DroidBridge 개발자 가이드

DroidBridge는 Electron으로 만든 Android QA 데스크톱 앱이다. Windows·macOS·Linux에서 실행하며, Android 기기는 USB 또는 ADB 무선 연결로 제어한다. UI·로그·주석은 한국어로 작성한다.

## 구조

```text
public/renderer.js ── window.db ──> src/preload.js ── IPC ──> src/main.js
       │                                                    ├─ ADB 명령 실행
       └─ WebSocket ──> src/mirror-bridge.js ───────────────┤
                 Android scrcpy-server 영상·제어 소켓       ├─ Jira Cloud REST v2
                                                            └─ MITM 프록시
```

- `src/main.js`: Electron 창, ADB 프로세스, IPC 핸들러와 운영체제 클립보드 관리.
- `src/preload.js`: 렌더러에 필요한 API만 `contextBridge`로 노출.
- `src/mirror-bridge.js`: `scrcpy-server.jar`를 Android에서 실행하고 영상·제어 프로토콜을 로컬 WebSocket으로 중계.
- `src/hid-keyboard.js`: UHID 물리 키보드 리포트와 `KeyboardEvent.code` 매핑. Electron 없이 단독 진단 가능.
- `src/jira.js`: Jira Cloud REST v2 호출과 진단.
- `src/proxy-server.js`, `src/cert-manager.js`: 패킷 분석 프록시와 인증서 관리.
- `public/index.html`, `public/style.css`, `public/renderer.js`: 단일 클래식 스크립트 기반 UI. 모듈 시스템은 없다.

화면은 도구·기기 화면·LogCat의 3컬럼이다. DOM 순서는 device → logcat → tool이고 CSS `order`로 화면 위치를 정하므로 레이아웃 변경 시 두 파일을 함께 확인한다.

## 핵심 동작

### 미러링과 입력

scrcpy 실행파일을 띄우지 않는다. `scrcpy-server.jar`를 기기에 복사해 `app_process`로 실행한 뒤, ADB forward로 영상 소켓과 제어 소켓을 연결한다. `mirror-bridge.js`가 영상 프로토콜을 파싱하고 WebSocket으로 전달하며 렌더러가 WebCodecs로 `<canvas>`에 그린다.

`session_meta`의 해상도 블록은 서버 빌드마다 8바이트 또는 12바이트 레이아웃이 관측됐다. 길이를 상수로 고정하지 말고 `parseSessionMeta()`와 자가진단 케이스를 함께 유지한다. `rotTransform()`과 `unrotate()`는 보기 회전 및 터치 좌표 변환의 한 쌍이다.

키보드는 UHID 물리 키보드 에뮬레이션을 우선 사용하고 `/dev/uhid`를 사용할 수 없는 기기에서는 클립보드 입력 방식으로 폴백한다. UHID는 `KeyboardEvent.code`로 키를 보내 문자 조합은 Android IME에 맡긴다. 한/영·한자 키는 확장 HID 디스크립터와 탭 형식 입력을 사용한다.

### 클립보드 동기화

미러링 중 텍스트 클립보드를 PC와 Android 사이에서 양방향으로 동기화한다. PC 쪽은 Electron 클립보드를 약 500ms 간격으로 확인하고, 변경된 텍스트를 scrcpy `SET_CLIPBOARD` 제어 메시지로 보낸다. 기기 쪽 클립보드 메시지는 제어 소켓의 역방향 스트림에서 파싱해 PC 클립보드에 반영한다.

동기화는 텍스트만 지원하며 최대 크기는 1MiB다. scrcpy 시퀀스 번호로 PC에서 보낸 클립보드 에코를 걸러내고, Android에서 받은 텍스트를 PC에 기록할 때 마지막 값을 동기화 상태에 반영해 반복 전송도 막는다. 제어 소켓은 여러 메시지가 한 청크에 붙거나 한 메시지가 여러 청크로 나뉠 수 있으므로 버퍼링 파서를 유지한다.

### 화면 녹화

`adb:record-start`는 `screenrecord` 프로세스가 바로 종료되거나 실행에 실패하면 오류를 반환한다. 녹화 종료 시 Android의 `screenrecord`에 SIGINT를 보내고 종료를 기다린 후 저장 대화상자를 띄워 PC로 가져온다. 정상 종료 대기 제한은 15초다. 저장 완료 경로는 렌더러의 녹화 상태 영역에 남고 복사할 수 있다. Android 녹화 한도는 3분이다.

녹화 정지 전에 로컬 ADB 프로세스를 종료하면 MP4 마무리 정보가 빠질 수 있다. 종료 순서를 바꾸지 말고 `waitRecordingExit()` 경로를 유지한다.

### LogCat과 Jira

`adb logcat -v threadtime -T 200`의 청크는 줄 중간에서 끊길 수 있다. 렌더러의 `logcatPending`이 이어 붙이고, 화면에는 최근 3,000줄만 둔다. 현재 앱 필터·레벨·검색·프리셋을 함께 유지한다.

Jira는 REST API v2를 사용한다. 자격 증명은 Electron `safeStorage`로 암호화해 사용자 데이터 폴더에 보관하며, 렌더러에는 토큰을 노출하지 않는다. 외부 브라우저로 여는 Jira 주소는 Atlassian 도메인으로 제한한다.

## IPC·UI 변경 규칙

- IPC 기능은 `main.js`의 `ipcMain.handle` → `preload.js`의 `contextBridge` API → `renderer.js` 호출을 함께 변경한다.
- 메인에서 렌더러로 보내는 반복 이벤트는 preload에서 기존 리스너를 제거한 뒤 등록해 중복 호출을 막는다.
- 렌더러는 클래식 스크립트이므로 함수는 전역이고 HTML 인라인 `onclick`에서 호출할 수 있다. DOM 요소가 없을 수도 있으므로 기존 `$()`·`setText()` 패턴을 따른다.
- `spawn()`을 쓰는 모든 경로에 `proc.on('error')` 처리를 둔다. 사용자 조작 결과는 기존 `{ ok, message }` 형식으로 반환한다.
- `resolveBin()`으로 실행 파일 경로를 찾는다. `bin/` → macOS/Linux 표준 설치 경로 → 시스템 PATH 순서다.
- 레이아웃 너비 상수는 `renderer.js`와 `style.css`에 함께 정의되어 있다. 창 최소 너비 계산도 함께 확인한다.

## 개발·검증 명령

```bash
npm install
powershell -ExecutionPolicy Bypass -File ./Windows_setup.ps1
npm start
npm run dev
npm run check
```

`bin/`은 저장소에 포함되지 않는다. Windows는 `Windows_setup.ps1`로 ADB를 설치한다. macOS/Linux에서는 ADB를 설치하고 `bin/`에 링크한다. `scrcpy-server.jar`는 없으면 첫 미러링 때 GitHub에서 내려받는다.

테스트 러너·린트·번들러는 없다. `npm run check`는 렌더러 문법 검사와 Jira·HID·미러링 브리지 자가진단을 실행한다. 순수 로직은 Electron 의존성 없이 `assert` 기반 자가진단을 추가하는 것이 기존 방식이다.

## 배포 참고

- `npm run build:win`, `npm run build:mac`, `npm run build:linux`로 각 플랫폼 패키지를 만든다.
- Windows 빌드에는 `bin/`의 ADB가 포함되므로 빌드 전에 설치 스크립트를 실행한다. macOS 빌드는 사용자의 `android-platform-tools` 설치를 전제로 한다.
- macOS 서명·공증 차이와 비밀 파일 관리, electron-builder 제외 규칙은 `CLAUDE.md`의 배포 절을 참고한다.
- `.github/workflows/build.yml`은 Windows·macOS 빌드를 수행하고, 일치하는 `v<버전>` 태그에서 Windows Release를 게시한다.
