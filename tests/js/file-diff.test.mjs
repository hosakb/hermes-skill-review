// Tests for the per-file composite diff (list of files, one diff per file, per-block actions).
// Same stub setup as plugin.test.mjs, kept in its own file so both can change independently.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CREATE_DIFF, FILES, GONE, MEMORY_DIFF, MEMORY_FILE, NEW_SKILL_FILE, ODD_FILE, SKILL_DIFF, SKILL_FILE, T0, USER_FILE } from './fixtures.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate() {},
  notify(toast) { this.toasts.push(toast) },
  notifyError() {},
  openWorkspace() { return () => {} },
  revealPane(id) { this.revealed.push(id) },
  undismissPane() {},
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = []; this.revealed = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $selection, STYLES, FILE_STYLES, BlockView, FileDetailView, FileDiffView, FileHeader, FileList, FileListRow,
  actionPath, actionToast, diffKey, fileDiffPath, fileKey, filesPath, handleDiffData, isNewBlock, lastOpenedAt,
  messages, openVisit, performAction, segmentRows, visibleItems
} = mod
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)

// --- tree helpers over the jsx() stub ({ type, props, key }) -----------------------------------
const OWN = new Set(Object.values(mod).filter(v => typeof v === 'function'))
const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
// Expand this plugin's own components (SDK stubs stay as leaves), so a whole view can be walked.
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
const rowsOf = node => walk(node).filter(n => n.props?.style?.display === 'grid')

function fakeStorage(initial = {}) {
  const store = { ...initial }
  return { store, get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } }
}

function fakeQueryClient() {
  return { invalidated: [], invalidateQueries({ queryKey }) { this.invalidated.push(queryKey) } }
}

function fakeRest(reply) {
  const calls = []
  const rest = async (path, opts) => { calls.push({ path, method: opts?.method }); return typeof reply === 'function' ? reply(path) : reply }
  return { calls, rest }
}

// --- paths ------------------------------------------------------------------------------------

test('file paths follow contract v1 and encode every segment', () => {
  assert.equal(filesPath(), '/files?kind=all')
  assert.equal(fileDiffPath(MEMORY_FILE), `/files/dev/memory/${MEMORY_FILE.key}/diff`)
  assert.equal(fileDiffPath(ODD_FILE), '/files/my%20profile/memory/a%2Fb%20c/diff')
  assert.equal(actionPath(ODD_FILE, { verb: 'accept', blockId: 'r1/0' }), '/files/my%20profile/memory/a%2Fb%20c/blocks/r1%2F0/accept')
  assert.equal(actionPath(MEMORY_FILE, { verb: 'reject', blockId: 'r1-0' }), `/files/dev/memory/${MEMORY_FILE.key}/blocks/r1-0/reject`)
  assert.equal(actionPath(MEMORY_FILE, { verb: 'accept-all' }), `/files/dev/memory/${MEMORY_FILE.key}/accept-all`)
  assert.equal(actionPath(MEMORY_FILE, { verb: 'reject-all' }), `/files/dev/memory/${MEMORY_FILE.key}/reject-all`)
  assert.throws(() => actionPath(MEMORY_FILE, { verb: 'delete' }))
})

test('fileKey separates the same file name in two profiles', () => {
  const opsUser = { ...USER_FILE, profile: 'ops' }
  assert.notEqual(fileKey(USER_FILE), fileKey(opsUser))
  assert.equal(fileKey(USER_FILE), `memory/dev/${USER_FILE.key}`)
})

// --- list -------------------------------------------------------------------------------------

test('the list has one row per profile and file, keyed by fileKey', () => {
  const opsUser = { ...USER_FILE, profile: 'ops' }
  const files = [...FILES.files, opsUser]
  const list = FileList({ files, lastOpened: {}, onSelect() {}, selection: null, t })
  const rows = kids(list).filter(n => n.type === FileListRow)
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map(r => r.key), files.map(fileKey))
  assert.equal(new Set(rows.map(r => r.key)).size, 5, 'USER.md in dev and in ops are two rows')
})

test('profile scope and kind filters apply to files', () => {
  assert.deepEqual(visibleItems(FILES.files, 'focused', 'dev').map(f => f.file), ['MEMORY.md', 'USER.md', 'council/SKILL.md'])
  assert.deepEqual(visibleItems(FILES.files, 'all', 'dev', 'skills').map(f => f.file), ['council/SKILL.md', 'release-notes/SKILL.md'])
  assert.deepEqual(visibleItems(FILES.files, 'focused', 'dev', 'memory').map(f => f.file), ['MEMORY.md', 'USER.md'])
})

test('a list row shows the file, profile, counts and a New badge, and selects on click', () => {
  let picked = null
  const row = FileListRow({ file: SKILL_FILE, hasNew: true, onSelect: k => { picked = k }, selected: true, t })
  const all = text(row)
  assert.match(all, /council\/SKILL\.md/)
  assert.match(all, /\bdev\b/)
  assert.match(all, /changes:3/)
  assert.match(all, /staleCount:1/)
  assert.match(all, /conflictCount:1/)
  assert.match(all, /\bnew\b/)
  assert.equal(row.props['aria-current'], true)
  assert.equal(row.props.style.borderLeft, '2px solid var(--ui-accent)')
  row.props.onClick()
  assert.equal(picked, fileKey(SKILL_FILE))
  const quiet = FileListRow({ file: USER_FILE, hasNew: false, onSelect() {}, selected: false, t })
  assert.doesNotMatch(text(quiet), /\bnew\b/)
  assert.doesNotMatch(text(quiet), /staleCount|conflictCount/, 'zero counts are not shown')
  const title = walk(row).find(n => n.props?.children === 'council/SKILL.md')
  assert.equal(title.props.style, STYLES.listTitle, 'long names truncate like the old list')
})

test('the list marks a file New when it has changes staged after it was last opened', () => {
  const lastOpened = { [fileKey(MEMORY_FILE)]: T0 + 1000, [fileKey(USER_FILE)]: T0 }
  const list = FileList({ files: [MEMORY_FILE, USER_FILE, SKILL_FILE], lastOpened, onSelect() {}, selection: null, t })
  assert.deepEqual(kids(list).map(r => r.props.hasNew), [false, true, true])
})

// --- last opened, NEW versus OLDER ------------------------------------------------------------

test('isNewBlock: never opened is New, otherwise staged after the last open', () => {
  assert.equal(isNewBlock({ staged_at: T0 }, null), true)
  assert.equal(isNewBlock({ staged_at: T0 }, undefined), true)
  assert.equal(isNewBlock({ staged_at: T0 + 1 }, T0), true)
  assert.equal(isNewBlock({ staged_at: T0 }, T0), false)
  assert.equal(isNewBlock({ staged_at: T0 - 1 }, T0), false)
})

test('openVisit stores the open time and keeps the previous one for the whole visit', () => {
  const storage = fakeStorage()
  const a = fileKey(MEMORY_FILE)
  const b = fileKey(USER_FILE)
  assert.equal(openVisit(storage, a, T0 + 500), null, 'first open: nothing before')
  assert.equal(lastOpenedAt(storage, a), T0 + 500)
  assert.equal(openVisit(storage, a, T0 + 600), null, 'a re-render in the same visit keeps the prior value')
  assert.equal(lastOpenedAt(storage, a), T0 + 500)
  assert.equal(openVisit(storage, b, T0 + 700), null)
  assert.equal(openVisit(storage, a, T0 + 800), T0 + 500, 'coming back compares with the earlier open')
  assert.equal(lastOpenedAt(storage, a), T0 + 800)
  storage.store.lastOpened = 'garbage'
  assert.equal(lastOpenedAt(storage, a), null, 'bad stored data is ignored')
  const broken = { get() { throw new Error('no storage') }, set() { throw new Error('no storage') } }
  assert.equal(openVisit(broken, fileKey(SKILL_FILE), T0), null, 'storage errors never break the view')
})

test('blocks are labelled New or Older from the stored last-open time', () => {
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, prior: T0 + 150, segments: MEMORY_DIFF.segments, t }))
  const found = blocks(tree)
  assert.deepEqual(found.map(b => b.props['data-block']), ['r1-0', 'r1-1', 'r2-0'])
  assert.deepEqual(found.map(b => b.props['data-new']), [false, false, true])
  assert.match(text(found[0]), /\bolder\b/)
  assert.match(text(found[0]), /staged:/)
  assert.match(text(found[2]), /\bnew\b/)
  assert.doesNotMatch(text(found[2]), /\bolder\b/)
  const never = blocks(expand(FileDiffView({ busy: false, onBlock() {}, prior: null, segments: MEMORY_DIFF.segments, t })))
  assert.ok(never.every(b => b.props['data-new'] === true), 'a file never opened shows every block as New')
  assert.notDeepEqual(found[0].props.style, found[2].props.style, 'New and Older look different')
})

test('block headers show the origin and summary', () => {
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, prior: null, segments: MEMORY_DIFF.segments, t }))
  const [first, , last] = blocks(tree)
  assert.match(text(first), /origin_background_review/)
  assert.match(text(first), /replace: deploy host/)
  assert.match(text(last), /\bchat\b/, 'an origin without a label is shown as is')
})

// --- composite diff rendering -----------------------------------------------------------------

test('segmentRows: context is grey with the line number, removed and added carry their numbers', () => {
  assert.deepEqual(segmentRows(MEMORY_DIFF.segments[0]), [
    { kind: 'context', oldNo: 1, text: 'The test suite runs with `pytest -q` from the repo root.' },
    { kind: 'context', oldNo: 2, text: '§' }
  ])
  assert.deepEqual(segmentRows(MEMORY_DIFF.segments[1]), [
    { kind: 'remove', oldNo: 3, text: 'Deploys go to the staging box first.' },
    { kind: 'add', newNo: 3, text: 'Deploys go to staging first, then production after a smoke test.' }
  ])
})

test('the composite diff draws context, red removed rows and green added rows in file order', () => {
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, prior: null, segments: MEMORY_DIFF.segments, t }))
  const rows = rowsOf(tree)
  assert.deepEqual(rows.map(r => r.props['aria-label']), [
    'row_context', 'row_context', 'row_remove', 'row_add', 'row_context', 'row_remove', 'row_remove', 'row_context', 'row_add', 'row_add'
  ])
  const ctx = rows[0]
  assert.equal(ctx.props.style.color, 'var(--ui-text-secondary)', 'context is grey')
  assert.equal(rows[2].props.style.background, 'var(--ui-diff-remove-background)')
  assert.equal(rows[2].props.style.color, 'var(--ui-diff-remove-foreground)')
  assert.equal(rows[3].props.style.background, 'var(--ui-diff-add-background)')
  assert.equal(rows[3].props.style.color, 'var(--ui-diff-add-foreground)')
  const cells = kids(rows[2])
  assert.deepEqual(cells.slice(0, 3).map(c => c.props.style), [STYLES.gutter, STYLES.gutter, STYLES.sign], 'gutter: old no, new no, sign')
  assert.deepEqual(cells.map(c => c.props.children), [3, '', '-', 'Deploys go to the staging box first.'])
  assert.deepEqual(kids(rows[3]).map(c => c.props.children), ['', 3, '+', 'Deploys go to staging first, then production after a smoke test.'])
  assert.deepEqual(kids(ctx).map(c => c.props.children).slice(0, 3), [1, '', ' '])
  const box = walk(tree).find(n => n.props?.style === STYLES.diffBox)
  assert.ok(box, 'the whole file sits in one guarded diff box')
})

test('a new-file create is one block of added lines with no context', () => {
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, prior: null, segments: CREATE_DIFF.segments, t }))
  assert.equal(blocks(tree).length, 1)
  const rows = rowsOf(tree)
  assert.equal(rows.length, 4)
  assert.ok(rows.every(r => r.props['aria-label'] === 'row_add'))
  assert.deepEqual(rows.map(r => kids(r)[1].props.children), [1, 2, 3, 4])
})

test('several blocks in one file each get their own Accept and Reject', () => {
  const seen = []
  const tree = expand(FileDiffView({ busy: false, onBlock: a => seen.push(a), prior: null, segments: MEMORY_DIFF.segments, t }))
  for (const b of blocks(tree)) {
    button(b, 'accept').props.onClick()
    button(b, 'reject').props.onClick()
  }
  assert.deepEqual(seen, [
    { blockId: 'r1-0', verb: 'accept' }, { blockId: 'r1-0', verb: 'reject' },
    { blockId: 'r1-1', verb: 'accept' }, { blockId: 'r1-1', verb: 'reject' },
    { blockId: 'r2-0', verb: 'accept' }, { blockId: 'r2-0', verb: 'reject' }
  ])
  const busy = expand(FileDiffView({ busy: true, onBlock() {}, prior: null, segments: MEMORY_DIFF.segments, t }))
  assert.ok(buttons(busy).every(b => b.props.disabled === true), 'buttons disable while a request runs')
})

test('a stale block is greyed, shows its reason and offers Reject only', () => {
  const stale = SKILL_DIFF.segments.find(s => s.block?.state === 'stale').block
  const view = expand(BlockView({ block: stale, busy: false, isNew: false, onAccept() {}, onReject() {}, t }))
  assert.equal(button(view, 'accept'), undefined, 'no Accept on a stale block')
  assert.ok(button(view, 'reject'))
  assert.match(text(view), /old_string no longer appears in the file/)
  assert.match(text(view), /\bstale\b/)
  assert.equal(view.props.style.opacity, FILE_STYLES.blockStale.opacity)
  assert.ok(view.props.style.opacity < 1, 'greyed')
  const blocked = { ...SKILL_DIFF.segments[1].block, can_accept: false }
  assert.equal(button(expand(BlockView({ block: blocked, busy: false, isNew: true, onAccept() {}, onReject() {}, t })), 'accept'), undefined,
    'can_accept false hides Accept even for a pending block')
})

test('a conflict block says it conflicts with the block above', () => {
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, prior: null, segments: SKILL_DIFF.segments, t }))
  const conflict = blocks(tree).find(b => b.props['data-block'] === 'p2-0')
  assert.match(text(conflict), /conflictAbove/)
  assert.ok(button(conflict, 'accept'), 'a conflict block can still be accepted when the backend allows it')
  assert.equal(messages.en.conflictAbove, 'Conflicts with the block above')
  const plain = blocks(tree).find(b => b.props['data-block'] === 'p1-0')
  assert.doesNotMatch(text(plain), /conflictAbove/)
})

// --- file header, confirmation ----------------------------------------------------------------

test('the file header has Accept all and Reject all; Reject all only asks for confirmation', () => {
  const asked = []
  const actions = []
  const view = expand(FileDetailView({
    busy: false, confirmOpen: false, data: SKILL_DIFF, file: SKILL_FILE, onAction: a => actions.push(a),
    onAskRejectAll: () => asked.push(true), onCloseConfirm() {}, prior: null, t
  }))
  assert.match(text(view), /council\/SKILL\.md/)
  button(view, 'acceptAll').props.onClick()
  assert.deepEqual(actions, [{ verb: 'accept-all' }])
  button(view, 'rejectAll').props.onClick()
  assert.deepEqual(asked, [true])
  assert.deepEqual(actions, [{ verb: 'accept-all' }], 'Reject all does not call the backend by itself')
  const dialog = walk(view).find(n => n.props?.destructive === true)
  assert.equal(dialog.props.open, false)
  const open = expand(FileDetailView({
    busy: false, confirmOpen: true, data: SKILL_DIFF, file: SKILL_FILE, onAction: a => actions.push(a),
    onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t
  }))
  const confirm = walk(open).find(n => n.props?.destructive === true)
  assert.equal(confirm.props.open, true)
  assert.match(confirm.props.description, /rejectAllBody:3,council\/SKILL\.md/)
  confirm.props.onConfirm()
  assert.deepEqual(actions.at(-1), { verb: 'reject-all' })
})

test('Accept all is disabled when no block can be accepted', () => {
  const onlyStale = { ...SKILL_DIFF, segments: SKILL_DIFF.segments.filter(s => s.type === 'context' || s.block.state === 'stale') }
  const header = FileHeader({ acceptable: 0, busy: false, file: SKILL_FILE, onAcceptAll() {}, onRejectAll() {}, t })
  assert.equal(button(header, 'acceptAll').props.disabled, true)
  const view = expand(FileDetailView({ busy: false, confirmOpen: false, data: onlyStale, file: SKILL_FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }))
  assert.equal(button(view, 'acceptAll').props.disabled, true)
  assert.equal(button(view, 'rejectAll').props.disabled, false)
})

test('the detail view shows loading, error and gone states', () => {
  const base = { busy: false, confirmOpen: false, file: MEMORY_FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }
  assert.match(text(expand(FileDetailView({ ...base, data: undefined, loading: true }))), /loading/)
  const failed = expand(FileDetailView({ ...base, data: undefined, error: new Error('500 boom') }))
  assert.ok(walk(failed).some(n => n.props?.title === 'diffError' && /500 boom/.test(n.props.description)))
  assert.match(text(expand(FileDetailView({ ...base, data: GONE }))), /fileGone/)
})

// --- actions, refetch, file gone --------------------------------------------------------------

test('per-block accept and reject POST to the block URL, toast, and refetch the file', async () => {
  host.reset()
  const qc = fakeQueryClient()
  const { calls, rest } = fakeRest({ status: 'applied', error: null, file_gone: false })
  $selection.set(fileKey(MEMORY_FILE))
  await performAction({ action: { blockId: 'r1-0', verb: 'accept' }, file: MEMORY_FILE, queryClient: qc, rest, t })
  assert.deepEqual(calls, [{ path: `/files/dev/memory/${MEMORY_FILE.key}/blocks/r1-0/accept`, method: 'POST' }])
  assert.deepEqual(host.toasts.map(x => x.kind), ['success'])
  assert.deepEqual(qc.invalidated, [diffKey(MEMORY_FILE), ['skill-review', 'files'], ['skill-review', 'pending']])
  assert.equal($selection.get(), fileKey(MEMORY_FILE), 'the file stays open while it has changes')

  const second = fakeRest({ status: 'rejected', error: null, file_gone: false })
  await performAction({ action: { blockId: 'r2-0', verb: 'reject' }, file: MEMORY_FILE, queryClient: qc, rest: second.rest, t })
  assert.deepEqual(second.calls, [{ path: `/files/dev/memory/${MEMORY_FILE.key}/blocks/r2-0/reject`, method: 'POST' }])
  assert.equal(host.toasts.at(-1).kind, 'info')
})

test('when the backend says file_gone, the view returns to the list', async () => {
  host.reset()
  const qc = fakeQueryClient()
  const { rest } = fakeRest({ status: 'applied', error: null, file_gone: true })
  $selection.set(fileKey(NEW_SKILL_FILE))
  await performAction({ action: { blockId: 'c1-0', verb: 'accept' }, file: NEW_SKILL_FILE, queryClient: qc, rest, t })
  assert.equal($selection.get(), null)
  assert.ok(qc.invalidated.some(k => k[1] === 'files'), 'the list refetches')
})

test('a failed block keeps the file open and reports the error with any multi-line detail', async () => {
  host.reset()
  const qc = fakeQueryClient()
  const scan = 'Security scan blocked this skill:\n  - exfiltration'
  const { rest } = fakeRest({ status: 'failed', error: scan, file_gone: false })
  $selection.set(fileKey(SKILL_FILE))
  await performAction({ action: { blockId: 'p1-0', verb: 'accept' }, file: SKILL_FILE, queryClient: qc, rest, t })
  const toast = host.toasts.at(-1)
  assert.equal(toast.kind, 'error')
  assert.match(toast.message, /Security scan blocked this skill:$/)
  assert.equal(toast.detail, scan)
  assert.equal($selection.get(), fileKey(SKILL_FILE))
  assert.deepEqual(qc.invalidated[0], diffKey(SKILL_FILE), 'still refetched, the file may have changed')
})

test('accept-all and reject-all POST to the file URL and summarise the results', async () => {
  host.reset()
  const qc = fakeQueryClient()
  const { calls, rest } = fakeRest(path => ({
    results: path.endsWith('accept-all')
      ? [{ block_id: 'p1-0', status: 'applied', error: null }, { block_id: 'p2-0', status: 'failed', error: 'overlaps p1-0' }]
      : [{ block_id: 'p1-0', status: 'rejected', error: null }, { block_id: 'p3-0', status: 'rejected', error: null }]
  }))
  await performAction({ action: { verb: 'accept-all' }, file: SKILL_FILE, queryClient: qc, rest, t })
  await performAction({ action: { verb: 'reject-all' }, file: SKILL_FILE, queryClient: qc, rest, t })
  assert.deepEqual(calls.map(c => [c.method, c.path]), [
    ['POST', `/files/dev/skills/${SKILL_FILE.key}/accept-all`],
    ['POST', `/files/dev/skills/${SKILL_FILE.key}/reject-all`]
  ])
  assert.equal(host.toasts[0].kind, 'error', 'a partial failure is an error toast')
  assert.match(host.toasts[0].message, /bulkAccepted:1,2/)
  assert.match(host.toasts[0].detail, /overlaps p1-0/)
  assert.equal(host.toasts[1].kind, 'info')
  assert.match(host.toasts[1].message, /bulkRejected:2,2/)
  assert.equal(qc.invalidated.filter(k => k[1] === 'file').length, 2, 'refetched after each')
})

test('a diff that comes back gone returns to the list and refreshes it', () => {
  const qc = fakeQueryClient()
  $selection.set(fileKey(USER_FILE))
  assert.equal(handleDiffData(MEMORY_DIFF, qc), false)
  assert.equal($selection.get(), fileKey(USER_FILE))
  assert.deepEqual(qc.invalidated, [])
  assert.equal(handleDiffData(GONE, qc), true)
  assert.equal($selection.get(), null)
  assert.deepEqual(qc.invalidated, [['skill-review', 'files']])
})

test('actionToast covers every block status', () => {
  const file = USER_FILE
  assert.equal(actionToast({ verb: 'accept' }, { status: 'applied' }, file, t).kind, 'success')
  assert.equal(actionToast({ verb: 'reject' }, { status: 'rejected' }, file, t).kind, 'info')
  assert.equal(actionToast({ verb: 'accept' }, { status: 'already_handled' }, file, t).kind, 'info')
  assert.equal(actionToast({ verb: 'accept' }, { status: 'failed', error: 'x' }, file, t).kind, 'error')
  assert.equal(actionToast({ verb: 'accept-all' }, { results: [] }, file, t).kind, 'info')
})

// --- styles -----------------------------------------------------------------------------------

test('file view styles let text wrap, shrink to the pane and use theme variables only', () => {
  for (const [name, style] of Object.entries(FILE_STYLES)) {
    for (const [prop, value] of Object.entries(style)) {
      if (/color|background|border/i.test(prop) && typeof value === 'string' && !/^(none|0|transparent)$/.test(value)) {
        assert.match(value, /var\(--ui-[a-z0-9-]+\)/, `${name}.${prop} uses a theme variable`)
      }
      if (typeof value === 'string') assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `${name}.${prop}`)
    }
  }
  for (const key of ['block', 'blockHead', 'blockSummary', 'blockNote', 'fileTitle']) {
    assert.equal(FILE_STYLES[key].minWidth, 0, key)
  }
  for (const key of ['blockSummary', 'blockNote', 'fileTitle']) {
    assert.equal(FILE_STYLES[key].overflowWrap, 'anywhere', key)
  }
  assert.equal(FILE_STYLES.blockHead.flexWrap, 'wrap', 'header buttons drop to a new line in a narrow pane')
})

test('a 400-character line inside a block wraps in the text column', () => {
  const long = 'x'.repeat(400)
  const seg = { type: 'block', block: { ...CREATE_DIFF.segments[0].block, added: [{ no: 1, text: long }] } }
  const row = rowsOf(expand(FileDiffView({ busy: false, onBlock() {}, prior: null, segments: [seg], t })))[0]
  const cell = kids(row)[3]
  assert.equal(cell.props.children, long)
  assert.equal(cell.props.style, STYLES.rowText)
  assert.equal(STYLES.rowText.whiteSpace, 'pre-wrap')
  assert.equal(STYLES.row.gridTemplateColumns.endsWith('minmax(0, 1fr)'), true)
})

test('every new message key used by the file view exists', () => {
  const src = readFileSync(pluginPath, 'utf8')
  const region = src.slice(src.indexOf('// File view'), src.indexOf('// Reveal, watcher'))
  const used = new Set([...region.matchAll(/\bt\('([a-zA-Z_]+)'/g)].map(m => m[1]))
  for (const key of used) assert.ok(key in messages.en, key)
})
