'use strict'

const ATTRIBUTE_RE = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g
const NODE_RE = /<node\b([^>]*)\/?>/g

function decodeXml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : _
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()]
  })
}

function parseAttributes(source) {
  const attributes = {}
  ATTRIBUTE_RE.lastIndex = 0
  let match
  while ((match = ATTRIBUTE_RE.exec(source))) {
    attributes[match[1]] = decodeXml(match[2])
  }
  return attributes
}

function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value || '')
  if (!match) return null
  const [, left, top, right, bottom] = match.map(Number)
  if (right <= left || bottom <= top) return null
  return { left, top, right, bottom, x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) }
}

function parseUiHierarchy(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('화면 구조가 비어 있습니다')
  const nodes = []
  NODE_RE.lastIndex = 0
  let match
  while ((match = NODE_RE.exec(xml))) {
    const attrs = parseAttributes(match[1])
    const bounds = parseBounds(attrs.bounds)
    nodes.push({
      index: nodes.length,
      text: attrs.text || '',
      desc: attrs['content-desc'] || '',
      id: attrs['resource-id'] || '',
      className: attrs.class || '',
      bounds: attrs.bounds || '',
      center: bounds ? { x: bounds.x, y: bounds.y } : null,
      enabled: attrs.enabled !== 'false',
      checked: attrs.checked === 'true',
      clickable: attrs.clickable === 'true',
      packageName: attrs.package || '',
    })
  }
  if (!nodes.length) throw new Error('화면 구조 XML에서 요소를 찾지 못했습니다')
  return nodes
}

function matches(element, selector) {
  if (!selector || typeof selector !== 'object') return false
  if (selector.text !== undefined && element.text !== String(selector.text)) return false
  if (selector.textContains !== undefined && !element.text.includes(String(selector.textContains))) return false
  if (selector.textMatches !== undefined) {
    try {
      if (!new RegExp(selector.textMatches).test(element.text)) return false
    } catch { return false }
  }
  if (selector.desc !== undefined && element.desc !== String(selector.desc)) return false
  if (selector.descContains !== undefined && !element.desc.includes(String(selector.descContains))) return false
  if (selector.descMatches !== undefined) {
    try {
      if (!new RegExp(selector.descMatches).test(element.desc)) return false
    } catch { return false }
  }
  if (selector.id !== undefined && !element.id.endsWith(String(selector.id))) return false
  if (selector.class !== undefined && element.className !== String(selector.class)) return false
  if (selector.enabled !== undefined && element.enabled !== selector.enabled) return false
  if (selector.checked !== undefined && element.checked !== selector.checked) return false
  if (selector.clickable !== undefined && element.clickable !== selector.clickable) return false
  return true
}

function findUiElement(nodes, selector) {
  const matchesForSelector = nodes.filter(element => matches(element, selector))
  const index = Number.isInteger(selector?.index) && selector.index >= 0 ? selector.index : 0
  return matchesForSelector[index] || null
}

module.exports = { parseUiHierarchy, parseBounds, findUiElement }

if (require.main === module) {
  const assert = require('assert')
  const xml = `<?xml version="1.0"?><hierarchy><node text="확인 &amp; 저장" content-desc="진행&#10;버튼" resource-id="net.example:id/submit" class="android.widget.Button" bounds="[10,20][50,60]" enabled="true" checked="false" clickable="true"/><node text="확인" content-desc="확인" resource-id="net.example:id/other" class="android.widget.Button" bounds="[60,20][100,60]" enabled="false"/></hierarchy>UI hierchary dumped to: /dev/tty`
  const nodes = parseUiHierarchy(xml)
  assert.strictEqual(nodes.length, 2)
  assert.strictEqual(nodes[0].text, '확인 & 저장')
  assert.strictEqual(nodes[0].desc, '진행\n버튼')
  assert.strictEqual(parseUiHierarchy('<hierarchy><node text="&#x110000;" bounds="[0,0][1,1]"/></hierarchy>')[0].text, '&#x110000;')
  assert.strictEqual(parseUiHierarchy('<hierarchy><node text="&#xD800;" bounds="[0,0][1,1]"/></hierarchy>')[0].text, '&#xD800;')
  assert.deepStrictEqual(nodes[0].center, { x: 30, y: 40 })
  assert.strictEqual(findUiElement(nodes, { textContains: '저장' }).index, 0)
  assert.strictEqual(findUiElement(nodes, { textMatches: '^확인' }).index, 0)
  assert.strictEqual(findUiElement(nodes, { desc: '확인' }).index, 1)
  assert.strictEqual(findUiElement(nodes, { id: 'other' }).index, 1)
  assert.strictEqual(findUiElement(nodes, { class: 'android.widget.Button', index: 1 }).index, 1)
  assert.strictEqual(findUiElement(nodes, { enabled: false }).index, 1)
  assert.strictEqual(findUiElement(nodes, { checked: true }), null)
  assert.strictEqual(parseBounds('invalid'), null)
  assert.throws(() => parseUiHierarchy('<hierarchy/>'), /요소를 찾지 못했습니다/)
  console.log('qa-xml 자가진단 통과 — XML·속성·셀렉터·bounds')
}
