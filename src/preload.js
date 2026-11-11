const { contextBridge, ipcRenderer } = require('electron')

function on(channel, cb) {
  ipcRenderer.on(channel, (_, ...args) => cb(...args))
}

contextBridge.exposeInMainWorld('db', {
  // 기기
  getDevices: () => ipcRenderer.invoke('adb:devices'),
  qaPackages: (serial) => ipcRenderer.invoke('qa:packages', serial),
  qaApps: () => ipcRenderer.invoke('qa:apps'),
  qaAppStatus: (opts) => ipcRenderer.invoke('qa:app-status', opts),
  qaApkRegister: (opts) => ipcRenderer.invoke('qa:apk-register', opts),
  qaApkUnregister: (opts) => ipcRenderer.invoke('qa:apk-unregister', opts),
  qaApkStatus: (opts) => ipcRenderer.invoke('qa:apk-status', opts),
  qaApkInstall: (opts) => ipcRenderer.invoke('qa:apk-install', opts),
  qaInspect: (serial) => ipcRenderer.invoke('qa:inspect', serial),
  qaTap: (opts) => ipcRenderer.invoke('qa:tap', opts),

  // QA 자동 진행 — 계정 비밀번호는 메인에만 있고 여기로 돌아오지 않는다 (hasPassword 만)
  qaAccountsLoad: () => ipcRenderer.invoke('qa:accounts-load'),
  qaAccountsSave: (acc) => ipcRenderer.invoke('qa:accounts-save', acc),
  qaAccountsDelete: (key) => ipcRenderer.invoke('qa:accounts-delete', key),
  qaChecklist: (appId) => ipcRenderer.invoke('qa:checklist', appId),
  qaChecklistImport: (opts) => ipcRenderer.invoke('qa:checklist-import', opts),
  qaScenarios: (appId) => ipcRenderer.invoke('qa:scenarios', appId),
  qaScenarioFolder: (appId) => ipcRenderer.invoke('qa:scenario-folder', appId),
  qaRunPreview: (opts) => ipcRenderer.invoke('qa:run-preview', opts),
  qaRun: (opts) => ipcRenderer.invoke('qa:run', opts),
  qaStop: () => ipcRenderer.invoke('qa:stop'),
  qaAnswer: (opts) => ipcRenderer.invoke('qa:answer', opts),
  qaStatus: () => ipcRenderer.invoke('qa:status'),
  qaRuns: (opts) => ipcRenderer.invoke('qa:runs', opts),
  qaRunDetail: (runId) => ipcRenderer.invoke('qa:run-detail', runId),
  qaEvidenceOpen: (opts) => ipcRenderer.invoke('qa:evidence-open', opts),
  qaLinkJira: (opts) => ipcRenderer.invoke('qa:link-jira', opts),
  qaExport: (runId) => ipcRenderer.invoke('qa:export', runId),
  // 중복 리스너 방지: 항상 기존 리스너 제거 후 새로 등록
  onQaProgress: (cb) => {
    ipcRenderer.removeAllListeners('qa:progress')
    ipcRenderer.on('qa:progress', (_, e) => cb(e))
  },
  onQaPrompt: (cb) => {
    ipcRenderer.removeAllListeners('qa:prompt')
    ipcRenderer.on('qa:prompt', (_, e) => cb(e))
  },

  connect: (ip, port) => ipcRenderer.invoke('adb:connect', ip, port),
  disconnect: (target) => ipcRenderer.invoke('adb:disconnect', target),

  // 미러링 (MirrorBridge)
  initMirror: (serial) => ipcRenderer.invoke('mirror:init', serial),
  startMirror: (opts) => ipcRenderer.invoke('mirror:start', opts),
  stopMirror: (serial) => ipcRenderer.invoke('mirror:stop', serial),
  // 중복 리스너 방지: 항상 기존 리스너 제거 후 새로 등록
  onMirrorLog: (cb) => {
    ipcRenderer.removeAllListeners('mirror:log')
    ipcRenderer.on('mirror:log', (_, ...args) => cb(...args))
  },

  // 캡처 / 녹화
  screenshot: (serial) => ipcRenderer.invoke('adb:screenshot', serial),
  saveCapture: (serial) => ipcRenderer.invoke('capture:save', serial),
  copyCapture: (serial) => ipcRenderer.invoke('capture:copy', serial),
  discardCapture: (serial) => ipcRenderer.invoke('capture:discard', serial),
  setMinSize: (w, h) => ipcRenderer.invoke('window:set-min-size', w, h),
  recordStart: (opts) => ipcRenderer.invoke('adb:record-start', opts),
  recordStop: (serial) => ipcRenderer.invoke('adb:record-stop', serial),
  onRecordEnded: (cb) => {
    ipcRenderer.removeAllListeners('adb:record-ended')
    ipcRenderer.on('adb:record-ended', (_, status, serial) => cb(status, serial))
  },

  // APK / 파일
  openApkDialog: () => ipcRenderer.invoke('dialog:openApk'),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  openVideoDialog: () => ipcRenderer.invoke('dialog:openVideo'),
  getAlwaysOnTop: () => ipcRenderer.invoke('window:get-always-on-top'),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('window:set-always-on-top', enabled),
  install: (opts) => ipcRenderer.invoke('adb:install', opts),
  patchAndInstallApk: (serial) => ipcRenderer.invoke('proxy:patch-and-install-apk', serial),

  onInstallLog: (cb) => on('adb:install-log', cb),
  pushFile: (opts) => ipcRenderer.invoke('adb:push', opts),
  pullFile: (opts) => ipcRenderer.invoke('adb:pull', opts),

  // 키
  keyevent: (opts) => ipcRenderer.invoke('adb:keyevent', opts),
  getCurrentActivity: (serial) => ipcRenderer.invoke('adb:current-activity', serial),
  getActivityInfo: (serial, activityName) => ipcRenderer.invoke('adb:activity-info', { serial, activityName }),

  // 세팅
  setupCheck: () => ipcRenderer.invoke('setup:check'),
  checkForUpdates: () => ipcRenderer.invoke('app:update-check'),
  downloadAppUpdate: () => ipcRenderer.invoke('app:update-download'),
  installAppUpdate: () => ipcRenderer.invoke('app:update-install'),
  onUpdateStatus: (cb) => {
    ipcRenderer.removeAllListeners('app:update-status')
    ipcRenderer.on('app:update-status', (_, status) => cb(status))
  },

  // Jira — 토큰은 메인에만 있고 여기로 돌아오지 않는다
  jiraLoad: () => ipcRenderer.invoke('jira:load'),
  jiraSave: (cfg) => ipcRenderer.invoke('jira:save', cfg),
  jiraTest: () => ipcRenderer.invoke('jira:test'),
  jiraPing: () => ipcRenderer.invoke('jira:ping'),
  jiraIssueTypes: (projectKey) => ipcRenderer.invoke('jira:issue-types', projectKey),
  jiraFields: (opts) => ipcRenderer.invoke('jira:fields', opts),
  jiraAssignable: (opts) => ipcRenderer.invoke('jira:assignable', opts),
  jiraBoards: (projectKey) => ipcRenderer.invoke('jira:boards', projectKey),
  jiraSprints: (boardId) => ipcRenderer.invoke('jira:sprints', boardId),
  jiraCreate: (issue) => ipcRenderer.invoke('jira:create', issue),
  jiraOpen: (url) => ipcRenderer.invoke('jira:open', url),

  // 현재 앱 / 기기 정보
  appInfo: (opts) => ipcRenderer.invoke('app:info', opts),
  appAction: (opts) => ipcRenderer.invoke('app:action', opts),
  deviceInfo: (serial) => ipcRenderer.invoke('device:info', serial),

  // LogCat
  startLogcat: (serial) => ipcRenderer.invoke('logcat:start', serial),
  stopLogcat: (serial) => ipcRenderer.invoke('logcat:stop', serial),
  saveLogcat: (text) => ipcRenderer.invoke('logcat:save', text),
  onLogcatData: (cb) => {
    ipcRenderer.removeAllListeners('logcat:data')
    ipcRenderer.on('logcat:data', (_, chunk, serial) => cb(chunk, serial))
  },
  onLogcatStopped: (cb) => {
    ipcRenderer.removeAllListeners('logcat:stopped')
    ipcRenderer.on('logcat:stopped', (_, serial) => cb(serial))
  },

  // 패킷 분석 프록시
  proxyStart: (port) => ipcRenderer.invoke('proxy:start', port),
  proxyStop: () => ipcRenderer.invoke('proxy:stop'),
  proxySetupDevice: (opts) => ipcRenderer.invoke('proxy:setup-device', opts),
  proxyClearDevice: (serial) => ipcRenderer.invoke('proxy:clear-device', serial),
  proxyInstallCert: (serial) => ipcRenderer.invoke('proxy:install-cert', serial),
  proxyGetPcIp: () => ipcRenderer.invoke('proxy:get-pc-ip'),
  onProxyPacket: (cb) => {
    ipcRenderer.removeAllListeners('proxy:packet')
    ipcRenderer.on('proxy:packet', (_, packet) => cb(packet))
  },
})
