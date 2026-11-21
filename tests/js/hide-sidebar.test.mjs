// Tests for the Hide control in the review pane header. It collapses the whole right sidebar through
// ctx.runAction('view.toggleRightSidebar'), the handler behind Cmd/Ctrl+J and the title bar button,
// so the user has a way out when the Review tab is the last visible tab in its zone.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate(path) { this.calls.push(`navigate:${path}`) },
  notify() {},
  notifyError() {},
  openWorkspace() { return () => {} },
  undismissPane() {},
  revealPane() {},
  state: { profile: { get: () => 'default' } },
  reset() { this.calls = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const { SidebarHideControl, hideSidebar, messages, reviewPaneContribution } = mod
const plugin = mod.default
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)
const src = readFileSync(pluginPath, 'utf8')
const slice = (from, to) => {
  const start = src.indexOf(from)
  assert.ok(start >= 0, `missing ${from}`)
  return src.slice(start, src.indexOf(to, start + from.length))
}

const ACTION = 'view.toggleRightSidebar'

function fakeCtx({ runAction = true, listActions = true, allowed = [ACTION, 'view.showFiles'] } = {}) {
  const store = {}
  const ctx = {
    actions: [],
    disposers: [],
    i18n: { register() {}, t },
    onDispose: fn => ctx.disposers.push(fn),
    registerMany: () => {},
    register: () => () => {},
    registerSettingsPage: () => () => {},
    rest: async () => ({}),
    setInterval: () => () => {},
    setTimeout: () => () => {},
    storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } }
  }
  if (runAction) ctx.runAction = id => { ctx.actions.push(id); return { ok: true } }
  if (listActions) ctx.listActions = () => allowed.map(id => ({ id, label: id }))
  return ctx
}
const start = opts => {
  host.reset()
  const ctx = fakeCtx(opts)
  plugin.register(ctx)
  return ctx
}
const dispose = ctx => ctx.disposers.forEach(fn => fn())

test('the Hide control is a ghost xs button labelled Hide with the shortcut tooltip', () => {
  const ctx = start()
  const btn = SidebarHideControl({ t })
  assert.ok(btn, 'rendered when the host can run the action')
  assert.equal(btn.props.variant, 'ghost')
  assert.equal(btn.props.size, 'xs')
  assert.equal(btn.props.type, 'button')
  assert.equal(btn.props.children, 'hideSidebar')
  assert.equal(btn.props.title, 'hideSidebarTip')
  assert.equal(btn.props['aria-label'], 'hideSidebarTip')
  dispose(ctx)
})

test('the English strings match the approved label and tooltip', () => {
  assert.equal(messages.en.hideSidebar, 'Hide')
  assert.equal(messages.en.hideSidebarTip, 'Hide the sidebar (Ctrl+J / Cmd+J). Reopen it from the title bar.')
})

test('a click runs the right sidebar toggle once, and nothing else', () => {
  const ctx = start()
  SidebarHideControl({ t }).props.onClick()
  assert.deepEqual(ctx.actions, [ACTION])
  assert.deepEqual(host.calls, [], 'no navigation or pane calls')
  dispose(ctx)
})

test('no control on a host without ctx.runAction, and hideSidebar does not throw', () => {
  const ctx = start({ runAction: false, listActions: false })
  assert.equal(SidebarHideControl({ t }), null)
  assert.doesNotThrow(() => hideSidebar())
  dispose(ctx)
})

test('no control when the host lists actions and the toggle is not among them', () => {
  const ctx = start({ allowed: ['view.showFiles'] })
  assert.equal(SidebarHideControl({ t }), null)
  hideSidebar()
  assert.deepEqual(ctx.actions, [])
  dispose(ctx)
})

test('a host with runAction but no listActions still gets the control', () => {
  const ctx = start({ listActions: false })
  assert.ok(SidebarHideControl({ t }))
  dispose(ctx)
})

test('a runAction that throws or refuses is swallowed', () => {
  const ctx = start()
  ctx.runAction = () => { throw new Error('boom') }
  assert.doesNotThrow(() => hideSidebar())
  ctx.runAction = () => ({ ok: false, error: 'unavailable' })
  assert.doesNotThrow(() => hideSidebar())
  dispose(ctx)
})

test('no control after the plugin is disposed', () => {
  const ctx = start()
  dispose(ctx)
  assert.equal(SidebarHideControl({ t }), null)
})

test('no control on the route page fallback (no pane, nothing to hide)', () => {
  const open = host.openWorkspace
  delete host.openWorkspace
  const ctx = start()
  assert.equal(SidebarHideControl({ t }), null)
  dispose(ctx)
  host.openWorkspace = open
})

test('both pane headers render the control next to the gear', () => {
  for (const name of ['export function FilesListPane()', 'export function LibraryListPane()']) {
    const pane = slice(name, '\nfunction ')
    const bar = pane.slice(pane.indexOf('const bar'), pane.indexOf('let body'))
    assert.match(bar, /SettingsGearButton, \{ onOpen: openSettings, t \}\),\n\s+jsx\(SidebarHideControl, \{ t \}\)/, name)
  }
})

test('the pane keeps its hideOnly dock', () => {
  const pane = reviewPaneContribution()
  assert.equal(pane.data.hideOnly, true)
  assert.deepEqual(pane.data.dock, { pane: 'files', pos: 'center', enforce: true })
})
