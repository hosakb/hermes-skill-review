// Tests for editing a proposed change in place.
// Same stub setup as file-diff.test.mjs, in its own file so the two can change independently.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CREATE_DIFF, MEMORY_DIFF, MEMORY_FILE, ODD_FILE, SKILL_DIFF, SKILL_FILE } from './fixtures.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate() {},
  notify(toast) { this.toasts.push(toast) },
  notifyError() {},
  openWorkspace() { return () => {} },
  revealPane() {},
  undismissPane() {},
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $editing, BlockEditor, BlockView, EDIT_STYLES, FileDetailView, FileDiffView, FileHeader, blockEdit,
  cancelEdit, changeEdit, editCount, editPath, editToast, editsPath, messages, performEdit, startEdit
} = mod
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)

// --- tree helpers over the jsx() stub ({ type, props, key }) -----------------------------------
const OWN = new Set(Object.values(mod).filter(v => typeof v === 'function'))
const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
const expand = node => {
  if (!node || typeof node !== 'object') return node
  if (OWN.has(node.type)) return expand(node.type(node.props))
  const c = node.props?.children
  if (c === undefined) return node
  const next = Array.isArray(c) ? c.flat(Infinity).map(expand) : expand(c)
  return { ...node, props: { ...node.props, children: next } }
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const text = node => walk(node).flatMap(n => {
  const c = n.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => typeof x === 'string' || typeof x === 'number')
}).join(' ')
const buttons = node => walk(node).filter(n => typeof n.props?.onClick === 'function')
const button = (node, label) => buttons(node).find(b => b.props.children === label)
const labels = node => buttons(node).map(b => b.props.children)
const ofType = (node, type) => walk(node).filter(n => n.type === type)
const { Textarea } = await import('@hermes/plugin-sdk')

function fakeQueryClient() {
  return { invalidated: [], invalidateQueries({ queryKey }) { this.invalidated.push(queryKey) } }
}

function fakeRest(reply) {
  const calls = []
  const rest = async (path, opts) => {
    calls.push({ path, ...opts })
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply(path, opts) : reply
  }
  return { calls, rest }
}

const block = id => [...MEMORY_DIFF.segments, ...SKILL_DIFF.segments, ...CREATE_DIFF.segments].find(s => s.block?.id === id).block
const INFO = { field: 'content', scope: 'entry', text: 'Deploys go to staging first, then production after a smoke test.', limit: null }
const noop = () => {}
const editFor = (info, session = null) => ({ info, session, onCancel: noop, onChange: noop, onSave: noop, onStart: noop })

// --- paths --------------------------------------------------------------------------------------

test('edit paths sit beside contract v1 and encode every segment', () => {
  assert.equal(editsPath(MEMORY_FILE), `/files/dev/memory/${MEMORY_FILE.key}/edits`)
  assert.equal(editPath(MEMORY_FILE, 'r1-0'), `/files/dev/memory/${MEMORY_FILE.key}/blocks/r1-0/edit`)
  assert.equal(editPath(ODD_FILE, 'r1/0'), '/files/my%20profile/memory/a%2Fb%20c/blocks/r1%2F0/edit')
})

// --- Edit button visibility ---------------------------------------------------------------------

test('Edit shows next to Accept and Reject on a block the backend lists as editable', () => {
  const view = expand(BlockView({ block: block('r1-0'), busy: false, edit: editFor(INFO), isNew: true, onAccept: noop, onReject: noop, t }))
  assert.deepEqual(labels(view), ['edit', 'accept', 'reject'])
  let started = 0
  const clickable = expand(BlockView({ block: block('r1-0'), busy: false, edit: { ...editFor(INFO), onStart: () => started++ }, isNew: true, onAccept: noop, onReject: noop, t }))
  button(clickable, 'edit').props.onClick()
  assert.equal(started, 1)
})

test('no Edit on a block the backend does not list (a removal, a stale pin)', () => {
  const removal = BlockView({ block: block('r1-1'), busy: false, edit: null, isNew: true, onAccept: noop, onReject: noop, t })
  assert.deepEqual(labels(removal), ['accept', 'reject'])
  const stale = BlockView({ block: block('p3-0'), busy: false, isNew: false, onAccept: noop, onReject: noop, t })
  assert.deepEqual(labels(stale), ['reject'], 'no edit prop at all: the view from before this feature')
})

test('a stale block whose reason editing can fix shows Edit but still no Accept', () => {
  const view = expand(BlockView({ block: block('p3-0'), busy: false, edit: editFor({ ...INFO, scope: 'span' }), isNew: false, onAccept: noop, onReject: noop, t }))
  assert.deepEqual(labels(view), ['edit', 'reject'])
  const editing = BlockView({ block: block('p3-0'), busy: false, edit: editFor(INFO, { blockId: 'p3-0', text: 'x', error: null, saving: null }), isNew: false, onAccept: noop, onReject: noop, t })
  assert.equal(editing.props.style.opacity, undefined, 'the editor of a stale block is not dimmed')
})

test('blockEdit maps the edits answer onto blocks and keeps a session even while edits refetch', () => {
  const session = { blockId: 'r1-0', file: 'f', info: INFO, text: 'typed', error: null, saving: null }
  const edit = { blocks: { 'r1-0': INFO }, onCancel: noop, onChange: noop, onSave: noop, onStart: noop, session }
  assert.equal(blockEdit(edit, block('r1-0')).info, INFO)
  assert.equal(blockEdit(edit, block('r1-0')).session, session)
  assert.equal(blockEdit(edit, block('r2-0')), null)
  assert.equal(blockEdit(null, block('r1-0')), null)
  const refetching = { ...edit, blocks: {} }
  assert.equal(blockEdit(refetching, block('r1-0')).info, INFO, 'the editor does not vanish while /edits reloads')
})

test('FileDiffView passes each block its own edit props', () => {
  const edit = { blocks: { 'r2-0': INFO }, onCancel: noop, onChange: noop, onSave: noop, onStart: noop, session: null }
  const tree = FileDiffView({ busy: false, edit, onBlock: noop, prior: null, segments: MEMORY_DIFF.segments, t })
  const views = walk(tree).filter(n => n.type === BlockView)
  assert.deepEqual(views.map(v => Boolean(v.props.edit)), [false, false, true])
})

// --- editing ------------------------------------------------------------------------------------

test('Edit opens a textarea prefilled with the proposed text, in place of the added lines', () => {
  const file = MEMORY_FILE
  startEdit(file, 'r1-0', INFO)
  const session = $editing.get()
  assert.equal(session.text, INFO.text)
  assert.equal(session.blockId, 'r1-0')
  const view = expand(BlockView({ block: block('r1-0'), busy: false, edit: editFor(INFO, session), isNew: true, onAccept: noop, onReject: noop, t }))
  const [area] = ofType(view, Textarea)
  assert.equal(area.props.value, INFO.text)
  assert.equal(area.props.wrap, 'soft')
  assert.equal(ofType(view, Textarea).length, 1)
  const rows = walk(view).filter(n => n.props?.['aria-label']?.startsWith?.('row_'))
  assert.deepEqual(rows.map(r => r.props['aria-label']), ['row_remove'], 'removed lines stay as reference, added lines become the editor')
  assert.deepEqual(labels(view), ['reject', 'editApply', 'editSave', 'editCancel'], 'no Accept or Edit while editing')
  cancelEdit()
})

test('typing updates the session; Cancel drops it', () => {
  startEdit(MEMORY_FILE, 'r1-0', INFO)
  changeEdit('new words')
  assert.equal($editing.get().text, 'new words')
  let cancelled = false
  const view = BlockEditor({ onCancel: () => { cancelled = true; cancelEdit() }, onChange: changeEdit, onSave: noop, session: $editing.get(), info: INFO, t })
  ofType(view, Textarea)[0].props.onChange({ target: { value: 'again' } })
  assert.equal($editing.get().text, 'again')
  button(view, 'editCancel').props.onClick()
  assert.equal(cancelled, true)
  assert.equal($editing.get(), null)
})

test('the editor sizes its minimum height to the text and keeps Hermes errors visible', () => {
  const session = { blockId: 'x', file: 'f', info: INFO, text: 'a\nb\nc\nd\ne\nf', error: 'Description is 61 chars; a skill description must fit the 60-char skill index.', saving: null }
  const view = BlockEditor({ info: INFO, onCancel: noop, onChange: noop, onSave: noop, session, t })
  const area = ofType(view, Textarea)[0]
  assert.equal(area.props.rows, 7)
  assert.match(area.props.style.minHeight, /rem$/)
  const short = ofType(BlockEditor({ info: INFO, onCancel: noop, onChange: noop, onSave: noop, session: { ...session, text: 'a' }, t }), Textarea)[0]
  assert.equal(short.props.rows, 3)
  assert.ok(parseFloat(short.props.style.minHeight) < parseFloat(area.props.style.minHeight))
  const alert = walk(view).find(n => n.props?.role === 'alert')
  assert.match(text(alert), /61 chars/)
  assert.equal(area.props['aria-invalid'], true)
})

test('buttons are disabled while saving', () => {
  const session = { blockId: 'x', file: 'f', info: INFO, text: 'a', error: null, saving: 'apply' }
  const view = BlockEditor({ info: INFO, onCancel: noop, onChange: noop, onSave: noop, session, t })
  assert.ok(buttons(view).every(b => b.props.disabled === true))
  assert.equal(ofType(view, Textarea)[0].props.readOnly, true)
})

test('Save and accept and Save as proposal call onSave with apply true and false', () => {
  const seen = []
  const session = { blockId: 'x', file: 'f', info: INFO, text: 'a', error: null, saving: null }
  const view = BlockEditor({ info: INFO, onCancel: noop, onChange: noop, onSave: apply => seen.push(apply), session, t })
  button(view, 'editApply').props.onClick()
  button(view, 'editSave').props.onClick()
  assert.deepEqual(seen, [true, false])
})

test('Save and accept posts the text with apply true, closes the editor and refetches', async () => {
  host.reset()
  startEdit(MEMORY_FILE, 'r1-0', INFO)
  changeEdit('edited text')
  const { calls, rest } = fakeRest({ status: 'applied', error: null, block_id: null, file_gone: false })
  const queryClient = fakeQueryClient()
  const result = await performEdit({ apply: true, file: MEMORY_FILE, queryClient, rest, session: $editing.get(), t })
  assert.equal(result.status, 'applied')
  assert.deepEqual(calls, [{ path: editPath(MEMORY_FILE, 'r1-0'), method: 'POST', body: { apply: true, text: 'edited text' } }])
  assert.equal($editing.get(), null)
  assert.equal(host.toasts.at(-1).kind, 'success')
  assert.ok(queryClient.invalidated.some(k => k.join('/') === ['skill-review', 'file', 'dev', 'memory', MEMORY_FILE.key].join('/')))
  assert.ok(queryClient.invalidated.some(k => k.join('/') === 'skill-review/files'))
})

test('Save as proposal posts apply false and closes the editor', async () => {
  host.reset()
  startEdit(MEMORY_FILE, 'r1-0', INFO)
  const { calls, rest } = fakeRest({ status: 'saved', error: null, block_id: 'r1-abcdef0123', file_gone: false })
  await performEdit({ apply: false, file: MEMORY_FILE, queryClient: fakeQueryClient(), rest, session: $editing.get(), t })
  assert.equal(calls[0].body.apply, false)
  assert.equal($editing.get(), null)
  assert.equal(host.toasts.at(-1).kind, 'info')
  assert.match(host.toasts.at(-1).message, /editSaved/)
})

for (const [label, reply] of [
  ['a failed accept', { status: 'failed', error: 'Description is 61 chars', block_id: null, file_gone: false }],
  ['a scan block', { status: 'blocked', error: 'Security scan blocked this skill', block_id: null, file_gone: false }],
  ['a request error', new Error('413 an edit is at most 100,000 characters')]
]) {
  test(`${label} keeps the editor open with the user's text and the error`, async () => {
    host.reset()
    startEdit(SKILL_FILE, 'p1-0', INFO)
    changeEdit('my careful edit')
    const { rest } = fakeRest(reply)
    await performEdit({ apply: true, file: SKILL_FILE, queryClient: fakeQueryClient(), rest, session: $editing.get(), t })
    const after = $editing.get()
    assert.equal(after.text, 'my careful edit')
    assert.equal(after.saving, null)
    assert.match(after.error, reply instanceof Error ? /100,000/ : new RegExp(reply.error))
    if (!(reply instanceof Error)) assert.equal(host.toasts.at(-1).kind, 'error')
    cancelEdit()
  })
}

test('an edit of a change already handled elsewhere closes the editor and says so', async () => {
  host.reset()
  startEdit(MEMORY_FILE, 'r1-0', INFO)
  const { rest } = fakeRest({ status: 'already_handled', error: null, block_id: null, file_gone: true })
  await performEdit({ apply: false, file: MEMORY_FILE, queryClient: fakeQueryClient(), rest, session: $editing.get(), t })
  assert.equal($editing.get(), null)
  assert.match(host.toasts.at(-1).message, /alreadyHandled/)
})

test('editToast wording', () => {
  assert.deepEqual(editToast(true, { status: 'applied' }, MEMORY_FILE, t), { kind: 'success', message: 'editApplied:MEMORY.md' })
  assert.equal(editToast(false, { status: 'not_editable', error: 'nothing to edit' }, MEMORY_FILE, t).detail, 'nothing to edit')
})

test('count: characters and words without a limit; Hermes total and limit with one', () => {
  assert.deepEqual(editCount('two words', null), { chars: 9, words: 2 })
  assert.deepEqual(editCount('   ', null), { chars: 3, words: 0 })
  const limit = { label: 'MEMORY.md', max: 2200, base: 2190, strip: true }
  assert.deepEqual(editCount('  hello  ', limit), { chars: 5, label: 'MEMORY.md', max: 2200, over: false, total: 2195 })
  assert.equal(editCount('hello world', limit).over, true)
  const view = BlockEditor({ info: { ...INFO, limit }, onCancel: noop, onChange: noop, onSave: noop, session: { text: 'hello world', error: null, saving: null, blockId: 'x' }, t })
  assert.match(text(view), /editTotalOver:MEMORY.md,2,201,2,200,1/, 'numbers are grouped: 2,201 of 2,200')
  const plain = BlockEditor({ info: INFO, onCancel: noop, onChange: noop, onSave: noop, session: { text: 'hello world', error: null, saving: null, blockId: 'x' }, t })
  assert.match(text(plain), /editCount:2,11/)
})

test('the editor label says whether the text is a span, an entry or a whole file', () => {
  for (const scope of ['span', 'entry', 'file']) {
    const view = BlockEditor({ info: { ...INFO, scope }, onCancel: noop, onChange: noop, onSave: noop, session: { text: 'x', error: null, saving: null, blockId: 'x' }, t })
    assert.match(text(view), new RegExp(`editScope_${scope}`))
  }
})

// --- no editor link ----------------------------------------------------------------------------

test('the file header holds only Accept all and Reject all', () => {
  const header = FileHeader({ acceptable: 1, busy: false, file: MEMORY_FILE, onAcceptAll: noop, onRejectAll: noop, t })
  const actions = walk(header).find(n => n.props?.style?.marginLeft === 'auto')
  assert.deepEqual(kids(actions).map(k => k.props.children), ['acceptAll', 'rejectAll'])
  const view = FileDetailView({ busy: false, confirmOpen: false, data: MEMORY_DIFF, edit: null, error: null, file: MEMORY_FILE, loading: false, onAction: noop, onAskRejectAll: noop, onCloseConfirm: noop, prior: null, t })
  assert.equal(walk(view).find(n => n.type === FileHeader).props.extra, undefined)
  assert.equal(walk(view).find(n => n.type === FileDiffView).props.edit, null)
})

test('nothing of the external editor link is left in the plugin', () => {
  // Built from parts so a repo-wide grep for the removed names stays empty.
  const gone = ['vs' + 'code', 'vs' + ' code', 'editor' + 'Template', 'openIn' + 'Editor', 'EditorLink', '/loc' + 'ation\\b']
  assert.doesNotMatch(readFileSync(pluginPath, 'utf8'), new RegExp(gone.join('|'), 'i'))
  assert.deepEqual(Object.keys(mod).filter(k => /^\$?editor|openIn|location|buildEditor|EditorLink|loadEditor|^EDITOR_/i.test(k)), [])
  assert.deepEqual(Object.keys(messages.en).filter(k => /^editor|^openIn|^settingsEditor/.test(k)), [])
})

// --- style ------------------------------------------------------------------------------------

test('edit styles use theme variables only, never colour literals', () => {
  const source = readFileSync(pluginPath, 'utf8')
  const start = source.indexOf('export const EDIT_STYLES')
  const end = source.indexOf('\n}\n', start)
  const block = source.slice(start, end)
  assert.ok(start > 0)
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(block, /\brgba?\(|\bhsla?\(/i)
  for (const value of Object.values(EDIT_STYLES)) {
    for (const v of Object.values(value)) {
      if (typeof v === 'string' && /(color|background)/i.test(v)) assert.match(v, /var\(--/)
    }
  }
})

test('every edit container can shrink, the textarea wraps and resizes only vertically', () => {
  for (const [name, style] of Object.entries(EDIT_STYLES)) {
    if (style.display === 'flex' || style.display === 'inline-flex' || name === 'textarea') {
      assert.equal(style.minWidth, 0, `${name} needs minWidth 0`)
    }
  }
  const ta = EDIT_STYLES.textarea
  assert.equal(ta.whiteSpace, 'pre-wrap')
  assert.equal(ta.overflowWrap, 'anywhere')
  assert.equal(ta.resize, 'vertical')
  assert.equal(ta.width, '100%')
  assert.equal(ta.maxWidth, '100%')
  assert.equal(ta.boxSizing, 'border-box')
  assert.match(ta.fontFamily, /var\(--font-mono/)
  assert.equal(EDIT_STYLES.error.overflowWrap, 'anywhere')
  assert.equal(EDIT_STYLES.count.overflowWrap, 'anywhere')
})

test('every new message is plain text with no em dash', () => {
  for (const key of ['edit', 'editApply', 'editSave', 'editCancel', 'editApplyFailed', 'editSaveFailed']) {
    const value = messages.en[key]
    assert.ok(value, key)
    const s = typeof value === 'function' ? value('X', 1, 2, 3) : value
    assert.doesNotMatch(s, /\u2014/)
  }
})
