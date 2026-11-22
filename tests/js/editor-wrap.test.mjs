// Tests for soft wrap in the Library editor: the gutter row mapping, the measuring mirror, the
// remembered Wrap lines toggle, and that wrapping never changes the text that is saved.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate() {},
  notify(toast) { this.toasts.push(toast) },
  notifyError(error, message) { this.errors.push(message) },
  openWorkspace() { return () => {} },
  revealPane() {},
  undismissPane() {},
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = []; this.errors = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
// Registered last, so it answers first: react hooks that use the small runtime in mount() below
// when one is active, and otherwise behave like the shared stub (no state, no effects).
const HOOKS = `
const idle = { useState: v => [v, () => {}], useEffect: () => {} }
export const useState = v => (globalThis.__hooks ?? idle).useState(v)
export const useEffect = (fn, deps) => (globalThis.__hooks ?? idle).useEffect(fn, deps)`
const HOOKS_LOADER = `
export async function resolve(specifier, context, next) {
  return specifier === 'react' ? { url: 'hooks:react', shortCircuit: true } : next(specifier, context)
}
export async function load(url, context, next) {
  return url === 'hooks:react' ? { format: 'module', source: ${JSON.stringify(HOOKS)}, shortCircuit: true } : next(url, context)
}`
const hooksDir = mkdtempSync(join(tmpdir(), 'skr-hooks-'))
writeFileSync(join(hooksDir, 'hooks-loader.mjs'), HOOKS_LOADER)
register(pathToFileURL(join(hooksDir, 'hooks-loader.mjs')))
process.on('exit', () => rmSync(hooksDir, { force: true, recursive: true }))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $libEditor, LIB_STYLES, LibraryEditorView, WRAP_KEY, changeLibraryText, libId, librarySession, measureWrapRows, messages,
  performLibrarySave, readEditorWrap, wrapGutter, writeEditorWrap
} = mod
const { Checkbox, Textarea } = await import('@hermes/plugin-sdk')
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)

const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const text = node => walk(node).flatMap(n => {
  const c = n.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => typeof x === 'string' || typeof x === 'number')
}).join(' ')

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) }
  }
}
const brokenStorage = {
  getItem() { throw new Error('denied') },
  setItem() { throw new Error('denied') }
}

const file = { key: 'soul00000000000s', kind: 'identity', name: 'SOUL.md', skill: null, exists: true, size: 10, mtime: 1, pending: 0, review: null }
const SOUL = { status: 'ok', file, text: 'You are terse.\nKeep it short.', version: 'abc:1', limit: { label: 'SOUL.md', max: 200000 } }
const soulId = libId('dev', file.key)
const fresh = () => librarySession(null, soulId, SOUL)
const meta = { file, profile: 'dev' }

const view = (session = fresh(), props = {}) => LibraryEditorView({ meta, session, t, ...props })
const area = tree => walk(tree).find(n => n.type === Textarea)
const gutter = tree => walk(tree).find(n => n.props?.['data-gutter'])
const wrapBox = tree => walk(tree).find(n => n.type === Checkbox)

// --- gutter rows --------------------------------------------------------------------------------

test('a wrapped line keeps one number on its first row and blank rows after it', () => {
  assert.deepEqual(wrapGutter('short\na long line\nend', [1, 3, 1]), { gutter: '1\n2\n\n\n3', rows: 5 })
  assert.deepEqual(wrapGutter('only', [4]), { gutter: '1\n\n\n', rows: 4 })
})

test('empty lines and a trailing newline each get their own number', () => {
  assert.deepEqual(wrapGutter('a\n\nb', [1, 1, 1]), { gutter: '1\n2\n3', rows: 3 })
  assert.deepEqual(wrapGutter('a\n', [2, 1]), { gutter: '1\n\n2', rows: 3 })
  assert.deepEqual(wrapGutter('', [1]), { gutter: '1', rows: 1 })
  assert.deepEqual(wrapGutter(null, null), { gutter: '1', rows: 1 })
})

test('CRLF counts as one line break, the same as the footer line count', () => {
  assert.deepEqual(wrapGutter('a\r\nlong\r\n', [1, 3, 1]), { gutter: '1\n2\n\n\n3', rows: 5 })
  assert.equal(wrapGutter('a\r\nb\r\nc', null).rows, 3)
})

test('missing, stale or bad counts fall back to one row per line', () => {
  assert.deepEqual(wrapGutter('a\nb', null), { gutter: '1\n2', rows: 2 })
  assert.deepEqual(wrapGutter('a\nb', [3]), { gutter: '1\n2', rows: 2 }, 'counts for another text are ignored')
  assert.deepEqual(wrapGutter('a\nb\nc', [0, Number.NaN, -3]), { gutter: '1\n2\n3', rows: 3 })
  assert.deepEqual(wrapGutter('a\nb', [2.4, 0.6]), { gutter: '1\n\n2', rows: 3 }, 'sub-pixel heights round to whole rows')
})

// --- measuring ---------------------------------------------------------------------------------

// A small DOM: enough tree for the mirror, and a layout where a line takes one row per
// CHARS_PER_PX * content width characters. `reads` and `created` count layout reads and new nodes.
const ROW = 18.6
const CHAR = 7.2
function fakeDom(width = '400px') {
  const doc = { created: 0, reads: 0 }
  const computed = { boxSizing: 'border-box', fontFamily: 'mono', lineHeight: `${ROW}px`, paddingLeft: '8px', paddingRight: '8px', whiteSpace: 'pre-wrap', width }
  class El {
    constructor(fragment = false) { this.children = []; this.fragment = fragment; this.parent = null; this.style = {}; this.textContent = '' }
    adopt(nodes) { nodes.forEach(n => { n.parent = this }); return nodes }
    appendChild(node) { this.children.push(...this.adopt([node])) }
    insertBefore(node, ref) {
      const at = ref ? this.children.indexOf(ref) : this.children.length
      const moved = this.adopt(node.fragment ? node.children : [node])
      this.children = this.children.slice(0, at).concat(moved, this.children.slice(at))
      if (node.fragment) node.children = []
    }
    remove() { const list = this.parent.children; list.splice(list.indexOf(this), 1); this.parent = null }
    replaceChildren(...nodes) { this.children = this.adopt(nodes) }
    getBoundingClientRect() {
      doc.reads += 1
      const box = this.parent?.style ?? {}
      const inner = parseFloat(box.width) - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight)
      const perRow = Math.floor(inner / CHAR)
      if (!(perRow > 0)) return { height: 0 }
      return { height: Math.max(1, Math.ceil(this.textContent.length / perRow)) * ROW + 0.01 }
    }
  }
  doc.createElement = () => { doc.created += 1; return new El() }
  doc.createDocumentFragment = () => new El(true)
  doc.defaultView = { getComputedStyle: () => computed }
  return { area: { ownerDocument: doc }, computed, doc, El, mirror: new El() }
}
const texts = mirror => mirror.children.map(n => n.textContent)

test('the mirror copies the textarea box and counts rows per line', () => {
  // 384px of text at 7.2px a character: 53 characters a row.
  const { area, mirror } = fakeDom()
  assert.deepEqual(measureWrapRows(area, mirror, ['short', '', 'x'.repeat(120), 'a'.repeat(53)]), [1, 1, 3, 1])
  assert.equal(mirror.style.width, '400px')
  assert.equal(mirror.style.fontFamily, 'mono')
  assert.equal(mirror.style.paddingLeft, '8px')
  assert.equal(mirror.style.whiteSpace, 'pre-wrap')
  assert.deepEqual(texts(mirror), ['short', '\u200b', 'x'.repeat(120), 'a'.repeat(53), '\u200b'], 'one node a line, then the probe row')
  assert.equal(measureWrapRows(null, mirror, ['a']), null)
  assert.equal(measureWrapRows(area, null, ['a']), null)
})

test('a file with 200,000 newlines measures without hitting the argument limit', () => {
  const { area, mirror } = fakeDom()
  const lines = new Array(200001).fill('')
  let counts
  assert.doesNotThrow(() => { counts = measureWrapRows(area, mirror, lines) })
  assert.equal(counts.length, 200001)
  assert.ok(counts.every(n => n === 1))
  assert.equal(mirror.children.length, 200002)
})

test('a keystroke lays out only the lines it changed', () => {
  const { area, computed, doc, mirror } = fakeDom()
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
  measureWrapRows(area, mirror, lines)

  doc.created = 0
  doc.reads = 0
  const typed = lines.slice()
  typed[20] = 'y'.repeat(150)
  assert.deepEqual(measureWrapRows(area, mirror, typed), typed.map((_, i) => (i === 20 ? 3 : 1)))
  assert.equal(doc.created, 1, 'one new node')
  assert.equal(doc.reads, 2, 'the changed line and the probe row')
  assert.deepEqual(texts(mirror).slice(0, -1), typed)

  doc.created = 0
  doc.reads = 0
  const split = typed.slice(0, 20).concat(['y'.repeat(100), 'y'.repeat(50)], typed.slice(21))
  assert.deepEqual(measureWrapRows(area, mirror, split).slice(19, 23), [1, 2, 1, 1])
  assert.equal(doc.created, 2, 'Enter replaces one line with two')
  assert.deepEqual(texts(mirror).slice(0, -1), split)

  doc.created = 0
  doc.reads = 0
  const joined = split.slice(0, 5).concat(split.slice(45))
  measureWrapRows(area, mirror, joined)
  assert.equal(doc.created, 0, 'deleting lines makes no nodes')
  assert.deepEqual(texts(mirror).slice(0, -1), joined)

  doc.reads = 0
  computed.width = '200px'
  assert.deepEqual(measureWrapRows(area, mirror, joined), joined.map(l => Math.max(1, Math.ceil(l.length / 25))))
  assert.equal(mirror.style.width, '200px')
  assert.equal(doc.reads, joined.length + 1, 'a new width reads every line again')

  doc.reads = 0
  measureWrapRows(area, mirror, joined, 1)
  assert.equal(doc.reads, joined.length + 1, 'so does a new font generation')
})

test('a hidden editor gives no counts, then measures every line once it shows', () => {
  const { area, computed, mirror } = fakeDom('0px')
  assert.equal(measureWrapRows(area, mirror, ['a', 'x'.repeat(60)]), null)
  computed.width = '400px'
  assert.deepEqual(measureWrapRows(area, mirror, ['a', 'x'.repeat(60)]), [1, 2])
})

// --- mounted: effects, resize, fonts and the toggle --------------------------------------------

/** Render with real state and effects: setters mark the tree stale, flush() renders until it is
 *  current and runs effects whose deps changed, unmount() runs the cleanups. */
function mount(render) {
  const slots = []
  let stale = false
  let tree
  const flush = () => {
    let passes = 0
    do {
      assert.ok(++passes < 25, 'renders settle')
      stale = false
      const effects = []
      let i = 0
      globalThis.__hooks = {
        useState(initial) {
          const k = i++
          if (!slots[k]) {
            const slot = { value: initial }
            slot.set = next => {
              const value = typeof next === 'function' ? next(slot.value) : next
              if (!Object.is(value, slot.value)) { slot.value = value; stale = true }
            }
            slots[k] = slot
          }
          return [slots[k].value, slots[k].set]
        },
        useEffect(fn, deps) {
          const k = i++
          const prev = slots[k]
          if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) {
            effects.push(() => { prev?.cleanup?.(); slots[k] = { cleanup: fn(), deps } })
          }
        }
      }
      try { tree = render() } finally { delete globalThis.__hooks }
      effects.forEach(run => run())
    } while (stale)
    return tree
  }
  return { flush, get tree() { return tree }, unmount: () => slots.forEach(s => s?.cleanup?.()) }
}

test('mounted: measures on attach, on typing, on resize and on font load; the toggle stops and restarts it', async () => {
  const storage = memoryStorage()
  const observers = []
  globalThis.localStorage = storage
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.off = false; observers.push(this) }
    observe(node) { this.node = node }
    disconnect() { this.off = true }
  }
  try {
    const env = fakeDom()
    let fontsLoaded
    env.doc.fonts = { ready: new Promise(resolve => { fontsLoaded = resolve }) }
    let session = { ...fresh(), text: `short\n${'x'.repeat(120)}` }
    const app = mount(() => LibraryEditorView({ meta, onChange: text => { session = { ...session, text } }, session, t }))
    const hasMirror = () => walk(app.tree).some(n => n.props?.['data-wrap-mirror'])
    const box = { ownerDocument: env.doc, querySelector: sel => (sel === 'textarea' ? env.area : sel === '[data-wrap-mirror]' && hasMirror() ? env.mirror : null) }
    const shown = () => ({ gutter: gutter(app.tree).props.children, height: area(app.tree).props.style.height })

    app.flush()
    assert.equal(shown().gutter, '1\n2', 'one row a line until the box is attached')
    walk(app.tree).find(n => typeof n.props?.ref === 'function').props.ref(box)
    app.flush()
    assert.equal(observers.length, 1)
    assert.equal(observers[0].node, env.area, 'the textarea width is observed')
    assert.deepEqual(shown(), { gutter: '1\n2\n\n', height: 'calc(5.45rem + 14px)' })

    // Typing measures in the change handler, so the same render shows the new rows; the effect
    // then finds nothing to do.
    env.doc.reads = 0
    area(app.tree).props.onChange({ target: { value: `${'w'.repeat(60)}\n${'x'.repeat(120)}` } })
    app.flush()
    assert.equal(shown().gutter, '1\n\n2\n\n')
    assert.equal(env.doc.reads, 2, 'the changed line and the probe, measured once')

    env.doc.reads = 0
    env.computed.width = '200px'
    observers[0].callback([{ contentRect: { width: 184 } }])
    app.flush()
    assert.equal(shown().gutter, '1\n\n\n2\n\n\n\n')
    assert.equal(env.doc.reads, 3, 'a resize reads every line')

    env.doc.reads = 0
    fontsLoaded()
    await new Promise(resolve => setImmediate(resolve))
    app.flush()
    assert.equal(env.doc.reads, 3, 'loaded fonts read every line again')

    wrapBox(app.tree).props.onCheckedChange(false)
    app.flush()
    assert.equal(storage.data[WRAP_KEY], '0')
    assert.equal(observers[0].off, true, 'wrap off stops observing')
    assert.equal(area(app.tree).props.wrap, 'off')
    assert.equal(hasMirror(), false)
    assert.deepEqual(shown(), { gutter: '1\n2', height: 'calc(3.13rem + 14px)' })

    env.mirror = new env.El() // React mounts a new mirror node
    wrapBox(app.tree).props.onCheckedChange(true)
    app.flush()
    assert.equal(storage.data[WRAP_KEY], '1')
    assert.equal(observers.length, 2, 'wrap on observes again')
    assert.equal(area(app.tree).props.wrap, 'soft')
    assert.equal(shown().gutter, '1\n\n\n2\n\n\n\n')

    app.unmount()
    assert.equal(observers[1].off, true, 'unmount stops observing')
  } finally {
    delete globalThis.localStorage
    delete globalThis.ResizeObserver
  }
})

// --- the toggle ---------------------------------------------------------------------------------

test('wrap is on unless the stored choice says off', () => {
  assert.ok(WRAP_KEY.startsWith('skill-review'))
  assert.equal(readEditorWrap(memoryStorage()), true)
  assert.equal(readEditorWrap(undefined), true)
  assert.equal(readEditorWrap(brokenStorage), true)
  assert.equal(readEditorWrap(memoryStorage({ [WRAP_KEY]: '0' })), false)
  assert.equal(readEditorWrap(memoryStorage({ [WRAP_KEY]: '1' })), true)
})

test('the choice is written under the plugin key and read back', () => {
  const storage = memoryStorage()
  writeEditorWrap(false, storage)
  assert.deepEqual(storage.data, { [WRAP_KEY]: '0' })
  assert.equal(readEditorWrap(storage), false)
  writeEditorWrap(true, storage)
  assert.equal(readEditorWrap(storage), true)
  assert.doesNotThrow(() => writeEditorWrap(false, brokenStorage))
  assert.doesNotThrow(() => writeEditorWrap(false, undefined))
})

test('the editor wraps by default and the footer toggle stores the change', () => {
  const storage = memoryStorage()
  globalThis.localStorage = storage
  try {
    const tree = view()
    assert.equal(area(tree).props.wrap, 'soft')
    assert.equal(area(tree).props.style.whiteSpace, 'pre-wrap')
    assert.equal(area(tree).props.style.overflowX, 'hidden')
    assert.equal(gutter(tree).props.children, '1\n2')
    const box = wrapBox(tree)
    assert.equal(box.props.checked, true)
    const footer = walk(tree).find(n => n.key === 'footer')
    assert.ok(walk(footer).includes(box), 'the toggle sits in the footer')
    assert.match(text(footer), /libWrap/)
    box.props.onCheckedChange(false)
    assert.equal(storage.data[WRAP_KEY], '0')
    assert.equal(messages.en.libWrap, 'Wrap lines')
  } finally {
    delete globalThis.localStorage
  }
})

test('with wrap off the textarea is exactly the unwrapped editor', () => {
  globalThis.localStorage = memoryStorage({ [WRAP_KEY]: '0' })
  try {
    const tree = view()
    const props = area(tree).props
    assert.equal(props.wrap, 'off')
    assert.deepEqual(props.style, { ...LIB_STYLES.textarea, height: 'calc(3.13rem + 14px)' })
    assert.equal(gutter(tree).props.children, '1\n2')
    assert.equal(wrapBox(tree).props.checked, false)
    assert.equal(walk(tree).some(n => n.props?.['data-wrap-mirror']), false, 'no mirror is rendered')
  } finally {
    delete globalThis.localStorage
  }
})

// --- saving -------------------------------------------------------------------------------------

test('typing into a wrapped editor saves the exact text, line for line', async () => {
  const typed = `${'word '.repeat(80)}\r\n\n${'x'.repeat(400)}\nend\n`
  let changed = null
  const tree = view(fresh(), { onChange: value => { changed = value } })
  assert.equal(area(tree).props.wrap, 'soft')
  assert.equal(area(tree).props.value, SOUL.text)
  area(tree).props.onChange({ target: { value: typed } })
  assert.equal(changed, typed)

  $libEditor.set(fresh())
  changeLibraryText($libEditor.get(), changed)
  const calls = []
  const rest = async (path, opts) => { calls.push({ path, ...opts }); return { status: 'saved', file, version: 'def:2' } }
  await performLibrarySave({ queryClient: { invalidateQueries() {} }, rest, session: $libEditor.get(), t })
  assert.equal(calls[0].body.text, typed)
  assert.deepEqual(calls[0].body.text.split('\n'), typed.split('\n'))
  assert.equal($libEditor.get().original, typed)
})
