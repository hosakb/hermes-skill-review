// Tests for the two review panes: `list` (the list and the diff) and `settings` (profile subset,
// sort order, notify mode, autoOpen and the VS Code link). Desktop turns a plugin off when the user
// closes its only pane, so two registered panes make every Close a plain dismiss.
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
  openWorkspace() { return () => {} },
  undismissPane(id) { this.calls.push(`undismiss:${id}`) },
  revealPane(id) { this.calls.push(`reveal:${id}`) },
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = []; this.calls = []; this.navigated = null }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $autoOpen, $editorTemplate, $hidden, $notifyMode, $sort, AutoOpenControl, DEFAULT_EDITOR_TEMPLATE, EDITOR_PRESETS,
  EditorLinkControl, LIST_PANE, NotifyModeControl, ProfileControl, ReviewPane, SETTINGS_PANE, SettingsGearButton,
  SettingsPane, SettingsSummary, SettingsView, SortControl, messages, openReview, openSettings, reviewPaneContribution,
  settingsPaneContribution
} = mod
const plugin = mod.default
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)
const src = readFileSync(pluginPath, 'utf8')
const slice = (from, to) => {
  const start = src.indexOf(from)
  assert.ok(start >= 0, `missing ${from}`)
  return src.slice(start, src.indexOf(to, start + from.length))
}

const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const ofType = (tree, type) => walk(tree).filter(n => n.type === type)
const text = tree => walk(tree).flatMap(n => {
  const c = n.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => typeof x === 'string')
}).join(' ')

// The real host's ctx.register tags every contribution with source 'plugin:<id>' and namespaces
// the id as '<id>:<localId>' (apps/desktop/src/contrib/plugin.ts lines 1 to 7 and 390).
function fakeCtx() {
  const store = {}
  const ctx = {
    disposers: [],
    registered: [],
    scoped: [],
    i18n: { register() {}, t },
    onDispose: fn => ctx.disposers.push(fn),
    registerMany: list => ctx.registered.push(...list),
    register: c => {
      ctx.registered.push(c)
      ctx.scoped.push({ ...c, id: `skill-review:${c.id}`, source: 'plugin:skill-review' })
      host.calls.push(`register:${c.id}`)
      return () => { ctx.scoped = ctx.scoped.filter(x => x.id !== `skill-review:${c.id}`) }
    },
    rest: async () => ({}),
    setInterval: () => () => {},
    setTimeout: () => () => {},
    storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } },
    store
  }
  return ctx
}
const dispose = ctx => ctx.disposers.forEach(fn => fn())
const start = () => {
  host.reset()
  const ctx = fakeCtx()
  plugin.register(ctx)
  return ctx
}
const panesOf = ctx => ctx.registered.filter(c => c.area === 'panes')

// COPY of the decision in closeTreePane, apps/desktop/src/components/pane-shell/tree/store.ts
// lines 1015 to 1053 (hermes-agent caafe5389a), without the paneClosers branch (a plugin pane has
// no closer: registerPaneCloser is only called for openWorkspace panes, sdk/index.ts 1213 to 1222).
// `panes` is registry.getArea('panes'): every REGISTERED contribution, whether or not it is still
// in the layout tree. dismissTreePane only edits the tree, so a dismissed pane still counts.
// Every close gesture (x, middle click, cmd-W, the zone menu Close rows, the compact tab picker)
// ends in closeTabPane -> closeTreePane for a pane that is not a tool panel.
function closeTreePaneOutcome(panes, paneId) {
  const source = panes.find(c => c.id === paneId)?.source

  if (source?.startsWith('plugin:')) {
    if (panes.filter(c => c.source === source).length > 1) {
      return 'dismiss'
    }

    return `disable:${source.slice('plugin:'.length)}`
  }

  return 'dismiss'
}

// --- registration -----------------------------------------------------------------------------

test('openReview registers two panes with distinct ids through the same plugin context', () => {
  const ctx = start()
  assert.equal(panesOf(ctx).length, 0, 'still nothing at startup')
  openReview()
  const panes = panesOf(ctx)
  assert.deepEqual(panes.map(p => p.id), ['list', 'settings'])
  assert.equal(new Set(ctx.scoped.filter(c => c.area === 'panes').map(c => c.source)).size, 1, 'one source for both')
  assert.equal(LIST_PANE, 'skill-review:list')
  assert.equal(SETTINGS_PANE, 'skill-review:settings')
  openReview()
  assert.equal(panesOf(ctx).length, 2, 'never registered twice')
  dispose(ctx)
  assert.equal(ctx.scoped.filter(c => c.area === 'panes').length, 0, 'unloading the plugin removes both')
})

test('the list pane keeps its old shape: id list, collapsed on arrival, docked right, no hideOnly', () => {
  const list = reviewPaneContribution()
  assert.equal(list.id, 'list')
  assert.deepEqual(list.data, { placement: 'main', dock: { pane: 'workspace', pos: 'right' }, defaultCollapsed: true, width: '720px', minWidth: '240px' })
  assert.equal(list.render().type, ReviewPane)
})

test('the settings pane: Review settings, same zone as the list, same placement, collapsed on arrival', () => {
  const pane = settingsPaneContribution()
  assert.equal(pane.id, 'settings')
  assert.equal(pane.area, 'panes')
  assert.equal(pane.title, 'Review settings')
  assert.equal(messages.en.settingsTitle, 'Review settings')
  assert.equal(pane.data.placement, reviewPaneContribution().data.placement)
  assert.deepEqual(pane.data.dock, { pane: LIST_PANE, pos: 'center' }, 'a tab in the list zone')
  assert.equal(pane.data.defaultCollapsed, true)
  assert.equal(pane.data.hideOnly, undefined)
  assert.equal(pane.render().type, SettingsPane)
})

test('openReview undismisses the list before registering, so the settings pane docks next to it', () => {
  const ctx = start()
  openReview()
  assert.deepEqual(host.calls, [`undismiss:${LIST_PANE}`, 'register:list', 'register:settings', `reveal:${LIST_PANE}`])
  host.calls = []
  openReview()
  assert.deepEqual(host.calls, [`undismiss:${LIST_PANE}`, `reveal:${LIST_PANE}`], 'after a Close, Review brings the list back')
  dispose(ctx)
})

test('openSettings undismisses and reveals the settings pane with the same helper', () => {
  const ctx = start()
  openReview()
  host.calls = []
  openSettings()
  assert.deepEqual(host.calls, [`undismiss:${SETTINGS_PANE}`, `reveal:${SETTINGS_PANE}`])
  assert.match(slice('export function openReview(', '\n}'), /showPane\(LIST_PANE\)/)
  assert.match(slice('export function openSettings(', '\n}'), /showPane\(SETTINGS_PANE\)/)
  dispose(ctx)
})

test('the chip, palette and toast still open the list', () => {
  const ctx = start()
  assert.ok(ctx.registered.some(c => c.area === 'statusBar.right' && c.id === 'chip'))
  ctx.registered.find(c => c.area === 'palette').data.run()
  assert.ok(host.calls.includes(`reveal:${LIST_PANE}`))
  assert.match(slice('function StatusChip()', '\nconst NOTIFY_EN'), /openReview\(\)/)
  dispose(ctx)
})

// --- the close rule (copy of closeTreePane's decision) ----------------------------------------

test('closeTreePane copy: with both panes registered, closing one and then the other never disables', () => {
  const ctx = start()
  openReview()
  const registry = ctx.scoped.filter(c => c.area === 'panes')
  // Closing the first only edits the layout tree; the registry keeps both contributions.
  assert.equal(closeTreePaneOutcome(registry, LIST_PANE), 'dismiss')
  assert.equal(closeTreePaneOutcome(registry, SETTINGS_PANE), 'dismiss')
  assert.equal(closeTreePaneOutcome(registry, SETTINGS_PANE), 'dismiss')
  assert.equal(closeTreePaneOutcome(registry, LIST_PANE), 'dismiss')
  dispose(ctx)
})

test('closeTreePane copy: the old single pane would have disabled the plugin', () => {
  const one = [{ id: LIST_PANE, source: 'plugin:skill-review' }]
  assert.equal(closeTreePaneOutcome(one, LIST_PANE), 'disable:skill-review')
})

// --- list header ------------------------------------------------------------------------------

const header = () => {
  const list = slice('function FilesListPane()', '\nfunction ')
  return list.slice(list.indexOf('const bar'), list.indexOf('let body'))
}

test('the list header no longer holds the settings controls and has the gear', () => {
  const bar = header()
  for (const name of ['ProfileControl', 'SortControl', 'NotifyModeControl', 'AutoOpenControl', 'EditorLinkControl']) {
    assert.doesNotMatch(bar, new RegExp(`jsx\\(${name}\\b`), `${name} moved to the settings pane`)
  }
  assert.match(bar, /jsx\(SettingsGearButton, \{ onOpen: openSettings, t \}\)/)
  assert.match(bar, /jsx\(SettingsSummary, \{ hidden: v\.hidden, profiles: v\.profiles, sort: v\.sort, t \}\)/)
  assert.match(bar, /KINDS\.map/, 'the kind filter stays in the list')
})

test('the gear button opens the settings', () => {
  let opened = 0
  const btn = SettingsGearButton({ onOpen: () => { opened++ }, t })
  assert.equal(btn.props['aria-label'], 'openSettings')
  assert.ok(walk(btn).some(n => n.props?.name === 'settings-gear'))
  btn.props.onClick()
  assert.equal(opened, 1)
  assert.equal(messages.en.openSettings, 'Review settings')
})

test('the list header summary follows the shared store: profile subset and sort order', () => {
  const profiles = [{ profile: 'default', count: 2 }, { profile: 'dev', count: 1 }, { profile: 'ops', count: 4 }]
  assert.equal(text(SettingsSummary({ hidden: [], profiles, sort: 'newest', t })), 'settingsSummary:profilesAll:3,sort_newest')
  // A change made in the settings pane goes through setSort / setHiddenProfiles into $sort / $hidden,
  // which useVisibleFiles reads for the header.
  SortControl().props.onChange('changes')
  ProfileControl({ focused: 'default', profiles }).props.onChange(['ops'])
  assert.equal($sort.get(), 'changes')
  assert.deepEqual($hidden.get(), ['ops'])
  assert.equal(text(SettingsSummary({ hidden: $hidden.get(), profiles, sort: $sort.get(), t })), 'settingsSummary:profilesShown:2,3,sort_changes')
  assert.match(slice('function useVisibleFiles()', '\nfunction '), /\n    hidden,\n[\s\S]*\n    sort\n  }/)
  SortControl().props.onChange('newest')
  ProfileControl({ focused: 'default', profiles }).props.onChange([])
  assert.equal(text(SettingsSummary({ hidden: [], profiles: [], sort: 'oldest', t })), 'sort_oldest', 'no profile count with nothing pending')
})

// --- settings pane ----------------------------------------------------------------------------

test('the settings pane renders every control', () => {
  const profiles = [{ profile: 'default', count: 2 }]
  const view = SettingsView({ focused: 'default', profiles, t })
  for (const type of [ProfileControl, SortControl, NotifyModeControl, AutoOpenControl, EditorLinkControl]) {
    assert.equal(ofType(view, type).length, 1, `${type.name} is in the settings pane`)
  }
  assert.equal(ofType(view, ProfileControl)[0].props.profiles, profiles)
  assert.match(text(view), /settingsTitle/)
  const empty = SettingsView({ focused: 'default', profiles: [], t })
  assert.match(text(empty), /settingsNoProfiles/, 'says why the profile list is empty')
  assert.match(slice('export function SettingsPane()', '\n}'), /useVisibleFiles\(\)/)
})

test('the settings controls write to the shared persisted store', () => {
  const ctx = start()
  NotifyModeControl().props.onChange('light')
  assert.equal($notifyMode.get(), 'light')
  AutoOpenControl().props.onChange(false)
  assert.equal($autoOpen.get(), false)
  assert.equal(ctx.store.autoOpen, false)
  const editor = EditorLinkControl()
  editor.props.onMode('local')
  assert.equal($editorTemplate.get(), EDITOR_PRESETS.local)
  NotifyModeControl().props.onChange('popup')
  AutoOpenControl().props.onChange(true)
  editor.props.onMode('remote')
  assert.equal($editorTemplate.get(), DEFAULT_EDITOR_TEMPLATE)
  dispose(ctx)
})

test('the route fallback page shows the settings with the list, and the gear is hidden there', () => {
  assert.match(slice('function FallbackPage()', '\n}'), /jsx\(SettingsPane, \{\}\)/)
  assert.match(header(), /useRouteFallback \? null : jsx\(SettingsGearButton/)
})
