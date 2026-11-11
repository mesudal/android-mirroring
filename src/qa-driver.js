'use strict'

const { parseUiHierarchy } = require('./qa-xml')

class QaDriver {
  constructor(runAdb) {
    this.runAdb = runAdb
    this.deviceQueues = new Map()
  }

  runForDevice(serial, operation) {
    if (!serial) return Promise.reject(new Error('QA 기기를 지정해야 합니다'))
    const previous = this.deviceQueues.get(serial) || Promise.resolve()
    const current = previous.then(operation)
    this.deviceQueues.set(serial, current.catch(() => {}))
    return current
  }

  async _dumpUi(serial) {
    let lastError
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const output = await this.runAdb(
          ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], 30000)
        if (/could not get idle state/i.test(output)) {
          throw new Error('화면이 움직이는 중입니다')
        }
        return { xml: output, elements: parseUiHierarchy(output) }
      } catch (error) {
        lastError = error
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350))
      }
    }

    try {
      await this.runAdb(
        ['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/droidbridge-window-dump.xml'],
        30000)
      const xml = await this.runAdb(
        ['-s', serial, 'exec-out', 'cat', '/sdcard/droidbridge-window-dump.xml'], 15000)
      return { xml, elements: parseUiHierarchy(xml) }
    } catch (error) {
      throw new Error(`화면 구조를 가져오지 못했습니다: ${String(error || lastError)}`)
    }
  }

  dumpUi(serial) {
    return this.runForDevice(serial, () => this._dumpUi(serial))
  }

  tap(serial, x, y) {
    return this.runForDevice(serial, async () => {
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
        throw new Error('탭 좌표가 올바르지 않습니다')
      }
      await this.runAdb(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)])
      return { x, y }
    })
  }
}

module.exports = QaDriver

if (require.main === module) {
  const assert = require('assert')
  const xml = '<hierarchy><node text="확인" bounds="[1,2][7,8]" enabled="true"/></hierarchy>'
  const calls = []
  const driver = new QaDriver(async (args, timeout) => {
    calls.push({ args, timeout })
    return xml
  })

  async function selfTest() {
    const result = await driver.dumpUi('test-device')
    assert.strictEqual(result.elements[0].text, '확인')
    assert.strictEqual(calls[0].timeout, 30000)

    await driver.tap('test-device', 4, 5)
    assert.deepStrictEqual(calls[1].args,
      ['-s', 'test-device', 'shell', 'input', 'tap', '4', '5'])
    await assert.rejects(driver.tap('test-device', -1, 5), /탭 좌표가 올바르지 않습니다/)

    let active = 0
    let maxActive = 0
    let releaseFirst
    const firstGate = new Promise(resolve => { releaseFirst = resolve })
    const first = driver.runForDevice('queue-device', async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await firstGate
      active--
    })
    const second = driver.runForDevice('queue-device', async () => {
      active++
      maxActive = Math.max(maxActive, active)
      active--
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(active, 1)
    releaseFirst()
    await Promise.all([first, second])
    assert.strictEqual(maxActive, 1)
    console.log('qa-driver 자가진단 통과 — UI 조회·탭·기기별 직렬화')
  }

  selfTest().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
