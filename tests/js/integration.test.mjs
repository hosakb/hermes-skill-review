// Edit, Remove entirely, expand context and word marks together in one block and one file view.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MEMORY_DIFF, MEMORY_FILE, SKILL_DIFF, SKILL_FILE } from './fixtures.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))
const host = { navigate() {}, notify() {}, notifyError() {}, openWorkspace() { return () => {} }, revealPane() {}, undismissPane() {}, state: { profile: { get: () => 'default' } } }
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const { BlockEditor, BlockView, ExpandRow, FileDetailView, FileDiffView } = mod
const { Textarea } = await import('@hermes/plugin-sdk')
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)

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
const labels = node => walk(node).filter(n => typeof n.props?.onClick === 'function').map(b => b.props.children)
const noop = () => {}

const replaceBlock = MEMORY_DIFF.segments[1].block // r1-0: one removed and one added line
const INFO = { field: 'content', limit: null, scope: 'entry', text: replaceBlock.added[0].text }
const removal = (current = null) => ({ current, file: MEMORY_FILE, onAsk: noop, onCancel: noop, onConfirm: noop })
const edit = (session = null) => ({ info: INFO, onCancel: noop, onChange: noop, onSave: noop, onStart: noop, session })
const session = { blockId: 'r1-0', error: null, file: 'memory/dev/x', info: INFO, saving: null, text: 'edited' }
const view = (props = {}) =>
  expand(BlockView({ block: replaceBlock, busy: false, isNew: true, onAccept: noop, onReject: noop, removal: removal(), t, ...props }))

test('a memory replace block offers Edit, Accept, Reject and Remove entirely together', () => {
  assert.deepEqual(labels(view({ edit: edit() })), ['edit', 'accept', 'reject', 'removeEntry'])
})

test('while the block is edited, Remove entirely and its question row are hidden', () => {
  const open = view({ edit: edit(session), removal: removal({ blockId: 'r1-0', error: null, key: 'memory/dev/' + MEMORY_FILE.key, phase: 'confirm' }) })
  assert.deepEqual(labels(open), ['reject', 'editApply', 'editSave', 'editCancel'])
  assert.equal(walk(open).filter(n => n.props?.['aria-label'] === 'removeConfirm').length, 0)
  assert.equal(walk(open).filter(n => n.type === Textarea).length, 1)
})

test("while this block's Remove question is open, Edit is hidden", () => {
  const asking = view({ edit: edit(), removal: removal({ blockId: 'r1-0', error: null, key: `memory/dev/${MEMORY_FILE.key}`, phase: 'confirm' }) })
  assert.ok(!labels(asking).includes('edit'))
  assert.ok(labels(asking).includes('removeDelete'))
})

test('Remove entirely stays hidden on skill blocks and add-only blocks that are editable', () => {
  const skill = expand(BlockView({ block: SKILL_DIFF.segments[1].block, busy: false, edit: edit(), isNew: true, onAccept: noop, onReject: noop,
    removal: { ...removal(), file: SKILL_FILE }, t }))
  assert.deepEqual(labels(skill), ['edit', 'accept', 'reject'])
  const add = expand(BlockView({ block: MEMORY_DIFF.segments[5].block, busy: false, edit: edit(), isNew: true, onAccept: noop, onReject: noop, removal: removal(), t }))
  assert.deepEqual(labels(add), ['edit', 'accept', 'reject'])
})

test('word marks render inside a block whose text was edited and saved', () => {
  const edited = { ...replaceBlock, added: [{ no: 3, text: 'Deploys go to the staging box second.' }] }
  const tree = expand(BlockView({ block: edited, busy: false, edit: edit(), isNew: true, onAccept: noop, onReject: noop, removal: removal(), t }))
  const marks = walk(tree).filter(n => n.props?.['data-mark'])
  assert.deepEqual(marks.map(m => [m.props['data-mark'], m.props.children]), [['remove', 'first'], ['add', 'second']])
})

test('while editing, the removed line keeps its row and the editor replaces the added one', () => {
  const tree = view({ edit: edit(session) })
  const rows = walk(tree).filter(n => n.props?.['aria-label']?.startsWith?.('row_'))
  assert.deepEqual(rows.map(r => r.props['aria-label']), ['row_remove'])
  assert.equal(walk(tree).filter(n => n.type === BlockEditor || n.props?.['data-editor']).length > 0, true)
})

test('the file view threads edit, removal and expansion together', () => {
  const blocks = { 'r1-0': INFO }
  const editProps = { blocks, onCancel: noop, onChange: noop, onSave: noop, onStart: noop, session: null }
  const detail = FileDetailView({ busy: false, confirmOpen: false, data: MEMORY_DIFF, edit: editProps, error: null, expansion: null, file: MEMORY_FILE,
    loading: false, onAction: noop, onAskRejectAll: noop, onCloseConfirm: noop, onExpand: noop, openButton: null, prior: null, removal: removal(), t })
  const diffView = walk(detail).find(n => n.type === FileDiffView)
  assert.equal(diffView.props.edit, editProps)
  assert.ok(diffView.props.removal && diffView.props.gaps)
  const tree = FileDiffView(diffView.props)
  const views = walk(tree).filter(n => n.type === BlockView)
  assert.deepEqual(views.map(v => [v.props.block.id, Boolean(v.props.edit), Boolean(v.props.removal)]),
    [['r1-0', true, true], ['r1-1', false, true], ['r2-0', false, true]])
})

test('expand rows still render beside an open editor', () => {
  const long = {
    ...MEMORY_DIFF,
    segments: [{ type: 'context', lines: Array.from({ length: 12 }, (_, i) => ({ no: i + 1, text: `line ${i + 1}` })) },
      { type: 'block', block: { ...replaceBlock, removed: [{ no: 13, text: 'old' }], added: [{ no: 13, text: 'new' }] } }]
  }
  const editProps = { blocks: { 'r1-0': INFO }, onCancel: noop, onChange: noop, onSave: noop, onStart: noop, session }
  const tree = FileDiffView({ busy: false, edit: editProps, gaps: {}, onBlock: noop, onExpand: noop, prior: null, removal: removal(), segments: long.segments, t })
  assert.equal(walk(tree).filter(n => n.type === ExpandRow).length, 1)
  assert.equal(walk(tree).find(n => n.type === BlockView).props.edit.session, session)
})
