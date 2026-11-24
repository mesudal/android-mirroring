// APK 파일에서 패키지명·버전·최소 SDK·서명 인증서를 읽는다.
// aapt·apksigner 같은 외부 도구 없이(설치파일 앱이라 추가 런타임을 요구하지 않는다),
// npm 의존성 없이 Node 내장 모듈만 쓴다. 단독 실행 = 자가진단 (`node src/apk-info.js`).
//
// 구성
//   1) ZIP: 끝의 EOCD → 중앙 디렉터리 → AndroidManifest.xml 항목만 꺼낸다 (파일 전체를 읽지 않는다)
//   2) 바이너리 XML(AXML): <manifest package versionCode versionName> 와 <uses-sdk minSdkVersion>
//   3) APK 서명 블록(v3 → v2 순): 첫 서명자의 인증서(DER)
//
// 서명 비교: 기기의 `dumpsys package <pkg>` 는 `signatures:[d7e007be]` 처럼 인증서의
// Java `Arrays.hashCode(byte[])` 값을 16진수로 보여 준다. 같은 값을 APK 인증서로 계산해
// 비교한다 (`signerHash`). v1(JAR) 서명만 있는 APK 는 인증서를 읽지 않는다.

const fs = require('fs')
const zlib = require('zlib')
const crypto = require('crypto')

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const SIG_BLOCK_MAGIC = 'APK Sig Block 42'
const SCHEME_IDS = [
  [0x1b93ad61, 'v3.1'],
  [0xf05368c0, 'v3'],
  [0x7109871a, 'v2'],
]
// 리소스 id — aapt2 빌드는 속성 이름 문자열을 비우고 이 id 로만 남기기도 한다
const ATTR_IDS = { versionCode: 0x0101021b, versionName: 0x0101021c, minSdkVersion: 0x0101020c }
const MAX_MANIFEST = 8 * 1024 * 1024

// ── 읽기 도구 ───────────────────────────────────────────────────
function bufferReader(buf) {
  return { size: buf.length, read: (off, len) => buf.subarray(off, off + len), close() {} }
}

function fileReader(file) {
  const fd = fs.openSync(file, 'r')
  const size = fs.fstatSync(fd).size
  return {
    size,
    read(off, len) {
      const b = Buffer.alloc(Math.max(0, Math.min(len, size - off)))
      if (b.length) fs.readSync(fd, b, 0, b.length, off)
      return b
    },
    close() { try { fs.closeSync(fd) } catch { } },
  }
}

// ── ZIP ────────────────────────────────────────────────────────
function findEocd(r) {
  const tail = Math.min(r.size, 22 + 0xffff)
  const buf = r.read(r.size - tail, tail)
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const cdSize = buf.readUInt32LE(i + 12)
      const cdOffset = buf.readUInt32LE(i + 16)
      if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error('ZIP64 형식은 지원하지 않습니다')
      return { cdSize, cdOffset }
    }
  }
  throw new Error('ZIP 파일이 아닙니다 (끝 레코드 없음)')
}

function listEntries(r, eocd) {
  const cd = r.read(eocd.cdOffset, eocd.cdSize)
  const entries = new Map()
  let p = 0
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, {
      method: cd.readUInt16LE(p + 10),
      compSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readEntry(r, e) {
  if (e.size > MAX_MANIFEST) throw new Error('매니페스트가 비정상적으로 큽니다')
  const lh = r.read(e.localOffset, 30)
  if (lh.length < 30 || lh.readUInt32LE(0) !== LOCAL_SIG) throw new Error('ZIP 로컬 헤더가 깨졌습니다')
  const start = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
  const data = r.read(start, e.compSize)
  if (e.method === 0) return data
  if (e.method === 8) return zlib.inflateRawSync(data)
  throw new Error(`지원하지 않는 압축 방식입니다 (${e.method})`)
}

// ── 바이너리 XML (AndroidManifest.xml) ──────────────────────────
function readStringPool(b, at) {
  const count = b.readUInt32LE(at + 8)
  const utf8 = (b.readUInt32LE(at + 16) & 0x100) !== 0
  const stringsStart = at + b.readUInt32LE(at + 20)
  const offsets = at + b.readUInt16LE(at + 2)
  const strings = []
  for (let i = 0; i < count; i++) {
    let p = stringsStart + b.readUInt32LE(offsets + i * 4)
    if (utf8) {
      // utf16 길이(1~2B) 다음 utf8 바이트 길이(1~2B)
      p += (b[p] & 0x80) ? 2 : 1
      let n = b[p]
      if (n & 0x80) { n = ((n & 0x7f) << 8) | b[p + 1]; p += 2 } else p += 1
      strings.push(b.toString('utf8', p, p + n))
    } else {
      let n = b.readUInt16LE(p)
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | b.readUInt16LE(p + 2); p += 4 } else p += 2
      strings.push(b.toString('utf16le', p, p + n * 2))
    }
  }
  return strings
}

function parseManifest(b) {
  if (b.length < 8 || b.readUInt16LE(0) !== 0x0003) throw new Error('바이너리 매니페스트가 아닙니다')
  let strings = []
  let resIds = []
  const out = { package: '', versionCode: null, versionName: '', minSdk: null }
  let p = b.readUInt16LE(2)
  while (p + 8 <= b.length) {
    const type = b.readUInt16LE(p)
    const headerSize = b.readUInt16LE(p + 2)
    const size = b.readUInt32LE(p + 4)
    if (size < 8 || p + size > b.length) break
    if (type === 0x0001) strings = readStringPool(b, p)
    else if (type === 0x0180) {
      resIds = []
      for (let q = p + headerSize; q + 4 <= p + size; q += 4) resIds.push(b.readUInt32LE(q))
    } else if (type === 0x0102) {
      const name = strings[b.readUInt32LE(p + 20)] || ''
      if (name === 'manifest' || name === 'uses-sdk') {
        const attrStart = p + headerSize + b.readUInt16LE(p + 24)
        const attrSize = b.readUInt16LE(p + 26)
        const attrCount = b.readUInt16LE(p + 28)
        for (let i = 0; i < attrCount; i++) {
          const a = attrStart + i * attrSize
          const nameIdx = b.readUInt32LE(a + 4)
          const raw = b.readUInt32LE(a + 8)
          const dataType = b[a + 15]
          const data = b.readUInt32LE(a + 16)
          const attrName = strings[nameIdx] || ''
          const rid = resIds[nameIdx]
          const is = key => attrName === key || rid === ATTR_IDS[key]
          const str = raw !== 0xffffffff ? strings[raw] : dataType === 0x03 ? strings[data] : null
          const int = dataType === 0x10 || dataType === 0x11 ? data : (str != null && /^\d+$/.test(str) ? Number(str) : null)
          if (name === 'manifest') {
            if (attrName === 'package') out.package = str || ''
            else if (is('versionCode')) out.versionCode = int
            else if (is('versionName')) out.versionName = str ?? (dataType === 0x01 ? '(리소스 참조)' : String(data))
          } else if (is('minSdkVersion')) {
            out.minSdk = int
          }
        }
      }
    }
    p += size
  }
  return out
}

// ── APK 서명 블록 ───────────────────────────────────────────────
function lenPrefixed(b, p) {
  if (p + 4 > b.length) throw new Error('서명 블록이 깨졌습니다')
  const n = b.readUInt32LE(p)
  if (p + 4 + n > b.length) throw new Error('서명 블록이 깨졌습니다')
  return { value: b.subarray(p + 4, p + 4 + n), next: p + 4 + n }
}

function firstSignerCert(schemeValue) {
  const signers = lenPrefixed(schemeValue, 0).value
  const signer = lenPrefixed(signers, 0).value
  const signedData = lenPrefixed(signer, 0).value
  const digests = lenPrefixed(signedData, 0)
  const certs = lenPrefixed(signedData, digests.next).value
  return lenPrefixed(certs, 0).value
}

function readSigner(r, cdOffset) {
  if (cdOffset < 32) return null
  const foot = r.read(cdOffset - 24, 24)
  if (foot.toString('latin1', 8, 24) !== SIG_BLOCK_MAGIC) return null
  const blockSize = Number(foot.readBigUInt64LE(0))
  const start = cdOffset - blockSize - 8
  if (start < 0 || blockSize > 64 * 1024 * 1024) throw new Error('서명 블록 크기가 비정상입니다')
  const block = r.read(start, blockSize + 8)
  const pairs = new Map()
  for (let p = 8; p + 12 <= block.length - 24;) {
    const len = Number(block.readBigUInt64LE(p))
    if (len < 4 || p + 8 + len > block.length - 24) break
    pairs.set(block.readUInt32LE(p + 8), block.subarray(p + 12, p + 8 + len))
    p += 8 + len
  }
  for (const [id, scheme] of SCHEME_IDS) {
    if (pairs.has(id)) {
      const cert = firstSignerCert(pairs.get(id))
      return { scheme, hash: signerHash(cert), sha256: crypto.createHash('sha256').update(cert).digest('hex') }
    }
  }
  return null
}

// Java Arrays.hashCode(byte[]) — 기기 dumpsys 의 signatures:[...] 값과 같은 계산
function signerHash(der) {
  let h = 1
  for (const byte of der) h = (Math.imul(31, h) + ((byte << 24) >> 24)) | 0
  return (h >>> 0).toString(16)
}

// ── 공개 함수 ───────────────────────────────────────────────────
function inspectReader(r) {
  const eocd = findEocd(r)
  const entries = listEntries(r, eocd)
  const entry = entries.get('AndroidManifest.xml')
  if (!entry) throw new Error('AndroidManifest.xml 이 없습니다 (APK 가 아닙니다)')
  const manifest = parseManifest(readEntry(r, entry))
  if (!manifest.package) throw new Error('매니페스트에서 패키지명을 읽지 못했습니다')
  let signer = null
  let signerError = ''
  try { signer = readSigner(r, eocd.cdOffset) } catch (e) { signerError = e.message }
  return { ...manifest, size: r.size, signer, signerError }
}

// APK 파일 하나를 읽는다. 예외 없이 { ok, ... } / { ok:false, message }.
function inspectApk(file) {
  let r
  try {
    r = fileReader(file)
    return { ok: true, ...inspectReader(r) }
  } catch (e) {
    return { ok: false, message: `APK 를 읽지 못했습니다: ${e.message}` }
  } finally { r?.close() }
}

// 기기 `dumpsys package <pkg>` 출력에서 그 패키지의 현재 서명자 해시. 없으면 ''.
// 출력에 다른 패키지 블록이 섞일 수 있어 `Package [<pkg>]` 블록 안에서만 찾는다.
function parseDeviceSigner(dump, pkg) {
  const all = String(dump || '')
  const head = pkg ? all.indexOf(`Package [${pkg}]`) : 0
  if (head < 0) return ''
  const rest = all.slice(head + 1)
  const next = rest.search(/\n\s*Package \[/)
  const m = /signatures:\[([0-9a-f]+)/.exec(next < 0 ? rest : rest.slice(0, next))
  return m ? m[1] : ''
}

// 등록한 APK 를 이 기기에 "덮어 설치(데이터 유지)" 할 수 있는지 판정한다.
//   apk:       inspectApk 결과
//   installed: { versionCode, versionName, signer } | null (미설치)
//   device:    { sdk }
//   expectPkg: 앱 타입의 패키지명
// 반환: { level: 'ok' | 'warn' | 'error', message, canInstall }
function checkUpdate({ apk, installed, device, expectPkg }) {
  if (!apk?.ok) return { level: 'error', canInstall: false, message: apk?.message || 'APK 정보가 없습니다' }
  if (apk.package !== expectPkg) {
    return { level: 'error', canInstall: false, message: `패키지가 다릅니다: APK ${apk.package} / 이 타입 ${expectPkg}` }
  }
  if (apk.minSdk && device?.sdk && apk.minSdk > device.sdk) {
    return { level: 'error', canInstall: false, message: `기기 Android 가 낮습니다 (APK 최소 SDK ${apk.minSdk}, 기기 ${device.sdk})` }
  }
  const to = `v${apk.versionName} (${apk.versionCode})`
  if (!installed) return { level: 'warn', canInstall: true, message: `기기에 설치돼 있지 않습니다 — ${to} 를 새로 설치합니다 (업데이트 테스트가 아님)` }
  const from = `v${installed.versionName} (${installed.versionCode})`
  if (apk.signer && installed.signer && apk.signer.hash !== installed.signer) {
    return { level: 'error', canInstall: false, message: `서명 키가 다릅니다 (APK ${apk.signer.hash} / 기기 ${installed.signer}) — 덮어 설치할 수 없습니다. 스토어 설치본이면 dev 빌드로 먼저 설치해 주세요` }
  }
  if (apk.versionCode < installed.versionCode) {
    return { level: 'error', canInstall: false, message: `APK 가 더 낮은 버전입니다 (${from} → ${to}). 낮은 버전은 데이터를 지워야만 설치됩니다` }
  }
  const unsure = !apk.signer || !installed.signer ? ' · 서명은 확인하지 못했습니다' : ''
  if (apk.versionCode === installed.versionCode) {
    return { level: 'warn', canInstall: true, message: `같은 버전입니다 (${from}) — 재설치만 됩니다${unsure}` }
  }
  return { level: unsure ? 'warn' : 'ok', canInstall: true, message: `${from} → ${to} 업데이트 가능 (데이터 유지)${unsure}` }
}

// 업데이트 테스트의 출발점인 "기존 버전" 설치 판정.
// 실제 사용자처럼 기존 버전에서 쌓은 데이터를 업데이트까지 이어 가야 하므로, 앱 데이터는
// **지울 수밖에 없을 때만** 지운다. action:
//   install   : 설치돼 있지 않음 → 그냥 설치
//   none      : 이미 같은 버전·같은 서명 → 설치할 것 없음 (그대로 기존 버전에서 확인 진행)
//   upgrade   : 같은 서명의 더 낮은 버전이 깔려 있음 → 덮어 설치 (데이터 유지)
//   reinstall : 더 높은 버전이거나 서명이 다름(스토어 설치본 등) → Android 가 덮어 설치를 막으므로
//               지우고(앱 데이터 초기화) 설치해야 한다. 이유를 메시지에 적는다.
function checkBaseInstall({ apk, installed, device, expectPkg }) {
  if (!apk?.ok) return { level: 'error', canInstall: false, message: apk?.message || 'APK 정보가 없습니다' }
  if (apk.package !== expectPkg) {
    return { level: 'error', canInstall: false, message: `패키지가 다릅니다: APK ${apk.package} / 이 타입 ${expectPkg}` }
  }
  if (apk.minSdk && device?.sdk && apk.minSdk > device.sdk) {
    return { level: 'error', canInstall: false, message: `기기 Android 가 낮습니다 (APK 최소 SDK ${apk.minSdk}, 기기 ${device.sdk})` }
  }
  const to = `v${apk.versionName} (${apk.versionCode})`
  if (!installed) return { level: 'ok', canInstall: true, action: 'install', message: `${to} 를 새로 설치합니다` }
  const from = `v${installed.versionName} (${installed.versionCode})`
  const signerKnown = !!(apk.signer && installed.signer)
  const sameSigner = !signerKnown || apk.signer.hash === installed.signer
  const unsure = signerKnown ? '' : ' · 서명은 확인하지 못했습니다'
  if (!sameSigner) {
    return {
      level: 'warn', canInstall: true, action: 'reinstall',
      message: `설치된 ${from} 와 서명 키가 달라(스토어 설치본 등) 덮어 설치할 수 없습니다 — 지우고(앱 데이터 초기화) ${to} 를 설치합니다`,
    }
  }
  if (installed.versionCode > apk.versionCode) {
    return {
      level: 'warn', canInstall: true, action: 'reinstall',
      message: `설치된 ${from} 가 더 높은 버전이라 낮은 버전으로 되돌리려면 지워야 합니다 — 지우고(앱 데이터 초기화) ${to} 를 설치합니다`,
    }
  }
  if (installed.versionCode === apk.versionCode) {
    return { level: 'ok', canInstall: false, action: 'none', message: `이미 기존 버전 ${from} 가 설치돼 있습니다 — 그대로 확인을 진행한 뒤 업데이트하세요${unsure}` }
  }
  return { level: 'ok', canInstall: true, action: 'upgrade', message: `설치된 ${from} 위에 ${to} 를 덮어 설치합니다 (앱 데이터 유지)${unsure}` }
}

// 등록한 두 APK 가 업데이트 테스트 한 쌍으로 맞는지. 둘 중 하나라도 없으면 null.
function checkPair(base, update) {
  if (!base || !update) return null
  if (!base.ok || !update.ok) return { level: 'error', ok: false, message: '읽지 못한 APK 가 있습니다' }
  if (base.package !== update.package) {
    return { level: 'error', ok: false, message: `두 APK 의 패키지가 다릅니다 (${base.package} / ${update.package})` }
  }
  const from = `v${base.versionName} (${base.versionCode})`
  const to = `v${update.versionName} (${update.versionCode})`
  if (base.signer && update.signer && base.signer.hash !== update.signer.hash) {
    return { level: 'error', ok: false, message: `두 APK 의 서명 키가 다릅니다 (${base.signer.hash} / ${update.signer.hash}) — 덮어 설치할 수 없습니다` }
  }
  if (update.versionCode < base.versionCode) {
    return { level: 'error', ok: false, message: `업데이트 APK 가 기존보다 낮은 버전입니다 (${from} → ${to})` }
  }
  if (update.versionCode === base.versionCode) {
    return { level: 'warn', ok: true, message: `두 APK 의 버전이 같습니다 (${from}) — 같은 버전 재설치 테스트가 됩니다` }
  }
  const unsure = !base.signer || !update.signer ? ' · 서명은 확인하지 못했습니다' : ''
  return { level: unsure ? 'warn' : 'ok', ok: true, message: `${from} → ${to} 업데이트 테스트 가능${unsure}` }
}

module.exports = {
  inspectApk, inspectReader, bufferReader, parseManifest, signerHash, parseDeviceSigner,
  checkUpdate, checkBaseInstall, checkPair,
}

// ── 자가진단 ────────────────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert')

  // Java Arrays.hashCode — 손계산 값과 음수 바이트
  assert.strictEqual(signerHash(Buffer.from([1, 2, 3])), (((1 * 31 + 1) * 31 + 2) * 31 + 3).toString(16))
  assert.strictEqual(signerHash(Buffer.from([0xff])), (31 - 1).toString(16), '바이트는 부호 있는 값으로 더한다')
  assert.strictEqual(signerHash(Buffer.alloc(0)), '1')
  // 32비트 넘침 후 음수 → 부호 없는 16진수 (Integer.toHexString 과 같게)
  const big = signerHash(Buffer.alloc(40, 0x7f))
  assert.ok(/^[0-9a-f]{1,8}$/.test(big))

  // ── 가짜 APK 만들기: AXML + ZIP + 서명 블록 ──
  function axml({ pkg, versionCode, versionName, minSdk, nameless = false }) {
    // 문자열 풀 (UTF-16). nameless=true 면 속성 이름을 비우고 리소스 id 로만 둔다 (aapt2 형태)
    // 0~2 = 속성 이름(리소스 맵과 같은 순서), 8 = 패키지명
    const S = [
      ...(nameless ? ['', '', ''] : ['versionCode', 'versionName', 'minSdkVersion']),
      'package', 'manifest', 'uses-sdk', versionName, 'http://schemas.android.com/apk/res/android', pkg,
    ]
    const encoded = S.map(s => { const b = Buffer.alloc(2 + s.length * 2 + 2); b.writeUInt16LE(s.length, 0); b.write(s, 2, 'utf16le'); return b })
    const offs = Buffer.alloc(S.length * 4)
    let o = 0
    encoded.forEach((e, i) => { offs.writeUInt32LE(o, i * 4); o += e.length })
    let body = Buffer.concat(encoded)
    if (body.length % 4) body = Buffer.concat([body, Buffer.alloc(4 - body.length % 4)])
    const sp = Buffer.alloc(28)
    sp.writeUInt16LE(0x0001, 0); sp.writeUInt16LE(28, 2); sp.writeUInt32LE(28 + offs.length + body.length, 4)
    sp.writeUInt32LE(S.length, 8); sp.writeUInt32LE(28 + offs.length, 20)
    const pool = Buffer.concat([sp, offs, body])
    const rm = Buffer.alloc(8 + 12)
    rm.writeUInt16LE(0x0180, 0); rm.writeUInt16LE(8, 2); rm.writeUInt32LE(20, 4)
    rm.writeUInt32LE(ATTR_IDS.versionCode, 8); rm.writeUInt32LE(ATTR_IDS.versionName, 12); rm.writeUInt32LE(ATTR_IDS.minSdkVersion, 16)
    const NS = 7
    const attr = (nameIdx, raw, type, data, ns = NS) => {
      const a = Buffer.alloc(20)
      a.writeUInt32LE(ns, 0); a.writeUInt32LE(nameIdx, 4); a.writeUInt32LE(raw, 8)
      a.writeUInt16LE(8, 12); a[15] = type; a.writeUInt32LE(data, 16)
      return a
    }
    const el = (nameIdx, attrs) => {
      const h = Buffer.alloc(36)
      h.writeUInt16LE(0x0102, 0); h.writeUInt16LE(16, 2); h.writeUInt32LE(36 + attrs.length * 20, 4)
      h.writeUInt32LE(1, 8); h.writeUInt32LE(0xffffffff, 12); h.writeUInt32LE(0xffffffff, 16); h.writeUInt32LE(nameIdx, 20)
      h.writeUInt16LE(20, 24); h.writeUInt16LE(20, 26); h.writeUInt16LE(attrs.length, 28)
      return Buffer.concat([h, ...attrs])
    }
    const manifest = el(4, [
      attr(0, 0xffffffff, 0x10, versionCode),
      attr(1, 6, 0x03, 6),
      attr(3, 0xffffffff, 0x03, 8, 0xffffffff),
    ])
    const uses = el(5, [attr(2, 0xffffffff, 0x10, minSdk)])
    const chunks = Buffer.concat([pool, rm, manifest, uses])
    const head = Buffer.alloc(8)
    head.writeUInt16LE(0x0003, 0); head.writeUInt16LE(8, 2); head.writeUInt32LE(8 + chunks.length, 4)
    return Buffer.concat([head, chunks])
  }

  function zip(files, sigBlock = Buffer.alloc(0)) {
    const locals = []
    const cds = []
    let off = 0
    for (const [name, data, method] of files) {
      const comp = method === 8 ? zlib.deflateRawSync(data) : data
      const n = Buffer.from(name)
      const lh = Buffer.alloc(30)
      lh.writeUInt32LE(LOCAL_SIG, 0); lh.writeUInt16LE(method, 8)
      lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26)
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(CD_SIG, 0); cd.writeUInt16LE(method, 10)
      cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28)
      cd.writeUInt32LE(off, 42)
      locals.push(lh, n, comp)
      cds.push(cd, n)
      off += 30 + n.length + comp.length
    }
    const localBuf = Buffer.concat([...locals, sigBlock])
    const cdBuf = Buffer.concat(cds)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(EOCD_SIG, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16)
    return Buffer.concat([localBuf, cdBuf, eocd])
  }

  function sigBlock(schemeId, cert) {
    const lp = b => { const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]) }
    const signedData = Buffer.concat([lp(Buffer.alloc(0)), lp(lp(cert)), lp(Buffer.alloc(0))])
    const value = lp(lp(Buffer.concat([lp(signedData), lp(Buffer.alloc(0)), lp(Buffer.alloc(0))])))
    const pair = Buffer.alloc(12)
    pair.writeBigUInt64LE(BigInt(4 + value.length), 0); pair.writeUInt32LE(schemeId, 8)
    const pairs = Buffer.concat([pair, value])
    const size = BigInt(pairs.length + 8 + 16)
    const s1 = Buffer.alloc(8); s1.writeBigUInt64LE(size)
    return Buffer.concat([s1, pairs, s1, Buffer.from(SIG_BLOCK_MAGIC, 'latin1')])
  }

  const CERT = crypto.randomBytes(700)
  const man = axml({ pkg: 'net.zerotalk.user', versionCode: 52, versionName: '1.2.13', minSdk: 26 })

  // 1) 압축된 매니페스트 + v2 서명
  let info = inspectReader(bufferReader(zip([['classes.dex', Buffer.alloc(100), 0], ['AndroidManifest.xml', man, 8]], sigBlock(0x7109871a, CERT))))
  assert.strictEqual(info.package, 'net.zerotalk.user')
  assert.strictEqual(info.versionCode, 52)
  assert.strictEqual(info.versionName, '1.2.13')
  assert.strictEqual(info.minSdk, 26)
  assert.strictEqual(info.signer.scheme, 'v2')
  assert.strictEqual(info.signer.hash, signerHash(CERT))

  // 2) 비압축 + v3 가 v2 보다 우선 (키 교체 시 현재 서명자는 v3 쪽)
  const CERT3 = crypto.randomBytes(500)
  info = inspectReader(bufferReader(zip([['AndroidManifest.xml', man, 0]], sigBlock(0xf05368c0, CERT3))))
  assert.strictEqual(info.signer.scheme, 'v3')
  assert.strictEqual(info.signer.hash, signerHash(CERT3))

  // 3) 서명 블록 없음(v1 만) → signer null, 나머지는 읽힌다
  info = inspectReader(bufferReader(zip([['AndroidManifest.xml', man, 8]])))
  assert.strictEqual(info.signer, null)
  assert.strictEqual(info.versionCode, 52)

  // 4) 속성 이름이 빈 aapt2 형태 — 리소스 id 로 찾는다
  info = inspectReader(bufferReader(zip([['AndroidManifest.xml', axml({ pkg: 'a.b', versionCode: 7, versionName: '0.7', minSdk: 24, nameless: true }), 8]])))
  assert.deepStrictEqual([info.package, info.versionCode, info.versionName, info.minSdk], ['a.b', 7, '0.7', 24])

  // 5) 깨진 입력
  assert.throws(() => inspectReader(bufferReader(Buffer.from('not a zip'))), /ZIP 파일이 아닙니다/)
  assert.throws(() => inspectReader(bufferReader(zip([['x.txt', Buffer.from('hi'), 0]]))), /AndroidManifest/)
  assert.throws(() => parseManifest(Buffer.from('<?xml version="1.0"?>')), /바이너리 매니페스트/)
  assert.strictEqual(inspectApk('없는-파일.apk').ok, false)

  // 기기 서명 해시 파싱 (SM-G986N 실측 형태)
  const DEV = [
    '  Package [com.other] (1):', '    signatures=PackageSignatures{1 version:2, signatures:[11111111], past signatures:[]}',
    '  Package [net.zerotalk.admin] (28bd3b7):', '    versionCode=39 minSdk=26 targetSdk=34',
    '    signatures=PackageSignatures{28bd3b7 version:2, signatures:[8464871e], past signatures:[]}',
  ].join('\n')
  assert.strictEqual(parseDeviceSigner(DEV, 'net.zerotalk.admin'), '8464871e', '대상 블록의 서명')
  assert.strictEqual(parseDeviceSigner(DEV, 'net.zerotalk.free'), '', '블록 없음')
  assert.strictEqual(parseDeviceSigner('Unable to find package: x', 'x'), '')

  // 업데이트 판정
  const apk = { ok: true, package: 'net.zerotalk.user', versionCode: 52, versionName: '1.2.13', minSdk: 26, signer: { hash: 'abc' } }
  const inst = { versionCode: 51, versionName: '1.2.12', signer: 'abc' }
  const dev = { sdk: 33 }
  const chk = o => checkUpdate({ apk, installed: inst, device: dev, expectPkg: 'net.zerotalk.user', ...o })
  assert.deepStrictEqual([chk().level, chk().canInstall], ['ok', true])
  assert.match(chk().message, /v1\.2\.12 \(51\) → v1\.2\.13 \(52\)/)
  assert.strictEqual(chk({ expectPkg: 'net.zerotalk.free' }).level, 'error', '패키지 불일치')
  assert.strictEqual(chk({ installed: { ...inst, signer: 'zzz' } }).canInstall, false, '서명 다름')
  assert.strictEqual(chk({ installed: { ...inst, versionCode: 60 } }).canInstall, false, '다운그레이드')
  assert.strictEqual(chk({ installed: { ...inst, versionCode: 52 } }).level, 'warn', '같은 버전')
  assert.strictEqual(chk({ installed: null }).level, 'warn', '미설치 = 새 설치')
  assert.strictEqual(chk({ device: { sdk: 25 } }).canInstall, false, '최소 SDK')
  assert.strictEqual(chk({ apk: { ...apk, signer: null } }).level, 'warn', '서명 확인 불가는 경고')
  assert.strictEqual(chk({ apk: { ok: false, message: 'x' } }).canInstall, false)

  // 기존 버전 설치 판정: 데이터는 지울 수밖에 없을 때만 지운다
  const base = { ...apk, versionCode: 51, versionName: '1.2.12' }
  const bchk = o => checkBaseInstall({ apk: base, installed: inst, device: dev, expectPkg: 'net.zerotalk.user', ...o })
  const act = o => { const r = bchk(o); return [r.action, r.canInstall] }
  assert.deepStrictEqual(act({ installed: null }), ['install', true], '미설치 → 설치')
  assert.deepStrictEqual(act(), ['none', false], '같은 버전·같은 서명 → 할 것 없음 (데이터 유지)')
  assert.deepStrictEqual(act({ installed: { ...inst, versionCode: 50 } }), ['upgrade', true], '낮은 버전 → 덮어 설치')
  assert.match(bchk({ installed: { ...inst, versionCode: 50 } }).message, /데이터 유지/)
  assert.deepStrictEqual(act({ installed: { ...inst, versionCode: 60 } }), ['reinstall', true], '높은 버전 → 지우고 설치')
  assert.match(bchk({ installed: { ...inst, versionCode: 60 } }).message, /더 높은 버전/)
  assert.deepStrictEqual(act({ installed: { ...inst, signer: 'zzz' } }), ['reinstall', true], '서명 다름 → 지우고 설치')
  assert.match(bchk({ installed: { ...inst, signer: 'zzz' } }).message, /서명 키가 달라/)
  // 서명을 모르면 같은 것으로 보고 데이터를 지키는 쪽으로 판정한다 (설치 실패는 adb 가 알려 준다)
  assert.deepStrictEqual(act({ installed: { ...inst, signer: '', versionCode: 50 } }), ['upgrade', true])
  assert.strictEqual(bchk({ expectPkg: 'net.zerotalk.free' }).canInstall, false, '패키지 불일치')
  assert.strictEqual(bchk({ device: { sdk: 25 } }).canInstall, false, '최소 SDK')

  // 두 APK 의 짝 검사
  assert.strictEqual(checkPair(null, apk), null, '하나만 있으면 판정하지 않는다')
  assert.deepStrictEqual([checkPair(base, apk).level, checkPair(base, apk).ok], ['ok', true])
  assert.match(checkPair(base, apk).message, /v1\.2\.12 \(51\) → v1\.2\.13 \(52\)/)
  assert.strictEqual(checkPair(base, { ...apk, package: 'x.y' }).ok, false, '패키지 다름')
  assert.strictEqual(checkPair(base, { ...apk, signer: { hash: 'zzz' } }).ok, false, '서명 다름')
  assert.strictEqual(checkPair(apk, base).ok, false, '업데이트가 더 낮음')
  assert.strictEqual(checkPair(base, base).level, 'warn', '같은 버전')
  assert.strictEqual(checkPair(base, { ...apk, signer: null }).level, 'warn', '서명 확인 불가')
  assert.strictEqual(checkPair(base, { ok: false }).ok, false)

  console.log('apk-info 자가진단 통과 — ZIP·매니페스트·서명 블록·해시·업데이트·기존 버전·짝 판정')
}
