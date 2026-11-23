// Tests for the review settings on Settings > Plugins > Skill Review (ctx.registerSettingsPage):
// profile subset, sort order and notify mode. The list header keeps a summary and a gear that
// opens that page. The review itself is a route page; the plugin registers no pane.
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
  $inlineSettings, $notifyMode, $sort, NotifyModeControl, NotifyModeSegments, ReviewPage, SettingsGearButton,
  SettingsPage, SettingsPageView, SettingsSummary, SortControl, messages, openReview, openSettings, settingsPageContribution
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

test('openReview opens the page and registers nothing; there is no settings pane', () => {
  const ctx = start()
  const before = ctx.registered.length
  openReview()
  assert.equal(panesOf(ctx).length, 0)
  assert.equal(ctx.registered.length, before)
  assert.deepEqual(host.calls, ['navigate:/skill-review'])
  assert.equal(ctx.registered.find(c => c.area === 'routes').render().type, ReviewPage)
  assert.ok(!/SETTINGS_PANE|settingsPaneContribution|id: 'settings', \/\/ skill-review:settings/.test(src), 'no settings pane any more')
  dispose(ctx)
})

test('the chip, palette and toast path open the page', () => {
  const ctx = start()
  assert.ok(ctx.registered.some(c => c.area === 'statusBar.right' && c.id === 'chip'))
  ctx.registered.find(c => c.area === 'palette').data.run()
  assert.ok(host.calls.includes('navigate:/skill-review'))
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
  for (const name of ['SortControl', 'NotifyModeControl']) {
    assert.doesNotMatch(bar, new RegExp(`jsx\\(${name}\\b`), `${name} lives on the settings page`)
  }
  assert.match(bar, /jsx\(SettingsGearButton, \{ onOpen: openSettings, t \}\)/)
  assert.match(bar, /jsx\(ConnectedProfile, \{ profile: v\.profile, t \}\)/)
  assert.match(bar, /jsx\(SettingsSummary, \{ sort: v\.sort, t \}\)/)
  assert.match(bar, /KINDS\.map/)
  assert.match(bar, /inline \? jsx\(SettingsPage, \{\}\) : null/, 'the inline fallback')
})

test('the list summary follows the shared sort when the settings page changes it', () => {
  assert.equal(text(SettingsSummary({ sort: 'newest', t })), 'sort_newest')
  SortControl().props.onChange('changes')
  assert.equal($sort.get(), 'changes')
  assert.equal(text(SettingsSummary({ sort: $sort.get(), t })), 'sort_changes')
  SortControl().props.onChange('newest')
})

// --- the settings page ------------------------------------------------------------------------

test('the settings page is built from ListRow and holds the sort and notify controls, no profile picker', () => {
  const view = SettingsPageView({ t })
  const rows = ofType(view, sdk.ListRow)
  assert.deepEqual(rows.map(r => r.props.title), ['sortLabel', 'notifyLabel'])
  assert.equal(kids(view).length, 2, 'sort and notify mode, nothing else')
  for (const type of [SortControl, NotifyModeControl]) {
    assert.equal(ofType(view, type).length, 1, `${type.name} is on the page`)
  }
  assert.equal(ofType(view, NotifyModeControl)[0].props.bare, true)
  assert.equal(mod.ProfileControl, undefined)
  assert.equal(messages.en.settingsProfilesHelp, undefined)
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

test('strings: the page title, the gear label and the notify help', () => {
  assert.equal(messages.en.settingsTitle, 'Skill Review')
  assert.equal(messages.en.openSettings, 'Skill Review settings')
  assert.equal(messages.en.settingsNotifyHelp, 'Popup shows a notification with an Open button. Light up icon marks the Review chip instead.')
})

test('the SDK extras are read optionally', () => {
  assert.match(src, /import \* as SDK from '@hermes\/plugin-sdk'/)
  assert.doesNotMatch(slice('import {', "} from '@hermes/plugin-sdk'"), /\b(ListRow|ToggleRow|pluginSettingsHref|SIDEBAR_NAV_AREA)\b/, 'never a named import: older hosts would fail to load the plugin')
  assert.match(src, /SDK\.SIDEBAR_NAV_AREA \?\? 'sidebar\.nav'/)
  assert.match(slice('register(ctx) {', '\n  }\n}'), /ctx\.registerSettingsPage\?\./)
})
