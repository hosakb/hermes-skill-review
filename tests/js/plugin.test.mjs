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
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = []; this.navigated = null }
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
  parseSection, planAutoOpen, itemKey, resultToast, statusText, openReview, countBySubsystem,
  messages, STYLES, DiffRow, $selection, ReviewPage, notePageMount
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

test('register adds the page and its sidebar row, never a pane, and moves nobody', () => {
  host.reset()
  const ctx = fakeCtx()
  plugin.register(ctx)
  assert.deepEqual(ctx.registered.filter(c => c.area === 'panes'), [], 'no layout pane at all')
  const route = ctx.registered.find(c => c.area === 'routes')
  assert.equal(route.data.path, '/skill-review')
  assert.equal(route.render().type, ReviewPage)
  assert.equal(ctx.registered.find(c => c.area === 'sidebar.nav').data.path, '/skill-review')
  assert.ok(ctx.registered.some(c => c.area === 'statusBar.right'))
  assert.ok(ctx.registered.some(c => c.area === 'palette'))
  assert.equal(host.navigated, null, 'register never takes over the main view')
  dispose(ctx)
})

test('openReview navigates to the page and registers nothing', () => {
  host.reset()
  const ctx = fakeCtx()
  plugin.register(ctx)
  const before = ctx.registered.length
  openReview()
  assert.equal(host.navigated, '/skill-review')
  assert.equal(ctx.registered.length, before)
  dispose(ctx)
})

// --- watcher ----------------------------------------------------------------------------------

test('the watcher polls from register() and only toasts, with an action that opens the page', async () => {
  host.reset()
  const qc = globalThis.__queryClient
  const ctx = fakeCtx()
  qc.data = { items: [] }
  plugin.register(ctx)
  const interval = ctx.timers.find(x => x.every)
  assert.ok(interval && interval.ms >= 2000 && interval.ms <= 10000, 'polls every few seconds')
  assert.ok(ctx.timers.some(x => !x.every), 'first check runs soon after load')

  interval.fn(); await flush()
  assert.deepEqual(qc.lastKey, ['skill-review', 'pending', 'default'], 'shares the page query key')
  assert.deepEqual(await qc.lastFn(), { path: '/pending' })
  assert.equal(host.toasts.length, 0)

  const council = { subsystem: 'skills', profile: 'default', id: '3e0b9dba' }
  qc.data = { items: [council] }
  interval.fn(); await flush()
  assert.equal(host.toasts.length, 1, 'a new item is announced once')
  assert.equal(host.navigated, null, 'never takes over the main view by itself')
  const toast = host.toasts[0]
  assert.equal(toast.message, 'newPending:1')
  assert.equal(toast.action?.label, 'open')
  $selection.set(null)
  toast.action.onClick()
  assert.equal(host.navigated, '/skill-review')
  assert.equal($selection.get(), null, 'an item key is not a file key, so the action selects nothing')

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

test('countBySubsystem', () => {
  assert.deepEqual(countBySubsystem([{ subsystem: 'skills' }, { subsystem: 'memory' }, { subsystem: 'memory' }]),
    { all: 3, memory: 2, skills: 1 })
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
  const guard = resultToast('accept', { status: 'conflict', reason: scan }, t)
  assert.equal(guard.kind, 'error')
  assert.equal(guard.detail, scan, 'a Skills Guard refusal from decide_write keeps its full report')
})

// --- every status of the write review API, in the words the user reads --------------------------

const tEn = (k, ...a) => (typeof messages.en[k] === 'function' ? messages.en[k](...a) : messages.en[k])

test('statusText: one plain message per decide_write status and per backend status', () => {
  const cases = [
    [{ status: 'applied' }, 'Accepted.'],
    [{ status: 'rejected' }, 'Rejected.'],
    [{ status: 'rejected', warning: 'The files may be partly changed' }, 'Rejected. The files may be partly changed.'],
    [{ status: 'already_resolved', prior: 'applied' }, 'Already accepted elsewhere, for example from chat. Nothing changed.'],
    [{ status: 'already_resolved', prior: 'rejected' }, 'Already rejected elsewhere, for example from chat. Nothing changed.'],
    [{ status: 'conflict', reason: 'the pending write changed since it was previewed. Preview it again.' },
      'Not applied: the pending write changed since it was previewed. Preview it again. Nothing was written, and the write is still pending. Look at it again.'],
    [{ status: 'conflict' }, 'Not applied: Hermes refused it. Nothing was written, and the write is still pending. Look at it again.'],
    [{ status: 'needs_review', reason: 'An earlier approval stopped after it began writing', id: 'ab12cd34', kind: 'skills' },
      'Hermes stopped partway through applying this write: An earlier approval stopped after it began writing. Check the files, then run /skills reject ab12cd34 in chat.'],
    [{ status: 'needs_review', id: 'ab12cd34', kind: 'memory' },
      'Hermes stopped partway through applying this write: the files may be partly changed. Check the files, then run /memory reject ab12cd34 in chat.'],
    [{ status: 'stale', reason: 'an entry this write targets changed since it was staged' },
      'Not applied, because it no longer fits the file: an entry this write targets changed since it was staged. Reject it, or ask Hermes for a new change.'],
    [{ status: 'unseen' }, 'Left pending: it was staged after this file was loaded. Look at it first.'],
    [{ status: 'whole_write' }, 'This version decides whole writes only. Hermes accepts or rejects all changes of a write together, so there are no per-change buttons.'],
    [{ status: 'gone' }, 'Already handled, for example from chat.'],
    [{ status: 'unavailable', message: 'needs the API' }, 'needs the API'],
    [{ status: 'unavailable' }, messages.en.needsApi],
    [{ status: 'something new', reason: 'odd' }, 'Change not applied: odd. It stays pending.']
  ]
  for (const [result, expected] of cases) {
    assert.equal(statusText(result, tEn), expected, JSON.stringify(result))
  }
})

test('resultToast: success for applied, info for the quiet outcomes, error for refusals', () => {
  const kinds = Object.fromEntries(['applied', 'rejected', 'already_resolved', 'conflict', 'needs_review', 'stale', 'unseen',
    'whole_write', 'gone', 'unavailable'].map(status => [status, resultToast('accept', { status, reason: 'r' }, tEn).kind]))
  assert.deepEqual(kinds, {
    applied: 'success', rejected: 'info', already_resolved: 'info', conflict: 'error', needs_review: 'error', stale: 'info',
    unseen: 'info', whole_write: 'info', gone: 'info', unavailable: 'error'
  })
  assert.equal(resultToast('accept', { status: 'applied', item: { subject: 'MEMORY.md' } }, tEn).message, 'Accepted change to MEMORY.md')
  assert.equal(resultToast('reject', { status: 'rejected', item: { subject: 'MEMORY.md' } }, tEn).message, 'Rejected change to MEMORY.md')
})

test('the missing-API message says a newer Hermes is needed and names the module', () => {
  assert.equal(messages.en.needsApi, 'This version of Skill Review needs a newer Hermes, one with the public write review API ' +
    '(tools.write_review_api). Update Hermes to review staged writes here. Library still opens files and saves identity files.')
  assert.equal(messages.en.needsApiTitle, 'Needs a newer Hermes')
  assert.doesNotMatch(messages.en.needsApi + messages.en.needsApiTitle, /\u2014/)
})

test('source: no hardcoded colours, only allowed imports, no workspace takeover, no Radix table wrapper', () => {
  const src = readFileSync(pluginPath, 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, 'hex colour')
  assert.doesNotMatch(code, /\b(?:rgb|rgba|hsl|hsla|oklch)\(/, 'colour function')
  const specs = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
  assert.deepEqual([...new Set(specs)].sort(), ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
  assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|WebSocket|window\./)
  assert.doesNotMatch(code, /openWorkspace|revealPane|undismissPane/, 'the page needs no pane API')
  assert.doesNotMatch(code, /\bScrollArea\b/, "Radix ScrollArea's display:table wrapper lets wide lines escape")
  assert.doesNotMatch(code, /max-content/)
})

// --- notification mode: popup or light up the status bar chip ---------------------------------

const {
  $notifyMode, $lit, setNotifyMode, markSeen, hasUnseen, ReviewChip, NotifyModeSwitch, CHIP_STYLES, NOTIFY_MODES
} = mod
const nowSec = () => Date.now() / 1000
const tick = async ctx => { ctx.timers.find(x => x.every).fn(); await flush() }

test('notifyMode defaults to popup and only accepts popup or light', () => {
  host.reset()
  const ctx = fakeCtx()
  plugin.register(ctx)
  assert.deepEqual(NOTIFY_MODES, ['popup', 'light'])
  assert.equal($notifyMode.get(), 'popup')
  setNotifyMode('bogus')
  assert.equal($notifyMode.get(), 'popup', 'an unknown value is ignored')
  assert.equal(ctx.store.notifyMode, undefined)
  dispose(ctx)
  const bad = fakeCtx()
  bad.store.notifyMode = 'banner'
  plugin.register(bad)
  assert.equal($notifyMode.get(), 'popup', 'a corrupt stored value falls back to popup')
  dispose(bad)
})

test('popup mode: a new change toasts exactly once, with an Open action that only opens the page', async () => {
  host.reset()
  const qc = globalThis.__queryClient
  const ctx = fakeCtx()
  qc.data = { items: [] }
  plugin.register(ctx)
  await tick(ctx) // the first poll only records
  const item = { subsystem: 'skills', profile: 'default', id: 'p1', created_at: nowSec() + 5 }
  qc.data = { items: [item] }
  await tick(ctx)
  await tick(ctx)
  assert.equal(host.toasts.length, 1, 'announced once, never repeated')
  assert.equal(host.toasts[0].action.label, 'open')
  assert.equal($lit.get(), false, 'popup mode never lights the chip')
  assert.equal(host.navigated, null, 'nothing moves until the user clicks Open')
  host.toasts[0].action.onClick()
  assert.equal(host.navigated, '/skill-review')
  dispose(ctx)
})

test('light mode: a new change does not toast and lights the chip', async () => {
  host.reset()
  const qc = globalThis.__queryClient
  const ctx = fakeCtx()
  ctx.store.notifyMode = 'light'
  ctx.store.lastSeenAt = Date.now() - 60_000
  qc.data = { items: [] }
  plugin.register(ctx)
  assert.equal($notifyMode.get(), 'light')
  await tick(ctx)
  assert.equal($lit.get(), false, 'nothing pending, nothing lit')
  qc.data = { items: [{ subsystem: 'memory', profile: 'default', id: 'l1', created_at: nowSec() }] }
  await tick(ctx)
  assert.equal(host.toasts.length, 0)
  assert.equal($lit.get(), true)
  assert.deepEqual(ctx.store.announced, ['memory/default/l1'], 'still recorded, so popup mode will not replay it')
  dispose(ctx)
})

test('opening the review page clears the lit chip and stores lastSeenAt', async () => {
  host.reset()
  const qc = globalThis.__queryClient
  const ctx = fakeCtx()
  ctx.store.notifyMode = 'light'
  plugin.register(ctx)
  qc.data = { items: [{ subsystem: 'skills', profile: 'default', id: 's1', created_at: nowSec() - 1 }] }
  await tick(ctx)
  assert.equal($lit.get(), true, 'never seen (lastSeenAt 0) counts as unseen')
  const before = Date.now()
  openReview()
  assert.equal($lit.get(), false)
  assert.ok(ctx.store.lastSeenAt >= before && ctx.store.lastSeenAt <= Date.now(), 'lastSeenAt is now')
  await tick(ctx)
  assert.equal($lit.get(), false, 'the same change stays seen on the next poll')
  qc.data = { items: [...qc.data.items, { subsystem: 'skills', profile: 'default', id: 's2', created_at: nowSec() + 2 }] }
  await tick(ctx)
  assert.equal($lit.get(), true, 'a change staged after the last look lights it again')
  dispose(ctx)
})

test('a mounted page counts as seen, so the chip does not light while the user is looking', async () => {
  host.reset()
  const qc = globalThis.__queryClient
  const ctx = fakeCtx()
  ctx.store.notifyMode = 'light'
  plugin.register(ctx)
  qc.data = { items: [{ subsystem: 'skills', profile: 'default', id: 'v1', created_at: nowSec() - 1 }] }
  await tick(ctx)
  assert.equal($lit.get(), true)
  const realNow = Date.now
  const T = realNow()
  Date.now = () => T
  const unmount = notePageMount()
  assert.equal($lit.get(), false, 'the page mounting marks everything seen')
  assert.equal(ctx.store.lastSeenAt, T)
  qc.data = { items: [...qc.data.items, { subsystem: 'skills', profile: 'default', id: 'v2', created_at: (T + 1000) / 1000 }] }
  Date.now = () => T + 2000
  await tick(ctx)
  Date.now = realNow
  assert.equal($lit.get(), false, 'still on the page: a change staged after the last look is seen as it lands')
  unmount()
  qc.data = { items: [...qc.data.items, { subsystem: 'skills', profile: 'default', id: 'v3', created_at: nowSec() + 5 }] }
  await tick(ctx)
  assert.equal($lit.get(), true, 'off the page: the next change lights the chip')
  dispose(ctx)
})

test('the mode persists in plugin storage and is read back after a restart', () => {
  host.reset()
  const ctx = fakeCtx()
  plugin.register(ctx)
  setNotifyMode('light')
  assert.equal(ctx.store.notifyMode, 'light')
  dispose(ctx)
  $notifyMode.set('popup') // simulate a fresh module
  const again = fakeCtx()
  again.store.notifyMode = ctx.store.notifyMode
  plugin.register(again)
  assert.equal($notifyMode.get(), 'light')
  dispose(again)
})

test('switching modes at runtime applies to the next change without a reload', async () => {
  host.reset()
  const qc = globalThis.__queryClient
  const ctx = fakeCtx()
  qc.data = { items: [] }
  plugin.register(ctx)
  await tick(ctx) // the first poll only records
  const a = { subsystem: 'skills', profile: 'default', id: 'r1', created_at: nowSec() - 3 }
  qc.data = { items: [a] }
  await tick(ctx)
  assert.equal(host.toasts.length, 1)
  markSeen()

  setNotifyMode('light')
  qc.data = { items: [a, { subsystem: 'skills', profile: 'default', id: 'r2', created_at: nowSec() + 1 }] }
  await tick(ctx)
  assert.equal(host.toasts.length, 1, 'light mode: no toast')
  assert.equal($lit.get(), true)

  setNotifyMode('popup')
  assert.equal($lit.get(), false, 'leaving light mode turns the light off at once')
  qc.data = { items: [...qc.data.items, { subsystem: 'memory', profile: 'default', id: 'r3', created_at: nowSec() + 2 }] }
  await tick(ctx)
  assert.equal(host.toasts.length, 2, 'popup mode again: the next change toasts')
  assert.equal(host.toasts[1].message, 'newPending:1', 'only the new one, r2 is not replayed')
  dispose(ctx)
})

test('hasUnseen compares staged seconds with lastSeenAt milliseconds', () => {
  assert.equal(hasUnseen([{ created_at: 10 }], 9_000), true)
  assert.equal(hasUnseen([{ created_at: 10 }], 10_000), false)
  assert.equal(hasUnseen([{}], 0), false, 'an item without a staged time never lights')
  assert.equal(hasUnseen(undefined, 0), false)
})

test('chip styles: lit uses the accent variable and a dot, unlit is plain; theme variables only', () => {
  const counts = { skills: 2, memory: 1 }
  const lit = ReviewChip({ count: 3, counts, lit: true, mode: 'light', onOpen() {}, onMode() {}, t })
  const unlit = ReviewChip({ count: 3, counts, lit: false, mode: 'light', onOpen() {}, onMode() {}, t })
  const button = tree => find(tree, n => n.type === 'button')
  const dot = tree => find(tree, n => n.props?.style === CHIP_STYLES.dot)
  assert.equal(button(lit).props.style.color, 'var(--ui-accent)')
  assert.equal(dot(lit).props.style.background, 'var(--ui-accent)')
  assert.equal(dot(lit).props['aria-hidden'], true)
  assert.equal(button(unlit).props.style.color, 'var(--ui-text-secondary)')
  assert.equal(dot(unlit), undefined, 'no dot while nothing is unseen')
  assert.equal(button(lit).props['data-lit'], true)
  assert.equal(button(unlit).props['data-lit'], false)
  assert.match(button(lit).props['aria-label'], /chipUnseen/, 'screen readers hear that it lit up')
  for (const tree of [lit, unlit]) {
    assert.ok(walk(tree).some(n => n.props?.children === 3), 'the count shows in both states')
  }
  const json = JSON.stringify(CHIP_STYLES)
  assert.doesNotMatch(json, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(json, /\b(?:rgb|rgba|hsl|hsla|oklch)\(/)
})

test('chip: click opens the review panes, right-click menu switches the mode', () => {
  let opened = 0
  const picked = []
  const tree = ReviewChip({ count: 1, counts: { skills: 1, memory: 0 }, lit: false, mode: 'popup', onOpen: () => { opened += 1 }, onMode: m => picked.push(m), t })
  find(tree, n => n.type === 'button').props.onClick()
  assert.equal(opened, 1)
  const items = walk(tree).filter(n => typeof n.props?.onCheckedChange === 'function')
  assert.equal(items.length, 2)
  assert.deepEqual(items.map(i => i.props.checked), [true, false])
  items[1].props.onCheckedChange(true)
  assert.deepEqual(picked, ['light'])
  assert.ok(walk(tree).some(n => n.props?.children === 'notifyLabel'), 'the menu says what the choice is about')
})

test('NotifyModeSwitch is a labelled two-option segmented control', () => {
  const changes = []
  const tree = NotifyModeSwitch({ mode: 'light', onChange: m => changes.push(m), t })
  assert.equal(tree.props.role, 'group')
  assert.equal(tree.props['aria-label'], 'notifyLabel')
  const seg = find(tree, n => Array.isArray(n.props?.options))
  assert.equal(seg.props.value, 'light')
  assert.deepEqual(seg.props.options.map(o => [o.id, o.label]), [['popup', 'notifyPopup'], ['light', 'notifyLight']])
  seg.props.onChange('popup')
  assert.deepEqual(changes, ['popup'])
  assert.deepEqual(messages.en.notifyLabel, 'When a new change arrives')
  assert.deepEqual([messages.en.notifyPopup, messages.en.notifyLight], ['Popup', 'Light up icon'])
})

