// Tests for the public-API version (0.3): one message per decision status, the stopped-partway
// line, the Library's editable and read-only files, and that the unsaved-text prompts and word wrap
// from 0.2.2 still work on the files Library can save.
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
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = []; this.errors = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $libDiscard, $libEditor, $libSelection, $mode, LibraryEditorView, LibraryTree, ModeSwitch, confirmDiscard, draftLabel,
  libId, librarySession, messages, needsReviewText, selectLibraryFile, setMode, statusText, treeRows
} = mod
const { Checkbox, Textarea } = await import('@hermes/plugin-sdk')
const en = messages.en
const tEn = (k, ...a) => (typeof en[k] === 'function' ? en[k](...a) : en[k])
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
const byLabel = (node, label) => walk(node).filter(n => typeof n.props?.onClick === 'function').find(b => text(b).includes(label))

// --- one message per status ------------------------------------------------------------------------

const STATUSES = [
  ['applied', { status: 'applied' }],
  ['rejected', { status: 'rejected' }],
  ['rejected with a warning', { status: 'rejected', warning: 'Nothing was rolled back' }],
  ['already resolved', { status: 'already_resolved', prior: 'applied' }],
  ['conflict', { status: 'conflict', reason: 'being decided by another client' }],
  ['needs review', { status: 'needs_review', id: 'ab12', kind: 'skills', reason: 'An earlier approval stopped partway' }],
  ['stale', { status: 'stale', reason: 'an entry this write targets changed since it was staged' }],
  ['unseen', { status: 'unseen' }],
  ['whole write', { status: 'whole_write' }],
  ['gone', { status: 'gone' }],
  ['unavailable', { status: 'unavailable' }]
]

test('every status has its own plain message', () => {
  const seen = new Map()
  for (const [name, result] of STATUSES) {
    const message = statusText(result, tEn)
    assert.ok(message && message.length > 5, name)
    assert.doesNotMatch(message, /—|undefined|null|\[object/, name)
    assert.ok(!seen.has(message), `${name} repeats the message of ${seen.get(message)}`)
    seen.set(message, name)
  }
  assert.match(statusText(STATUSES[2][1], tEn), /^Rejected\. Nothing was rolled back\.$/, 'Hermes\'s warning is shown')
  assert.match(statusText(STATUSES[5][1], tEn), /\/skills reject ab12/, 'needs review names the command')
  assert.match(statusText({ ...STATUSES[5][1], kind: 'memory' }, tEn), /\/memory reject ab12/)
  assert.match(statusText(STATUSES[4][1], tEn), /being decided by another client/, 'conflict carries Hermes\'s reason')
  assert.match(statusText(STATUSES[6][1], tEn), /changed since it was staged/)
  assert.equal(statusText(STATUSES[10][1], tEn), en.needsApi)
  assert.match(en.needsApi, /needs a newer Hermes/)
  assert.match(en.needsApi, /tools\.write_review_api/)
})

test('writes Hermes stopped partway are counted with the command that clears them, never listed', () => {
  assert.equal(needsReviewText(null, tEn), '')
  assert.equal(needsReviewText({ skills: 0, memory: 0, total: 0 }, tEn), '')
  assert.equal(needsReviewText({ skills: 1, memory: 0, total: 1 }, tEn),
    '1 write stopped partway: check the files, then clear it with /skills reject <id>.')
  assert.equal(needsReviewText({ skills: 0, memory: 2, total: 2 }, tEn),
    '2 writes stopped partway: check the files, then clear each one with /memory reject <id>.')
  assert.match(needsReviewText({ skills: 1, memory: 1, total: 2 }, tEn), /\/skills reject <id> or \/memory reject <id>\.$/)
})

// --- Library: identity files save, memory and skill files are read-only ---------------------------

const READ_ONLY_REASON = "This file can't be saved from here yet. Hermes has no public way to check and lock memory files when saving. Change it through the agent, and review the change under Pending."
const file = (key, kind, name, extra = {}) =>
  ({ key, kind, name, skill: null, exists: true, size: 10, mtime: 1, pending: 0, review: null, read_only: kind !== 'identity', read_only_reason: kind === 'identity' ? null : READ_ONLY_REASON, ...extra })

const TREE = [{
  profile: 'hermes-dev', pending: 0, error: null, staged: [],
  identity: [file('soul00000000000s', 'identity', 'SOUL.md'), file('proj00000000000p', 'identity', 'PROJECT.md')],
  memory: [file('mem0000000000000', 'memory', 'MEMORY.md'), file('user000000000000', 'memory', 'USER.md')],
  skills: [{ name: 'demo', pending: 0, files: [file('demo0000000000sk', 'skill', 'SKILL.md', { skill: 'demo' })] }]
}]

test('the tree marks identity files editable and memory and skill files read-only', () => {
  const rows = treeRows(TREE, { 's:hermes-dev:demo0000000000sk': true }, '')
  const groups = rows.filter(r => r.type === 'group')
  assert.deepEqual(groups.map(g => [g.label, g.access]), [
    ['libGroup_identity', 'editable'], ['libGroup_memory', 'readOnly'], ['libGroup_skills', 'readOnly']
  ])
  const tree = LibraryTree({ onSelect() {}, onToggle() {}, rows, selection: null, t: tEn })
  const tags = walk(tree).filter(n => n.props?.['data-access']).map(n => n.props.children)
  assert.deepEqual(tags, ['editable', 'read-only', 'read-only'])
})

const PROJECT = {
  status: 'ok', file: TREE[0].identity[1], text: '# Hermes development\n\nOne implementation owner per task.', version: 'v1',
  limit: { label: 'PROJECT.md', max: 200000 }
}
const MEMORY = { status: 'ok', file: TREE[0].memory[0], text: 'Project: Hermes development.\n§\nOne gateway.', version: 'v2', limit: null }

test('a read-only file shows its text read-only, with the reason and no Save', () => {
  $libEditor.set(null)
  const session = librarySession(null, libId('hermes-dev', MEMORY.file.key), MEMORY)
  const view = LibraryEditorView({ meta: { file: MEMORY.file, profile: 'hermes-dev' }, session, t: tEn })
  const [area] = walk(view).filter(n => n.type === Textarea)
  assert.equal(area.props.readOnly, true)
  assert.equal(area.props.value, MEMORY.text, 'the saved text is shown as it is on disk')
  assert.match(text(view), /can't be saved from here yet/)
  assert.equal(byLabel(view, 'Save'), undefined)
  assert.equal(byLabel(view, 'Revert'), undefined)
  assert.ok(walk(view).some(n => n.props?.['data-gutter']), 'line numbers still show')
})

test('an identity file keeps word wrap, the gutter and Save', () => {
  globalThis.localStorage = { getItem: () => null, setItem() {} }
  try {
    $libEditor.set(null)
    const session = librarySession(null, libId('hermes-dev', PROJECT.file.key), PROJECT)
    const view = LibraryEditorView({ meta: { file: PROJECT.file, profile: 'hermes-dev' }, session, t: tEn })
    const [area] = walk(view).filter(n => n.type === Textarea)
    assert.equal(area.props.readOnly, false)
    assert.equal(area.props.wrap, 'soft')
    assert.equal(walk(view).find(n => n.props?.['data-gutter']).props.children, '1\n2\n3')
    assert.ok(walk(view).some(n => n.type === Checkbox && n.props.checked === true), 'the Wrap lines toggle is on')
    assert.ok(byLabel(view, 'Save'))
    assert.match(text(view), /Saves straight to the file/)
  } finally {
    delete globalThis.localStorage
  }
})

test('unsaved identity text still asks before it is dropped, and the page names the draft', () => {
  $mode.set('library')
  $libSelection.set(libId('hermes-dev', PROJECT.file.key))
  const session = librarySession(null, libId('hermes-dev', PROJECT.file.key), PROJECT)
  $libEditor.set({ ...session, text: `${PROJECT.text}\nmore` })
  setMode('pending')
  assert.equal($mode.get(), 'library', 'the switch waits for an answer')
  assert.ok($libDiscard.get(), 'the discard prompt is open')
  selectLibraryFile(libId('hermes-dev', MEMORY.file.key))
  assert.equal($libSelection.get(), libId('hermes-dev', PROJECT.file.key))
  assert.equal(draftLabel($libEditor.get()), 'hermes-dev/PROJECT.md')
  const sw = ModeSwitch({ mode: 'library', onChange() {}, t: tEn, total: 2, unsaved: draftLabel($libEditor.get()) })
  assert.match(text(sw), /Unsaved changes in hermes-dev\/PROJECT\.md/)
  confirmDiscard()
  assert.equal($libEditor.get(), null)
  $mode.set('pending'); $libSelection.set(null); $libDiscard.set(null)
})
