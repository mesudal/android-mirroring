# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DroidBridge — scrcpy/adb 기반 Android 제어 데스크탑 앱 (Electron). UI 문자열·로그·주석은 모두 한국어이며, 새 코드도 한국어로 유지한다.

## 명령어

```bash
npm install
npm start            # 실행
npm run dev          # DevTools 포함 (--dev 플래그)
npm run build:win    # NSIS 설치파일 → dist/
npm run build:mac    # dmg (x64/arm64) — 미서명. CI 가 쓰는 것
npm run build:linux  # AppImage

npm run release:mac  # dmg + Developer ID 서명 (사내 배포용, 약 2분)
npm run notarize:mac # 위 + Apple 공증 + staple (외부 배포용, 20분+)

node src/jira.js          # Jira 모듈 자가진단 (fetch 를 가짜로 바꿔 끼운 assert 스위트)
node src/hid-keyboard.js  # HID 리포트/디스크립터 자가진단
node src/mirror-bridge.js # session_meta 레이아웃 판별 자가진단
npm run check             # 위 자가진단 + renderer.js 문법 검사
```

- **테스트 러너·린트·번들러가 없다.** 검증은 위 자가진단(`require.main === module` 가드 안의 `assert`), `npm run check`, `npm run dev` 직접 실행으로 한다. 순수 로직을 새로 추가하면 같은 방식으로 자가진단을 붙인다(Electron 의존이 없어야 단독 실행된다).
- **런타임 문제는 `app.getPath('userData')/mirror.log` 를 먼저 본다.** 미러링 로그뿐 아니라 **렌더러의 console warn/error 까지** 이 파일로 끌어내 둔다(`main.js` 의 `console-message` 핸들러). 렌더러가 클래식 스크립트 한 덩어리라 예외 하나로 이후 핸들러가 통째로 죽는데, 화면상으로는 멀쩡해 보이기 때문이다. 앱 시작마다 비워진다.
- **`bin/` 의 adb 바이너리가 없으면 앱은 거의 아무것도 못 한다.** `bin/` 은 gitignore 대상이므로 클론 직후 한 번 채워야 한다: Windows 는 `powershell -File ./Windows_setup.ps1`, macOS/Linux 는 `brew`/`apt` 설치 후 `bin/` 에 심볼릭 링크 (README 참고).
- `scrcpy-server` jar 은 `bin/` 에 없으면 미러링 첫 실행 시 GitHub 에서 자동 다운로드된다 (폐쇄망이면 미리 넣어둘 것).
- `docs/TODO.md` 에 **현재 남은 작업**이 정리돼 있다. 완료된 항목은 목록에 남기지 않는다. 관련 영역을 건드리기 전에 확인할 것.

## 아키텍처

Electron 3-프로세스 구조에 Android 제어·미러링, Jira, 패킷 분석 기능이 연결돼 있다.

```
public/renderer.js ──(window.db.*)──> src/preload.js ──(ipcRenderer)──> src/main.js
                                                                         │
┌─────────────────┬────────────────────┬───────────────┬─────────────────┘
│                 │                    │               │
MirrorBridge      ProxyServer          jira.js         adb 직접 호출
mirror-bridge.js  proxy-server.js      Jira Cloud      runAdb / spawn:
+hid-keyboard.js  +cert-manager.js     REST v2         캡처·녹화·APK·파일·기기정보
│                                                      + LogCat (→ logcat:data)
adb forward tcp → scrcpy 소켓 파싱 → 로컬 WS
│
renderer: WebSocket → WebCodecs VideoDecoder → <canvas>
```

UI 는 **3컬럼**이다: 도구 패널 · 디바이스(canvas) · LogCat. 마크업 순서는 device → logcat → tool 이고 **CSS `order` 로 재배치**하므로(`style.css` 의 `.tool-col{order:1}` …) 화면 위치와 DOM 순서가 다르다.

### 1. 미러링 (`src/mirror-bridge.js` ↔ `public/renderer.js`)

**scrcpy 실행파일을 띄우지 않는다.** `scrcpy-server.jar` 만 기기에 push 해서 `app_process` 로 직접 구동하고, 와이어 프로토콜을 JS 로 파싱해 로컬 WebSocket 으로 중계한다. 렌더러가 WebCodecs 로 디코딩해 canvas 에 그린다. scrcpy **실행파일**은 쓰지 않으므로 `bin/` 에 필요한 건 adb 와 `scrcpy-server` jar 뿐이다.

주의할 점:

- **`session_meta` 길이는 상수가 아니다. 값을 보고 판별한다** (`parseSessionMeta()`). `DEVICE_NAME_LEN = 65`(더미 1B + 이름 64B)와 `CODEC_ID_LEN = 4` 는 고정이지만, 그 뒤 width/height 블록은 **서버 빌드마다 레이아웃이 달라지는 것이 실측으로 확인됐다.**
  - `8B` 형태 = `[width][height]` — iMac / SM-G981N 에서 관측 (`00000240`=576, `00000500`=1280)
  - `12B` 형태 = `[flags][width][height]` — 다운로드본 v4.1 에서 관측 (`80000000`, `0000025e`=606, `00000500`=1280)
  - 해상도는 값 범위가 좁고(1~`MAX_DIM`=8192) flags 는 최상위 비트가 서 있어 값만으로 구분된다. 오프셋을 고정하면 **한쪽을 맞추는 순간 다른 쪽이 깨진다** — 실제로 그렇게 한 번 잘못 고쳤다. 판별 불가면 `null` 을 돌려 세션을 끊는다(쓰레기값으로 조용히 진행하지 않게).
  - **증상 단서: 해상도 로그에 `2147483648`(=`0x80000000`, 프레임 헤더 PTS 상위 4B)이 보이면 이 블록을 잘못 읽은 것이다.** 프레임 경계까지 밀려 SPS/PPS 가 깨지므로 겉으로는 디코더 쪽 `A key frame is required after configure()` 로 나타나 원인을 놓치기 쉽다.
  - 레이아웃이 왜 갈리는지는 아직 확정하지 못했다. 1순위 후보는 **jar 출처**다 — `ensureJar()` 는 `/opt/homebrew/share/scrcpy/scrcpy-server` 등 **시스템 설치본을 GitHub 다운로드본보다 먼저** 집는다(`mirror-bridge.js:131-135`). brew 로 scrcpy 를 깐 기기는 다른 버전 jar 를 쓰게 된다. 기기 차이는 아니다(같은 SM-G981N 이 양쪽 형태로 관측됐다). 문제가 생기면 로그의 `jar @ ...` 줄부터 볼 것.
  - 세 번째 레이아웃이 나오면 `해상도 파싱 실패 — 헤더 앞 12B: <hex>` 가 로그에 남는다. 그 hex 를 자가진단 케이스로 추가하면 된다.
- 비디오 소켓과 제어 소켓은 **같은 forward 포트로 순서대로 두 번 connect** 해서 얻는다. 둘 다 성공해야 스트리밍이 시작된다. `controlSock` 은 제어 메시지를 쓰고 Android에서 오는 역방향 클립보드 메시지도 버퍼링해 읽는다.
- 디코더 코덱이 `avc1.640020` 으로 하드코딩되어 있고, config 패킷(SPS+PPS)은 `configNalBuffer` 에 캐시해뒀다가 IDR 앞에 수동으로 붙여야 한다 (`feedFrame()`). VideoDecoder 는 description 없이 config 만으로는 디코딩하지 못한다.
- jar 버전 문자열은 `app_process` 인자로 그대로 넘어가고 **서버가 자기 버전과 다르면 기동을 거부한다** (`IllegalArgumentException: The server version (4.1) does not match the client (...)`). 버전은 ① `ensureJar()` 의 다운로드 경로가 알려준 값 → ② `_jarVer()` 의 파일명 파싱 → ③ `_probeJarVer()` 가 서버에 직접 물어본 값 순으로 정해진다. ③ 덕분에 파일명에 버전이 없는 jar(`Windows_setup.ps1` 이 zip 에서 복사한 것, brew 설치본)도 그냥 동작하므로 **리네임은 필요 없다.** `FALLBACK_VER` 는 ③까지 실패했을 때만 쓰이는 최후값이라 정확할 필요가 없다.
- 시작 시 기기의 좀비 scrcpy 프로세스를 `pkill` 로 정리하고, 서버 기동 후 abstract socket 바인딩까지 1.5초를 더 기다린다 — 이 대기를 줄이면 소켓 연결이 간헐적으로 실패한다.
- **보기 회전은 기기를 돌리지 않는다.** `state.viewRot` 으로 우리 렌더링만 90°씩 돌린다(앱이 세로 고정이면 기기 회전은 거부당한다). `rotTransform()`(그리기)과 `unrotate()`(터치 역변환)는 **한 쌍**이라 한쪽만 고치면 즉시 터치가 어긋난다. 기기 자체를 돌리는 경로는 별도로 `rotateDevice()` = scrcpy `ROTATE_DEVICE(11)` 다.

### 2. 입력 주입 (터치 / 키 / 텍스트)

렌더러가 JSON 으로 WS 에 보내면 브리지가 scrcpy 제어 패킷으로 바꿔 쓴다 (`injectTouch` 32B / `injectKeycode` 14B / `uhidInput` / `injectText`). 화면 전원은 scrcpy `TYPE_SET_DISPLAY_POWER(10)` 으로 제어하며, 화면을 끈 채 입력을 계속 받고 미러링 종료 시 다시 켠다.

- **좌표는 렌더러에서 기기 픽셀로 환산해서 보낸다.** `sendTouchEvent()` 가 letterbox/pillarbox 여백과 보기 회전을 빼고 역산하므로, 캔버스 크기 로직을 건드리면 터치 정확도가 같이 깨진다.
- **키보드는 UHID 가 기본, 클립보드가 폴백이다.** 브리지가 시작 시 `/dev/uhid` 접근 가능 여부로 판정해(`keyboardMode`) WS 메시지로 렌더러에 알려준다. 서버 로그에 UHID 오류가 뒤늦게 보이면 런타임에 클립보드로 되돌린다.
  - UHID 경로: 렌더러가 눌린 `KeyboardEvent.code` 집합을 `{type:'hid', codes:[...]}` 로 보내고 브리지가 `hid.buildReport()` 로 8바이트 부트 키보드 리포트를 만든다. **`e.key`(문자)가 아니라 `e.code`(물리 위치)** 를 쓰므로 PC 레이아웃·IME 상태와 무관하다. 문자 조합은 단말 IME 가 한다. 렌더러가 `nodeIntegration=false` 라 `hid-keyboard` 를 직접 require 하지 못해 코드 집합만 넘기는 구조다.
  - 한/영·한자(`Lang1`/`Lang2` = 0x90/0x91)는 scrcpy 기본 디스크립터 범위(0x65) 밖이라 `EXTENDED_MAX_USAGE` 디스크립터를 직접 만들어 쓴다. 이때 **Logical Maximum 은 2바이트 형식(`0x26 lo hi`)이어야 한다** — 1바이트(`0x25`)로 두면 0x91 이 음수로 읽혀 디스크립터가 조용히 망가진다. Windows 는 이 토글 키에 `keyup` 을 주지 않아 눌림 집합에서 직접 떼어낸다(`TAP_ONLY`).
  - 클립보드 폴백: scrcpy 의 `TYPE_INJECT_TEXT` 는 한글을 주입하지 못하므로 `TYPE_SET_CLIPBOARD(9) + paste:true` 를 쓴다. 숨은 `textarea` 값을 60ms 디바운스 후 이전 전송분과 공통 접두사 비교 → 차이만큼 백스페이스 + 나머지 붙여넣기 (`syncText()`). **이 디바운스와 순서가 한글 조합 레이스 컨디션("기서서" 현상)의 핵심이므로 임의로 줄이지 말 것.** 저장소에서 가장 취약한 로직이며 폐기 검토 중이다 (`docs/TODO.md` 2번).

**클립보드 공유와 키보드 폴백은 별개다.** 미러링 중 PC 클립보드는 500ms 간격으로 확인해 Android와 동기화하고, 기기의 클립보드 메시지는 제어 소켓에서 읽어 PC에 반영한다. scrcpy 시퀀스 번호로 에코를 걸러내며, 텍스트만 지원하고 1MiB를 넘는 텍스트는 무시한다. 키보드 입력 폴백은 기존처럼 scrcpy 클립보드 붙여넣기를 사용한다.

Android 개발자 옵션의 `show_touches` 는 물리 터치만 표시하고 scrcpy 가 주입한 PC 클릭은 표시하지 않는다. 녹화는 Android `screenrecord` 원본을 저장하므로 PC에서 누른 위치는 녹화 영상에 표시되지 않는다.

### 3. 화면 녹화

`adb:record-start` 는 ADB 프로세스가 실행 직후 종료되거나 `spawn`에 실패하면 오류를 반환한다. 녹화 중에는 경과 시간과 STOP 동작을 표시한다. 종료할 때는 기기 `screenrecord`에 SIGINT를 보내 종료가 끝날 때까지 기다린 뒤 저장 대화상자를 띄우고, 저장된 파일 경로를 화면에 계속 보여준다. 최대 녹화 시간은 3분이다. 종료 대기 제한은 15초이며 초과하면 저장 파일이 불완전할 수 있음을 알린다.

### 4. LogCat / 현재 앱 / Jira (QA 고리)

`adb logcat -v threadtime -T 200` 을 spawn 해 `logcat:data` 청크로 흘린다. 렌더러 쪽 제약이 촘촘하다:

- 청크는 **줄 중간에서 끊긴다** — `logcatPending` 에 꼬리를 물려 처리한다. 화면 보관은 `LOGCAT_MAX_LINES = 3000` 까지(넘으면 앞에서 버림, DOM 이 감당 못 함).
- 레벨·프리셋·쿼리(`tag:` / `level:` / `pid:` …) 필터와 현재 패키지 PID 필터가 겹쳐 걸린다. 파싱은 `LOGCAT_PARSE_RE` 한 곳이다.
- Activity 폴링으로 얻은 포그라운드 패키지를 기준으로 `app:info` / `app:action`(force-stop·clear·재실행)이 동작한다.

Jira(`src/jira.js`)는 **REST API v2** 를 쓴다 — v3 는 description 을 ADF JSON 으로만 받아 QA 리포트 평문을 넣을 수 없다. 토큰은 `safeStorage` 로 암호화해 `userData/jira.json`(mode 0600)에 두고 **렌더러로는 절대 돌려보내지 않는다**(`hasToken` 불리언만). `jira:open` 은 atlassian.net / id.atlassian.com 만 허용하는 화이트리스트가 걸려 있다. 스코프형 토큰이면 사이트 주소가 401 이라 `api.atlassian.com/ex/jira/<cloudId>` 게이트웨이로 폴백하고 그 경로를 캐시한다 — 이 분기는 자가진단이 덮고 있다.

**스프린트는 이슈를 만든 뒤 Agile API(`POST /rest/agile/1.0/sprint/{id}/issue`)로 넣는다.** 스프린트는 사이트마다 번호가 다른 커스텀 필드이고 생성 화면에 없으면 생성 API 가 거부하므로 생성 본문에 넣지 않는다. 설정(`jira.json`)은 `sprintMode`(`off` / `active` / `fixed`)·`boardId`·`boardName`·`sprintId`·`sprintName`. `active` 는 발행할 때마다 `resolveSprint()` 가 보드의 진행 중 스프린트를 고른다(병렬 스프린트면 그 보드에서 만든 것 → 먼저 끝나는 것, `pickActiveSprint()` — 렌더러의 안내 문구용 `jiraPickActive()` 와 규칙을 맞춰 둘 것). 완료된 스프린트는 Jira 가 거부하므로 `fixed` 는 넣기 전에 상태를 확인한다. 스프린트 실패는 첨부 실패처럼 `r.warn` 으로만 돌려준다(이슈는 이미 만들어졌다). Agile API 의 401/403 은 스코프형 토큰의 Jira Software 권한 누락일 수 있어 `agileErr()` 가 그 안내를 붙인다.

QA 화면 확인은 `src/qa-driver.js` 가 ADB UIAutomator XML을 읽고 `src/qa-xml.js` 가 접근성 요소와 좌표를 파싱한다. 렌더러의 QA 탭은 역할별 기기·앱 변형을 선택하고 화면 요소를 확인·탭한다(좌표 탭, 글자로 누르기).

**QA 자동 진행** — 체크리스트(CSV) × 시나리오(JSON) → 실행기 → 회차 기록. 순수 로직은 전부 자가진단이 있다(실행기는 가짜 기기로).

```
qa-checklist.js  시트 CSV → 항목 (ID 모양으로 표 시작을 찾고, 열은 키워드로, 병합 셀은 위 값을 이어 씀)
qa-scenario.js   시나리오 검증 · 공통 절차(use, $dev) 펼치기 · 변수($account.id …) 치환
qa-runner.js     createRunner({ roles, scenarios, procedures, hooks }) → run({ items, update })
qa-results.js    항목별 최근 결과 · 변화(fixed/regression/still/new) · 실행 범위 · 시트 CSV
main.js          qa:accounts-* / qa:checklist(-import) / qa:scenarios / qa:run · stop · answer / qa:runs · run-detail / qa:export …
```

- **실행기는 Electron·adb 를 모른다.** 기기는 드라이버(역할마다 `getQaDriver(serial)`), 파일 저장·사람 응답·APK 설치·logcat 은 `hooks` 로 main 이 넣는다. 그래서 `node src/qa-runner.js` 가 가짜 기기로 판정·teardown·중단·업데이트 흐름을 검사한다. 새 단계 종류는 `qa-scenario.js` 의 `ACTIONS`/`EXPECTS`(검증)와 `qa-runner.js` 의 `execStep()`(실행) 두 곳에 같이 넣는다.
- 판정: iOS 전용 → Skipped / `variants` 밖 → Skipped / 역할 기기 없음 → Blocked / `pre` 실패 → Blocked / `steps` 실패 → Fail(그 순간 스크린샷·XML) / logcat 의 FATAL EXCEPTION(`Process: <pkg>`)·ANR → Fail. **teardown 은 항상** 돈다(중단 요청이 와도 teardown 은 끝까지, `inTeardown`). 시나리오가 끈 네트워크는 teardown 이 안 켜도 실행기가 켠다.
- 시나리오가 없는 항목은 `manualForUnscripted`(기본 켬)면 체크리스트 절차·기대 결과를 `ask` 로 띄워 사람이 판정한다.
- **사람 응답은 `qa:prompt`(메인→렌더러 푸시) → `qa:answer`(requestId) 로 오간다.** `qa:stop` 은 기다리던 응답을 `{ action: 'stop' }` 으로 끝낸다. 푸시 두 개(`qa:progress`, `qa:prompt`)는 preload 에서 `removeAllListeners` 후 등록한다.
- **지난 결과는 회차가 아니라 항목 단위로 찾는다**(`latestResults()`): 2차를 Fail 만 돌리면 Pass 항목은 2차에 없기 때문. 같은 앱·타입만, 업데이트 전 단계(`phase: 'before'`)와 중단(To do)은 빼고 본다. 기본 범위는 "지난 Pass 인 사람 판정 항목만 뺀다" — 자동 항목은 회귀 확인용으로 늘 다시 돌린다.
- 저장: `userData/qa-accounts.json`(비밀번호 safeStorage, 렌더러에는 `hasPassword` 만), `qa-checklists/<appId>.json`, `qa-scenarios/<appId>/*.json`(앱에 든 `qa/scenarios/<appId>` 보다 우선), `qa-runs/<runId>/result.json` + 증거. 증거 경로를 렌더러에서 받을 때(`qa:evidence-open`, Jira 첨부 `qaEvidence`)는 `qaEvidencePath()` 로 실행 기록 폴더 안인지 확인한다.
- QA 실행 중 logcat 은 역할 기기마다 별도 프로세스(`startQaLogcat`)로 받아 항목 구간만 자른다 — 화면의 LogCat 과 무관하다.
- 업데이트 테스트 실행은 `qaInstallApk()`(앱 선택 창 버튼과 같은 함수)로 기존·업데이트를 설치한다. 기존 버전이 이미 같은 버전이면 `skipped` 로 성공 처리한다.
- Jira: QA 결과의 실패 항목에서 연 등록 창(`openJiraModal(false, true)`)은 일반 초안을 불러오지도 저장하지도 않고(`jiraQaContext`), 등록 후 `qa:link-jira` 로 티켓 키를 실행 기록에 남긴다.

- **QA 대상 앱 목록은 `src/qa-apps.js` 의 `QA_APPS` 한 곳이다.** 앱 → 타입 → 패키지 구조이고(제로톡 = 무료용 `net.zerotalk.free` / 단체용 사용자 `net.zerotalk.user` / 단체용 관리자 `net.zerotalk.admin`), 새 앱은 여기에 항목만 추가하면 좌측 메뉴의 앱 선택 창과 QA 탭이 그대로 그린다. `validateApps()` 자가진단이 id·패키지 중복을 잡는다. 렌더러는 `qa:apps` 로 받는다.
- **고른 앱은 전역 하나, 타입은 기기 시리얼마다다** (`localStorage` `db_qa_target` = `{ appId, variants: { [appId]: { [serial]: variantId } } }`). 슬롯(A/B/C)이 아니라 시리얼에 묶어서, 기기 화면 왼쪽 메뉴(`openQaAppPicker()`)와 QA 탭 역할 카드가 같은 값을 보고 서로 반영한다. QA 탭 역할 카드는 저장된 배정이 없으면 같은 글자 슬롯의 기기를 기본으로 잡는다.
- `qa:app-status` 는 타입별 설치 여부와 버전을 `dumpsys package <pkg>` 로 읽는다. **`dumpsys package --user 0 <pkg>` 는 패키지 인자를 무시하고 전체를 쏟아낸다** — 붙이지 말 것. 출력에는 다른 패키지 블록도 섞이므로 `parsePackageVersion()` 이 `Package [<pkg>]` 블록 안에서만 읽는다.
- `updateDevicePanels()` 는 스크립트 로드 중에도 불린다. 그 안에서 아래쪽 `let` 상태(QA 등)를 건드리면 TDZ 예외로 렌더러 전체가 죽는다 — `qaBadgesReady` 같은 위쪽 플래그로 막는다.
- **업데이트 테스트용 APK** — 앱 선택 창에서 타입마다 dev APK 두 개(`kind`: `base` 기존 버전 / `update` 업데이트)를 등록한다(`qa:apk-register`). 파일은 복사하지 않고 `userData/qa-apks.json`(`{ [appId]: { [variantId]: { base, update } } }`, 예전의 업데이트 하나짜리 형식은 `update` 로 읽는다)에 경로·크기·수정 시각만 두며, 같은 경로에 새로 빌드하면 바뀐 것을 보고 다시 읽는다. `qa:apk-install` 은 설치 직전에 판정을 다시 한다: `base` 는 `checkBaseInstall()` 의 `action` 대로 — **앱 데이터는 지울 수밖에 없을 때만 지운다**(실제 사용자처럼 기존 버전의 데이터를 업데이트까지 이어 가야 하므로): 미설치 `install` / 같은 버전·서명 `none`(설치 안 함) / 같은 서명의 낮은 버전 `upgrade`(`install -r`) / 더 높은 버전·다른 서명 `reinstall`(`adb uninstall` 후 설치 — Android 가 다운그레이드·서명 변경을 막는다), `update` 는 `adb install -r`(데이터 유지, `checkUpdate()`). 두 APK 의 짝(패키지·서명 같음, 업데이트 버전이 높음)은 `checkPair()`.
- `src/apk-info.js` 가 aapt 없이 APK 를 읽는다: ZIP 중앙 디렉터리 → 바이너리 `AndroidManifest.xml`(패키지·versionCode·versionName·minSdk) → APK 서명 블록(v3.1 → v3 → v2 순, 첫 서명자 인증서). aapt2 빌드는 속성 이름을 비우고 리소스 id 로만 남기기도 해서 id(`0x0101021b` 등)로도 찾는다.
- **서명 비교는 기기 `dumpsys package` 의 `signatures:[xxxxxxxx]` 값과 한다.** 이 값은 인증서 DER 의 Java `Arrays.hashCode(byte[])` 를 16진수로 쓴 것이라 `signerHash()` 로 같은 값을 계산한다(SM-G986N 에서 무료용 v3·관리자 v2 APK 로 일치 확인). v1(JAR) 서명만 있으면 서명은 "확인하지 못함" 경고로 두고 막지 않는다. 판정은 `checkUpdate()`: 패키지 불일치·최소 SDK·서명 다름·낮은 버전은 설치 불가, 같은 버전·미설치는 경고.
- **드라이버는 기기 1대당 하나다** (`createDriver({ adb, serial })`, `main.js` 의 `getQaDriver()` 가 캐시). 드라이버가 그 기기의 adb 명령 큐를 들고 있어 같은 기기 명령은 순서대로, 다른 기기는 병렬로 돈다. 모든 메서드는 예외 대신 `{ ok, message }` 를 돌려준다.
- **제로톡(`net.zerotalk.free`)은 Flutter 다.** 글자가 `text` 가 아니라 `content-desc` 로 오고 `resource-id` 는 전부 비어 있다(SM-G986N / Android 13 실측). 그래서 `text` · `textContains` · `textMatches` 셀렉터는 **둘 다** 본다. `{ id: ... }` 셀렉터는 이 앱에서 쓸 수 없다.
- 셀렉터 종류와 검증은 `qa-xml.js` 의 `SELECTOR_KEYS` / `selectorError()` 한 곳이다. 넓이 0 노드(`[0,0][0,0]`)는 매칭에서 빠진다.
- `qa:packages` 는 `pm list packages -3 --user 0` 을 쓴다. 보안 폴더가 있는 기기는 `--user` 없이 조회하면 `Shell does not have permission to access user 150` 으로 실패한다.
- 드라이버의 기기 상태 명령(네트워크·권한·오버레이·배터리 최적화·위치)은 **아직 실기기에서 돌려 보지 않았다.** 무선 ADB 로 붙은 기기는 네트워크 차단을 거부한다(와이파이를 끄면 adb 가 끊겨 되돌릴 수 없다).

### 5. 패킷 분석 프록시 (`src/proxy-server.js`, `src/cert-manager.js`)

MITM HTTP/HTTPS 프록시. CONNECT 터널을 가로채 node-forge 로 호스트별 인증서를 즉석 발급(CA 는 `userData/proxy-certs` 에 영속)하고, 복호화한 요청/응답을 `proxy:packet` 이벤트로 렌더러에 흘린다. 기기 설정은 adb(`settings put global http_proxy`) 로 자동 주입한다.
`proxy:patch-and-install-apk` 는 **PC 에 Java 가 설치돼 있어야** 하고 `npx apk-mitm` 을 그때그때 실행한다 (번들 아님).

### 6. 그 외 기능

캡처·녹화·APK 설치·파일 전송·클립보드·키이벤트는 `main.js` 에서 adb 를 직접 호출한다. 결과는 예외를 던지지 않고 **`{ ok, message }` 객체로 반환**하는 것이 이 코드베이스 전체의 규약이다 (`{ ok:false, canceled:true }` 로 사용자 취소를 구분하기도 한다).

## 코드 수정 시 알아야 할 규칙

- **IPC 를 추가하면 반드시 3곳을 같이 고친다**: `main.js` 의 `ipcMain.handle` → `preload.js` 의 `contextBridge` 노출 → `renderer.js` 의 `window.db.*` 호출. 채널 접두사는 `adb:` / `mirror:` / `proxy:` / `dialog:` / `setup:` / `capture:` / `logcat:` / `jira:` / `qa:` / `app:` / `device:` / `window:`.
- **메인 → 렌더러 푸시 이벤트(`mirror:log`, `logcat:data`, `logcat:stopped`, `proxy:packet`)는 preload 에서 `removeAllListeners` 후 등록한다.** 재연결마다 리스너가 쌓이면 같은 줄이 여러 번 그려진다.
- **렌더러에 모듈 시스템이 없다.** `renderer.js` 는 클래식 `<script>` 한 개이고 모든 함수가 전역이며, `index.html` 이 인라인 `onclick="fn()"` 으로 호출한다. UI 동작 추가 = 전역 함수 + onclick. (`src/` 는 CommonJS.) DOM 요소가 없어도 죽지 않도록 `setText()` / `$()` 를 거치는 관행이 있다 — 탭에서 내려간 페이지의 마크업이 그대로 남아 있기 때문이다.
- **창 최소 크기와 시작 크기는 별개다.** `pickLaunchSize()` 는 화면 작업 영역에 맞춘 시작 크기만 정하고, 창은 최소 `720×320` 까지 줄일 수 있다. `window:set-min-size` 는 필요한 경우 최소 너비를 더 올릴 수 있지만, 시작 크기를 하한으로 삼지 않는다.
- **바이너리 경로는 `resolveBin()` 을 통해서만 얻는다.** `bin/` → macOS/Linux 표준 경로(`/opt/homebrew/bin` 등) → `where`/`which` 순으로 탐색한다. macOS GUI 실행 시 `$PATH` 가 비어 있는 문제 때문에 필요한 로직이다. 패키징 상태에서 `resourcesPath/bin` 이 쓰기 불가면 `userData/bin` 으로 복사 후 전환한다 (`main.js` 상단).
- **`spawn` 하는 곳에는 `proc.on('error')` 를 반드시 단다.** 핸들러가 없으면 spawn 실패가 처리되지 않은 이벤트로 올라와 메인 프로세스가 통째로 죽는다.
- UI 설정값은 `localStorage` 에 `db_` 접두사로 저장한다: `db_screen_width`, `db_bitrate`, `db_fps`, `db_theme`, `db_logcat_font`, `db_log_app_only`, `db_tools_collapsed`, `db_jira_draft`, `db_jira_pins`, `db_jira_projects`, `db_qa_roles`, `db_qa_target`, `db_qa_role_accounts`, `db_qa_picked`.

## 빌드 / 배포

- `.github/workflows/build.yml` — main/master push 또는 수동 실행 시 windows+macos 매트릭스 빌드. Windows 잡은 빌드 전에 `Windows_setup.ps1` 로 바이너리를 받아 패키지에 포함시키고, macOS 잡은 빈 `bin/` 만 만든다(=배포된 dmg 는 사용자 PC 의 brew adb 에 의존한다). `v*` 태그 푸시는 버전 일치 확인 후 Windows 설치파일·`latest.yml`·`.blockmap` 을 GitHub Release 에 게시한다. Windows 앱은 `electron-updater` 로 공개 GitHub Release 를 확인한다. macOS 앱 내 업데이트는 아직 지원하지 않는다.
- `bin/` 은 `extraResources` 로 패키지에 통째로 들어간다.
- **asar 에 넣을 파일은 `build.files` 의 제외 목록으로 거른다.** electron-builder 는 자기 출력 폴더(`dist/`)만 자동으로 빼고 나머지는 저장소 루트를 통째로 담는다. 출력 경로를 바꿨다 되돌리며 남은 `dist-win/`(옛 설치파일)가 들어가 설치파일이 87MB → 274MB 로 부푼 적이 있다. 그래서 `dist*/` 를 통째로 막는다 — 출력 폴더를 바꿔 빌드하면 이번엔 원래 `dist/` 가 들어가기 때문이다. 같은 이유로 `bin/`(이미 `extraResources` 로 들어감 — 패키징 상태에선 `resourcesPath/bin` 만 쓴다), `docs/`, `.omc/`(에이전트 세션 기록), 문서·스크립트도 뺐다. **electron-builder 는 `.gitignore` 를 보지 않고 점(.)으로 시작하는 파일도 담는다** — 루트에 새 비밀 파일을 추가하면 패키징 제외 목록에도 넣는다. 루트에 새 폴더를 만들면 여기에 추가할지 확인하고, 빌드 후 `npx asar list dist/win-unpacked/resources/app.asar` 최상위가 `node_modules · src · public · package.json` 뿐인지 본다.

### macOS 서명 / 공증

로컬 배포용 스크립트가 셋으로 갈려 있다. **용도를 섞지 말 것.**

| 스크립트 | 서명 | 공증 | 소요 | 쓰는 곳 |
|---|---|---|---|---|
| `build:mac` | ✗ | ✗ | ~2분 | CI (`build.yml:50`) |
| `release:mac` | Developer ID | ✗ | ~2분 | 사내 배포 |
| `notarize:mac` | Developer ID | ✓ | 20분+ | 외부 배포 |

- **`build:mac` 에 `CSC_IDENTITY_AUTO_DISCOVERY=false` 가 박혀 있다. 빼지 말 것.** 빼면 electron-builder 가 키체인에서 아무 인증서나 주워 서명하는데, `Apple Development` 인증서가 걸리면 프로비저닝 프로파일이 없어 **실행 자체가 안 되는 앱**이 나온다(SIGTRAP). CI 는 인증서가 없으므로 어차피 미서명이고, 이 플래그는 로컬에서 실수로 서명되는 것을 막는 용도다.
- `release:mac` 은 `CSC_NAME` 으로 Developer ID 인증서를 **이름으로 고정**한다. 접두사 `Developer ID Application:` 을 붙이면 electron-builder 가 거부하므로 빼고 쓴다.
- `notarize:mac` 은 **gitignore 된 `.notarize.env`** 를 읽어 `APPLE_API_KEY`(.p8 경로) / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` 를 넘긴다. **저장소가 공개라 이 값들을 `package.json` 에 넣지 말 것.** 클론 직후에는 파일이 없으므로 직접 만들어야 한다:
  ```bash
  cat > .notarize.env <<'EOF'
  APPLE_API_KEY=$HOME/private_keys/AuthKey_<KEYID>.p8
  APPLE_API_KEY_ID=<KEYID>
  APPLE_API_ISSUER=<ISSUER-UUID>
  EOF
  ```
  파일이 없으면 스크립트가 **에러로 멈춘다** — 의도된 동작이다. 반대로 env 만 비어 있으면 electron-builder 는 `skipped macOS notarization` 경고만 남기고 서명본을 그냥 내놓으므로(조용한 성공) 그 경로를 피하려고 파일 없으면 실패하게 해 뒀다.
- 공증은 **빌드마다** 해야 한다. 티켓이 바이너리 해시에 묶여 있어 코드 한 줄만 고쳐도 무효다. 인증서(약 5년)와 .p8(만료 없음)만 1회성이다.
- 공증 상태를 보는 웹페이지는 없다. `xcrun notarytool history|info|log --key … --key-id … --issuer …` 가 유일한 경로다.
- **서명 여부에 따라 받는 쪽 증상이 다르다.** 미서명 → "손상되었기 때문에 열 수 없습니다"(우클릭 열기도 안 먹힘, `xattr -cr` 필요). Developer ID 서명 + 공증 없음 → "확인할 수 없음"(우클릭 → 열기 1회로 통과). 공증까지 → 경고 없음. 단 quarantine 이 안 붙는 경로(USB·파일서버·scp)로 주면 어느 쪽이든 그냥 열린다.
- README 와 DEVELOPER.md 에 `xattr -cr` 안내가 있다. 앱 이름이 `DroidBridge.app` 으로 바뀌었으므로 관련 변경 시 같이 갱신할 것.

### macOS 로컬 빌드에서 실측으로 걸린 것들 (2026-09-17)

- **`productName` 을 한글로 되돌리지 말 것.** 한때 `"안드로이드 미러링"` 이었고, 그 상태로 만든 .app 은 기동 즉시 SIGTRAP(exit 133)으로 죽었다. 메시지는 `FATAL:electron_main_delegate_mac.mm(67)] Unable to find helper app` — Electron 이 **CFBundleName** 으로 헬퍼 앱 경로를 조립하는데 비ASCII 이름이 디스크상 이름과 맞지 않는다. `npm start`(개발 실행)는 멀쩡하므로 **패키징해서 실행해 보기 전에는 드러나지 않는다.**
  지금은 `productName: "DroidBridge"` 로 두고 표시 이름만 한글로 준다 — macOS 는 `mac.extendInfo.CFBundleDisplayName`, Windows 는 `nsis.shortcutName`. `CFBundleName` 까지 한글로 덮으면 같은 이유로 다시 죽으므로 **`CFBundleDisplayName` 만** 바꿔야 한다. (`userData` 경로는 `package.json` 의 `name`(=`droidbridge`)에서 오므로 이 변경에 영향받지 않는다.)
- **npm 11 은 postinstall 을 차단할 수 있다.** `npm install` 이 성공해도 `node_modules/electron/dist/` 에 라이선스 파일만 남고 바이너리가 없으면 `node node_modules/electron/install.js` 로 따로 받아야 한다. macOS 에서 `extract-zip` 이 첫 파일에서 멈추면 캐시된 zip(`~/Library/Caches/electron/*/electron-v*.zip`)을 `ditto -x -k` 로 풀고 `path.txt` 에 `Electron.app/Contents/MacOS/Electron` 을 쓴다.
