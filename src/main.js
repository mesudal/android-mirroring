const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const { spawn, execFile, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const MirrorBridge = require('./mirror-bridge')
const CertManager = require('./cert-manager')
const ProxyServer = require('./proxy-server')

const isDev = process.argv.includes('--dev')
let binDir = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, '..', 'bin')

if (app.isPackaged) {
  try {
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true })
    fs.accessSync(binDir, fs.constants.W_OK)
  } catch (e) {
    const userBin = path.join(app.getPath('userData'), 'bin')
    if (!fs.existsSync(userBin)) fs.mkdirSync(userBin, { recursive: true })
    
    if (fs.existsSync(binDir)) {
      fs.readdirSync(binDir).forEach(f => {
        const src = path.join(binDir, f)
        const dst = path.join(userBin, f)
        if (!fs.existsSync(dst)) {
          try { fs.copyFileSync(src, dst) } catch(err) {}
        }
      })
    }
    binDir = userBin
  }
}

const platform = process.platform
const adbBin = platform === 'win32' ? 'adb.exe' : 'adb'

// ── 바이너리 자동 탐색: bin/ 폴더 → 시스템 PATH 순서로 검색 ──
function resolveBin(name) {
  const cleanName = name.replace('.exe', '')
  const local = path.join(binDir, name)
  if (fs.existsSync(local)) return local

  // macOS / Linux - GUI 환경에서 터미널 PATH($PATH) 유실 문제 보완을 위해 표준 설치 경로 직접 탐색
  if (platform === 'darwin' || platform === 'linux') {
    const standardPaths = [
      `/opt/homebrew/bin/${cleanName}`, // Apple Silicon Homebrew
      `/usr/local/bin/${cleanName}`,    // Intel Mac Homebrew / Standard Local
      `/usr/bin/${cleanName}`,
      `/bin/${cleanName}`,
    ]
    for (const p of standardPaths) {
      if (fs.existsSync(p)) return p
    }
  }

  try {
    const cmd = platform === 'win32' ? `where ${name}` : `which ${cleanName}`
    const found = execSync(cmd, { encoding: 'utf8' }).split('\n')[0].trim()
    if (found && fs.existsSync(found)) return found
  } catch { }
  return null
}


let adbPath = resolveBin(adbBin)

let mainWindow = null
let mirror = null   // MirrorBridge 인스턴스
let recordingProcess = null
let proxyServer = null
let certManager = null

function getMirror() {
  if (!mirror) {
    mirror = new MirrorBridge({
      adbPath,
      binDir,
      onLog: msg => mainWindow?.webContents.send('mirror:log', msg),
    })
  }
  return mirror
}

// ── 윈도우 생성 ────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 960, minHeight: 640,
    backgroundColor: '#0e0e10',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'))
  if (isDev) mainWindow.webContents.openDevTools()
  mainWindow.on('closed', () => {
    mirror?.destroy()
    mainWindow = null
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!mainWindow) createWindow() })

// ── ADB 유틸 ──────────────────────────────────────────────────
function runAdb(args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message)
      else resolve(stdout.trim())
    })
  })
}

// ── IPC 핸들러들 ──────────────────────────────────────────────

// 기기 목록
ipcMain.handle('adb:devices', async () => {
  try {
    const out = await runAdb(['devices', '-l'])
    return out.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('List of devices'))
      // 상태가 'device'인 줄만 (offline/unauthorized 제외)
      .filter(l => /\s+device\b/.test(l))
      .map(line => {
        const parts = line.split(/\s+/)
        const serial = parts[0]
        const model = (line.match(/model:(\S+)/) || [])[1] || serial
        const product = (line.match(/product:(\S+)/) || [])[1] || ''
        return { serial, model: model.replace(/_/g, ' '), product }
      })
  } catch { return [] }
})

// Wi-Fi 연결
ipcMain.handle('adb:connect', async (_, ip, port = 5555) => {
  try {
    const r = await runAdb(['connect', `${ip}:${port}`])
    return { ok: r.includes('connected'), message: r }
  } catch (e) { return { ok: false, message: String(e) } }
})

// ── 미러링 IPC (MirrorBridge 사용) ────────────────────────────
ipcMain.handle('mirror:start', async (_, { serial, maxSize, videoBitrate, fps }) => {
  try {
    adbPath = resolveBin(adbBin) // 재탐색 (setup 이후 변경 대응)
    await getMirror().start({ serial, maxSize, videoBitrate, fps })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e.message }
  }
})

ipcMain.handle('mirror:stop', async () => {
  await mirror?.stop()
  return { ok: true }
})

ipcMain.handle('mirror:init', async () => {
  return await getMirror().startWss()
})

// 화면 캡처
ipcMain.handle('adb:screenshot', async (_, serial) => {
  try {
    const tmp = path.join(os.tmpdir(), `db_${Date.now()}.png`)
    await runAdb(['-s', serial, 'shell', 'screencap', '-p', '/sdcard/_db_tmp.png'])
    await runAdb(['-s', serial, 'pull', '/sdcard/_db_tmp.png', tmp])
    await runAdb(['-s', serial, 'shell', 'rm', '/sdcard/_db_tmp.png'])
    
    const { clipboard, nativeImage } = require('electron')
    const image = nativeImage.createFromPath(tmp)
    clipboard.writeImage(image)
    fs.unlinkSync(tmp)
    
    return { ok: true, path: '클립보드' }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 녹화 시작
ipcMain.handle('adb:record-start', async (_, { serial, bitrate, size }) => {
  const args = ['-s', serial, 'shell', 'screenrecord',
    '--bit-rate', String((bitrate || 4) * 1000000),
    '--time-limit', '180'] // screenrecord 최대 한도 (3분). 그 이상은 자동 종료됨
  if (size) args.push('--size', size)
  args.push('/sdcard/_db_rec.mp4')
  recordingProcess = spawn(adbPath, args)
  recordingProcess.on('close', () => { recordingProcess = null })
  return { ok: true }
})

// 녹화 중지 + 저장
ipcMain.handle('adb:record-stop', async (_, serial) => {
  try {
    // 기기에서 실행 중인 screenrecord 프로세스에 SIGINT 전송 (정상 종료 → 파일 무결성 보장)
    await runAdb(['-s', serial, 'shell', 'pkill', '-2', 'screenrecord']).catch(() => { })
    if (recordingProcess) { recordingProcess.kill(); recordingProcess = null }
    // 기기가 mp4 moov atom을 쓸 시간 확보
    await new Promise(r => setTimeout(r, 2000))
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '녹화 파일 저장',
      defaultPath: `recording_${Date.now()}.mp4`,
      filters: [{ name: 'MP4', extensions: ['mp4'] }],
    })
    if (!filePath) return { ok: false, message: '취소됨' }
    await runAdb(['-s', serial, 'pull', '/sdcard/_db_rec.mp4', filePath])
    await runAdb(['-s', serial, 'shell', 'rm', '/sdcard/_db_rec.mp4'])
    return { ok: true, path: filePath }
  } catch (e) { return { ok: false, message: String(e) } }
})

// APK 선택 다이얼로그
ipcMain.handle('dialog:openApk', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'APK 파일 선택',
    filters: [{ name: 'APK', extensions: ['apk', 'xapk'] }],
    properties: ['openFile', 'multiSelections'],
  })
  return filePaths || []
})

// 일반 파일 선택 다이얼로그 (파일 전송용)
ipcMain.handle('dialog:openFile', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '파일 선택 (Android로 전송)',
    properties: ['openFile', 'multiSelections'],
  })
  return filePaths || []
})

// APK 설치
ipcMain.handle('adb:install', (_, { serial, apkPath }) => {
  return new Promise(resolve => {
    const proc = spawn(adbPath, ['-s', serial, 'install', '-r', apkPath])
    let output = ''
    proc.stdout.on('data', d => { output += d; mainWindow?.webContents.send('adb:install-log', output) })
    proc.stderr.on('data', d => { output += d })
    proc.on('close', () => resolve({ ok: output.includes('Success'), output }))
  })
})

// 파일 push (PC → 기기)
ipcMain.handle('adb:push', async (_, { serial, localPath, remotePath }) => {
  try {
    return { ok: true, result: await runAdb(['-s', serial, 'push', localPath, remotePath]) }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 파일 pull (기기 → PC)
ipcMain.handle('adb:pull', async (_, { serial, remotePath }) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.basename(remotePath),
    })
    if (!filePath) return { ok: false }
    await runAdb(['-s', serial, 'pull', remotePath, filePath])
    return { ok: true, path: filePath }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 클립보드 전송
ipcMain.handle('adb:clipboard-send', async (_, { serial, text }) => {
  try {
    const escaped = text.replace(/'/g, "'\\''")
    await runAdb(['-s', serial, 'shell', `am broadcast -a clipper.set -e text '${escaped}'`])
    return { ok: true }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 클립보드 가져오기
ipcMain.handle('adb:clipboard-get', async (_, serial) => {
  try {
    return { ok: true, text: await runAdb(['-s', serial, 'shell', 'clipper']) }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 키 이벤트
ipcMain.handle('adb:keyevent', async (_, { serial, keycode }) => {
  try {
    await runAdb(['-s', serial, 'shell', 'input', 'keyevent', String(keycode)]); return { ok: true }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 현재 액티비티(화면명) 조회
ipcMain.handle('adb:current-activity', async (_, serial) => {
  try {
    let out = await runAdb(['-s', serial, 'shell', 'dumpsys window displays'])
    let match = out.match(/mCurrentFocus=Window\{[^\s]+\s+[^\s]+\s+([^\s\}]+)/)
    if (match && match[1] && match[1] !== 'null') {
      return { ok: true, activity: match[1] }
    }

    out = await runAdb(['-s', serial, 'shell', 'dumpsys activity activities'])
    match = out.match(/mResumedActivity:.*?([a-zA-Z0-9_\.]+\/[a-zA-Z0-9_\.]+)/)
    if (match && match[1]) {
      return { ok: true, activity: match[1] }
    }

    out = await runAdb(['-s', serial, 'shell', 'dumpsys activity top'])
    match = out.match(/ACTIVITY\s+([a-zA-Z0-9_\.]+\/[a-zA-Z0-9_\.]+)/)
    if (match && match[1]) {
      return { ok: true, activity: match[1] }
    }

    return { ok: false, message: 'Not found' }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// 현재 액티비티 상세 정보 조회
ipcMain.handle('adb:activity-info', async (_, { serial, activityName }) => {
  try {
    const out = await runAdb(['-s', serial, 'shell', `dumpsys activity ${activityName}`])
    return { ok: true, info: out }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// ── 세팅 체크 ──────────────────────────────────────────────────
ipcMain.handle('setup:check', async () => {
  adbPath = resolveBin(adbBin)  // 재탐색

  let adbVersion = null, deviceCount = 0
  const serverJarExists = fs.existsSync(path.join(binDir, 'scrcpy-server'))

  if (adbPath) {
    try { adbVersion = (await runAdb(['--version'])).split('\n')[0] } catch { }
    try {
      const out = await runAdb(['devices'])
      deviceCount = out.split('\n').slice(1).filter(l => /\s+device\b/.test(l.trim())).length
    } catch { }
  }
  return {
    adb: { found: !!adbPath, path: adbPath, version: adbVersion },
    scrcpy: { found: true, version: `server jar ${serverJarExists ? '있음(캐시)' : '없음(자동 다운로드)'}` },
    deviceCount,
    platform,
  }
})

// ── 패킷 분석 프록시 IPC ────────────────────────────────────────
ipcMain.handle('proxy:start', async (_, port) => {
  try {
    if (proxyServer) await proxyServer.stop()

    const certDir = path.join(app.getPath('userData'), 'proxy-certs')
    certManager = new CertManager(certDir)
    proxyServer = new ProxyServer(certManager, (packet) => {
      mainWindow?.webContents.send('proxy:packet', packet)
    })
    const actualPort = await proxyServer.start(port || 8888)
    return { ok: true, port: actualPort }
  } catch (e) {
    return { ok: false, message: e.message }
  }
})

ipcMain.handle('proxy:stop', async () => {
  if (proxyServer) {
    await proxyServer.stop()
    proxyServer = null
  }
  return { ok: true }
})

// 기기에 프록시 설정 (ADB)
ipcMain.handle('proxy:setup-device', async (_, { serial, proxyPort }) => {
  try {
    // PC의 로컬 IP 획득
    const nets = os.networkInterfaces()
    let pcIp = '127.0.0.1'
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          pcIp = net.address
          break
        }
      }
    }
    await runAdb(['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', `${pcIp}:${proxyPort}`])
    return { ok: true, pcIp, proxyPort }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// 기기에서 프록시 해제
ipcMain.handle('proxy:clear-device', async (_, serial) => {
  try {
    await runAdb(['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0'])
    return { ok: true }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// CA 인증서를 기기에 push
ipcMain.handle('proxy:install-cert', async (_, serial) => {
  try {
    if (!certManager) {
      const certDir = path.join(app.getPath('userData'), 'proxy-certs')
      certManager = new CertManager(certDir)
    }
    const certPath = certManager.getCACertPath()
    await runAdb(['-s', serial, 'push', certPath, '/sdcard/Download/DroidBridge_CA.crt'])
    // 인증서 파일 경로 권한(Scoped Storage) 문제 회피를 위해, Android 내장 '인증서 설치 파일 선택기' 호출
    await runAdb(['-s', serial, 'shell', 'am', 'start', '-a', 'android.credentials.INSTALL'])
    return { ok: true }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// PC의 로컬 IP 조회
ipcMain.handle('proxy:get-pc-ip', async () => {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return '127.0.0.1'
})

// APK 패치 및 설치 (apk-mitm)
ipcMain.handle('proxy:patch-and-install-apk', async (_, serial) => {
  try {
    // 1. Java 설치 확인
    try {
      await new Promise((resolve, reject) => {
        require('child_process').exec('java -version', (err) => {
          if (err) reject(new Error('Java가 설치되어 있지 않습니다. PC에 Java(JRE)를 설치해 주세요. (apk-mitm 필수 요구사항)'))
          else resolve()
        })
      })
    } catch (e) {
      return { ok: false, message: e.message }
    }

    // 2. APK 파일 선택
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
      title: '패치할 원본 APK 파일 선택',
      properties: ['openFile'],
      filters: [{ name: 'APK Files', extensions: ['apk'] }]
    })
    
    if (canceled || filePaths.length === 0) return { ok: false, message: '취소됨', isCancel: true }
    
    const originalApkPath = filePaths[0]
    
    // 3. npx apk-mitm 실행
    const patchedApkPath = await new Promise((resolve, reject) => {
      // apk-mitm은 실행된 위치에 '파일명-patched.apk'를 생성함
      const targetDir = path.dirname(originalApkPath)
      const apkName = path.basename(originalApkPath)
      const patchedName = apkName.replace(/\.apk$/i, '-patched.apk')
      const expectedPatchedPath = path.join(targetDir, patchedName)

      // 이전 패치 파일이 있다면 삭제
      if (fs.existsSync(expectedPatchedPath)) {
        fs.unlinkSync(expectedPatchedPath)
      }

      const execProcess = require('child_process').exec(`npx apk-mitm "${apkName}"`, { cwd: targetDir }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`패치 실패: ${error.message}\n${stderr}`))
        } else {
          resolve(expectedPatchedPath)
        }
      })
    })

    // 4. 생성된 패치 파일을 기기에 설치
    if (!fs.existsSync(patchedApkPath)) {
      throw new Error('패치된 파일이 생성되지 않았습니다.')
    }
    
    await runAdb(['-s', serial, 'install', '-r', patchedApkPath])
    
    return { ok: true, message: '패치 및 기기 설치가 완료되었습니다!' }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})
