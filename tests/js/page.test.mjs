// The review lives on its own page: a sidebar nav row and a route, like Memory Wiki and Kanban.
// The plugin registers no layout pane at all, so Desktop has nothing to dock, enforce or turn off.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate(path) { this.navigated.push(path) },
  notify(toast) { this.toasts.push(toast) },
  notifyError() {},
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = []; this.navigated = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const H = globalThis.__host
const {
  $libEditor, $libSelection, $mode, $selection, ModeSwitch, PAGE_STYLES, REVIEW_STYLES, ReviewChip, ReviewPage, ReviewPageView,
  ReviewWorkArea, isNarrowWidth, messages, notePageMount, openReview
} = mod
const plugin = mod.default
const src = readFileSync(pluginPath, 'utf8')
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)
// The real English strings, as usePluginI18n resolves them.
const en = (k, ...a) => (typeof messages.en[k] === 'function' ? messages.en[k](...a) : messages.en[k] ?? k)

const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const textOf = node => {
  if (node == null || node === false) return ''
  if (typeof node !== 'object') return String(node)
  const c = node.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).map(textOf).join('')
}

function start({ settingsPages = false } = {}) {
  H.reset?.()
  H.navigated = []
  H.toasts = []
  const ctx = {
    disposers: [], registered: [],
    i18n: { register() {}, t },
    onDispose: fn => ctx.disposers.push(fn),
    registerMany: list => { ctx.registered.push(...list); return () => {} },
    register: c => { ctx.registered.push(c); return () => {} },
    rest: async () => ({}),
    setInterval: () => () => {},
    setTimeout: () => () => {},
    storage: { get: (k, d) => d, set() {} }
  }
  if (settingsPages) ctx.registerSettingsPage = () => () => {}
  plugin.register(ctx)
  return ctx
}
const stop = ctx => ctx.disposers.forEach(fn => fn())

// --- contributions ------------------------------------------------------------------------------

test('register adds the route page, the sidebar nav row, the palette command and the chip, and no pane', () => {
  const ctx = start()
  const areas = ctx.registered.map(c => c.area).sort()
  assert.deepEqual(areas, ['palette', 'routes', 'sidebar.nav', 'statusBar.right'])
  assert.equal(ctx.registered.filter(c => c.area === 'panes').length, 0)
  stop(ctx)
})

test('the route is /skill-review, titled Skill review, and renders the page', () => {
  const ctx = start()
  const route = ctx.registered.find(c => c.area === 'routes')
  assert.deepEqual(route.data, { path: '/skill-review' })
  assert.equal(route.title, 'Skill review')
  assert.equal(route.render().type, ReviewPage)
  stop(ctx)
})

test('the sidebar nav row points at the route with the pull-request codicon', () => {
  const ctx = start()
  const nav = ctx.registered.find(c => c.area === 'sidebar.nav')
  assert.deepEqual(nav.data, { codicon: 'git-pull-request', label: 'Skill review', path: '/skill-review' })
  stop(ctx)
})

test('the palette command and the status chip navigate to the page', () => {
  const ctx = start()
  ctx.registered.find(c => c.area === 'palette').data.run()
  assert.deepEqual(H.navigated, ['/skill-review'])
  const chip = ReviewChip({ count: 2, counts: { skills: 1, memory: 1 }, lit: false, mode: 'popup', onOpen: () => openReview(), onMode() {}, t })
  walk(chip).find(n => n.type === 'button').props.onClick()
  assert.deepEqual(H.navigated, ['/skill-review', '/skill-review'])
  assert.match(src.slice(src.indexOf('function StatusChip()'), src.indexOf('const NOTIFY_EN')), /openReview\(\)/)
  stop(ctx)
})

test('openReview keeps the mode the user left the page in; openReview({ pending: true }) switches to Pending', () => {
  const ctx = start()
  $libEditor.set(null)
  $mode.set('library')
  openReview()
  assert.equal($mode.get(), 'library')
  openReview({ pending: true })
  assert.equal($mode.get(), 'pending')
  assert.deepEqual(H.navigated, ['/skill-review', '/skill-review'])
  stop(ctx)
})

test('openReview({ pending: true }) asks before it drops unsaved Library text', () => {
  const ctx = start()
  $mode.set('library')
  $libSelection.set('dev/k')
  $libEditor.set({ id: 'dev/k', original: 'a', text: 'b' })
  openReview({ pending: true })
  assert.equal($mode.get(), 'library', 'still in Library until the user confirms')
  assert.deepEqual(H.navigated, ['/skill-review'], 'the page opens so the discard dialog is on screen')
  assert.ok(mod.$libDiscard.get(), 'the discard dialog is open')
  mod.cancelDiscard()
  $libEditor.set(null)
  $libSelection.set(null)
  $mode.set('pending')
  stop(ctx)
})

// --- the pane is gone ---------------------------------------------------------------------------

test('no pane code is left: no pane id, dock, hideOnly, sidebar toggle or pane reveal', () => {
  for (const name of ['LIST_PANE', 'reviewPaneContribution', 'SidebarHideControl', 'hideSidebar', 'canHideSidebar', 'ReviewPane', 'FallbackPage']) {
    assert.equal(mod[name], undefined, `${name} is removed`)
  }
  assert.doesNotMatch(src, /hideOnly|enforce: true|PANES_AREA|area: 'panes'/)
  assert.doesNotMatch(src, /\brunAction\b|toggleRightSidebar|revealPane|undismissPane|paneVisibility|openWorkspace|useRouteFallback/)
  assert.doesNotMatch(src, /`\$\{ID\}:list`|'skill-review:list'/)
})

test('the list headers no longer carry the mode switch or a Hide button', () => {
  const files = src.slice(src.indexOf('export function FilesListPane()'), src.indexOf('export function FilesEmpty('))
  const lib = src.slice(src.indexOf('export function LibraryListPane()'), src.indexOf('const textLines'))
  for (const body of [files, lib]) {
    assert.doesNotMatch(body, /ModeControl|SidebarHide/)
    assert.match(body, /SettingsGearButton/, 'the gear stays')
  }
  assert.equal(messages.en.hideSidebar, undefined)
})

// --- the page -----------------------------------------------------------------------------------

test('the page: title, one lede sentence, the mode buttons, then the work area', () => {
  const page = ReviewPageView({ mode: 'pending', onMode() {}, t: en, total: 3 })
  const nodes = walk(page)
  const h1 = nodes.find(n => n.type === 'h1')
  assert.equal(textOf(h1), 'Skill review')
  const lede = nodes.find(n => n.type === 'p')
  assert.equal(textOf(lede), 'Changes your agents want to make to their skills and memory. Nothing is saved until you accept it. Library lets you read and edit the saved files directly.')
  const order = nodes.filter(n => n.type === 'h1' || n.type === 'p' || n.type === ModeSwitch || n.type === ReviewWorkArea).map(n => n.type)
  assert.deepEqual(order, ['h1', 'p', ModeSwitch, ReviewWorkArea])
})

test('the mode switch is two buttons like Memory Wiki: the active one pressed, Pending with its count', () => {
  const changes = []
  const view = ModeSwitch({ mode: 'pending', onChange: m => changes.push(m), t: en, total: 3 })
  assert.equal(view.type, 'div')
  assert.equal(view.props.role, 'group')
  const buttons = walk(view).filter(n => n.type?.name === 'Button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].props['aria-pressed'], true)
  assert.equal(buttons[0].props.variant, 'secondary')
  assert.equal(buttons[1].props['aria-pressed'], false)
  assert.equal(buttons[1].props.variant, 'outline')
  assert.equal(textOf(buttons[0]), 'Pending3')
  assert.equal(buttons[0].props['aria-label'], 'Pending, 3 changes')
  assert.equal(textOf(buttons[1]), 'Library')
  buttons[1].props.onClick()
  buttons[0].props.onClick()
  assert.deepEqual(changes, ['library', 'pending'])
})

test('the mode switch hides a zero count and treats an unknown mode as Pending', () => {
  const view = ModeSwitch({ mode: 'bogus', onChange() {}, t: en, total: 0 })
  const buttons = walk(view).filter(n => n.type?.name === 'Button')
  assert.equal(textOf(buttons[0]), 'Pending')
  assert.equal(buttons[0].props['aria-pressed'], true)
})

test('the page fills the workspace pane and scrolls only when it is too short for the work area', () => {
  const { root, header, work } = PAGE_STYLES
  assert.equal(root.height, '100%')
  assert.equal(root.minWidth, 0)
  assert.equal(root.overflowX, 'hidden')
  assert.equal(root.overflowY, 'auto')
  assert.equal(root.boxSizing, 'border-box')
  assert.equal(header.minWidth, 0)
  assert.equal(work.flex, '1 1 auto')
  assert.equal(work.minWidth, 0)
  assert.equal(work.minHeight, '16rem')
  assert.equal(work.overflow, 'hidden')
  const json = JSON.stringify(PAGE_STYLES)
  assert.doesNotMatch(json, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(json, /\b(?:rgb|rgba|hsl|hsla|oklch)\(/)
})

test('at a ~1000px main area the list and detail sit side by side; under 560px they take turns', () => {
  // 1000px main width minus the page padding on both sides.
  assert.equal(isNarrowWidth(1000 - 2 * 20), false)
  assert.equal(REVIEW_STYLES.list.flex, '0 0 300px')
  assert.equal(REVIEW_STYLES.detail.minWidth, 0)
  assert.equal(isNarrowWidth(540), true)
})

test('the page counts as seen while it is mounted', () => {
  const ctx = start()
  const before = Date.now()
  const cleanup = notePageMount()
  assert.ok(mod.$lit.get() === false)
  assert.equal(typeof cleanup, 'function')
  assert.match(src.slice(src.indexOf('function startWatcher('), src.indexOf('// ----', src.indexOf('function startWatcher('))), /pageMounted\(\)/)
  assert.ok(mod.pageMounted())
  cleanup()
  assert.ok(!mod.pageMounted())
  assert.ok(Date.now() >= before)
  stop(ctx)
})

test('ReviewPage hands the view the shared mode and the Pending total', () => {
  const body = src.slice(src.indexOf('export function ReviewPage()'), src.indexOf('\n}\n', src.indexOf('export function ReviewPage()')))
  assert.match(body, /useEffect\(\(\) => notePageMount\(\), \[\]\)/)
  assert.match(body, /onMode: setMode/)
  assert.match(body, /pendingTotal\(/)
})

// --- unsaved Library text -----------------------------------------------------------------------
// Desktop's public SDK has no route-leave hook (host.navigate only sets the hash), so the plugin
// gates the navigations it starts itself, and a draft left behind by a sidebar click stays in the
// module atoms and is flagged on the page when the user comes back.

const SOUL_ID = 'dev/soulKey'
const draft = (extra = {}) => ({ id: SOUL_ID, profile: 'dev', key: 'soulKey', name: 'SOUL.md', skill: null, original: 'a', text: 'b', ...extra })
const withDraft = () => {
  mod.$libDiscard.set(null)
  $mode.set('library')
  $libSelection.set(SOUL_ID)
  $libEditor.set(draft())
}
const clearDraft = () => {
  mod.$libDiscard.set(null)
  $libEditor.set(null)
  $libSelection.set(null)
  $mode.set('pending')
}

test('the gear asks before it leaves for Settings with unsaved Library text, then goes on Discard', () => {
  const ctx = start({ settingsPages: true })
  withDraft()
  mod.openSettings()
  assert.deepEqual(H.navigated, [], 'nothing leaves the page yet')
  assert.ok(mod.$libDiscard.get(), 'the discard dialog is open')
  mod.confirmDiscard()
  assert.deepEqual(H.navigated, ['/settings?tab=plugins&plugin=skill-review'])
  assert.equal($libEditor.get(), null, 'Discard drops the text')
  clearDraft()
  stop(ctx)
})

test('Cancel on the gear prompt stays on the page with the text kept', () => {
  const ctx = start({ settingsPages: true })
  withDraft()
  mod.openSettings()
  mod.cancelDiscard()
  assert.deepEqual(H.navigated, [])
  assert.equal($libEditor.get().text, 'b')
  assert.equal($mode.get(), 'library')
  clearDraft()
  stop(ctx)
})

test('the gear goes straight to Settings when nothing is unsaved', () => {
  const ctx = start({ settingsPages: true })
  clearDraft()
  mod.openSettings()
  assert.deepEqual(H.navigated, ['/settings?tab=plugins&plugin=skill-review'])
  assert.equal(mod.$libDiscard.get(), null)
  stop(ctx)
})

test('the Pending button on the page asks before it drops unsaved Library text', () => {
  const ctx = start()
  withDraft()
  const page = ReviewPageView({ mode: 'library', onMode: mod.setMode, t: en, total: 0 })
  const pending = walk(page).filter(n => n.type === ModeSwitch).map(n => ModeSwitch(n.props))[0]
  walk(pending).find(n => n.key === 'pending').props.onClick()
  assert.equal($mode.get(), 'library')
  assert.ok(mod.$libDiscard.get())
  clearDraft()
  stop(ctx)
})

test('the status button and palette on the page keep the draft: same page, no prompt, mode unchanged', () => {
  const ctx = start()
  withDraft()
  ctx.registered.find(c => c.area === 'palette').data.run()
  const chip = ReviewChip({ count: 0, counts: { skills: 0, memory: 0 }, lit: false, mode: 'popup', onOpen: () => openReview(), onMode() {}, t })
  walk(chip).find(n => n.type === 'button').props.onClick()
  assert.deepEqual(H.navigated, ['/skill-review', '/skill-review'])
  assert.equal(mod.$libDiscard.get(), null)
  assert.equal($mode.get(), 'library')
  assert.equal($libEditor.get().text, 'b')
  clearDraft()
  stop(ctx)
})

test('the toast Open goes to the page and asks there before switching to Pending', () => {
  const ctx = start()
  withDraft()
  openReview({ pending: true })
  assert.deepEqual(H.navigated, ['/skill-review'])
  assert.equal($mode.get(), 'library')
  assert.ok(mod.$libDiscard.get())
  mod.confirmDiscard()
  assert.equal($mode.get(), 'pending')
  clearDraft()
  stop(ctx)
})

test('coming back after leaving another way: Library, the same file, the unsaved text', () => {
  const ctx = start()
  withDraft()
  // A sidebar click leaves without the plugin knowing; then the page mounts again.
  const unmount = notePageMount()
  assert.equal($mode.get(), 'library')
  assert.equal($libSelection.get(), SOUL_ID)
  const fresh = { status: 'ok', file: { key: 'soulKey', name: 'SOUL.md', kind: 'identity' }, text: 'a', version: 'v2' }
  assert.equal(mod.librarySession($libEditor.get(), SOUL_ID, fresh).text, 'b', 'a refetch never replaces the kept text')
  const tree = mod.LibraryTree({ dirtyId: SOUL_ID, onSelect() {}, onToggle() {}, rows: [{ type: 'file', id: SOUL_ID, depth: 2, label: 'SOUL.md' }], selection: SOUL_ID, t })
  assert.ok(walk(tree).some(n => n.props?.['data-dirty']), 'the tree row keeps its dirty marker')
  unmount()
  clearDraft()
  stop(ctx)
})

test('draftLabel names the file with its profile, and a skill file with its skill', () => {
  assert.equal(mod.draftLabel(draft()), 'dev/SOUL.md')
  assert.equal(mod.draftLabel(draft({ name: 'references/a.md', skill: 'council' })), 'dev/council/references/a.md')
  assert.equal(mod.draftLabel(null), '')
})

test('the Library switch carries an Unsaved changes notice while a draft is kept', () => {
  const view = ModeSwitch({ mode: 'pending', onChange() {}, t: en, total: 0, unsaved: 'dev/SOUL.md' })
  const library = walk(view).find(n => n.key === 'library')
  assert.ok(walk(library).some(n => n.props?.['data-dirty']), 'a dot on the Library button')
  assert.equal(library.props['aria-label'], 'Library, unsaved changes in dev/SOUL.md')
  const notice = walk(view).find(n => n.props?.role === 'status')
  assert.equal(textOf(notice), 'Unsaved changes in dev/SOUL.md')
  assert.equal(notice.props.title, 'Unsaved changes in dev/SOUL.md')
  const clean = ModeSwitch({ mode: 'library', onChange() {}, t: en, total: 0, unsaved: '' })
  assert.ok(!walk(clean).some(n => n.props?.role === 'status' || n.props?.['data-dirty']))
})

test('ReviewPage hands the switch the kept draft, only while it differs from the file', () => {
  const body = src.slice(src.indexOf('export function ReviewPage()'), src.indexOf('\n}\n', src.indexOf('export function ReviewPage()')))
  assert.match(body, /useValue\(\$libEditor\)/)
  assert.match(body, /isDirty\(editing\) \? draftLabel\(editing\) : ''/)
  const view = src.slice(src.indexOf('export function ReviewPageView('), src.indexOf('\n}\n', src.indexOf('export function ReviewPageView(')))
  assert.match(view, /jsx\(ModeSwitch, \{ mode, onChange: onMode, t, total, unsaved \}\)/)
})
