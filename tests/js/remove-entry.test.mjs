// Tests for "Remove entirely": the third block action that deletes the memory entry a replace or
// patch targets and drops the proposal. Same stub setup as file-diff.test.mjs.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CREATE_DIFF, MEMORY_DIFF, MEMORY_FILE, SKILL_DIFF, SKILL_FILE, USER_FILE } from './fixtures.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate() {},
  notify(toast) { this.toasts.push(toast) },
  notifyError() {},
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $removal, $selection, REMOVE_STYLES, STYLES, BlockView, FileDetailView, FileDiffView, RemoveEntryButton, RemoveEntryRow,
  canRemoveEntry, diffKey, fileKey, messages, performRemove, removeEntryPath
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
const blocks = tree => walk(tree).filter(n => n.props?.['data-block'])

function fakeQueryClient() {
  return { invalidated: [], invalidateQueries({ queryKey }) { this.invalidated.push(queryKey) } }
}

function fakeRest(reply) {
  const calls = []
  const rest = async (path, opts) => {
    calls.push({ path, method: opts?.method, removal: $removal.get() })
    if (reply instanceof Error) throw reply
    return reply
  }
  return { calls, rest }
}

const replaceBlock = MEMORY_DIFF.segments[1].block // r1-0: one removed line, one added line
const removeBlock = MEMORY_DIFF.segments[3].block // r1-1: removed lines only
const addBlock = MEMORY_DIFF.segments[5].block // r2-0: added lines only
const skillPatch = SKILL_DIFF.segments[1].block // p1-0: one removed, one added, but a skill
const conflictMem = { ...replaceBlock, id: 'r9-0', state: 'conflict', conflicts_with: 'r1-0' }
const staleMem = { ...replaceBlock, id: 'r8-0', state: 'stale', can_accept: false, reason: 'Entry changed since it was staged' }
const multiLine = { ...replaceBlock, id: 'r7-0', removed: [{ no: 3, text: 'line a' }, { no: 4, text: 'line b' }] }

function removal(file, current = null, log = []) {
  return {
    current,
    file,
    onAsk: id => log.push(['ask', id]),
    onCancel: () => log.push(['cancel']),
    onConfirm: id => log.push(['confirm', id])
  }
}

const viewOf = (block, file, current = null, log = []) =>
  expand(BlockView({ block, busy: false, isNew: true, onAccept() {}, onReject() {}, removal: removal(file, current, log), t }))

// --- visibility ---------------------------------------------------------------------------------

test('canRemoveEntry: only pending or conflicting memory blocks that swap one line', () => {
  assert.equal(canRemoveEntry(replaceBlock, 'memory'), true)
  assert.equal(canRemoveEntry(conflictMem, 'memory'), true)
  assert.equal(canRemoveEntry(staleMem, 'memory'), false, 'stale')
  assert.equal(canRemoveEntry(addBlock, 'memory'), false, 'add-only')
  assert.equal(canRemoveEntry(removeBlock, 'memory'), false, 'plain remove')
  assert.equal(canRemoveEntry(multiLine, 'memory'), false, 'several removed lines')
  assert.equal(canRemoveEntry(skillPatch, 'skills'), false, 'skill patch')
  assert.equal(canRemoveEntry(CREATE_DIFF.segments[0].block, 'skills'), false, 'skill file')
})

test('the button shows after Reject on a replace block, in the same action group', () => {
  const view = viewOf(replaceBlock, MEMORY_FILE)
  const group = walk(view).find(n => n.props?.style === STYLES.actions)
  const labels = buttons(group).map(b => b.props.children)
  assert.deepEqual(labels, ['accept', 'reject', 'removeEntry'])
  const tip = walk(group).find(n => n.props?.label === 'removeEntryTip')
  assert.ok(tip, 'the tooltip wraps the button')
  assert.equal(messages.en.removeEntryTip, 'Deletes the existing entry and drops this proposal. Neither version is kept.')
  assert.equal(messages.en.removeEntry, 'Remove entirely')
})

test('the button is hidden on add, remove, stale, multi-line and every skill block', () => {
  for (const [block, file] of [[addBlock, MEMORY_FILE], [removeBlock, MEMORY_FILE], [staleMem, MEMORY_FILE],
    [multiLine, MEMORY_FILE], [skillPatch, SKILL_FILE], [CREATE_DIFF.segments[0].block, SKILL_FILE]]) {
    assert.equal(button(viewOf(block, file), 'removeEntry'), undefined, block.id)
  }
  assert.ok(button(viewOf(conflictMem, MEMORY_FILE), 'removeEntry'), 'a conflict block still offers it')
  assert.ok(button(viewOf(replaceBlock, USER_FILE), 'removeEntry'), 'USER.md too')
})

test('the composite view offers it only on the eligible block', () => {
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, prior: null, removal: removal(MEMORY_FILE), segments: MEMORY_DIFF.segments, t }))
  const offered = blocks(tree).filter(b => button(b, 'removeEntry')).map(b => b.props['data-block'])
  assert.deepEqual(offered, ['r1-0'])
  const skills = expand(FileDiffView({ busy: false, onBlock() {}, prior: null, removal: removal(SKILL_FILE), segments: SKILL_DIFF.segments, t }))
  assert.equal(blocks(skills).filter(b => button(b, 'removeEntry')).length, 0)
})

test('the button disables while any request runs', () => {
  const view = expand(BlockView({ block: replaceBlock, busy: true, isNew: true, onAccept() {}, onReject() {}, removal: removal(MEMORY_FILE), t }))
  assert.equal(button(view, 'removeEntry').props.disabled, true)
})

// --- confirm flow ---------------------------------------------------------------------------------

test('clicking asks first; the question row has Delete and Cancel, Cancel takes focus', () => {
  const log = []
  const closed = viewOf(replaceBlock, MEMORY_FILE, null, log)
  assert.equal(button(closed, 'removeDelete'), undefined, 'no question before the click')
  button(closed, 'removeEntry').props.onClick()
  assert.deepEqual(log, [['ask', 'r1-0']])

  const current = { key: fileKey(MEMORY_FILE), blockId: 'r1-0', phase: 'confirm', error: null }
  const open = viewOf(replaceBlock, MEMORY_FILE, current, log)
  assert.match(text(open), /removeConfirm/)
  assert.equal(messages.en.removeConfirm, 'Delete this entry and drop the proposal?')
  const del = button(open, 'removeDelete')
  const cancel = button(open, 'removeCancel')
  assert.equal(del.props.variant, 'destructive')
  assert.equal(cancel.props.autoFocus, true)
  assert.equal(button(open, 'removeEntry').props.disabled, true, 'no second question while one is open')
  assert.equal(button(open, 'removeEntry').props['aria-expanded'], true)
  del.props.onClick()
  cancel.props.onClick()
  assert.deepEqual(log.slice(1), [['confirm', 'r1-0'], ['cancel']])
})

test('the question sits right under the block head, before the diff lines', () => {
  const current = { key: fileKey(MEMORY_FILE), blockId: 'r1-0', phase: 'confirm', error: null }
  const view = viewOf(replaceBlock, MEMORY_FILE, current)
  const children = kids(view)
  assert.equal(children[1].props.style, REMOVE_STYLES.row)
  assert.equal(children.at(-1).props.style.display, 'grid', 'diff rows follow')
})

test('Escape cancels the question, but not while the delete runs', () => {
  const log = []
  const row = expand(RemoveEntryRow({ block: replaceBlock, removal: removal(MEMORY_FILE, { key: fileKey(MEMORY_FILE), blockId: 'r1-0', phase: 'confirm' }, log), t }))
  row.props.onKeyDown({ key: 'Enter' })
  row.props.onKeyDown({ key: 'Escape' })
  assert.deepEqual(log, [['cancel']])
  const busy = expand(RemoveEntryRow({ block: replaceBlock, removal: removal(MEMORY_FILE, { key: fileKey(MEMORY_FILE), blockId: 'r1-0', phase: 'busy' }, log), t }))
  busy.props.onKeyDown({ key: 'Escape' })
  assert.deepEqual(log, [['cancel']])
})

test('the question belongs to one block of one file', () => {
  const current = { key: fileKey(MEMORY_FILE), blockId: 'r1-0', phase: 'confirm', error: null }
  assert.equal(button(viewOf(conflictMem, MEMORY_FILE, current), 'removeDelete'), undefined, 'other block')
  assert.equal(button(viewOf(replaceBlock, USER_FILE, current), 'removeDelete'), undefined, 'other file')
})

test('while deleting, Delete shows its spinner and both buttons disable', () => {
  const current = { key: fileKey(MEMORY_FILE), blockId: 'r1-0', phase: 'busy', error: null }
  const view = viewOf(replaceBlock, MEMORY_FILE, current)
  assert.equal(button(view, 'removeDelete').props.loading, true)
  assert.equal(button(view, 'removeDelete').props.disabled, true)
  assert.equal(button(view, 'removeCancel').props.disabled, true)
})

test('an error shows in the block row with Dismiss, and the button is usable again', () => {
  const log = []
  const current = { key: fileKey(MEMORY_FILE), blockId: 'r1-0', phase: 'error', error: 'Entry changed since it was staged.' }
  const view = viewOf(replaceBlock, MEMORY_FILE, current, log)
  const alert = walk(view).find(n => n.props?.role === 'alert')
  assert.ok(alert)
  assert.match(text(alert), /Entry changed since it was staged/)
  assert.equal(button(view, 'removeEntry').props.disabled, false)
  button(view, 'removeDismiss').props.onClick()
  assert.deepEqual(log, [['cancel']])
  const nowStale = viewOf({ ...replaceBlock, state: 'stale' }, MEMORY_FILE, current)
  assert.ok(walk(nowStale).find(n => n.props?.role === 'alert'), 'the error stays when the refetch turns the block stale')
})

test('the detail view passes the removal down to its blocks', () => {
  const data = { ...MEMORY_DIFF }
  const view = expand(FileDetailView({ busy: false, confirmOpen: false, data, error: null, file: MEMORY_FILE, loading: false,
    onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, removal: removal(MEMORY_FILE), t }))
  assert.ok(button(view, 'removeEntry'))
})

// --- request ------------------------------------------------------------------------------------

test('a removal POSTs to the block URL, toasts "Entry removed" and refetches', async () => {
  host.reset()
  $selection.set(fileKey(MEMORY_FILE))
  const qc = fakeQueryClient()
  const { calls, rest } = fakeRest({ status: 'removed', error: null, file_gone: false })
  await performRemove({ blockId: 'r1-0', file: MEMORY_FILE, queryClient: qc, rest, t })
  assert.equal(removeEntryPath(MEMORY_FILE, 'r1-0'), `/files/dev/memory/${MEMORY_FILE.key}/blocks/r1-0/remove-entry`)
  assert.deepEqual(calls.map(c => [c.path, c.method]), [[removeEntryPath(MEMORY_FILE, 'r1-0'), 'POST']])
  assert.equal(calls[0].removal.phase, 'busy', 'busy while the request runs')
  assert.deepEqual(host.toasts, [{ kind: 'success', message: 'entryRemoved' }])
  assert.equal(messages.en.entryRemoved, 'Entry removed')
  assert.deepEqual(qc.invalidated, [diffKey(MEMORY_FILE), ['skill-review', 'files'], ['skill-review', 'pending']])
  assert.equal($removal.get(), null)
  assert.equal($selection.get(), fileKey(MEMORY_FILE), 'the file stays open while it has changes')
})

test('when the file is gone after the removal, the view returns to the list', async () => {
  host.reset()
  $selection.set(fileKey(USER_FILE))
  const qc = fakeQueryClient()
  const { rest } = fakeRest({ status: 'removed', error: null, file_gone: true })
  await performRemove({ blockId: 'u1-0', file: USER_FILE, queryClient: qc, rest, t })
  assert.equal($selection.get(), null)
  assert.ok(qc.invalidated.some(k => k[1] === 'files'))
})

test('a failed removal keeps the file open and puts the error in the block', async () => {
  host.reset()
  $selection.set(fileKey(MEMORY_FILE))
  const qc = fakeQueryClient()
  const error = "Operation 1 (remove): Entry changed since it was staged, so this write was not applied: 'x'"
  const { rest } = fakeRest({ status: 'failed', error, file_gone: false })
  await performRemove({ blockId: 'r1-0', file: MEMORY_FILE, queryClient: qc, rest, t })
  assert.deepEqual($removal.get(), { blockId: 'r1-0', key: fileKey(MEMORY_FILE), phase: 'error', error })
  assert.equal($selection.get(), fileKey(MEMORY_FILE))
  assert.deepEqual(host.toasts, [], 'no toast: the error is beside the block')
  assert.deepEqual(qc.invalidated, [diffKey(MEMORY_FILE)], 'only this diff refetches, so the block can turn stale')
})

test('a network error is shown in the block the same way', async () => {
  host.reset()
  $selection.set(fileKey(MEMORY_FILE))
  const { rest } = fakeRest(new Error('gateway unreachable'))
  await performRemove({ blockId: 'r1-0', file: MEMORY_FILE, queryClient: fakeQueryClient(), rest, t })
  assert.equal($removal.get().phase, 'error')
  assert.equal($removal.get().error, 'gateway unreachable')
  assert.equal($selection.get(), fileKey(MEMORY_FILE))
})

test('already handled elsewhere: an info toast and a refetch', async () => {
  host.reset()
  $selection.set(fileKey(MEMORY_FILE))
  const qc = fakeQueryClient()
  const { rest } = fakeRest({ status: 'already_handled', error: null, file_gone: true })
  await performRemove({ blockId: 'r1-0', file: MEMORY_FILE, queryClient: qc, rest, t })
  assert.deepEqual(host.toasts.map(x => x.kind), ['info'])
  assert.equal($removal.get(), null)
  assert.equal($selection.get(), null)
})

test('moving to another file closes an open question', () => {
  $selection.set(fileKey(MEMORY_FILE))
  $removal.set({ key: fileKey(MEMORY_FILE), blockId: 'r1-0', phase: 'confirm', error: null })
  $selection.set(fileKey(USER_FILE))
  assert.equal($removal.get(), null)
})

// --- styles -------------------------------------------------------------------------------------

test('remove styles use theme variables only and wrap like the block head', () => {
  for (const [name, style] of Object.entries(REMOVE_STYLES)) {
    for (const [prop, value] of Object.entries(style)) {
      if (/color|background|border/i.test(prop) && typeof value === 'string') {
        assert.match(value, /var\(--ui-[a-z0-9-]+\)/, `${name}.${prop} uses a theme variable`)
      }
      if (typeof value === 'string') assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `${name}.${prop}`)
    }
  }
  assert.equal(REMOVE_STYLES.button.color, 'var(--ui-diff-remove-foreground)', 'the destructive tone is the theme red')
  assert.equal(REMOVE_STYLES.button.flexShrink, 0)
  assert.equal(REMOVE_STYLES.button.maxWidth, '100%')
  assert.equal(REMOVE_STYLES.row.flexWrap, 'wrap')
  for (const key of ['row', 'question', 'error']) assert.equal(REMOVE_STYLES[key].minWidth, 0, key)
  for (const key of ['question', 'error']) assert.equal(REMOVE_STYLES[key].overflowWrap, 'anywhere', key)
  assert.equal(STYLES.actions.flexWrap, 'wrap', 'Accept, Reject and Remove entirely wrap as one group')
})

test('a long error wraps inside the row', () => {
  const long = 'x'.repeat(400)
  const current = { key: fileKey(MEMORY_FILE), blockId: 'r1-0', phase: 'error', error: long }
  const row = expand(RemoveEntryRow({ block: replaceBlock, removal: removal(MEMORY_FILE, current), t }))
  const span = walk(row).find(n => n.props?.children === long)
  assert.equal(span.props.style, REMOVE_STYLES.error)
  assert.equal(REMOVE_STYLES.error.whiteSpace, 'pre-wrap')
})
