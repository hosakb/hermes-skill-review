import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate(path) { this.navigated = path },
  notify(toast) { this.toasts.push(toast) },
  notifyError() {},
  openWorkspace() { this.workspaceOpens += 1; return () => {} },
  revealPane(id) { this.revealed.push(id) },
  undismissPane(id) { this.undismissed.push(id) },
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = []; this.revealed = []; this.undismissed = []; this.workspaceOpens = 0; this.navigated = null }
}
host.reset()
globalThis.__host = host
// The background watcher reads through the shared React Query client; the test feeds it pending lists.
globalThis.__queryClient = {
  data: { items: [] },
  fail: false,
  fetchQuery({ queryKey, queryFn }) {
    this.lastKey = queryKey
    this.lastFn = queryFn
    return this.fail ? Promise.reject(new Error('404')) : Promise.resolve(this.data)
  }
}
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  parseSection, planAutoOpen, visibleItems, itemKey, resultToast, openReview, countBySubsystem, pendingPath,
  messages, STYLES, DiffRow, DiffView, DetailHeader, ListRow, $selection, nextKeyAfter, LIST_PANE, DETAIL_PANE
} = mod
const plugin = mod.default
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)

// --- tiny tree helpers over the jsx() stub ({ type, props, key }) ------------------------------
const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const find = (node, pred) => walk(node).find(pred)
const styleHas = (style, expected) => Object.entries(expected).every(([k, v]) => style?.[k] === v)

function fakeCtx() {
  const timers = []
  const store = {}
  const ctx = {
    disposers: [],
    registered: [],
    i18n: { register: bundle => { ctx.bundle = bundle }, t },
    onDispose: fn => ctx.disposers.push(fn),
    registerMany: list => ctx.registered.push(...list),
    register: c => { ctx.registered.push(c); return () => {} },
    rest: async path => ({ path }),
    setInterval: (fn, ms) => { timers.push({ fn, ms, every: true }); return () => {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, every: false }); return () => {} },
    storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } },
    store,
    timers
  }
  return ctx
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const dispose = ctx => ctx.disposers.forEach(fn => fn())

// --- contract and layout ----------------------------------------------------------------------

test('default export has the contract fields', () => {
  assert.equal(plugin.id, 'skill-review')
  assert.equal(typeof plugin.register, 'function')
})

test('register adds a list pane and a detail pane docked to its right, no route by default', () => {
  host.reset()
  const ctx = fakeCtx()
  plugin.register(ctx)
  const panes = ctx.registered.filter(c => c.area === 'panes')
  assert.deepEqual(panes.map(p => p.id), ['list', 'detail'])
  assert.equal(LIST_PANE, 'skill-review:list')
  assert.equal(DETAIL_PANE, 'skill-review:detail')
  const [list, detail] = panes
  assert.deepEqual(list.data.dock, { pane: 'workspace', pos: 'right' }, 'list splits the workspace right edge')
  assert.equal(list.data.placement, 'main')
  assert.match(list.data.width, /^(2[89]\d|3[0-2]\d)px$/, 'list is a ~280-320px fixed track')
  assert.deepEqual(detail.data.dock, { pane: LIST_PANE, pos: 'right' }, 'detail sits in its own column beside the list')
  assert.equal(typeof list.render, 'function')
  assert.equal(typeof detail.render, 'function')
  assert.ok(!ctx.registered.some(c => c.area === 'routes'), 'no route when the desktop has the pane APIs')
  assert.ok(ctx.registered.some(c => c.area === 'statusBar.right'))
  assert.ok(ctx.registered.some(c => c.area === 'palette'))
  assert.equal(host.workspaceOpens, 0, 'register never takes over the main view')
  dispose(ctx)
})

test('old desktops without openWorkspace get the route page as the only fallback', () => {
  host.reset()
  const saved = host.openWorkspace
  host.openWorkspace = undefined
  const ctx = fakeCtx()
  plugin.register(ctx)
  assert.equal(ctx.registered.find(c => c.area === 'routes')?.data.path, '/skill-review')
  openReview()
  assert.equal(host.navigated, '/skill-review')
  host.openWorkspace = saved
  dispose(ctx)
})

test('openReview reveals both panes and never opens a workspace tab', () => {
  host.reset()
  const ctx = fakeCtx()
  plugin.register(ctx)
  openReview()
  assert.deepEqual(host.revealed, [LIST_PANE, DETAIL_PANE])
  assert.deepEqual(host.undismissed, [LIST_PANE, DETAIL_PANE], 'a closed pane comes back')
  assert.equal(host.workspaceOpens, 0)
  assert.equal(host.navigated, null)
  dispose(ctx)
})

// --- watcher ----------------------------------------------------------------------------------

test('the watcher polls from register() and only toasts, with an action that reveals the item', async () => {
  host.reset()
  const qc = globalThis.__queryClient
  const ctx = fakeCtx()
  qc.data = { items: [] }
  plugin.register(ctx)
  const interval = ctx.timers.find(x => x.every)
  assert.ok(interval && interval.ms >= 2000 && interval.ms <= 10000, 'polls every few seconds')
  assert.ok(ctx.timers.some(x => !x.every), 'first check runs soon after load')

  interval.fn(); await flush()
  assert.deepEqual(qc.lastKey, ['skill-review', 'pending', 'default'], 'shares the pane query key')
  assert.deepEqual(await qc.lastFn(), { path: '/pending' })
  assert.equal(host.toasts.length, 0)

  const council = { subsystem: 'skills', profile: 'default', id: '3e0b9dba' }
  qc.data = { items: [council] }
  interval.fn(); await flush()
  assert.equal(host.toasts.length, 1, 'a new item is announced once')
  assert.equal(host.workspaceOpens, 0, 'never takes over the main view')
  assert.deepEqual(host.revealed, [], 'never steals focus by itself')
  const toast = host.toasts[0]
  assert.equal(toast.message, 'newPending:1')
  assert.equal(typeof toast.action?.onClick, 'function')
  toast.action.onClick()
  assert.deepEqual(host.revealed, [LIST_PANE, DETAIL_PANE])
  assert.equal($selection.get(), itemKey(council), 'the toast action selects the new item')

  interval.fn(); await flush()
  assert.equal(host.toasts.length, 1, 'the same item is never announced again')
  qc.data.items = [...qc.data.items, { subsystem: 'memory', profile: 'dev', id: 'aa11' }]
  interval.fn(); await flush()
  assert.equal(host.toasts.length, 2, 'a further new item is announced')

  qc.fail = true
  interval.fn(); await flush()
  assert.equal(host.toasts.length, 2, 'a failing backend neither throws nor toasts')
  qc.fail = false
  dispose(ctx)
})

test('items seen in an earlier session are not announced again after a restart', async () => {
  host.reset()
  const qc = globalThis.__queryClient
  const ctx = fakeCtx()
  ctx.store.announced = ['skills/default/3e0b9dba']
  qc.data = { items: [{ subsystem: 'skills', profile: 'default', id: '3e0b9dba' }] }
  plugin.register(ctx)
  ctx.timers.find(x => x.every).fn(); await flush()
  assert.equal(host.toasts.length, 0)
  dispose(ctx)
})

// --- selection --------------------------------------------------------------------------------

test('selection is a module-level atom, so it survives pane remounts', () => {
  $selection.set('skills/dev/a1')
  assert.equal($selection.get(), 'skills/dev/a1')
  $selection.set(null)
})

test('nextKeyAfter picks the following item, else the previous, else null', () => {
  const items = ['a', 'b', 'c'].map(id => ({ subsystem: 'skills', profile: 'dev', id }))
  assert.equal(nextKeyAfter(items, 'skills/dev/b'), 'skills/dev/c')
  assert.equal(nextKeyAfter(items, 'skills/dev/c'), 'skills/dev/b')
  assert.equal(nextKeyAfter(items.slice(0, 1), 'skills/dev/a'), null)
  assert.equal(nextKeyAfter(items, 'skills/dev/zzz'), 'skills/dev/a')
})

test('ListRow highlights the selected item and selects on click', () => {
  const item = { subsystem: 'skills', profile: 'default', id: '3e0b9dba', subject: 'council', action: 'batch', created_at: 1 }
  let picked = null
  const on = ListRow({ item, selected: true, onSelect: k => { picked = k }, t })
  const off = ListRow({ item, selected: false, onSelect: () => {}, t })
  assert.equal(on.props['aria-current'], true)
  assert.equal(off.props['aria-current'], false)
  assert.notDeepEqual(on.props.style, off.props.style, 'selected row is visually distinct')
  assert.equal(on.props.style.borderLeft, '2px solid var(--ui-accent)')
  assert.ok(styleHas(on.props.style, { minWidth: 0, width: '100%' }))
  on.props.onClick()
  assert.equal(picked, itemKey(item))
  const title = find(on, n => n.props?.children === 'council')
  assert.ok(styleHas(title.props.style, { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
    'long names are truncated, never widen the list')
})

// --- overflow: style objects ------------------------------------------------------------------

test('pane roots are clipped flex columns that let children shrink', () => {
  assert.ok(styleHas(STYLES.paneRoot, {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden'
  }))
})

test('list and detail bodies are independent vertical scroll regions', () => {
  for (const key of ['listScroll', 'detailScroll']) {
    assert.ok(styleHas(STYLES[key], { flex: '1 1 auto', minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }), key)
  }
})

test('the diff box scrolls horizontally as a last resort and never widens its parent', () => {
  assert.ok(styleHas(STYLES.diffBox, { overflowX: 'auto', minWidth: 0, maxWidth: '100%' }))
  assert.equal(STYLES.diffBox.boxSizing, 'border-box', 'its border stays inside the pane')
})

test('diff rows are a grid: fixed gutters, a shrinkable wrapping text column', () => {
  assert.ok(styleHas(STYLES.row, { display: 'grid', minWidth: 0 }))
  assert.match(STYLES.row.gridTemplateColumns, /^\d+(\.\d+)?ch \d+(\.\d+)?ch \d+(\.\d+)?ch minmax\(0, 1fr\)$/)
  for (const key of ['gutter', 'sign']) {
    assert.equal(STYLES[key].whiteSpace, 'nowrap', key)
    assert.equal(STYLES[key].userSelect, 'none', key)
  }
  assert.equal(STYLES.gutter.textAlign, 'right')
  assert.ok(styleHas(STYLES.rowText, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }))
})

test('a 400-character single line renders as one wrapping row, text under the text column', () => {
  const long = 'Runs several independent subagents, each with a different review lens. '.repeat(6).slice(0, 400)
  assert.equal(long.length, 400)
  const row = DiffRow({ row: { kind: 'add', text: long, newNo: 16 }, t })
  assert.ok(styleHas(row.props.style, { display: 'grid', minWidth: 0 }))
  const cells = kids(row)
  assert.equal(cells.length, 4, 'old no, new no, sign, text')
  assert.deepEqual(cells.slice(0, 3).map(c => c.props.style), [STYLES.gutter, STYLES.gutter, STYLES.sign])
  assert.equal(cells[3].props.children, long, 'the whole line is rendered, nothing cut')
  assert.ok(styleHas(cells[3].props.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 }))
  assert.equal(row.props.style.background, 'var(--ui-diff-add-background)')
})

test('a new-file diff box carries the guarded box style and no max-content sizing anywhere', () => {
  const tree = DiffView({ sections: [{ title: '', kind: 'create', text: 'x'.repeat(400) + '\nshort\n' }], newFileLabel: 'New file', t })
  const box = find(tree, n => n.props?.style === STYLES.diffBox)
  assert.ok(box, 'diff box uses STYLES.diffBox')
  for (const node of walk(tree)) {
    const s = node.props?.style
    if (!s) continue
    assert.notEqual(s.minWidth, 'max-content')
    assert.notEqual(s.width, 'max-content')
    assert.notEqual(s.whiteSpace, 'pre', 'no unwrapped text anywhere')
  }
})

test('detail header and summary keep horizontal padding off the pane edge', () => {
  assert.equal(STYLES.header.paddingLeft, '0.75rem')
  assert.equal(STYLES.header.paddingRight, '0.75rem')
  assert.equal(STYLES.summary.paddingLeft, '0.75rem')
  assert.equal(STYLES.summary.paddingRight, '0.75rem')
  assert.ok(styleHas(STYLES.header, { display: 'flex', flexWrap: 'wrap', minWidth: 0 }))
  const item = { subsystem: 'skills', profile: 'default', id: '3e0b9dba', subject: 'council', action: 'batch',
    origin: 'assistant_tool', created_at: 1, summary: 'batch(1 ops: create) on council' }
  let accepted = 0, rejected = 0
  const header = DetailHeader({ item, busy: false, onAccept: () => { accepted += 1 }, onReject: () => { rejected += 1 }, t })
  assert.equal(header.props.style, STYLES.headerWrap)
  const [row, summary] = kids(header)
  assert.equal(row.props.style, STYLES.header, 'title row carries its own padding')
  assert.equal(summary.props.children, 'batch(1 ops: create) on council')
  assert.equal(summary.props.style, STYLES.summary, 'summary is a sibling of the row, padded once, not nested in it')
  assert.equal(STYLES.headerWrap.paddingLeft, undefined, 'no double indent from the wrapper')
  const buttons = walk(header).filter(n => typeof n.props?.onClick === 'function')
  buttons.find(b => b.props.children === 'accept').props.onClick()
  buttons.find(b => b.props.children === 'reject').props.onClick()
  assert.deepEqual([accepted, rejected], [1, 1])
  const disabled = DetailHeader({ item, busy: true, onAccept() {}, onReject() {}, t })
  assert.ok(walk(disabled).filter(n => n.props?.children === 'accept' || n.props?.children === 'reject')
    .every(b => b.props.disabled === true), 'buttons disable while a request runs')
})

// --- pure helpers (unchanged behaviour) -------------------------------------------------------

test('planAutoOpen announces only keys that are new', () => {
  const a = { subsystem: 'skills', profile: 'dev', id: 'a1' }
  const b = { subsystem: 'skills', profile: 'ops', id: 'a1' }
  const c = { subsystem: 'memory', profile: 'dev', id: 'a1' }
  let r = planAutoOpen([a], [])
  assert.deepEqual(r.fresh, ['skills/dev/a1'])
  assert.deepEqual(planAutoOpen([a], r.keep).fresh, [])
  r = planAutoOpen([a, b, c], r.keep)
  assert.deepEqual(r.fresh, ['skills/ops/a1', 'memory/dev/a1'])
  assert.deepEqual(planAutoOpen([b], r.keep).keep, ['skills/ops/a1'])
})

test('visibleItems filters by focused profile and by subsystem', () => {
  const items = [
    { subsystem: 'skills', profile: 'dev', id: '1' },
    { subsystem: 'memory', profile: 'dev', id: '2' },
    { subsystem: 'memory', profile: 'ops', id: '3' }
  ]
  assert.deepEqual(visibleItems(items, 'focused', 'dev').map(i => i.id), ['1', '2'])
  assert.deepEqual(visibleItems(items, 'all', 'dev', 'memory').map(i => i.id), ['2', '3'])
  assert.deepEqual(visibleItems(items, 'focused', 'dev', 'skills').map(i => i.id), ['1'])
})

test('countBySubsystem and pendingPath', () => {
  assert.deepEqual(countBySubsystem([{ subsystem: 'skills' }, { subsystem: 'memory' }, { subsystem: 'memory' }]),
    { all: 3, memory: 2, skills: 1 })
  assert.equal(pendingPath({ subsystem: 'memory', profile: 'dev', id: 'a/b' }, 'accept'), '/pending/memory/dev/a%2Fb/accept')
})

test('every action the backend can report has a label', () => {
  for (const action of ['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file', 'batch', 'add', 'remove', 'replace', 'unknown']) {
    assert.ok(messages.en[`action_${action}`], action)
  }
})

test('parseSection: create, delete, unified diff, header lookalikes, notes', () => {
  assert.deepEqual(parseSection({ kind: 'create', text: 'a\nb\n' }).map(r => [r.kind, r.newNo]), [['add', 1], ['add', 2]])
  assert.deepEqual(parseSection({ kind: 'delete', text: "delete skill 'x'" }), [{ kind: 'remove', text: "delete skill 'x'" }])
  const d = parseSection({ kind: 'diff', text: '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n--- not a header\n+++ also not\n same\n' })
  assert.deepEqual(d.map(r => r.kind), ['file', 'hunk', 'remove', 'add', 'context'])
  assert.deepEqual(parseSection({ kind: 'diff', text: '(patch would fail: no match)' }).map(r => r.kind), ['note'])
})

test('resultToast maps every backend status and keeps a scan report', () => {
  assert.equal(resultToast('accept', { status: 'applied', item: { subject: 's' } }, t).kind, 'success')
  assert.equal(resultToast('accept', { status: 'already_handled' }, t).kind, 'info')
  const scan = 'Security scan blocked this skill (dangerous findings):\n  - exfiltration'
  const r = resultToast('accept', { status: 'failed', error: scan }, t)
  assert.equal(r.kind, 'error')
  assert.equal(r.detail, scan)
})

test('source: no hardcoded colours, only allowed imports, no workspace takeover, no Radix table wrapper', () => {
  const src = readFileSync(pluginPath, 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, 'hex colour')
  assert.doesNotMatch(code, /\b(?:rgb|rgba|hsl|hsla|oklch)\(/, 'colour function')
  const specs = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
  assert.deepEqual([...new Set(specs)].sort(), ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
  assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|WebSocket|window\./)
  assert.doesNotMatch(code, /host\.openWorkspace\(/, 'openWorkspace is only feature-detected, never called')
  assert.doesNotMatch(code, /\bScrollArea\b/, "Radix ScrollArea's display:table wrapper lets wide lines escape")
  assert.doesNotMatch(code, /max-content/)
})
