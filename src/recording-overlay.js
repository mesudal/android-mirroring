'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const SEGMENTS = 24
const MAX_TOUCHES = 500

function buildTouchOverlayFilter(touches) {
  const filters = []
  for (const touch of touches.slice(0, MAX_TOUCHES)) {
    if (![touch.time, touch.x, touch.y].every(Number.isFinite)) continue
    const time = Math.max(0, touch.time)
    const x = Math.max(0, Math.min(1, touch.x))
    const y = Math.max(0, Math.min(1, touch.y))
    for (let i = 0; i < SEGMENTS; i++) {
      const angle = (2 * Math.PI * i / SEGMENTS).toFixed(6)
      const positionX = `iw*${x.toFixed(6)}+max(8,min(iw,ih)*0.025)*cos(${angle})-max(1.5,min(iw,ih)*0.004)`
      const positionY = `ih*${y.toFixed(6)}+max(8,min(iw,ih)*0.025)*sin(${angle})-max(1.5,min(iw,ih)*0.004)`
      const size = 'max(3,min(iw,ih)*0.008)'
      filters.push(
        `drawbox=x='${positionX}':y='${positionY}':w='${size}':h='${size}':color=0xffd54a@0.95:t=fill:enable='between(t,${time.toFixed(3)},${(time + 0.7).toFixed(3)})'`
      )
    }
  }
  return filters.join(',')
}

function overlayRecording({ ffmpegPath, inputPath, outputPath, filterPath, touches, duration, onProgress }) {
  const filter = buildTouchOverlayFilter(touches)
  if (!filter) return Promise.resolve({ skipped: true })
  fs.writeFileSync(filterPath, `[0:v:0]${filter}[marked]\n`)

  return new Promise((resolve, reject) => {
    let stderr = ''
    let stdoutPending = ''
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-filter_complex_script', filterPath,
      '-map', '[marked]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats', outputPath,
    ]
    let proc
    try { proc = spawn(ffmpegPath, args, { windowsHide: true }) } catch (error) {
      reject(error)
      return
    }
    proc.stdout.on('data', chunk => {
      stdoutPending += chunk.toString()
      const lines = stdoutPending.split(/\r?\n/)
      stdoutPending = lines.pop()
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)$/)
        if (match && duration > 0) {
          const percent = Math.min(99, Math.floor(Number(match[1]) / (duration * 1000000) * 100))
          onProgress?.(percent)
        }
      }
    })
    proc.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8000)
    })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) {
        onProgress?.(100)
        resolve({ skipped: false })
      } else {
        reject(new Error(stderr.trim() || `FFmpeg 종료 코드 ${code}`))
      }
    })
  })
}

module.exports = { buildTouchOverlayFilter, overlayRecording, MAX_TOUCHES }

if (require.main === module) {
  const assert = require('assert')
  const filter = buildTouchOverlayFilter([{ time: 1.25, x: 0.5, y: 0.25 }])
  assert.strictEqual((filter.match(/drawbox=/g) || []).length, SEGMENTS)
  assert(filter.includes('between(t,1.250,1.950)'))
  assert(filter.includes('iw*0.500000'))
  assert.strictEqual(buildTouchOverlayFilter([]), '')
  console.log('recording-overlay 자가진단 통과 — 링 필터·위치·표시 시간')
}
