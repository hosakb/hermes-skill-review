// The review tab can be collapsed or hidden but not closed, so the plugin stays enabled.
//
// Desktop turns a plugin off when its only registered pane is closed (closeTreePane,
// apps/desktop/src/components/pane-shell/tree/store.ts lines 1015 to 1053). The review pane is this
// plugin's only pane, so it registers `hideOnly: true` (no close verb at all) and
// `placement: 'right'` (cmd-W only closes tabs in zones that hold a 'main' pane).
//
// KNOWN GAP, accepted by the owner: if the user drags the review tab into the chat zone (or any zone
// that holds a 'main' pane: the workspace, a session tile, a preview) and presses cmd-W while that
// zone is focused or hovered and the review tab is active, closeFocusedSessionTab (store.ts lines
// 650 to 660) does not check hideOnly and calls closeTreePane, which turns the plugin off.
// Capabilities > Plugins turns it back on. The last test below pins this gap down.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate(path) { this.calls.push(`navigate:${path}`) },
  notify(toast) { this.toasts.push(toast) },
  notifyError() {},
  openWorkspace() { return () => {} },
  undismissPane(id) { this.calls.push(`undismiss:${id}`) },
  revealPane(id) { this.calls.push(`reveal:${id}`) },
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = []; this.calls = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const { LIST_PANE, openReview, reviewPaneContribution } = mod
const plugin = mod.default

// The registry as Desktop sees it once openReview ran: the plugin's pane plus core panes.
// ctx.register namespaces the id and stamps the source (apps/desktop/src/contrib/plugin.ts 1-7, 390).
const review = { ...reviewPaneContribution(), id: LIST_PANE, source: 'plugin:skill-review' }
const workspace = { id: 'workspace', data: { placement: 'main', uncloseable: true } }
const sessionTile = { id: 'session-tile:abc', data: { placement: 'main' } }
const registry = [review, workspace, sessionTile]
const paneFor = id => registry.find(c => c.id === id)
const chrome = id => paneFor(id)?.data ?? {}

// --- COPIES of Desktop's close-verb gates (hermes-agent caafe5389a) -------------------------------

// tree-group.tsx 628-629: the tab's x, middle click and cmd-click (lines 696/712, 797/810) and the
// compact tab picker's Close (line 749 -> 343) are offered only when this is true.
const closeableTab = (paneId, panesWithCloser = new Set()) =>
  !chrome(paneId).hideOnly && (!chrome(paneId).uncloseable || panesWithCloser.has(paneId))

// tree-group.tsx 597-602: the tab/zone menu's Close row targets this id, or none.
const closable = paneId => (chrome(paneId).uncloseable || chrome(paneId).hideOnly ? undefined : paneId)

// store.ts 583-591 and 705-715, 762-766: Close others / to the right / all skip these.
const isUncloseablePane = paneId => Boolean(chrome(paneId).uncloseable)
const isHideOnlyPane = paneId => Boolean(chrome(paneId).hideOnly)
const closeAllTargets = groupPanes => groupPanes.filter(id => !isUncloseablePane(id) && !isHideOnlyPane(id))

// store.ts 604-606 and 650-660: cmd-W's chat-zone rung.
const isMainStripPane = paneId => chrome(paneId).placement === 'main'
const cmdWClosesInChatZone = group =>
  group.panes.some(isMainStripPane) && Boolean(group.active) && !isUncloseablePane(group.active)

// store.ts 1015-1053, without the paneClosers branch (no plugin pane has a closer).
const closeTreePaneOutcome = paneId => {
  const source = paneFor(paneId)?.source
  if (source?.startsWith('plugin:')) {
    return registry.filter(c => c.source === source).length > 1 ? 'dismiss' : 'disable'
  }
  return 'dismiss'
}

// --- tests --------------------------------------------------------------------------------------

test('registration: placement right, hideOnly, and the rest unchanged', () => {
  const pane = reviewPaneContribution()
  assert.equal(pane.id, 'list')
  assert.equal(pane.data.placement, 'right')
  assert.equal(pane.data.hideOnly, true)
  assert.deepEqual(pane.data.dock, { pane: 'workspace', pos: 'right' })
  assert.equal(pane.data.defaultCollapsed, true)
  assert.equal(pane.data.width, '720px')
  assert.equal(pane.data.minWidth, '240px')
})

test('closing the only pane would turn the plugin off, which is why no close verb may reach it', () => {
  assert.equal(closeTreePaneOutcome(LIST_PANE), 'disable')
})

test('x, middle click, cmd-click and the compact picker offer no close for the review tab', () => {
  assert.equal(closeableTab(LIST_PANE), false)
  assert.equal(closeableTab('session-tile:abc'), true, 'the model still closes ordinary tabs')
})

test('the tab and zone menu Close row has no target for the review tab', () => {
  assert.equal(closable(LIST_PANE), undefined)
  assert.equal(closable('session-tile:abc'), 'session-tile:abc')
})

test('Close others, to the right and all skip the review tab', () => {
  assert.deepEqual(closeAllTargets(['workspace', 'session-tile:abc', LIST_PANE]), ['session-tile:abc'])
})

test('cmd-W does not reach the review tab in its own zone', () => {
  assert.equal(cmdWClosesInChatZone({ panes: [LIST_PANE], active: LIST_PANE }), false)
})

test('KNOWN GAP: dragged into the chat zone and active, cmd-W still reaches it', () => {
  assert.equal(cmdWClosesInChatZone({ panes: ['workspace', LIST_PANE], active: LIST_PANE }), true)
  assert.equal(closeTreePaneOutcome(LIST_PANE), 'disable')
})

test('openReview (chip, palette, toast action and autoOpen all call it) undismisses and reveals the pane', () => {
  host.reset()
  const ctx = {
    disposers: [], registered: [],
    i18n: { register() {}, t: k => k },
    onDispose: fn => ctx.disposers.push(fn),
    registerMany: list => ctx.registered.push(...list),
    register: c => { ctx.registered.push(c); host.calls.push(`register:${c.id}`); return () => {} },
    rest: async () => ({}),
    setInterval: () => () => {},
    setTimeout: () => () => {},
    storage: { get: (k, d) => d, set() {} }
  }
  plugin.register(ctx)
  openReview()
  assert.deepEqual(host.calls, [`undismiss:${LIST_PANE}`, 'register:list', `reveal:${LIST_PANE}`])
  host.calls = []
  ctx.registered.find(c => c.area === 'palette').data.run()
  assert.deepEqual(host.calls, [`undismiss:${LIST_PANE}`, `reveal:${LIST_PANE}`])
  ctx.disposers.forEach(fn => fn())
})
