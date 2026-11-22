// Tests for the list sort, the profile subset picker, overflow-safe styles, the failure message
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
  $hidden, $sort, BlockView, DiffSkeleton, FileDetailView, FileHeader, FileListRow, FilesEmpty, FilterButton, LIST_STYLES,
  ProfilePicker, SORTS, STYLES, FILE_STYLES, SortMenu, diffKey, diffMatches, diffQueryKey, diffVersion, endSentence,
  filterFiles, loadListSettings, messages, onlyProfile, profileSummary, resultToast, setHiddenProfiles, setSort,
  shownFiles, sortFiles, toggleHidden
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

test('sorting happens after the profile and kind filters', () => {
  const files = [file('dev', 'z.md', 5, 1), file('ops', 'a.md', 9, 1), file('dev', 'm/SKILL.md', 1, 4, 'skills'), file('dev', 'b.md', 3, 2)]
  assert.deepEqual(shownFiles(files, ['ops'], 'memory', 'name').map(f => f.file), ['b.md', 'z.md'])
  assert.deepEqual(shownFiles(files, [], 'all', 'changes').map(f => f.file), ['m/SKILL.md', 'b.md', 'z.md', 'a.md'])
  assert.deepEqual(shownFiles(files, ['dev'], 'all', 'oldest').map(f => f.file), ['a.md'])
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
  assert.deepEqual($hidden.get(), ['ops'])
  setSort('oldest')
  assert.equal(ctx.storage.store.sortOrder, 'oldest')
  setSort('nope')
  assert.equal($sort.get(), 'oldest', 'an unknown value is ignored')
  loadListSettings(fakeCtx({ sortOrder: 'sideways', hiddenProfiles: 'ops' }))
  assert.equal($sort.get(), 'newest')
  assert.deepEqual($hidden.get(), [])
})

test('SortControl is its own component, rendered on the settings page', () => {
  assert.match(src, /export function SortControl\(\) \{/)
  assert.match(slice('export function SettingsPageView(', '\nexport function '), /jsx\(SortControl, \{\}\)/)
})

// --- 2. profile subset ------------------------------------------------------------------------

const PROFILES = [file('dev', 'MEMORY.md', 9, 3), file('ops', 'USER.md', 8, 1), file('dev', 'USER.md', 7, 1), file('default', 'MEMORY.md', 6, 2), file('qa', 'x/SKILL.md', 5, 1, 'skills')]

test('profileSummary lists each profile with pending files once, default first, with its file count', () => {
  assert.deepEqual(profileSummary(PROFILES), [
    { count: 1, profile: 'default' }, { count: 2, profile: 'dev' }, { count: 1, profile: 'ops' }, { count: 1, profile: 'qa' }
  ])
  assert.deepEqual(profileSummary([]), [])
})

test('hidden profiles are filtered out; a profile that appears later is shown', () => {
  assert.deepEqual(filterFiles(PROFILES, ['dev', 'qa']).map(f => f.profile), ['ops', 'default'])
  assert.deepEqual(filterFiles(PROFILES, []).length, 5)
  const later = [...PROFILES, file('newbie', 'MEMORY.md', 1, 1)]
  assert.ok(filterFiles(later, ['dev', 'qa']).some(f => f.profile === 'newbie'))
  assert.deepEqual(filterFiles(PROFILES, ['ops'], 'skills').map(f => f.file), ['x/SKILL.md'])
})

test('toggle, All and Only-focused produce the hidden list', () => {
  assert.deepEqual(toggleHidden([], 'ops', false), ['ops'])
  assert.deepEqual(toggleHidden(['ops', 'qa'], 'ops', true), ['qa'])
  assert.deepEqual(toggleHidden(['ops'], 'ops', false), ['ops'], 'no duplicates')
  assert.deepEqual(onlyProfile(profileSummary(PROFILES), 'dev'), ['default', 'ops', 'qa'])
})

test('the hidden list, not the shown one, is what persists', () => {
  const ctx = fakeCtx()
  plugin.register(ctx)
  setHiddenProfiles(['ops', 'ops', 7, 'qa'])
  assert.deepEqual(ctx.storage.store.hiddenProfiles, ['ops', 'qa'])
  assert.deepEqual($hidden.get(), ['ops', 'qa'])
  setHiddenProfiles([])
})

test('the picker label says how many profiles are shown', () => {
  const profiles = profileSummary(PROFILES)
  const label = hidden => {
    const tree = ProfilePicker({ focused: 'dev', hidden, onChange() {}, profiles, t })
    return walk(tree).find(n => n.props?.asChild).props.children.props.title
  }
  assert.equal(label([]), 'profilesAll:4')
  assert.equal(label(['ops']), 'profilesShown:3,4')
  assert.equal(label(['ops', 'gone-profile']), 'profilesShown:3,4', 'a hidden profile without files does not count')
  assert.equal(en.profilesShown(3, 7), '3 of 7 profiles')
  assert.equal(en.profilesAll(7), 'All 7 profiles')
})

test('the picker has a checkbox per profile with its count, plus All and Only-focused', () => {
  const changes = []
  const profiles = profileSummary(PROFILES)
  const tree = ProfilePicker({ focused: 'dev', hidden: ['ops'], onChange: h => changes.push(h), profiles, t })
  const rows = walk(tree).filter(n => n.type === 'label')
  assert.deepEqual(rows.map(r => r.key), ['default', 'dev', 'ops', 'qa'])
  const checks = rows.map(r => kids(r)[0])
  assert.deepEqual(checks.map(c => c.props.checked), [true, true, false, true])
  assert.deepEqual(rows.map(r => text(r)), ['default 1', 'dev focusedMark 2', 'ops 1', 'qa 1'])
  checks[2].props.onCheckedChange(true)
  checks[0].props.onCheckedChange(false)
  const shortcuts = walk(tree).filter(n => typeof n.props?.onClick === 'function')
  shortcuts.forEach(b => b.props.onClick())
  assert.deepEqual(changes, [[], ['ops', 'default'], [], ['default', 'ops', 'qa']])
})

test('Only-focused is disabled when the focused chat profile has nothing pending', () => {
  const tree = expand(ProfilePicker({ focused: 'elsewhere', hidden: [], onChange() {}, profiles: profileSummary(PROFILES), t }))
  const only = walk(tree).find(n => n.props?.title === 'onlyFocusedNone:elsewhere')
  assert.equal(only.props.disabled, true)
})

test('the settings page uses the picker; the status chip keeps counting every profile', () => {
  const list = slice('function FilesListPane()', '\nfunction ')
  assert.match(slice('export function SettingsPageView(', '\nexport function '), /jsx\(ProfileControl, /)
  assert.doesNotMatch(list, /scopeFocused|\$scope/, 'the old two-way scope control is gone from the live list')
  const chip = slice('function StatusChip()', '\nconst NOTIFY_EN')
  assert.doesNotMatch(chip, /\$hidden|filterFiles|shownFiles/)
  assert.match(chip, /count: items\.length/)
})

test('an empty list with hidden profiles explains and offers to show them all', () => {
  let shown = 0
  const tree = expand(FilesEmpty({ files: 3, gateOn: true, inScope: 0, kind: 'all', onShowAll: () => { shown += 1 }, t }))
  assert.match(text(tree), /showAll/)
  assert.ok(walk(tree).some(n => n.props?.description === 'emptyHidden:3'))
  walk(tree).find(n => typeof n.props?.onClick === 'function').props.onClick()
  assert.equal(shown, 1)
  assert.ok(walk(expand(FilesEmpty({ files: 3, gateOn: true, inScope: 2, kind: 'skills', onShowAll() {}, t }))).some(n => n.props?.description === 'emptyKind:kind_skills'))
  assert.ok(walk(expand(FilesEmpty({ files: 0, gateOn: false, inScope: 0, kind: 'all', onShowAll() {}, t }))).some(n => n.props?.description === 'gateOff'))
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
    assertContained(expand(BlockView({ block: seg.block, busy: false, isNew: true, onAccept() {}, onReject() {}, t })), `BlockView ${seg.block.id}`)
  }
  assertContained(expand(FileListRow({ file: long, hasNew: true, onSelect() {}, selected: false, t })), 'FileListRow')
  const detail = expand(FileDetailView({ busy: false, confirmOpen: false, data: SKILL_DIFF, file: SKILL_FILE, onAction() {}, onAskRejectAll() {}, onCloseConfirm() {}, prior: null, t }))
  assertContained(detail, 'FileDetailView')
})

test('the block Reject button sits in the action group, never alone at the row end', () => {
  const head = kids(BlockView({ block: SKILL_DIFF.segments[1].block, busy: false, isNew: false, onAccept() {}, onReject() {}, t }))[0]
  const group = kids(head).find(n => n.props?.style === STYLES.actions)
  assert.ok(group, 'action group present')
  assert.equal(kids(group).length, 2)
  assert.equal(kids(group)[1].props.children, 'reject')
})

test('profile picker and sort menu triggers stay inside the pane', () => {
  const profiles = profileSummary([...PROFILES, file('a-profile-with-a-really-long-name-indeed', 'MEMORY.md', 1, 1)])
  const picker = expand(ProfilePicker({ focused: 'dev', hidden: ['ops'], onChange() {}, profiles, t }))
  assertContained(picker, 'ProfilePicker')
  const trigger = walk(picker).find(n => n.props?.asChild).props.children
  assert.equal(trigger.props.style, STYLES.button)
  assert.equal(kids(trigger)[0].props.style, STYLES.ellipsis)
  assert.equal(LIST_STYLES.popover.maxWidth, 'calc(100vw - 2rem)')
  assert.equal(LIST_STYLES.checkName.textOverflow, 'ellipsis')
  assert.equal(LIST_STYLES.checkCount.flex, 'none')
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
