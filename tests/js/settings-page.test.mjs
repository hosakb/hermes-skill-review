// Tests for the review settings on Settings > Plugins > Skill Review (ctx.registerSettingsPage):
// profile subset, sort order, notify mode, autoOpen and the VS Code link. The list header keeps a
// summary and a gear that opens that page. The plugin registers one pane again.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const sdk = await import('@hermes/plugin-sdk')
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $autoOpen, $editorTemplate, $hidden, $inlineSettings, $notifyMode, $sort, AutoOpenRow, AutoOpenToggle, DEFAULT_EDITOR_TEMPLATE,
  EDITOR_PRESETS, EditorLinkControl, LIST_PANE, NotifyModeControl, NotifyModeSegments, ProfileControl, ReviewPane, SettingsGearButton,
  SettingsPage, SettingsPageView, SettingsSummary, SortControl, messages, openReview, openSettings, reviewPaneContribution,
  setAutoOpen, settingsPageContribution
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
  return [c, node?.props?.action, node?.props?.below].flatMap(x => (Array.isArray(x) ? x.flat(Infinity) : [x])).filter(x => x && typeof x === 'object')
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const ofType = (tree, type) => walk(tree).filter(n => n.type === type)
const text = tree => walk(tree).flatMap(n => {
  const c = n.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => typeof x === 'string')
}).join(' ')

function fakeCtx({ settingsPages = true } = {}) {
  const store = {}
  const ctx = {
    disposers: [],
    registered: [],
    pages: [],
    i18n: { register() {}, t },
    onDispose: fn => ctx.disposers.push(fn),
    registerMany: list => ctx.registered.push(...list),
    register: c => { ctx.registered.push(c); host.calls.push(`register:${c.id}`); return () => {} },
    rest: async () => ({}),
    setInterval: () => () => {},
    setTimeout: () => () => {},
    storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } },
    store
  }
  if (settingsPages) ctx.registerSettingsPage = page => { ctx.pages.push(page); return () => {} }
  return ctx
}
const dispose = ctx => ctx.disposers.forEach(fn => fn())
const start = opts => {
  host.reset()
  $inlineSettings.set(false)
  const ctx = fakeCtx(opts)
  plugin.register(ctx)
  return ctx
}
const panesOf = ctx => ctx.registered.filter(c => c.area === 'panes')

// --- registration -----------------------------------------------------------------------------

test('register adds one settings page: id settings, titled Skill Review, with an icon', () => {
  const ctx = start()
  assert.equal(ctx.pages.length, 1)
  const [page] = ctx.pages
  assert.equal(page.id, 'settings')
  assert.equal(page.title, 'Skill Review')
  assert.equal(page.icon, 'git-pull-request')
  assert.equal(page.render().type, SettingsPage)
  const { render, ...rest } = settingsPageContribution()
  assert.deepEqual(rest, { id: page.id, icon: page.icon, title: page.title })
  assert.equal(render().type, SettingsPage)
  dispose(ctx)
})

test('openReview registers only the list pane: placement right, hideOnly', () => {
  const ctx = start()
  openReview()
  assert.deepEqual(panesOf(ctx).map(p => p.id), ['list'])
  assert.deepEqual(host.calls, [`undismiss:${LIST_PANE}`, 'register:list', `reveal:${LIST_PANE}`])
  const list = reviewPaneContribution()
  assert.deepEqual(list.data, { placement: 'right', hideOnly: true, dock: { pane: 'workspace', pos: 'right' }, defaultCollapsed: true, width: '720px', minWidth: '240px' })
  assert.equal(list.render().type, ReviewPane)
  assert.ok(!/SETTINGS_PANE|settingsPaneContribution|id: 'settings', \/\/ skill-review:settings/.test(src), 'no settings pane any more')
  dispose(ctx)
})

test('the chip, palette and toast path still open the list', () => {
  const ctx = start()
  assert.ok(ctx.registered.some(c => c.area === 'statusBar.right' && c.id === 'chip'))
  ctx.registered.find(c => c.area === 'palette').data.run()
  assert.ok(host.calls.includes(`reveal:${LIST_PANE}`))
  assert.match(slice('function StatusChip()', '\nconst NOTIFY_EN'), /openReview\(\)/)
  dispose(ctx)
})

// --- the gear ---------------------------------------------------------------------------------

test('the gear opens Settings > Plugins > Skill Review through pluginSettingsHref', () => {
  const ctx = start()
  openSettings()
  assert.deepEqual(host.calls, [`navigate:${sdk.pluginSettingsHref('skill-review')}`])
  assert.deepEqual(host.calls, ['navigate:/settings?tab=plugins&plugin=skill-review'])
  assert.equal($inlineSettings.get(), false)
  dispose(ctx)
})

test('a host without settings pages shows the settings inline in the list instead', () => {
  const ctx = start({ settingsPages: false })
  openSettings()
  assert.deepEqual(host.calls, [], 'nothing to navigate to')
  assert.equal($inlineSettings.get(), true)
  openSettings()
  assert.equal($inlineSettings.get(), false, 'the gear toggles it')
  dispose(ctx)
})

test('the gear button', () => {
  let opened = 0
  const btn = SettingsGearButton({ onOpen: () => { opened++ }, t })
  assert.equal(btn.props['aria-label'], 'openSettings')
  assert.ok(walk(btn).some(n => n.props?.name === 'settings-gear'))
  btn.props.onClick()
  assert.equal(opened, 1)
})

// --- list header ------------------------------------------------------------------------------

const header = () => {
  const list = slice('function FilesListPane()', '\nfunction ')
  return list.slice(list.indexOf('const bar'), list.indexOf('let body'))
}

test('the list header has the summary and the gear, no settings controls, and keeps the kind filter', () => {
  const bar = header()
  for (const name of ['ProfileControl', 'SortControl', 'NotifyModeControl', 'AutoOpenRow', 'EditorLinkControl']) {
    assert.doesNotMatch(bar, new RegExp(`jsx\\(${name}\\b`), `${name} lives on the settings page`)
  }
  assert.match(bar, /jsx\(SettingsGearButton, \{ onOpen: openSettings, t \}\)/)
  assert.match(bar, /jsx\(SettingsSummary, \{ hidden: v\.hidden, profiles: v\.profiles, sort: v\.sort, t \}\)/)
  assert.match(bar, /KINDS\.map/)
  assert.match(bar, /inline \? jsx\(SettingsPage, \{\}\) : null/, 'the inline fallback')
})

test('the list summary follows the shared store when the settings page changes it', () => {
  const profiles = [{ profile: 'default', count: 2 }, { profile: 'dev', count: 1 }, { profile: 'ops', count: 4 }]
  assert.equal(text(SettingsSummary({ hidden: [], profiles, sort: 'newest', t })), 'settingsSummary:profilesAll:3,sort_newest')
  SortControl().props.onChange('changes')
  ProfileControl({ focused: 'default', profiles }).props.onChange(['ops'])
  assert.equal($sort.get(), 'changes')
  assert.deepEqual($hidden.get(), ['ops'])
  assert.equal(text(SettingsSummary({ hidden: $hidden.get(), profiles, sort: $sort.get(), t })), 'settingsSummary:profilesShown:2,3,sort_changes')
  assert.match(slice('function useVisibleFiles()', '\nfunction '), /\n    hidden,\n[\s\S]*\n    sort\n  }/)
  SortControl().props.onChange('newest')
  ProfileControl({ focused: 'default', profiles }).props.onChange([])
})

// --- the settings page ------------------------------------------------------------------------

test('the settings page is built from ListRow and ToggleRow and holds every control', () => {
  const profiles = [{ profile: 'default', count: 2 }]
  const view = SettingsPageView({ focused: 'default', profiles, t })
  const rows = ofType(view, sdk.ListRow)
  assert.deepEqual(rows.map(r => r.props.title), ['scopeGroup', 'sortLabel', 'notifyLabel', 'editorSettings'])
  for (const type of [ProfileControl, SortControl, NotifyModeControl, AutoOpenRow, EditorLinkControl]) {
    assert.equal(ofType(view, type).length, 1, `${type.name} is on the page`)
  }
  assert.equal(ofType(view, ProfileControl)[0].props.profiles, profiles)
  assert.equal(ofType(view, NotifyModeControl)[0].props.bare, true)
  assert.match(text(SettingsPageView({ focused: 'default', profiles: [], t })), /settingsNoProfiles/)
  assert.match(slice('export function SettingsPage()', '\n}'), /useVisibleFiles\(\)/)
})

test('the autoOpen row is a ToggleRow on the shared atom', () => {
  const ctx = start()
  const el = AutoOpenRow()
  assert.equal(el.type, AutoOpenToggle)
  assert.equal(el.props.onChange, setAutoOpen)
  const row = AutoOpenToggle({ ...el.props, on: true, t })
  assert.equal(row.type, sdk.ToggleRow)
  assert.equal(row.props.checked, true)
  assert.equal(row.props.label, 'autoOpenLabel')
  row.props.onChange(false)
  assert.equal($autoOpen.get(), false)
  assert.equal(ctx.store.autoOpen, false, 'persisted through ctx.storage')
  row.props.onChange(true)
  dispose(ctx)
})

test('the notify control on the page is the bare segmented control', () => {
  const ctx = start()
  const el = NotifyModeControl({ bare: true })
  assert.equal(el.type, NotifyModeSegments)
  const seg = NotifyModeSegments({ ...el.props, t })
  assert.equal(seg.type, sdk.SegmentedControl)
  assert.deepEqual(seg.props.options.map(o => o.id), ['popup', 'light'])
  el.props.onChange('light')
  assert.equal($notifyMode.get(), 'light')
  assert.equal(ctx.store.notifyMode, 'light')
  seg.props.onChange('popup')
  dispose(ctx)
})

test('the VS Code link control writes the shared template', () => {
  const ctx = start()
  const editor = EditorLinkControl()
  editor.props.onMode('local')
  assert.equal($editorTemplate.get(), EDITOR_PRESETS.local)
  editor.props.onMode('remote')
  assert.equal($editorTemplate.get(), DEFAULT_EDITOR_TEMPLATE)
  dispose(ctx)
})

test('strings: the page title and the gear label', () => {
  assert.equal(messages.en.settingsTitle, 'Skill Review')
  assert.equal(messages.en.openSettings, 'Skill Review settings')
})

test('the route fallback page shows the settings above the list; the SDK extras are read optionally', () => {
  assert.match(slice('function FallbackPage()', '\n}'), /jsx\(SettingsPage, \{\}\)/)
  assert.match(src, /import \* as SDK from '@hermes\/plugin-sdk'/)
  assert.doesNotMatch(slice('import {', "} from '@hermes/plugin-sdk'"), /\b(ListRow|ToggleRow|pluginSettingsHref)\b/, 'never a named import: older hosts would fail to load the plugin')
  assert.match(slice('register(ctx) {', '\n  }\n}'), /ctx\.registerSettingsPage\?\./)
})
