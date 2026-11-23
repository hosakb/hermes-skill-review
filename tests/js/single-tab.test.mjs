// Tests for the review work area on the page: the list and the diff side by side, stacked (list,
// then diff with Back) when the work area is narrower than the breakpoint.
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
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $kind, $selection, $sort, REVIEW_NARROW_PX, REVIEW_STYLES, ReviewLayout, ReviewWorkArea, isNarrowWidth,
  observeWidth, openReview
} = mod
const plugin = mod.default
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)
const src = readFileSync(pluginPath, 'utf8')

const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const named = (tree, name) => walk(tree).filter(n => typeof n.type === 'function' && n.type.name === name)
const columns = tree => kids(tree)
const visible = col => col.props.style?.visibility !== 'hidden' && col.props['aria-hidden'] !== true
const visibleColumns = tree => columns(tree).filter(visible)

function fakeCtx() {
  const store = {}
  const ctx = {
    disposers: [],
    registered: [],
    i18n: { register() {}, t },
    onDispose: fn => ctx.disposers.push(fn),
    registerMany: list => ctx.registered.push(...list),
    register: c => { ctx.registered.push(c); return () => {} },
    rest: async () => ({}),
    setInterval: () => () => {},
    setTimeout: () => () => {},
    storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } }
  }
  return ctx
}
const dispose = ctx => ctx.disposers.forEach(fn => fn())

// --- registration -----------------------------------------------------------------------------

test('the page holds one work area, and the plugin registers no pane for it', () => {
  host.reset()
  const ctx = fakeCtx()
  plugin.register(ctx)
  openReview()
  assert.deepEqual(ctx.registered.filter(c => c.area === 'panes'), [])
  const page = ctx.registered.find(c => c.area === 'routes').render()
  assert.equal(page.type, mod.ReviewPage)
  dispose(ctx)
})

test('no detail pane is registered and nothing refers to its id any more', () => {
  const ctx = fakeCtx()
  plugin.register(ctx)
  assert.ok(!ctx.registered.some(c => c.id === 'detail'))
  assert.equal(mod.DETAIL_PANE, undefined)
  assert.ok(!/skill-review:detail|DETAIL_PANE|\bid: 'detail'/.test(src), 'no code path reveals or docks to the old detail pane')
  dispose(ctx)
})

test('the Review action (chip, palette) opens the page and keeps the selection', () => {
  host.reset()
  const ctx = fakeCtx()
  plugin.register(ctx)
  $selection.set('skills/default/k')
  ctx.registered.find(c => c.area === 'palette').data.run()
  assert.equal(host.navigated, '/skill-review')
  assert.equal($selection.get(), 'skills/default/k')
  $selection.set(null)
  dispose(ctx)
})

// --- breakpoint -------------------------------------------------------------------------------

test('the breakpoint is a named 560px constant; unknown widths fall back to side by side', () => {
  assert.equal(REVIEW_NARROW_PX, 560)
  assert.equal(isNarrowWidth(559), true)
  assert.equal(isNarrowWidth(320), true)
  assert.equal(isNarrowWidth(560), false)
  assert.equal(isNarrowWidth(900), false)
  assert.equal(isNarrowWidth(null), false, 'not measured yet')
  assert.equal(isNarrowWidth(0), false, 'a hidden work area measures 0: keep the wide layout')
})

test('observeWidth reports the work area width through ResizeObserver and disconnects on cleanup', () => {
  const seen = []
  let instance
  class FakeRO {
    constructor(cb) { this.cb = cb; this.observed = []; this.disconnected = false; instance = this }
    observe(node) { this.observed.push(node) }
    disconnect() { this.disconnected = true }
  }
  const node = {}
  const stop = observeWidth(node, w => seen.push(w), FakeRO)
  assert.deepEqual(instance.observed, [node])
  instance.cb([{ contentRect: { width: 480 } }])
  instance.cb([{ contentRect: { width: 700 } }])
  assert.deepEqual(seen, [480, 700])
  stop()
  assert.equal(instance.disconnected, true)
})

test('without ResizeObserver, or before the node exists, nothing is observed and the work area stays wide', () => {
  const seen = []
  assert.equal(observeWidth({}, w => seen.push(w), undefined), undefined)
  assert.equal(observeWidth(null, w => seen.push(w), class { observe() { throw new Error('no') } }), undefined)
  assert.deepEqual(seen, [])
  // The stubbed hooks never measure, which is the no-ResizeObserver case: both columns show.
  $selection.set(null)
  const pane = ReviewWorkArea({})
  assert.equal(pane.type, ReviewLayout)
  assert.equal(pane.props.narrow, false)
  assert.equal(visibleColumns(ReviewLayout(pane.props)).length, 2)
})

// --- layout -----------------------------------------------------------------------------------

test('wide: both columns render side by side, list on the left with a divider, detail on the right', () => {
  const tree = ReviewLayout({ narrow: false, onBack() {}, selection: null, t })
  assert.equal(tree.props.style.flexDirection, 'row')
  const cols = columns(tree)
  assert.deepEqual(cols.map(c => c.key), ['list', 'detail'])
  assert.equal(visibleColumns(tree).length, 2)
  assert.equal(named(cols[0], 'FilesListPane').length, 1)
  assert.equal(named(cols[1], 'FileDetailPane').length, 1, 'empty selection: the detail column shows its empty state')
  assert.match(cols[0].props.style.flex, /^0 0 (2[6-9]\d|3[01]\d|320)px$/, 'fixed list basis of 260 to 320px')
  assert.equal(cols[0].props.style.borderRight, '1px solid var(--ui-stroke-secondary)')
  assert.equal(cols[1].props.style.flex, '1 1 0')
  assert.equal(walk(tree).filter(n => n.props?.['data-review-back']).length, 0, 'no Back button when both columns show')
})

test('wide: selecting a file fills the detail column and leaves the list on screen', () => {
  const tree = ReviewLayout({ narrow: false, onBack() {}, selection: 'skills:default:SKILL.md', t })
  const cols = visibleColumns(tree)
  assert.equal(cols.length, 2)
  assert.equal(named(cols[0], 'FilesListPane').length, 1)
  assert.equal(named(cols[1], 'FileDetailPane').length, 1)
  assert.equal(walk(tree).filter(n => n.props?.['data-review-back']).length, 0)
})

test('narrow with nothing selected: only the list shows', () => {
  const tree = ReviewLayout({ narrow: true, onBack() {}, selection: null, t })
  const cols = visibleColumns(tree)
  assert.equal(cols.length, 1)
  assert.equal(cols[0].key, 'list')
  assert.equal(named(tree, 'FileDetailPane').length, 0)
})

test('narrow with a file selected: only the detail shows, with Back at the top; the list stays mounted', () => {
  const tree = ReviewLayout({ narrow: true, onBack() {}, selection: 'skills:default:SKILL.md', t })
  const cols = visibleColumns(tree)
  assert.equal(cols.length, 1)
  assert.equal(cols[0].key, 'detail')
  const [first] = kids(cols[0])
  assert.ok(first.props['data-review-back'], 'Back is the first thing in the detail column')
  assert.equal(named(cols[0], 'FileDetailPane').length, 1)
  const list = columns(tree).find(c => c.key === 'list')
  assert.ok(list, 'the list is kept, hidden, so its scroll position survives')
  assert.equal(list.props.style.visibility, 'hidden')
  assert.equal(list.props['aria-hidden'], true)
})

test('Back clears the selection, returns to the list and leaves every filter as it was', () => {
  $kind.set('memory')
  $sort.set('name')
  $selection.set('memory:default:MEMORY.md')
  const before = ReviewLayout({ narrow: true, onBack: () => $selection.set(null), selection: $selection.get(), t })
  const listBefore = columns(before).find(c => c.key === 'list')
  const back = walk(before).find(n => n.props?.['data-review-back'])
  const button = walk(back).find(n => typeof n.props?.onClick === 'function')
  button.props.onClick()
  assert.equal($selection.get(), null)
  assert.equal($kind.get(), 'memory')
  assert.equal($sort.get(), 'name')
  const after = ReviewLayout({ narrow: true, onBack() {}, selection: $selection.get(), t })
  const cols = visibleColumns(after)
  assert.equal(cols.length, 1)
  assert.equal(cols[0].key, 'list')
  // Same key, type and position: React keeps the list instance, so its scroll position is kept.
  const listAfter = columns(after)[0]
  assert.equal(listAfter.key, listBefore.key)
  assert.equal(listAfter.type, listBefore.type)
  assert.equal(columns(before)[0], listBefore)
  $kind.set('all'); $sort.set('newest')
})

test('ReviewWorkArea Back button wiring clears the shared selection atom', () => {
  $selection.set('skills:default:SKILL.md')
  const layout = ReviewWorkArea({})
  // ReviewWorkArea hands its layout an onBack bound to the atom; call it through the rendered layout.
  const inner = layout.type === ReviewLayout ? layout : walk(layout).find(n => n.type === ReviewLayout)
  assert.ok(inner, 'ReviewWorkArea renders ReviewLayout')
  inner.props.onBack()
  assert.equal($selection.get(), null)
})

// --- styles -----------------------------------------------------------------------------------

test('columns clip on their own, never force the page wider, and use theme variables only', () => {
  const { root, list, detail, back } = REVIEW_STYLES
  assert.equal(root.minWidth, 0)
  assert.equal(root.overflow, 'hidden')
  for (const col of [list, detail]) {
    assert.equal(col.minWidth, 0)
    assert.equal(col.minHeight, 0)
    assert.equal(col.overflow, 'hidden', 'each column scrolls inside itself, not with the other')
    assert.equal(col.display, 'flex')
    assert.equal(col.flexDirection, 'column')
  }
  assert.equal(mod.STYLES.listScroll.overflowY, 'auto', 'the list scrolls in its own box')
  assert.equal(mod.STYLES.detailScroll.overflowY, 'auto', 'the diff scrolls in its own box')
  const all = JSON.stringify(REVIEW_STYLES)
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(all), 'no hex colours')
  assert.ok(!/rgba?\(|hsla?\(/i.test(all), 'no rgb or hsl literals')
  for (const value of all.match(/(border[A-Za-z]*|color|background)":"[^"]*"/g) ?? []) {
    assert.match(value, /var\(--ui-|transparent|none|^[a-zA-Z]+":"0"$/, value)
  }
  assert.equal(back.flex, 'none')
  const block = src.slice(src.indexOf('export const REVIEW_STYLES'), src.indexOf('export function ReviewWorkArea'))
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(block), 'no colour literals anywhere in the wrapper code')
})
