// Tests for when the review pane appears: never on its own at startup, only on a new change
// (with autoOpen on) or on Review (chip, palette, toast). Also the autoOpen setting and the chip.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

// A host that models the desktop's persisted dismissed set and what is on screen.
const host = {
  navigate(path) { this.navigated = path },
  notify(toast) { this.toasts.push(toast) },
  notifyError() {},
  openWorkspace() { this.workspaceOpens += 1; return () => {} },
  undismissPane(id) { this.calls.push(`undismiss:${id}`); this.dismissed.delete(id) },
  revealPane(id) {
    this.calls.push(`reveal:${id}`)
    this.dismissed.delete(id)
    if (this.registered.has(id)) this.onScreen.add(id)
  },
  state: { profile: { get: () => 'default' } },
  dismissed: new Set(), // survives a simulated restart, like $dismissedPanes
  reset() {
    this.toasts = []; this.calls = []; this.workspaceOpens = 0; this.navigated = null
    this.registered = new Set(); this.onScreen = new Set()
  },
  // The user's X on the pane: Desktop dismisses it and takes it off screen.
  userCloses(id) { this.dismissed.add(id); this.onScreen.delete(id) }
}
host.reset()
globalThis.__host = host
globalThis.__queryClient = {
  data: { items: [] },
  fetchQuery() { return Promise.resolve(this.data) }
}
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $autoOpen, $lit, $notifyMode, $selection, AUTO_OPEN_STYLES, AutoOpenSwitch, LIST_PANE, ReviewChip, ReviewPane, messages,
  openReview, reviewPaneContribution, setAutoOpen
} = mod
const plugin = mod.default
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)
const src = readFileSync(pluginPath, 'utf8')

const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const flush = () => new Promise(resolve => setImmediate(resolve))
const nowSec = () => Date.now() / 1000
const item = (id, extra = {}) => ({ subsystem: 'skills', profile: 'default', id, created_at: nowSec() + 5, ...extra })

function fakeCtx(store = {}) {
  const timers = []
  const ctx = {
    disposers: [],
    registered: [],
    i18n: { register() {}, t },
    onDispose: fn => ctx.disposers.push(fn),
    registerMany: list => ctx.registered.push(...list),
    register: c => {
      ctx.registered.push(c)
      host.calls.push(`register:${c.id}`)
      if (c.area === 'panes') host.registered.add(`skill-review:${c.id}`)
      return () => { ctx.unregistered = (ctx.unregistered ?? 0) + 1; host.registered.delete(`skill-review:${c.id}`) }
    },
    rest: async () => ({}),
    setInterval: (fn, ms) => { timers.push({ fn, ms, every: true }); return () => {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, every: false }); return () => {} },
    storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } },
    store,
    timers
  }
  return ctx
}
const dispose = ctx => ctx.disposers.forEach(fn => fn())
const poll = async (ctx, items) => {
  globalThis.__queryClient.data = { items }
  ctx.timers.find(x => x.every).fn()
  await flush()
}
const paneRegs = ctx => ctx.registered.filter(c => c.area === 'panes')

function start(store = {}) {
  host.reset()
  $selection.set(null)
  const ctx = fakeCtx(store)
  plugin.register(ctx)
  return ctx
}

// --- registration -----------------------------------------------------------------------------

test('startup registers no pane, so nothing appears on its own; the Review chip and palette are there', () => {
  const ctx = start()
  assert.equal(paneRegs(ctx).length, 0, 'no pane until the first change or Review press')
  assert.deepEqual(host.calls, [], 'startup neither registers, reveals nor undismisses a pane')
  assert.ok(ctx.registered.some(c => c.area === 'statusBar.right' && c.id === 'chip'), 'the Review chip is always registered')
  assert.ok(ctx.registered.some(c => c.area === 'palette'))
  dispose(ctx)
})

test('the review pane contribution: id list, a tab in the Files zone, 720px, no companion', () => {
  const pane = reviewPaneContribution()
  assert.equal(pane.id, 'list')
  assert.equal(LIST_PANE, 'skill-review:list')
  assert.equal(pane.area, 'panes')
  assert.equal(pane.title, messages.en.listTitle)
  assert.equal(pane.data.defaultCollapsed, undefined, 'a silent tab in a shared zone never collapses, so the flag would do nothing')
  assert.equal(pane.data.placement, 'right')
  assert.equal(pane.data.hideOnly, true)
  assert.notEqual(pane.data.placement, 'floating')
  assert.deepEqual(pane.data.dock, { pane: 'files', pos: 'center', enforce: true })
  assert.equal(pane.data.width, '720px')
  assert.equal(pane.render().type, ReviewPane)
  const ctx = start()
  openReview()
  assert.deepEqual(paneRegs(ctx).map(p => p.id), ['list'], 'exactly one pane, no companion')
  dispose(ctx)
})

test('openReview undismisses, registers the pane once, then reveals it (reveal also expands a collapsed zone)', () => {
  const ctx = start()
  openReview()
  assert.deepEqual(host.calls, [`undismiss:${LIST_PANE}`, 'register:list', `reveal:${LIST_PANE}`])
  host.calls = []
  openReview()
  assert.deepEqual(host.calls, [`undismiss:${LIST_PANE}`, `reveal:${LIST_PANE}`], 'never registered twice')
  assert.equal(paneRegs(ctx).length, 1)
  assert.equal(host.workspaceOpens, 0, 'never the centre zone')
  dispose(ctx)
  assert.equal(ctx.unregistered, 1, 'the lazily registered pane is unregistered with the plugin')
})

test('chip, palette command and toast action all open the pane', async () => {
  const ctx = start({ autoOpen: false })
  // Palette
  ctx.registered.find(c => c.area === 'palette').data.run()
  assert.ok(host.onScreen.has(LIST_PANE))
  // Chip
  host.userCloses(LIST_PANE)
  const chip = ReviewChip({ count: 0, counts: { skills: 0, memory: 0 }, lit: false, mode: 'popup', onOpen: () => openReview(), onMode() {}, t })
  walk(chip).find(n => n.type === 'button').props.onClick()
  assert.ok(host.onScreen.has(LIST_PANE))
  // Toast
  host.userCloses(LIST_PANE)
  await poll(ctx, [])
  await poll(ctx, [item('t1')])
  assert.equal(host.toasts.length, 1)
  host.toasts[0].action.onClick()
  assert.ok(host.onScreen.has(LIST_PANE))
  assert.equal($selection.get(), 'skills/default/t1')
  dispose(ctx)
})

test('the StatusChip always renders the chip, with zero changes and on error too', () => {
  const body = src.slice(src.indexOf('function StatusChip()'), src.indexOf('const NOTIFY_EN'))
  assert.ok(body.length > 0)
  assert.doesNotMatch(body, /return null/, 'the chip never hides')
  const zero = ReviewChip({ count: 0, counts: { skills: 0, memory: 0 }, lit: false, mode: 'popup', onOpen() {}, onMode() {}, t })
  const button = walk(zero).find(n => n.type === 'button')
  assert.ok(button, 'a Review button with nothing pending')
  assert.ok(kids(button).every(n => n.type?.name !== 'Badge'), 'no badge when the count is 0')
})

// --- persisted close across a restart ---------------------------------------------------------

test('a closed pane stays out after a restart, and openReview brings it back', () => {
  host.dismissed.clear()
  let ctx = start()
  openReview()
  assert.ok(host.onScreen.has(LIST_PANE))
  host.userCloses(LIST_PANE)
  dispose(ctx)

  ctx = start() // simulated restart: host.dismissed survives, the pane is not registered
  assert.ok(host.dismissed.has(LIST_PANE), 'the close is remembered')
  assert.ok(!host.onScreen.has(LIST_PANE), 'nothing on screen after the restart')
  assert.equal(paneRegs(ctx).length, 0)
  openReview()
  assert.ok(!host.dismissed.has(LIST_PANE))
  assert.ok(host.onScreen.has(LIST_PANE))
  dispose(ctx)
})

// --- first poll and autoOpen ------------------------------------------------------------------

test('first poll only records what is already pending: no pane, no toast, but the chip still lights', async () => {
  const ctx = start({ notifyMode: 'light', lastSeenAt: 1 })
  await poll(ctx, [item('old1'), item('old2')])
  assert.deepEqual(host.calls, [], 'changes pending at startup never open the pane')
  assert.equal(host.toasts.length, 0)
  assert.deepEqual(ctx.store.announced, ['skills/default/old1', 'skills/default/old2'], 'recorded as known')
  assert.equal($lit.get(), true, 'the chip still shows them as unseen')
  await poll(ctx, [item('old1'), item('old2')])
  assert.deepEqual(host.calls, [], 'still the same items')
  dispose(ctx)
})

test('first poll that fails does not count; the first successful one only records', async () => {
  const ctx = start()
  const qc = globalThis.__queryClient
  const real = qc.fetchQuery
  qc.fetchQuery = () => Promise.reject(new Error('down'))
  ctx.timers.find(x => x.every).fn(); await flush()
  qc.fetchQuery = real
  await poll(ctx, [item('was-there')])
  assert.deepEqual(host.calls, [])
  dispose(ctx)
})

test('autoOpen on (default): a change that arrives after the first poll opens the pane, without a toast', async () => {
  const ctx = start()
  assert.equal($autoOpen.get(), true)
  await poll(ctx, [item('old')])
  await poll(ctx, [item('old'), item('new1')])
  assert.deepEqual(host.calls, [`undismiss:${LIST_PANE}`, 'register:list', `reveal:${LIST_PANE}`])
  assert.equal(host.toasts.length, 0, 'the pane is the signal')
  assert.equal($selection.get(), 'skills/default/new1', 'nothing was selected, so the new change is')
  dispose(ctx)
})

test('autoOpen on in light mode also opens the pane and leaves the chip unlit once it is open', async () => {
  const ctx = start({ notifyMode: 'light' })
  await poll(ctx, [])
  await poll(ctx, [item('n1', { created_at: nowSec() - 1 })])
  assert.ok(host.calls.includes(`reveal:${LIST_PANE}`))
  assert.equal(host.toasts.length, 0)
  assert.equal($lit.get(), false)
  dispose(ctx)
})

test('autoOpen does not take away the change the user is reading', async () => {
  const ctx = start()
  await poll(ctx, [item('a')])
  $selection.set('skills/default/a')
  await poll(ctx, [item('a'), item('b')])
  assert.ok(host.calls.includes(`reveal:${LIST_PANE}`))
  assert.equal($selection.get(), 'skills/default/a')
  dispose(ctx)
})

test('autoOpen off: popup mode toasts and light mode lights the chip; neither opens the pane', async () => {
  let ctx = start({ autoOpen: false })
  assert.equal($notifyMode.get(), 'popup')
  await poll(ctx, [])
  await poll(ctx, [item('p1')])
  assert.equal(host.toasts.length, 1)
  assert.deepEqual(host.calls, [])
  dispose(ctx)

  ctx = start({ autoOpen: false, notifyMode: 'light', lastSeenAt: 1 })
  await poll(ctx, [])
  await poll(ctx, [item('l1')])
  assert.equal(host.toasts.length, 0)
  assert.equal($lit.get(), true)
  assert.deepEqual(host.calls, [])
  dispose(ctx)
})

test('a manual close is respected: the same pending changes never reopen it, a new one does', async () => {
  host.dismissed.clear()
  const ctx = start()
  await poll(ctx, [])
  await poll(ctx, [item('c1')])
  assert.ok(host.onScreen.has(LIST_PANE))
  host.userCloses(LIST_PANE)
  host.calls = []
  await poll(ctx, [item('c1')])
  await poll(ctx, [item('c1')])
  assert.deepEqual(host.calls, [], 'already announced: stays closed')
  assert.ok(!host.onScreen.has(LIST_PANE))
  await poll(ctx, [item('c1'), item('c2')])
  assert.ok(host.onScreen.has(LIST_PANE), 'a new arrival opens it again')
  dispose(ctx)
})

test('old desktops (route fallback): a new change never navigates the main view by itself', async () => {
  host.reset()
  const saved = host.openWorkspace
  host.openWorkspace = undefined
  const ctx = fakeCtx()
  plugin.register(ctx)
  await poll(ctx, [])
  await poll(ctx, [item('f1')])
  assert.equal(host.navigated, null)
  assert.equal(host.toasts.length, 1, 'falls back to the notify mode (popup)')
  host.openWorkspace = saved
  dispose(ctx)
})

// --- the setting ------------------------------------------------------------------------------

test('autoOpen defaults to true, persists in plugin storage and is read back after a restart', () => {
  let ctx = start()
  assert.equal($autoOpen.get(), true)
  assert.equal(ctx.store.autoOpen, undefined, 'the default is not written')
  setAutoOpen(false)
  assert.equal($autoOpen.get(), false)
  assert.equal(ctx.store.autoOpen, false)
  const saved = { ...ctx.store }
  dispose(ctx)
  $autoOpen.set(true) // a fresh module
  ctx = start(saved)
  assert.equal($autoOpen.get(), false)
  dispose(ctx)
  ctx = start({ autoOpen: 'yes' })
  assert.equal($autoOpen.get(), true, 'a corrupt stored value falls back to on')
  dispose(ctx)
})

test('AutoOpenSwitch is a labelled checkbox with plain text that reports a boolean', () => {
  const seen = []
  const tree = AutoOpenSwitch({ on: true, onChange: v => seen.push(v), t })
  assert.equal(tree.type, 'label', 'the whole row toggles, and the text labels the checkbox')
  const box = walk(tree).find(n => typeof n.props?.onCheckedChange === 'function')
  assert.equal(box.type.name, 'Checkbox')
  assert.equal(box.props.checked, true)
  box.props.onCheckedChange(false)
  box.props.onCheckedChange('indeterminate')
  box.props.onCheckedChange(true)
  assert.deepEqual(seen, [false, false, true])
  assert.ok(walk(tree).some(n => n.props?.children === 'autoOpenLabel'))
  assert.equal(messages.en.autoOpenLabel, 'Open this tab automatically when a change arrives')
})

test('AutoOpenSwitch styles: shrinkable, wraps long text, theme variables only', () => {
  const tree = AutoOpenSwitch({ on: false, onChange() {}, t })
  assert.equal(tree.props.style, AUTO_OPEN_STYLES.row)
  const { row, text } = AUTO_OPEN_STYLES
  assert.equal(row.display, 'flex')
  assert.equal(row.alignItems, 'center')
  assert.equal(row.minWidth, 0)
  assert.equal(row.cursor, 'pointer')
  assert.equal(text.minWidth, 0)
  assert.equal(text.overflowWrap, 'anywhere')
  assert.match(text.color, /^var\(--ui-/)
  const json = JSON.stringify(AUTO_OPEN_STYLES)
  assert.doesNotMatch(json, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(json, /\b(?:rgb|rgba|hsl|hsla|oklch)\(/)
})

test('the settings page carries the autoOpen row right after the notify row', () => {
  const view = src.slice(src.indexOf('export function SettingsPageView('), src.indexOf('export function SettingsPage('))
  assert.match(view, /jsx\(NotifyModeControl, \{ bare: true \}\)[^\n]*\n\s*jsx\(AutoOpenRow, \{\}\)/)
})
