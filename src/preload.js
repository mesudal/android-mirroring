const { contextBridge, ipcRenderer } = require('electron')

function on(channel, cb) {
  ipcRenderer.on(channel, (_, ...args) => cb(...args))
}

contextBridge.exposeInMainWorld('db', {
  // 기기
  getDevices: () => ipcRenderer.invoke('adb:devices'),
  connect: (ip, port) => ipcRenderer.invoke('adb:connect', ip, port),

  // 미러링 (MirrorBridge)
  initMirror: () => ipcRenderer.invoke('mirror:init'),
  startMirror: (opts) => ipcRenderer.invoke('mirror:start', opts),
  stopMirror: () => ipcRenderer.invoke('mirror:stop'),
  // 중복 리스너 방지: 항상 기존 리스너 제거 후 새로 등록
  onMirrorLog: (cb) => {
    ipcRenderer.removeAllListeners('mirror:log')
    ipcRenderer.on('mirror:log', (_, ...args) => cb(...args))
  },

  // 캡처 / 녹화
  screenshot: (serial) => ipcRenderer.invoke('adb:screenshot', serial),
  recordStart: (opts) => ipcRenderer.invoke('adb:record-start', opts),
  recordStop: (serial) => ipcRenderer.invoke('adb:record-stop', serial),

  // APK / 파일
  openApkDialog: () => ipcRenderer.invoke('dialog:openApk'),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  install: (opts) => ipcRenderer.invoke('adb:install', opts),
  patchAndInstallApk: (serial) => ipcRenderer.invoke('proxy:patch-and-install-apk', serial),

  onInstallLog: (cb) => on('adb:install-log', cb),
  pushFile: (opts) => ipcRenderer.invoke('adb:push', opts),
  pullFile: (opts) => ipcRenderer.invoke('adb:pull', opts),

  // 클립보드 / 키
  clipboardSend: (opts) => ipcRenderer.invoke('adb:clipboard-send', opts),
  clipboardGet: (serial) => ipcRenderer.invoke('adb:clipboard-get', serial),
  keyevent: (opts) => ipcRenderer.invoke('adb:keyevent', opts),
  getCurrentActivity: (serial) => ipcRenderer.invoke('adb:current-activity', serial),
  getActivityInfo: (serial, activityName) => ipcRenderer.invoke('adb:activity-info', { serial, activityName }),

  // 세팅
  setupCheck: () => ipcRenderer.invoke('setup:check'),

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
