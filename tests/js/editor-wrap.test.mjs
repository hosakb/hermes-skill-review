// Tests for soft wrap in the Library editor: the gutter row mapping, the measuring mirror, the
// remembered Wrap lines toggle, and that wrapping never changes the text that is saved.
import assert from 'node:assert/strict'
import { register } from 'node:module'
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

// --- measuring ----------------------------------------------------------------------------------

test('the mirror copies the textarea box and counts rows per line', () => {
  const ROW = 18.6
  const PER_ROW = 10 // characters that fit on one row in this fake layout
  const made = []
  const doc = {
    createElement: () => {
      const el = { style: {}, textContent: '' }
      el.getBoundingClientRect = () => ({ height: Math.max(1, Math.ceil(el.textContent.length / PER_ROW)) * ROW + 0.01 })
      made.push(el)
      return el
    }
  }
  const computed = { boxSizing: 'border-box', fontFamily: 'mono', fontSize: '12px', lineHeight: '18.6px', paddingLeft: '8px', whiteSpace: 'pre-wrap', width: '301.5px' }
  doc.defaultView = { getComputedStyle: () => computed }
  const textarea = { ownerDocument: doc }
  const mirror = { style: {}, children: [], replaceChildren(...nodes) { this.children = nodes } }

  const rows = measureWrapRows(textarea, mirror, ['short', '', 'x'.repeat(25), 'a'.repeat(10)])
  assert.deepEqual(rows, [1, 1, 3, 1])
  assert.equal(mirror.style.width, '301.5px')
  assert.equal(mirror.style.fontFamily, 'mono')
  assert.equal(mirror.style.paddingLeft, '8px')
  assert.equal(mirror.style.whiteSpace, 'pre-wrap')
  assert.equal(mirror.children[1].textContent, '​', 'an empty line still takes one row')
  assert.equal(measureWrapRows(null, mirror, ['a']), null)
  assert.equal(measureWrapRows(textarea, null, ['a']), null)
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
