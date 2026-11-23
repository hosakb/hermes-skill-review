// Tests for the per-file diff (list of files, one diff per file, whole-write decisions).
// Same stub setup as plugin.test.mjs, kept in its own file so both can change independently.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { API_DIFF, CREATE_DIFF, EXPECT_M1, EXPECT_M2, FILES, GONE, MEMORY_DIFF, MEMORY_FILE, NEW_SKILL_FILE, ODD_FILE, SKILL_DIFF, SKILL_FILE, T0, USER_FILE } from './fixtures.mjs'

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
  $selection, STYLES, FILE_STYLES, BlockView, FileDetailView, FileDiffView, FileHeader, FileList, FileListRow,
  actionPath, actionToast, diffKey, fileDiffPath, fileKey, filesPath, handleDiffData, isNewBlock, lastOpenedAt,
  decisionBody, hasWholeWrite, messages, openVisit, performAction, readyWrites, segmentRows
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
  const rest = async (path, opts) => { calls.push({ path, method: opts?.method, body: opts?.body }); return typeof reply === 'function' ? reply(path) : reply }
  return { calls, rest }
}

// --- paths ------------------------------------------------------------------------------------

test('file paths follow contract v1 and encode every segment', () => {
  assert.equal(filesPath(), '/files?kind=all')
  assert.equal(fileDiffPath(MEMORY_FILE), `/files/dev/memory/${MEMORY_FILE.key}/diff`)
  assert.equal(fileDiffPath(ODD_FILE), '/files/my%20profile/memory/a%2Fb%20c/diff')
  assert.equal(actionPath(ODD_FILE, { verb: 'accept-all' }), '/files/my%20profile/memory/a%2Fb%20c/accept-all')
  assert.equal(actionPath(MEMORY_FILE, { verb: 'accept-all' }), `/files/dev/memory/${MEMORY_FILE.key}/accept-all`)
  assert.equal(actionPath(MEMORY_FILE, { verb: 'reject-all' }), `/files/dev/memory/${MEMORY_FILE.key}/reject-all`)
  assert.throws(() => actionPath(MEMORY_FILE, { verb: 'delete' }))
  assert.throws(() => actionPath(MEMORY_FILE, { verb: 'accept', blockId: 'r1-0' }), 'there is no per-change route')
  assert.throws(() => actionPath(MEMORY_FILE, { verb: 'reject', blockId: 'r1-0' }))
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

test('a list row shows the file, profile, counts and a New badge, and selects on click', () => {
  let picked = null
  const row = FileListRow({ file: SKILL_FILE, hasNew: true, onSelect: k => { picked = k }, selected: true, t })
  const all = text(row)
  assert.match(all, /council\/SKILL\.md/)
  assert.doesNotMatch(all, /\bdev\b/, 'one profile only: the list header names it, the rows do not')
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
  const tree = expand(FileDiffView({ prior: T0 + 150, segments: MEMORY_DIFF.segments, t }))
  const found = blocks(tree)
  assert.deepEqual(found.map(b => b.props['data-block']), ['r1-0', 'r1-1', 'r2-0'])
  assert.deepEqual(found.map(b => b.props['data-new']), [false, false, true])
  assert.match(text(found[0]), /\bolder\b/)
  assert.match(text(found[0]), /staged:/)
  assert.match(text(found[2]), /\bnew\b/)
  assert.doesNotMatch(text(found[2]), /\bolder\b/)
  const never = blocks(expand(FileDiffView({ prior: null, segments: MEMORY_DIFF.segments, t })))
  assert.ok(never.every(b => b.props['data-new'] === true), 'a file never opened shows every block as New')
  assert.notDeepEqual(found[0].props.style, found[2].props.style, 'New and Older look different')
})

test('block headers show the origin and summary', () => {
  const tree = expand(FileDiffView({ prior: null, segments: MEMORY_DIFF.segments, t }))
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
  // A paired removed/added line also carries word marks (tests/js/intraline.test.mjs); compared without them here.
  assert.deepEqual(segmentRows(MEMORY_DIFF.segments[1]).map(({ marks, ...row }) => row), [
    { kind: 'remove', oldNo: 3, text: 'Deploys go to the staging box first.' },
    { kind: 'add', newNo: 3, text: 'Deploys go to staging first, then production after a smoke test.' }
  ])
})

test('the composite diff draws context, red removed rows and green added rows in file order', () => {
  const tree = expand(FileDiffView({ prior: null, segments: MEMORY_DIFF.segments, t }))
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
  // The text cell may hold marked spans; its visible text is the whole line.
  const shown = c => [c.props.children].flat(Infinity).map(x => (typeof x === 'object' && x ? x.props.children : x)).join('')
  assert.deepEqual(cells.map(shown), ['3', '', '-', 'Deploys go to the staging box first.'])
  assert.deepEqual(kids(rows[3]).map(shown), ['', '3', '+', 'Deploys go to staging first, then production after a smoke test.'])
  assert.deepEqual(kids(ctx).map(c => c.props.children).slice(0, 3), [1, '', ' '])
  const box = walk(tree).find(n => n.props?.style === STYLES.diffBox)
  assert.ok(box, 'the whole file sits in one guarded diff box')
})

test('a new-file create is one block of added lines with no context', () => {
  const tree = expand(FileDiffView({ prior: null, segments: CREATE_DIFF.segments, t }))
  assert.equal(blocks(tree).length, 1)
  const rows = rowsOf(tree)
  assert.equal(rows.length, 4)
  assert.ok(rows.every(r => r.props['aria-label'] === 'row_add'))
  assert.deepEqual(rows.map(r => kids(r)[1].props.children), [1, 2, 3, 4])
})

test('no change has a button of its own: Hermes decides whole writes', () => {
  for (const segments of [MEMORY_DIFF.segments, API_DIFF.segments, SKILL_DIFF.segments, CREATE_DIFF.segments]) {
    const tree = expand(FileDiffView({ prior: null, segments, t }))
    assert.ok(blocks(tree).length > 0)
    assert.deepEqual(buttons(tree).filter(b => blocks(b).length === 0 && /accept|reject/i.test(text(b))), [])
    for (const b of blocks(tree)) {
      assert.equal(button(b, 'accept'), undefined)
      assert.equal(button(b, 'reject'), undefined)
    }
  }
})
test('a stale block is greyed and shows its reason', () => {
  const stale = SKILL_DIFF.segments.find(s => s.block?.state === 'stale').block
  const view = expand(BlockView({ block: stale, isNew: false, t }))
  assert.equal(buttons(view).length, 0)
  assert.match(text(view), /old_string no longer appears in the file/)
  assert.match(text(view), /\bstale\b/)
  assert.equal(view.props.style.opacity, FILE_STYLES.blockStale.opacity)
  assert.ok(view.props.style.opacity < 1, 'greyed')
})
test('a conflict block shows Hermes\'s reason', () => {
  const tree = expand(FileDiffView({ prior: null, segments: API_DIFF.segments, t }))
  const conflict = blocks(tree).find(b => b.props['data-block'] === 'm3-cccccccccc')
  assert.match(text(conflict), /conflictReason:Skill 'council' already exists/)
  assert.equal(buttons(conflict).length, 0)
  assert.equal(messages.en.conflictReason('x.'), 'Cannot apply: x.')
  assert.equal(messages.en.conflictAbove, undefined, 'no overlap guess any more: Hermes decides')
})
test('a file with a write of several changes says once that this version decides whole writes only', () => {
  const base = { busy: false, confirmOpen: false, file: MEMORY_FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }
  assert.equal(hasWholeWrite(API_DIFF), true)
  const view = expand(FileDetailView({ ...base, data: API_DIFF }))
  const notes = walk(view).filter(n => n.props?.role === 'note')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].props.children, 'statusWholeWrite')
  assert.equal(notes[0].props.style, FILE_STYLES.wholeNote)
  for (const b of blocks(view)) assert.doesNotMatch(text(b), /statusWholeWrite|one part of a write/)
  const singles = { ...API_DIFF, writes: { m1: API_DIFF.writes.m1, m3: API_DIFF.writes.m3 } }
  assert.equal(hasWholeWrite(singles), false)
  assert.equal(walk(expand(FileDetailView({ ...base, data: singles }))).filter(n => n.props?.role === 'note').length, 0)
  assert.match(messages.en.statusWholeWrite, /^This version decides whole writes only\./)
})
test('blocks render the preview text: a new entry, a unified diff, a removed entry', () => {
  const rows = id => segmentRows({ type: 'block', block: API_DIFF.segments.find(s => s.block.id === id).block })
  assert.deepEqual(rows('m1-0123456789').map(r => [r.kind, r.text]), [['add', 'gamma fact']])
  assert.deepEqual(rows('m2-aaaaaaaaaa').map(r => [r.kind, r.text]),
    [['hunk', '@@ -1 +1 @@'], ['remove', 'alpha fact'], ['add', 'ALPHA fact']], 'the file header row is dropped')
  assert.deepEqual(rows('m2-bbbbbbbbbb').map(r => [r.kind, r.text]), [['remove', 'beta fact']])
  assert.deepEqual(rows('m3-cccccccccc'), [], 'a blocked op shows its reason, not a diff')
})

test('Accept all and Reject all send back the expect of each preview shown, unchanged', () => {
  const actions = []
  const view = expand(FileDetailView({
    busy: false, confirmOpen: true, data: API_DIFF, file: MEMORY_FILE, onAction: a => actions.push(a),
    onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t
  }))
  button(view, 'acceptAll').props.onClick()
  walk(view).find(n => n.props?.destructive === true).props.onConfirm()
  const all = { m1: EXPECT_M1, m2: EXPECT_M2 }
  assert.deepEqual(actions, [{ verb: 'accept-all', body: { expects: all } }, { verb: 'reject-all', body: { expects: all } }])
  assert.ok(!('m3' in actions[0].body.expects), 'a write without an expect is left out, so the backend leaves it pending')
  assert.equal(actions[0].body.expects.m1, EXPECT_M1, 'the same object, not a copy or a rebuild')
  assert.equal(actions[0].body.expects.m2, EXPECT_M2)
  assert.equal(readyWrites(API_DIFF), 2)
})
test('a decision POSTs its expects to the file URL', async () => {
  host.reset()
  const qc = fakeQueryClient()
  const { calls, rest } = fakeRest({ results: [{ id: 'm1', status: 'applied' }], file_gone: false })
  await performAction({ action: { verb: 'accept-all', body: { expects: { m1: EXPECT_M1 } } }, file: MEMORY_FILE, queryClient: qc, rest, t })
  assert.deepEqual(calls.at(-1).body, { expects: { m1: EXPECT_M1 } })
  assert.equal(calls.at(-1).path, `/files/dev/memory/${MEMORY_FILE.key}/accept-all`)
})
test('a file view on a Hermes without the write review API shows its one message', () => {
  const view = expand(FileDetailView({
    busy: false, confirmOpen: false, data: { status: 'unavailable', message: 'needs the API' }, file: MEMORY_FILE,
    onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t
  }))
  assert.ok(walk(view).some(n => n.props?.description === 'needs the API'))
  assert.equal(blocks(view).length, 0)
})

// --- file header, confirmation ----------------------------------------------------------------

test('a one-change file says Accept and Reject; Reject comes first, as in the mockup', () => {
  const one = { ...MEMORY_FILE, counts: { ...MEMORY_FILE.counts, total: 1 } }
  const header = expand(FileHeader({ acceptable: 1, busy: false, file: one, onAcceptAll() {}, onRejectAll() {}, t }))
  assert.deepEqual(buttons(header).map(b => b.props.children), ['reject', 'accept'])
  const many = expand(FileHeader({ acceptable: 1, busy: false, file: SKILL_FILE, onAcceptAll() {}, onRejectAll() {}, t }))
  assert.deepEqual(buttons(many).map(b => b.props.children), ['rejectAll', 'acceptAll'])
})

test('the file header has Accept all and Reject all; Reject all only asks for confirmation', () => {
  const asked = []
  const actions = []
  const view = expand(FileDetailView({
    busy: false, confirmOpen: false, data: SKILL_DIFF, file: SKILL_FILE, onAction: a => actions.push(a),
    onAskRejectAll: () => asked.push(true), onCloseConfirm() {}, prior: null, t
  }))
  assert.match(text(view), /council\/SKILL\.md/)
  button(view, 'acceptAll').props.onClick()
  assert.deepEqual(actions, [{ verb: 'accept-all', body: { expects: {} } }])
  button(view, 'rejectAll').props.onClick()
  assert.deepEqual(asked, [true])
  assert.deepEqual(actions, [{ verb: 'accept-all', body: { expects: {} } }], 'Reject all does not call the backend by itself')
  const dialog = walk(view).find(n => n.props?.destructive === true)
  assert.equal(dialog.props.open, false)
  const open = expand(FileDetailView({
    busy: false, confirmOpen: true, data: SKILL_DIFF, file: SKILL_FILE, onAction: a => actions.push(a),
    onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t
  }))
  const confirm = walk(open).find(n => n.props?.destructive === true)
  assert.equal(confirm.props.open, true)
  assert.match(confirm.props.description, /rejectAllBody:3,council\/SKILL\.md/)
  assert.equal(confirm.props.title, 'rejectAllTitle')
  assert.equal(messages.en.rejectAllBody(1, 'MEMORY.md'), 'The proposed change to MEMORY.md is discarded. Hermes can propose it again.')
  assert.equal(messages.en.rejectAllBody(2, 'MEMORY.md'), 'All 2 proposed changes to MEMORY.md are discarded. Hermes can propose them again.')
  const one = { ...CREATE_DIFF, writes: { c1: { expect: EXPECT_M1, status: 'ready', reason: null, op_count: 1 } } }
  const single = expand(FileDetailView({ busy: false, confirmOpen: true, data: one, file: NEW_SKILL_FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }))
  const ask = walk(single).find(n => n.props?.destructive === true)
  assert.deepEqual([ask.props.title, ask.props.confirmLabel], ['rejectOneTitle', 'reject'])
  confirm.props.onConfirm()
  assert.deepEqual(actions.at(-1), { verb: 'reject-all', body: { expects: {} } })
})

test('Accept all is disabled when no shown write is ready', () => {
  const onlyStale = { ...API_DIFF, writes: { m3: API_DIFF.writes.m3, m4: { expect: {}, status: 'stale', reason: 'moved', op_count: 1 } } }
  const header = FileHeader({ acceptable: 0, busy: false, file: SKILL_FILE, onAcceptAll() {}, onRejectAll() {}, t })
  assert.equal(button(header, 'acceptAll').props.disabled, true)
  const view = expand(FileDetailView({ busy: false, confirmOpen: false, data: onlyStale, file: MEMORY_FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }))
  assert.equal(button(view, 'acceptAll').props.disabled, true)
  const ready = expand(FileDetailView({ busy: false, confirmOpen: false, data: API_DIFF, file: MEMORY_FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }))
  assert.equal(button(ready, 'acceptAll').props.disabled, false)
  assert.equal(button(view, 'rejectAll').props.disabled, false)
})

test('the detail view shows loading, error and gone states', () => {
  const base = { busy: false, confirmOpen: false, file: MEMORY_FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }
  // Loading is a skeleton in the diff box's place, with the file's header already filled in.
  const loading = expand(FileDetailView({ ...base, data: undefined, loading: true }))
  assert.ok(walk(loading).some(n => n.props?.role === 'status' && n.props['aria-busy'] === true && n.props['aria-label'] === 'loadingDiff'))
  assert.match(text(loading), /MEMORY\.md/)
  const failed = expand(FileDetailView({ ...base, data: undefined, error: new Error('500 boom') }))
  assert.ok(walk(failed).some(n => n.props?.title === 'diffError' && /500 boom/.test(n.props.description)))
  assert.match(text(expand(FileDetailView({ ...base, data: GONE }))), /fileGone/)
})

// --- actions, refetch, file gone --------------------------------------------------------------

test('when the backend says file_gone, the view returns to the list', async () => {
  host.reset()
  const qc = fakeQueryClient()
  const { rest } = fakeRest({ results: [{ id: 'c1', status: 'applied' }], file_gone: true })
  $selection.set(fileKey(NEW_SKILL_FILE))
  await performAction({ action: { verb: 'accept-all', body: { expects: {} } }, file: NEW_SKILL_FILE, queryClient: qc, rest, t })
  assert.equal($selection.get(), null)
  assert.ok(qc.invalidated.some(k => k[1] === 'files'), 'the list refetches')
})

test('a conflict keeps the file open and reports Hermes\'s reason', async () => {
  host.reset()
  const qc = fakeQueryClient()
  const { rest } = fakeRest({ results: [{ id: 'p1', kind: 'skills', status: 'conflict', reason: 'Security scan blocked this skill' }], file_gone: false })
  $selection.set(fileKey(SKILL_FILE))
  await performAction({ action: { verb: 'accept-all', body: { expects: {} } }, file: SKILL_FILE, queryClient: qc, rest, t })
  const toast = host.toasts.at(-1)
  assert.equal(toast.kind, 'error')
  assert.match(toast.detail, /p1: statusConflict:Security scan blocked this skill\./)
  assert.equal($selection.get(), fileKey(SKILL_FILE))
  assert.deepEqual(qc.invalidated[0], diffKey(SKILL_FILE), 'still refetched, the file may have changed')
})
test('accept-all and reject-all POST to the file URL and summarise the results', async () => {
  host.reset()
  const qc = fakeQueryClient()
  const { calls, rest } = fakeRest(path => ({
    results: path.endsWith('accept-all')
      ? [{ id: 'p1', status: 'applied' }, { id: 'p2', status: 'conflict', reason: 'overlaps p1' }]
      : [{ id: 'p1', status: 'rejected' }, { id: 'p3', status: 'rejected' }]
  }))
  await performAction({ action: { verb: 'accept-all' }, file: SKILL_FILE, queryClient: qc, rest, t })
  await performAction({ action: { verb: 'reject-all' }, file: SKILL_FILE, queryClient: qc, rest, t })
  assert.deepEqual(calls.map(c => [c.method, c.path]), [
    ['POST', `/files/dev/skills/${SKILL_FILE.key}/accept-all`],
    ['POST', `/files/dev/skills/${SKILL_FILE.key}/reject-all`]
  ])
  assert.equal(host.toasts[0].kind, 'error', 'a partial failure is an error toast')
  assert.match(host.toasts[0].message, /bulkAccepted:1,2/)
  assert.match(host.toasts[0].detail, /p2: statusConflict:overlaps p1\./)
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

test('actionToast covers every bulk outcome', () => {
  const file = USER_FILE
  assert.equal(actionToast({ verb: 'accept-all' }, { results: [{ id: 'a', status: 'applied' }] }, file, t).kind, 'success')
  assert.equal(actionToast({ verb: 'reject-all' }, { results: [{ id: 'a', status: 'rejected' }] }, file, t).kind, 'info')
  assert.equal(actionToast({ verb: 'accept-all' }, { results: [{ id: 'a', status: 'already_resolved', prior: 'applied' }] }, file, t).kind, 'info')
  assert.equal(actionToast({ verb: 'accept-all' }, { results: [{ id: 'a', status: 'stale', reason: 'moved' }] }, file, t).kind, 'info')
  assert.equal(actionToast({ verb: 'accept-all' }, { results: [{ id: 'a', status: 'unseen' }] }, file, t).kind, 'info')
  assert.equal(actionToast({ verb: 'accept-all' }, { results: [{ id: 'a', status: 'conflict', reason: 'x' }] }, file, t).kind, 'error')
  assert.equal(actionToast({ verb: 'accept-all' }, { results: [{ id: 'a', kind: 'memory', status: 'needs_review', reason: 'x' }] }, file, t).kind, 'error')
  assert.equal(actionToast({ verb: 'accept-all' }, { results: [] }, file, t).kind, 'info')
  const off = actionToast({ verb: 'accept-all' }, { status: 'unavailable', message: 'needs the API', results: [] }, file, t)
  assert.deepEqual(off, { kind: 'error', message: 'needs the API' })
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
  const row = rowsOf(expand(FileDiffView({ prior: null, segments: [seg], t })))[0]
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
