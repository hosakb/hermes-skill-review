// Tests for the list sort, the connected-profile label, overflow-safe styles, the failure message
// punctuation, and the version-keyed diff query.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { FILES, MEMORY_DIFF, MEMORY_FILE, NEW_SKILL_FILE, SKILL_DIFF, SKILL_FILE, T0, USER_FILE } from './fixtures.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate() {},
  notify(toast) { this.toasts.push(toast) },
  notifyError() {},
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $sort, BlockView, ConnectedProfile, DiffSkeleton, FileDetailView, FileHeader, FileListRow, FilesEmpty, FilterButton, LIST_STYLES,
  SORTS, STYLES, FILE_STYLES, SortMenu, diffKey, diffMatches, diffQueryKey, diffVersion, endSentence,
  filterFiles, loadListSettings, messages, resultToast, setSort, shownFiles, sortFiles
} = mod
const plugin = mod.default
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)
const en = messages.en
const tEn = (k, ...a) => (typeof en[k] === 'function' ? en[k](...a) : en[k])
const src = readFileSync(pluginPath, 'utf8')
const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from) + from.length))

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
const byType = (tree, type) => walk(tree).filter(n => n.type === type)

function fakeStorage(initial = {}) {
  const store = { ...initial }
  return { store, get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } }
}

function fakeCtx(initial = {}) {
  const storage = fakeStorage(initial)
  return {
    i18n: { register() {}, t },
    onDispose() {},
    registerMany() {},
    register: () => () => {},
    rest: async () => ({}),
    setInterval: () => () => {},
    setTimeout: () => () => {},
    storage
  }
}

const file = (profile, name, latest, total, subsystem = 'memory') => ({
  counts: { conflict: 0, pending: total, stale: 0, total },
  file: name,
  key: `${profile}-${name}`.replace(/[^A-Za-z0-9_-]/g, '_').padEnd(16, 'x').slice(0, 16),
  latest_staged_at: latest,
  profile,
  subsystem
})

// --- 1. sort ----------------------------------------------------------------------------------

test('sort options are newest, oldest, file name and most changes, newest by default', () => {
  assert.deepEqual(SORTS, ['newest', 'oldest', 'name', 'changes'])
  assert.equal($sort.get(), 'newest')
  assert.deepEqual(SORTS.map(id => en[`sort_${id}`]), ['Newest first', 'Oldest first', 'File name A to Z', 'Most changes'])
})

test('newest and oldest order by latest_staged_at', () => {
  const files = [USER_FILE, NEW_SKILL_FILE, MEMORY_FILE, SKILL_FILE]
  assert.deepEqual(sortFiles(files, 'newest').map(f => f.latest_staged_at), [T0 + 300, T0 + 200, T0 + 50, T0 + 10])
  assert.deepEqual(sortFiles(files, 'oldest').map(f => f.latest_staged_at), [T0 + 10, T0 + 50, T0 + 200, T0 + 300])
  assert.deepEqual(sortFiles(files, 'bogus'), sortFiles(files, 'newest'), 'an unknown choice falls back to newest')
  assert.deepEqual(files.map(f => f.file), ['USER.md', 'release-notes/SKILL.md', 'MEMORY.md', 'council/SKILL.md'], 'input untouched')
})

test('file name sorts A to Z without regard to case, numbers in numeric order', () => {
  const files = [file('dev', 'b10/SKILL.md', 1, 1), file('dev', 'USER.md', 2, 1), file('dev', 'b2/SKILL.md', 3, 1), file('dev', 'MEMORY.md', 4, 1)]
  assert.deepEqual(sortFiles(files, 'name').map(f => f.file), ['b2/SKILL.md', 'b10/SKILL.md', 'MEMORY.md', 'USER.md'])
})

test('most changes puts the largest count first', () => {
  const files = [file('dev', 'a', 1, 2), file('dev', 'b', 2, 9), file('dev', 'c', 3, 5)]
  assert.deepEqual(sortFiles(files, 'changes').map(f => f.file), ['b', 'c', 'a'])
})

test('the sort is stable: ties keep the order they came in', () => {
  const tied = ['p', 'q', 'r', 's', 't'].map((n, i) => file(i % 2 ? 'ops' : 'dev', n, 100, 3))
  for (const sort of SORTS.filter(s => s !== 'name')) {
    assert.deepEqual(sortFiles(tied, sort).map(f => f.file), ['p', 'q', 'r', 's', 't'], sort)
  }
  const same = ['dev', 'ops', 'qa'].map(p => file(p, 'MEMORY.md', 100 + p.length, 1))
  assert.deepEqual(sortFiles(same, 'name').map(f => f.profile), ['dev', 'ops', 'qa'])
})

test('sorting happens after the kind filter', () => {
  const files = [file('dev', 'z.md', 5, 1), file('dev', 'a.md', 9, 1), file('dev', 'm/SKILL.md', 1, 4, 'skills'), file('dev', 'b.md', 3, 2)]
  assert.deepEqual(shownFiles(files, 'memory', 'name').map(f => f.file), ['a.md', 'b.md', 'z.md'])
  assert.deepEqual(shownFiles(files, 'all', 'changes').map(f => f.file), ['m/SKILL.md', 'b.md', 'z.md', 'a.md'])
  assert.deepEqual(shownFiles(files, 'skills', 'oldest').map(f => f.file), ['m/SKILL.md'])
  assert.deepEqual(filterFiles(files).length, 4)
})

test('SortMenu shows the active choice in its trigger and reports a pick', () => {
  const picked = []
  const tree = SortMenu({ onChange: v => picked.push(v), t, value: 'name' })
  assert.equal(tree.props.value, 'name')
  const value = walk(tree).find(n => n.props?.children?.props?.children === 'sort_name')
  assert.ok(value, 'the trigger renders the active label')
  assert.equal(text(walk(tree)[1]), 'sort_name')
  const items = walk(tree).filter(n => n.props?.value && n.key)
  assert.deepEqual(items.map(i => i.props.value), SORTS)
  tree.props.onValueChange('changes')
  assert.deepEqual(picked, ['changes'])
  assert.equal(SortMenu({ onChange() {}, t, value: 'junk' }).props.value, 'newest')
})

test('the sort choice persists in ctx.storage and loads back', () => {
  const ctx = fakeCtx({ hiddenProfiles: ['ops'], sortOrder: 'changes' })
  plugin.register(ctx)
  assert.equal($sort.get(), 'changes')
  assert.equal(mod.$hidden, undefined, 'a stored hidden-profile list from 0.2.x is ignored')
  setSort('oldest')
  assert.equal(ctx.storage.store.sortOrder, 'oldest')
  setSort('nope')
  assert.equal($sort.get(), 'oldest', 'an unknown value is ignored')
  loadListSettings(fakeCtx({ sortOrder: 'sideways', hiddenProfiles: 'ops' }))
  assert.equal($sort.get(), 'newest')
})

test('SortControl is its own component, rendered on the settings page', () => {
  assert.match(src, /export function SortControl\(\) \{/)
  assert.match(slice('export function SettingsPageView(', '\nexport function '), /jsx\(SortControl, \{\}\)/)
})

// --- 2. one profile: the connected one -----------------------------------------------------------

test('there is no profile picker: the list names the connected profile only', () => {
  for (const name of ['ProfilePicker', 'ProfileControl', 'profileLabel', 'profileSummary', 'toggleHidden', 'onlyProfile', 'setHiddenProfiles', '$hidden']) {
    assert.equal(mod[name], undefined, name)
  }
  const label = ConnectedProfile({ profile: 'hermes-dev', t })
  const parts = label.props.children
  assert.deepEqual([parts[0], parts[2].props.children, parts[4]], ['profileWord', 'hermes-dev', 'connectedMark'])
  assert.equal(label.props.title, 'connectedProfileTip:hermes-dev')
  assert.equal(label.props.style.textOverflow, 'ellipsis')
  assert.equal(ConnectedProfile({ profile: null, t }), null)
  assert.equal(en.connectedMark, '(connected)')
  assert.match(slice('export function FilesListPane()', '\nexport function '), /jsx\(ConnectedProfile, \{ profile: v\.profile, t \}\)/)
  assert.match(slice('export function LibraryListPane()', '\nconst textLines'), /jsx\(ConnectedProfile, /)
  assert.doesNotMatch(src, /hiddenProfiles['"]?\s*,|writeStored\('hiddenProfiles'/)
})

test('the status chip counts the connected profile\'s writes', () => {
  const chip = slice('function StatusChip()', '\nconst NOTIFY_EN')
  assert.doesNotMatch(chip, /\$hidden|filterFiles|shownFiles/)
  assert.match(chip, /count: items\.length/)
})

test('an empty list says why: nothing of this kind, nothing at all, or the gate is off', () => {
  assert.ok(walk(expand(FilesEmpty({ files: 3, gateOn: true, kind: 'skills', t }))).some(n => n.props?.description === 'emptyKind:kind_skills'))
  assert.ok(walk(expand(FilesEmpty({ files: 0, gateOn: true, kind: 'all', t }))).some(n => n.props?.description === 'emptyBody'))
  assert.ok(walk(expand(FilesEmpty({ files: 0, gateOn: false, kind: 'all', t }))).some(n => n.props?.description === 'gateOff'))
  assert.equal(en.emptyKind('Skills'), 'Nothing under Skills for this profile.')
  assert.equal(en.emptyHidden, undefined)
})

test('the settings page carries the notify control', () => {
  assert.match(slice('export function SettingsPageView(', '\nexport function '), /jsx\(NotifyModeControl, \{ bare: true \}\)/)
})

// --- 3a. nothing overflows the pane -----------------------------------------------------------

const isFlex = style => style?.display === 'flex' || style?.display === 'inline-flex'
const buttonsIn = tree => walk(tree).filter(n => typeof n.props?.onClick === 'function' || n.props?.disabled !== undefined)

function assertContained(tree, label) {
  for (const n of walk(tree)) {
    const st = n.props?.style
    if (isFlex(st)) {
      assert.equal(st.minWidth, 0, `${label}: flex box without minWidth 0: ${JSON.stringify(st)}`)
      const rowWithButtons = st.flexDirection !== 'column' && buttonsIn(n).length > 0 && kids(n).length > 1
      if (rowWithButtons) assert.equal(st.flexWrap, 'wrap', `${label}: a control row must wrap: ${JSON.stringify(st)}`)
    }
  }
  // SDK buttons (the native full-width row <button> of the file list is the row itself, not a control).
  for (const b of buttonsIn(tree).filter(n => typeof n.type === 'function' && n.props?.onCheckedChange === undefined)) {
    assert.equal(b.props.style?.flexShrink, 0, `${label}: button without flexShrink 0`)
    assert.equal(b.props.style?.maxWidth, '100%', `${label}: button may grow past its row`)
  }
}

test('shared styles: pane, bar and rows can shrink, buttons cannot, labels cut with an ellipsis', () => {
  assert.equal(STYLES.paneRoot.minWidth, 0)
  assert.equal(STYLES.paneRoot.overflow, 'hidden')
  assert.equal(STYLES.bar.minWidth, 0)
  assert.equal(STYLES.barRow.flexWrap, 'wrap')
  assert.equal(LIST_STYLES.controls.flexWrap, 'wrap')
  assert.equal(LIST_STYLES.controls.minWidth, 0)
  assert.deepEqual(STYLES.button, { flexShrink: 0, maxWidth: '100%', minWidth: 0 })
  assert.deepEqual(STYLES.ellipsis, { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  assert.equal(STYLES.listTitle.textOverflow, 'ellipsis')
  assert.equal(STYLES.listMeta.flexWrap, 'wrap')
  assert.equal(FILE_STYLES.blockHead.flexWrap, 'wrap')
  assert.equal(STYLES.header.flexWrap, 'wrap')
})

test('row actions wrap together onto their own right-aligned line', () => {
  assert.equal(STYLES.actions.marginLeft, 'auto')
  assert.equal(STYLES.actions.flexWrap, 'wrap')
  assert.equal(STYLES.actions.justifyContent, 'flex-end')
  assert.equal(STYLES.actions.flex, '0 0 auto')
  assert.equal(STYLES.actions.maxWidth, '100%')
})

test('filter chips cannot push past the pane edge', () => {
  const b = FilterButton({ active: true, label: 'All profiles (7 with a very long name that cannot fit)', onClick() {} })
  assert.equal(b.props.style, STYLES.button)
  assert.equal(b.props.children.props.style, STYLES.ellipsis)
  assert.equal(b.props.title, 'All profiles (7 with a very long name that cannot fit)')
})

test('file header, block header and list row stay inside the pane', () => {
  const long = { ...SKILL_FILE, file: 'a-very-long-skill-name-without-breaks/references/another-long-file-name.md', profile: 'a-long-profile-name' }
  assertContained(expand(FileHeader({ acceptable: 1, busy: false, file: long, onAcceptAll() {}, onRejectAll() {}, t })), 'FileHeader')
  for (const seg of [...MEMORY_DIFF.segments, ...SKILL_DIFF.segments].filter(s => s.type === 'block')) {
    assertContained(expand(BlockView({ block: seg.block, isNew: true, t })), `BlockView ${seg.block.id}`)
  }
  assertContained(expand(FileListRow({ file: long, hasNew: true, onSelect() {}, selected: false, t })), 'FileListRow')
  const detail = expand(FileDetailView({ busy: false, confirmOpen: false, data: SKILL_DIFF, file: SKILL_FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }))
  assertContained(detail, 'FileDetailView')
})

test('a block head has no action group: the decision is in the file header', () => {
  const head = kids(BlockView({ block: SKILL_DIFF.segments[1].block, isNew: false, t }))[0]
  assert.equal(kids(head).find(n => n.props?.style === STYLES.actions), undefined)
  const header = expand(FileHeader({ acceptable: 1, busy: false, file: SKILL_FILE, onAcceptAll() {}, onRejectAll() {}, t }))
  const group = walk(header).find(n => n.props?.style === STYLES.actions)
  assert.deepEqual(kids(group).map(b => b.props.children), ['rejectAll', 'acceptAll'])
})

test('the sort menu trigger stays inside the pane', () => {
  const sortTrigger = walk(SortMenu({ onChange() {}, t, value: 'newest' }))[1]
  assert.deepEqual(sortTrigger.props.style, { flexShrink: 0, maxWidth: '100%', minWidth: 0, width: 'auto' })
})

test('the live list header uses only wrapping rows', () => {
  const list = slice('function FilesListPane()', '\nfunction ')
  const bar = list.slice(list.indexOf('const bar'), list.indexOf('let body'))
  const styles = [...bar.matchAll(/style: ([A-Z_]+\.[a-zA-Z]+)/g)].map(m => m[1])
  assert.deepEqual(styles, ['STYLES.bar', 'LIST_STYLES.controls', 'STYLES.barRow'])
})

// --- 3b. failure message punctuation ----------------------------------------------------------

test('endSentence adds a period only when the text has no terminal punctuation', () => {
  assert.equal(endSentence('all touched skills rolled back.'), 'all touched skills rolled back.')
  assert.equal(endSentence('no match for old_string'), 'no match for old_string.')
  assert.equal(endSentence('Really?'), 'Really?')
  assert.equal(endSentence('stopped!'), 'stopped!')
  assert.equal(endSentence('wait…'), 'wait…')
  assert.equal(endSentence('(see "op 2.")'), '(see "op 2.")')
  assert.equal(endSentence('blocked (dangerous findings):'), 'blocked (dangerous findings).')
  assert.equal(endSentence('  trailing space.  '), 'trailing space.')
  assert.equal(endSentence(''), '')
  assert.equal(endSentence(null), '')
})

test('the failure toast never doubles the period', () => {
  const ends = resultToast('accept', { status: 'failed', error: 'Batch failed at op 2; all touched skills rolled back.' }, tEn)
  assert.equal(ends.message, 'Change not applied: Batch failed at op 2; all touched skills rolled back. It stays pending.')
  assert.doesNotMatch(ends.message, /\.\./)
  const bare = resultToast('accept', { status: 'failed', error: 'old_string not found' }, tEn)
  assert.equal(bare.message, 'Change not applied: old_string not found. It stays pending.')
  const none = resultToast('accept', { status: 'failed', error: '' }, tEn)
  assert.equal(none.message, 'Change not applied. It stays pending.')
  const scan = resultToast('accept', { status: 'failed', error: 'Security scan blocked this skill (dangerous findings):\n  - exfiltration' }, tEn)
  assert.equal(scan.message, 'Change not applied: Security scan blocked this skill (dangerous findings). It stays pending.')
})

// --- 3c. version-keyed diff, stale answers, skeleton ------------------------------------------

test('the diff key carries the file version under the invalidation prefix', () => {
  const a = { ...MEMORY_FILE, version: 'aaaaaaaaaaaaaaaa' }
  assert.deepEqual(diffQueryKey(a).slice(0, diffKey(a).length), diffKey(a))
  assert.notDeepEqual(diffQueryKey(a), diffQueryKey({ ...a, version: 'bbbbbbbbbbbbbbbb' }))
  assert.deepEqual(diffQueryKey(a), diffQueryKey({ ...a }))
  assert.equal(diffVersion(a), 'aaaaaaaaaaaaaaaa')
})

test('without a backend version, counts and latest_staged_at decide when to refetch', () => {
  const v = diffVersion(MEMORY_FILE)
  assert.equal(v, `${T0 + 300}:3:3:0:0`)
  assert.notEqual(diffVersion({ ...MEMORY_FILE, latest_staged_at: T0 + 301 }), v)
  assert.notEqual(diffVersion({ ...MEMORY_FILE, counts: { ...MEMORY_FILE.counts, stale: 1, pending: 2 } }), v)
})

test('the detail query does not poll on its own and keeps the previous diff while refetching', () => {
  const detail = slice('function FileDetail({ file })', '\nfunction ')
  const query = detail.slice(detail.indexOf('useQuery({'), detail.indexOf('})', detail.indexOf('useQuery({')))
  assert.doesNotMatch(query, /refetchInterval/)
  assert.match(query, /staleTime: Infinity/)
  assert.match(query, /queryKey: diffQueryKey\(file\)/)
  assert.match(query, /placeholderData: previous => previous/)
  assert.match(slice('function useFiles()', '\n}'), /refetchInterval: POLL_MS/, 'the cheap list keeps its 3-second poll')
})

test('a diff answer for another file is never shown', () => {
  assert.equal(diffMatches(MEMORY_DIFF, MEMORY_FILE), true)
  assert.equal(diffMatches(SKILL_DIFF, MEMORY_FILE), false)
  assert.equal(diffMatches({ ...MEMORY_DIFF, file: { ...MEMORY_FILE, profile: 'ops' } }, MEMORY_FILE), false)
  assert.equal(diffMatches({ status: 'gone' }, MEMORY_FILE), true)
  assert.equal(diffMatches(undefined, MEMORY_FILE), false)
  const base = { busy: false, confirmOpen: false, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }
  const tree = expand(FileDetailView({ ...base, data: SKILL_DIFF, file: MEMORY_FILE, loading: false }))
  assert.equal(walk(tree).filter(n => n.props?.['data-block']).length, 0, 'no blocks of the other file')
  assert.ok(walk(tree).some(n => n.props?.role === 'status'), 'skeleton until the right answer arrives')
  assert.match(text(tree), /MEMORY\.md/)
})

test('the skeleton is a busy status in the diff box shape', () => {
  const sk = DiffSkeleton({ t })
  assert.equal(sk.props.role, 'status')
  assert.equal(sk.props['aria-busy'], true)
  assert.equal(sk.props['aria-label'], 'loadingDiff')
  assert.equal(sk.props.style.borderRadius, STYLES.diffBox.borderRadius)
  assert.ok(kids(sk).length >= 6)
  assert.ok(kids(sk).every(b => b.props.style.maxWidth === '100%'))
})
