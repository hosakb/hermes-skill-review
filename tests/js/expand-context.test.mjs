// Tests for context expansion in the composite diff: a few grey lines next to each change, the rest
// folded into expand rows that reveal EXPAND_STEP lines at a time or the whole gap.
// Same stub setup as file-diff.test.mjs, kept in its own file so both can change independently.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CREATE_DIFF, MEMORY_DIFF, MEMORY_FILE, SKILL_FILE, T0 } from './fixtures.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

globalThis.__host ??= { notify() {}, notifyError() {}, state: { profile: { get: () => 'default' } } }
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  CONTEXT_LINES, EXPAND_STEP, EXPAND_STYLES, STYLES, DiffRow, ExpandRow, FileDetailView, FileDiffView, contextPlan,
  expandGap, expansionFor, messages
} = mod
const en = messages.en
const t = (k, ...a) => (typeof en[k] === 'function' ? en[k](...a) : en[k] ?? k)

// --- tree helpers over the jsx() stub ({ type, props, key }) -----------------------------------
const OWN = new Set(Object.values(mod).filter(v => typeof v === 'function'))
const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
const expand = node => {
  if (!node || typeof node !== 'object') return node
  if (OWN.has(node.type)) return expand(node.type(node.props))
  const c = node.props?.children
  if (c === undefined) return node
  const next = Array.isArray(c) ? c.flat(Infinity).map(expand) : expand(c)
  return { ...node, props: { ...node.props, children: next } }
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const text = node => walk(node).flatMap(n => {
  const c = n.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => typeof x === 'string' || typeof x === 'number')
}).join(' ')
const expandButtons = node => walk(node).filter(n => n.type === 'button' && n.props?.['data-expand'])
const expandRows = node => walk(node).filter(n => n.props?.['data-gap'])
const contextNos = node => walk(node).filter(n => n.props?.['aria-label'] === en.row_context).map(r => kids(r)[0].props.children)

// --- fixture: one long file, three changes -----------------------------------------------------
// Lines 1-20 above the first change, 22-45 between the first and second, 47-52 between the second
// and third (6 lines: fully shown), 53-60 below the last (8 lines: 3 shown, 5 hidden).
const ctx = (from, to) => ({ type: 'context', lines: Array.from({ length: to - from + 1 }, (_, i) => ({ no: from + i, text: `line ${from + i}` })) })
const blk = (id, fields) => ({ type: 'block', block: { id, record_id: id, op_index: 0, state: 'pending', staged_at: T0, origin: 'chat', summary: id, reason: null, conflicts_with: null, can_accept: true, removed: [], added: [], ...fields } })
const LONG = [
  ctx(1, 20),
  blk('b1', { removed: [{ no: 21, text: 'old 21' }], added: [{ no: 21, text: 'new 21' }] }),
  ctx(22, 45),
  blk('b2', { removed: [{ no: 46, text: 'old 46' }] }),
  ctx(47, 52),
  blk('b3', { added: [{ no: 52, text: '§' }, { no: 53, text: 'new entry' }] }),
  ctx(53, 60)
]
const FILE = { ...MEMORY_FILE, version: 'v1' }
const gaps = plan => plan.filter(p => p.type === 'gap')
const visible = plan => plan.filter(p => p.type === 'context').flatMap(p => p.lines.map(l => l.no))
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

test('constants: three context lines by default, ten per step', () => {
  assert.equal(CONTEXT_LINES, 3)
  assert.equal(EXPAND_STEP, 10)
})

test('default plan: three lines next to each change, the rest folded, small gaps joined', () => {
  const plan = contextPlan(LONG, {})
  assert.deepEqual(visible(plan), [...range(18, 20), ...range(22, 24), ...range(43, 45), ...range(47, 52), ...range(53, 55)])
  assert.deepEqual(gaps(plan).map(g => [g.position, g.hidden]), [['top', 17], ['between', 18], ['bottom', 5]])
  assert.deepEqual(plan.map(p => p.type), ['gap', 'context', 'block', 'context', 'gap', 'context', 'block', 'context', 'block', 'context', 'gap'])
})

test('expand rows read the step and the hidden count, by position', () => {
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, onExpand() {}, prior: null, segments: LONG, gaps: {}, t }))
  const [top, between, bottom] = expandRows(tree)
  assert.deepEqual(expandButtons(top).map(b => text(b)), ['Show 10 more lines above', 'Show all 17 hidden lines'])
  assert.deepEqual(expandButtons(between).map(b => text(b)), ['Show 10 more lines', 'Show 10 more lines', 'Show all 18 hidden lines'])
  assert.deepEqual(expandButtons(bottom).map(b => text(b)), ['Show all 5 hidden lines'], 'a gap of ten or fewer offers only Show all')
})

test('expand buttons are real buttons with aria-labels naming direction and count', () => {
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, onExpand() {}, prior: null, segments: LONG, gaps: {}, t }))
  const labels = expandButtons(tree).map(b => [b.type, b.props.type, b.props['aria-label']])
  assert.deepEqual(labels, [
    ['button', 'button', 'Show 10 more lines above, 17 hidden'],
    ['button', 'button', 'Show all 17 hidden lines above'],
    ['button', 'button', 'Show 10 more lines below the change above, 18 hidden'],
    ['button', 'button', 'Show 10 more lines above the change below, 18 hidden'],
    ['button', 'button', 'Show all 18 hidden lines between these changes'],
    ['button', 'button', 'Show all 5 hidden lines below']
  ])
  for (const b of expandButtons(tree)) assert.ok(!b.props.disabled, 'expansion is local, never disabled')
})

test('clicks report the gap and direction; alt-click shows everything', () => {
  const seen = []
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, onExpand: (id, dir) => seen.push([id, dir]), prior: null, segments: LONG, gaps: {}, t }))
  const [up, topAll, down, up2, midAll, bottomAll] = expandButtons(tree)
  up.props.onClick({ altKey: false })
  up.props.onClick({ altKey: true })
  topAll.props.onClick({})
  down.props.onClick({})
  up2.props.onClick()
  midAll.props.onClick({})
  bottomAll.props.onClick({})
  assert.deepEqual(seen, [['1-20', 'up'], ['1-20', 'all'], ['1-20', 'all'], ['22-45', 'down'], ['22-45', 'up'], ['22-45', 'all'], ['53-60', 'all']])
})

test('stepping above reveals ten lines upward, then the small rest is Show all', () => {
  let state = expansionFor(null, FILE)
  state = expandGap(state, FILE, '1-20', 'up')
  let plan = contextPlan(LONG, state.gaps)
  assert.deepEqual(visible(plan).slice(0, 13), range(8, 20))
  assert.equal(gaps(plan)[0].hidden, 7)
  const row = expand(ExpandRow({ gap: gaps(plan)[0], onExpand() {}, t }))
  assert.deepEqual(expandButtons(row).map(b => text(b)), ['Show all 7 hidden lines'])
  state = expandGap(state, FILE, '1-20', 'up')
  plan = contextPlan(LONG, state.gaps)
  assert.equal(gaps(plan)[0].position, 'between', 'top gap is fully shown, its row is gone')
  assert.deepEqual(visible(plan).slice(0, 20), range(1, 20))
})

test('between two changes: down extends below the upper change, up extends above the lower one', () => {
  let state = expandGap(null, FILE, '22-45', 'down')
  let mid = gaps(contextPlan(LONG, state.gaps)).find(g => g.position === 'between')
  assert.equal(mid.hidden, 8)
  assert.deepEqual([mid.firstHidden, mid.lastHidden], [35, 42])
  state = expandGap(state, FILE, '22-45', 'up')
  const plan = contextPlan(LONG, state.gaps)
  assert.equal(gaps(plan).filter(g => g.position === 'between').length, 0, 'the gap is closed')
  assert.deepEqual(visible(plan).filter(n => n >= 22 && n <= 45), range(22, 45))
  const rows = plan.filter(p => p.type === 'context' && p.lines[0].no === 22)
  assert.equal(rows.length, 1, 'the joined gap is one run of lines, no row between')
})

test('Show all merges the gap, and blocks with a small gap are joined without a row', () => {
  const state = expandGap(null, FILE, '22-45', 'all')
  const plan = contextPlan(LONG, state.gaps)
  assert.deepEqual(gaps(plan).map(g => g.position), ['top', 'bottom'])
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, onExpand() {}, prior: null, segments: LONG, gaps: state.gaps, t }))
  assert.deepEqual(contextNos(tree).filter(n => n >= 22 && n <= 52), [...range(22, 45), ...range(47, 52)])
  assert.equal(expandRows(tree).length, 2)
})

test('top and bottom of the file: no row when nothing is hidden', () => {
  const small = [ctx(1, 3), blk('a', { added: [{ no: 4, text: 'x' }] }), ctx(4, 6)]
  assert.equal(gaps(contextPlan(small, {})).length, 0)
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, onExpand() {}, prior: null, segments: small, gaps: {}, t }))
  assert.equal(expandRows(tree).length, 0)
  assert.deepEqual(contextNos(tree), [1, 2, 3, 4, 5, 6])
  const atStart = [blk('a', { removed: [{ no: 1, text: 'x' }] }), ctx(2, 40)]
  assert.deepEqual(gaps(contextPlan(atStart, {})).map(g => [g.position, g.hidden]), [['bottom', 36]])
  const atEnd = [ctx(1, 30), blk('a', { added: [{ no: 31, text: 'x' }] })]
  assert.deepEqual(gaps(contextPlan(atEnd, {})).map(g => [g.position, g.hidden]), [['top', 27]])
})

test('existing fixtures keep every context line: their gaps are three lines or fewer', () => {
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, prior: null, segments: MEMORY_DIFF.segments, t }))
  assert.deepEqual(contextNos(tree), [1, 2, 4, 7])
  assert.equal(expandRows(tree).length, 0)
})

test('a new-file create and a stale block on a missing file have no expand rows', () => {
  const create = expand(FileDiffView({ busy: false, onBlock() {}, onExpand() {}, prior: null, segments: CREATE_DIFF.segments, gaps: {}, t }))
  assert.equal(expandRows(create).length, 0)
  const staleGone = [blk('s', { state: 'stale', can_accept: false, reason: 'The skill no longer exists.', added: [] })]
  const stale = expand(FileDiffView({ busy: false, onBlock() {}, onExpand() {}, prior: null, segments: staleGone, gaps: {}, t }))
  assert.equal(expandRows(stale).length, 0)
})

test('context rows are plain grey DiffRows with real numbers and never carry Accept or Reject', () => {
  const plan = contextPlan(LONG, {})
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, onExpand() {}, prior: null, segments: LONG, gaps: {}, t }))
  const lineNodes = walk(tree).filter(n => n.props?.['data-context'])
  assert.equal(lineNodes.length, plan.filter(p => p.type === 'context').length)
  for (const node of lineNodes) {
    for (const row of kids(node)) assert.equal(row.props['aria-label'], en.row_context)
    assert.ok(!/accept|reject/i.test(text(node)), 'no actions in context')
  }
  const sample = expand(DiffRow({ row: { kind: 'context', oldNo: 18, text: 'line 18' }, t }))
  const first = walk(tree).find(n => n.props?.['aria-label'] === en.row_context)
  assert.deepEqual(first.props.style, sample.props.style, 'same row and gutter styles as existing context rows')
  assert.equal(kids(first)[0].props.children, 18)
})

test('expanded state is per file and per gap; it survives a refetch and resets on a new version', () => {
  let state = expandGap(null, FILE, '1-20', 'up')
  state = expandGap(state, FILE, '22-45', 'all')
  assert.deepEqual(state.gaps, { '1-20': { up: 10, down: 0, all: false }, '22-45': { up: 0, down: 0, all: true } })
  assert.equal(expansionFor(state, { ...FILE }), state, 'same file and version: kept')
  assert.deepEqual(expansionFor(state, { ...FILE, version: 'v2' }).gaps, {}, 'new version: reset')
  assert.deepEqual(expansionFor(state, { ...SKILL_FILE, version: 'v1' }).gaps, {}, 'another file: its own state')
  const reset = expandGap(state, { ...FILE, version: 'v2' }, '1-20', 'up')
  assert.deepEqual(reset.gaps, { '1-20': { up: 10, down: 0, all: false } }, 'a step after a version change starts from scratch')
})

test('the detail view applies the state for the shown version and reports expansions with that file', () => {
  const seen = []
  const data = { status: 'ok', file: FILE, segments: LONG }
  const base = { busy: false, confirmOpen: false, data, file: FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }
  const opened = expandGap(null, FILE, '1-20', 'all')
  const view = expand(FileDetailView({ ...base, expansion: opened, onExpand: (f, id, dir) => seen.push([f.version, id, dir]) }))
  assert.equal(expandRows(view).length, 2, 'top gap open')
  expandButtons(view)[0].props.onClick({})
  assert.deepEqual(seen, [['v1', '22-45', 'down']])
  const newer = { ...data, file: { ...FILE, version: 'v2' } }
  const after = expand(FileDetailView({ ...base, data: newer, expansion: opened, onExpand() {} }))
  assert.equal(expandRows(after).length, 3, 'a changed version folds everything again')
  const bare = expand(FileDetailView({ ...base }))
  assert.equal(expandRows(bare).length, 3, 'works without expansion props')
})

test('styles: theme variables only, rows wrap and shrink', () => {
  const src = JSON.stringify(EXPAND_STYLES)
  assert.doesNotMatch(src, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  for (const [name, style] of Object.entries(EXPAND_STYLES)) {
    assert.equal(style.minWidth, 0, `${name} minWidth 0`)
    for (const [prop, value] of Object.entries(style)) {
      if (/color|background|border/i.test(prop) && typeof value === 'string' && !/^(none|0|inherit)$|transparent$/.test(value)) {
        assert.match(value, /var\(--/, `${name}.${prop} uses a theme variable`)
      }
    }
  }
  assert.equal(EXPAND_STYLES.row.flexWrap, 'wrap')
  assert.equal(EXPAND_STYLES.button.overflowWrap, 'anywhere')
  assert.equal(EXPAND_STYLES.button.whiteSpace, 'normal')
  const tree = expand(FileDiffView({ busy: false, onBlock() {}, onExpand() {}, prior: null, segments: LONG, gaps: {}, t }))
  for (const row of expandRows(tree)) assert.equal(row.props.style, EXPAND_STYLES.row)
  for (const node of walk(tree).filter(n => n.props?.['data-context'])) assert.equal(node.props.style.minWidth, 0)
  assert.equal(STYLES.rowText.whiteSpace, 'pre-wrap', 'context lines wrap like every other row')
})

test('every expand message key exists', () => {
  const src = readFileSync(pluginPath, 'utf8')
  const region = src.slice(src.indexOf('// Context expansion'), src.indexOf('// Reveal, watcher'))
  assert.ok(region.length > 100, 'region found')
  const used = new Set([...region.matchAll(/\bt\('([a-zA-Z_]+)'/g)].map(m => m[1]))
  assert.ok(used.size >= 6)
  for (const key of used) assert.ok(key in en, key)
})
