// The review tab can be collapsed or hidden but not closed, so the plugin stays enabled.
//
// Desktop turns a plugin off when its only registered pane is closed (closeTreePane,
// apps/desktop/src/components/pane-shell/tree/store.ts lines 1015 to 1053). The review pane is this
// plugin's only pane, so it registers `hideOnly: true` (no close verb at all) and
// `placement: 'right'` (cmd-W only closes tabs in zones that hold a 'main' pane).
//
// The dock hint stacks the tab in the Files zone with `enforce: true`. A zone of its own showed no
// tab strip on auto (strip-visibility.ts 82-95: a lone side pane is not stranded and needs
// shown.length > 1), so it had no chevron and no zone menu, and cmd-J folded a different column.
// In the Files zone the strip shows, Hide works and cmd-J folds it with the right side.
//
// KNOWN GAP, accepted by the owner: if the user drags the review tab into the chat zone (or any zone
// that holds a 'main' pane: the workspace, a session tile, a preview) and presses cmd-W while that
// zone is focused or hovered and the review tab is active, closeFocusedSessionTab (store.ts lines
// 650 to 660) does not check hideOnly and calls closeTreePane, which turns the plugin off.
// Adoption also lands it in the chat zone when the layout holds neither Files nor another
// placement 'right' pane (store.ts 1590-1600). Capabilities > Plugins turns it back on. The
// KNOWN GAP test pins this down.
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
// app/contrib/controller.tsx 257-274.
const files = { id: 'files', data: { placement: 'right', collapsible: true, dock: { pane: 'workspace', pos: 'right' } } }
const registry = [review, workspace, sessionTile, files]
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

// strip-visibility.ts 57-95: resolveTabStripVisible with stranded(), zone mode left on auto.
const stranded = shown => shown.length === 1 && (shown[0].collapsePane || shown[0].placement === 'main')
const resolveTabStripVisible = ({ shown, mode, headerVeto }) => {
  if (shown.length === 0 || headerVeto) return false
  if (stranded(shown)) return true
  if (mode) return mode === 'always'
  return shown.length > 1
}
const stripFor = ids => resolveTabStripVisible({ shown: ids.map(id => ({ collapsePane: false, placement: chrome(id).placement })) })

// store.ts 380-390: the zone menu's Hide row is refused for the last shown tab.
const isLastShownInGroup = (group, paneId, hidden = new Set()) => !group.panes.some(id => id !== paneId && !hidden.has(id))

// store.ts 1590-1600: adoption's anchor. A dock pane in the tree, else a pane with the same
// placement, else main. dock.pos (default 'center') decides tab versus new column.
const adoptionAnchor = (paneId, treePanes) => {
  const data = chrome(paneId)
  const placement = data.placement ?? 'right'
  return (data.dock && treePanes.includes(data.dock.pane) ? data.dock.pane : undefined) ??
    treePanes.find(id => id !== paneId && chrome(id).placement === placement) ??
    registry.find(c => c.data?.placement === 'main')?.id
}

// store.ts 1466-1525: enforceDockedPanes for a center hint. Moves the pane into its anchor's group,
// silently (the anchor keeps its active tab); a group left empty drops out (model.ts 165, normalize).
const enforceCenterDock = (groups, paneId) => {
  const dock = chrome(paneId).dock
  const from = groups.find(g => g.panes.includes(paneId))
  const anchor = groups.find(g => g.panes.includes(dock?.pane))
  if (!dock?.enforce || !from || !anchor || from === anchor || dock.pos !== 'center') return groups
  return groups
    .map(g => g === from ? { ...g, panes: g.panes.filter(id => id !== paneId) } : g)
    .map(g => g === anchor ? { ...g, panes: [...g.panes, paneId] } : g)
    .filter(g => g.panes.length > 0)
}

// store.ts 1920-1945, the shared-zone branch of setPaneCollapsed(paneId, true) as adoption calls it.
const collapseInSharedZone = (group, paneId) =>
  group.active !== paneId ? 'nothing' : group.panes.some(isUncloseablePane) ? 'hand active to workspace' : 'minimize whole zone'

// --- tests --------------------------------------------------------------------------------------

test('registration: placement right, hideOnly, and the rest unchanged', () => {
  const pane = reviewPaneContribution()
  assert.equal(pane.id, 'list')
  assert.equal(pane.data.placement, 'right')
  assert.equal(pane.data.hideOnly, true)
  assert.deepEqual(pane.data.dock, { pane: 'files', pos: 'center', enforce: true })
  assert.equal(pane.data.defaultCollapsed, undefined)
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

test('the dock hint stacks the tab in the Files zone and Desktop enforces it every boot', () => {
  const { dock } = reviewPaneContribution().data
  assert.deepEqual(dock, { pane: 'files', pos: 'center', enforce: true })
})

test('regression: the dock hint never goes back to its own column on the workspace right edge', () => {
  const { dock } = reviewPaneContribution().data
  assert.notEqual(dock.pos, 'right', 'an edge dock makes a lone column with no tab strip')
  assert.notEqual(dock.pane, 'workspace')
  assert.equal(dock.pos, 'center')
  assert.equal(dock.enforce, true, 'without enforce an existing lone column stays where it is')
})

test('strip model: a lone placement right pane gets no strip on auto, a two pane zone does', () => {
  assert.equal(stripFor([LIST_PANE]), false, 'the old lone column: no chevron, no zone menu')
  assert.equal(stripFor(['files', LIST_PANE]), true, 'FILES | PENDING WRITES')
  assert.equal(stripFor(['session-tile:abc']), true, 'a lone main tile is stranded, so it keeps its strip')
})

test('adoption puts the tab in the Files zone, and without Files it still stacks as a tab', () => {
  assert.equal(adoptionAnchor(LIST_PANE, ['sessions', 'workspace', 'files']), 'files')
  const desktopReview = { id: 'review', data: { placement: 'right' } }
  registry.push(desktopReview)
  try {
    assert.equal(adoptionAnchor(LIST_PANE, ['sessions', 'workspace', 'review']), 'review', 'falls back to another right pane')
  } finally {
    registry.pop()
  }
  assert.equal(adoptionAnchor(LIST_PANE, ['sessions', 'workspace']), 'workspace', 'last resort is the chat zone')
  assert.equal(reviewPaneContribution().data.dock.pos, 'center', 'every fallback is a center insert, never a new column')
  assert.equal(cmdWClosesInChatZone({ panes: ['workspace', LIST_PANE], active: LIST_PANE }), true, 'the chat zone fallback keeps the cmd-W gap')
})

test('upgrade: enforce moves the tab out of an old lone column into the Files zone', () => {
  const before = [
    { id: 'grp-sessions', panes: ['sessions'] },
    { id: 'grp-main', panes: ['workspace'] },
    { id: 'g-old', panes: [LIST_PANE] },
    { id: 'grp-files', panes: ['files'], active: 'files' }
  ]
  const after = enforceCenterDock(before, LIST_PANE)
  assert.deepEqual(after.map(g => g.id), ['grp-sessions', 'grp-main', 'grp-files'], 'the lone column is gone')
  assert.deepEqual(after.find(g => g.id === 'grp-files').panes, ['files', LIST_PANE])
  assert.equal(after.find(g => g.id === 'grp-files').active, 'files', 'silent: Review fronts it later')
  assert.equal(enforceCenterDock(after, LIST_PANE), after, 'already there: nothing moves')
})

test('in the Files zone the zone menu Hide row works and cmd-W does not reach the tab', () => {
  const zone = { panes: ['files', LIST_PANE], active: LIST_PANE }
  assert.equal(isLastShownInGroup(zone, LIST_PANE), false, 'Files is still shown, so Hide Pending writes is allowed')
  assert.equal(isLastShownInGroup({ panes: [LIST_PANE] }, LIST_PANE), true, 'the old lone column refused Hide')
  assert.equal(isLastShownInGroup(zone, LIST_PANE, new Set(['files'])), true, 'with Files chrome-hidden, Hide is refused again')
  assert.equal(cmdWClosesInChatZone(zone), false, 'no placement main pane in the Files zone')
})

test('defaultCollapsed would do nothing in the Files zone, so the pane does not set it', () => {
  // Adoption inserts silently (model.ts 262-305, activate false), so Files keeps the active slot.
  assert.equal(collapseInSharedZone({ panes: ['files', LIST_PANE], active: 'files' }, LIST_PANE), 'nothing')
  // Were the tab ever active there, the flag would fold the Files tab with it.
  assert.equal(collapseInSharedZone({ panes: ['files', LIST_PANE], active: LIST_PANE }, LIST_PANE), 'minimize whole zone')
  assert.equal(reviewPaneContribution().data.defaultCollapsed, undefined)
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
