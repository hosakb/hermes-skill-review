// Tests for Library mode: the Pending | Library switch, the profile tree with its counts and search,
// and the file editor with Save, Revert, the 409 reload flow, 422 messages and the discard prompt.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

const host = {
  navigate() {},
  notify(toast) { this.toasts.push(toast) },
  notifyError(error, message) { this.errors.push(message) },
  openWorkspace() { return () => {} },
  revealPane() {},
  undismissPane() {},
  state: { profile: { get: () => 'default' } },
  reset() { this.toasts = []; this.errors = [] }
}
host.reset()
globalThis.__host ??= host
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const {
  $hidden, $kind, $libDiscard, $libEditor, $libOpen, $libSelection, $mode, $selection, FilesListPane, LibraryDetailPane,
  LibraryEditorView, LibraryListPane, LibraryTree, ModeSwitch, ReviewLayout, cancelDiscard, changeLibraryText,
  confirmDiscard, librarySession, filterLibrary, findLibraryFile, isDirty, libId, libraryFilePath, libraryPath, messages,
  libraryErrorState, openPendingFor, performLibrarySave, reloadLibraryFile, requestLeave, restError, revertLibrary, selectLibraryFile,
  setMode, toggleNode, treeRows
} = mod
const { SegmentedControl, Textarea } = await import('@hermes/plugin-sdk')
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)
const H = globalThis.__host

// --- tree helpers over the jsx() stub ({ type, props, key }) -----------------------------------
const kids = node => {
  const c = node?.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object')
}
const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); kids(node).forEach(k => walk(k, out)) } return out }
const text = node => walk(node).flatMap(n => {
  const c = n.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => typeof x === 'string' || typeof x === 'number')
}).join(' ')
const named = (tree, name) => walk(tree).filter(n => typeof n.type === 'function' && n.type.name === name)
const buttons = node => walk(node).filter(n => typeof n.props?.onClick === 'function')
const byLabel = (node, label) => buttons(node).find(b => text(b).includes(label))

// --- fixtures (the GET /library shape) -----------------------------------------------------------
const file = (key, kind, name, pending = 0, extra = {}) =>
  ({ key, kind, name, skill: null, exists: true, size: 10, mtime: 1795000000, pending, review: null, ...extra })

const TREE = {
  total: 6,
  profiles: [
    {
      profile: 'default', pending: 0, error: null, identity: [], staged: [], skills: [],
      memory: [file('mdefault000000mm', 'memory', 'MEMORY.md'), file('udefault000000uu', 'memory', 'USER.md', 0, { exists: false, size: 0 })]
    },
    {
      profile: 'dev', pending: 5, error: null,
      identity: [file('soul00000000000s', 'identity', 'SOUL.md'), file('agents000000000a', 'identity', 'AGENTS.md')],
      memory: [
        file('mem0000000000000', 'memory', 'MEMORY.md', 2, { review: { subsystem: 'memory', key: 'reviewMemKey0000' } }),
        file('user000000000000', 'memory', 'USER.md')
      ],
      skills: [
        {
          name: 'council', pending: 2,
          files: [
            file('council000000skl', 'skill', 'SKILL.md', 1, { skill: 'council', review: { subsystem: 'skills', key: 'reviewSkillKey00' } }),
            file('council00000refa', 'skill', 'references/a.md', 1, { skill: 'council', review: { subsystem: 'skills', key: 'reviewRefKey0000' } })
          ]
        },
        { name: 'shared', pending: 0, files: [file('shared0000000skl', 'skill', 'SKILL.md', 0, { skill: 'shared' })] }
      ],
      staged: [{ file: 'release-notes/SKILL.md', subsystem: 'skills', pending: 1, review: { subsystem: 'skills', key: 'reviewNewKey0000' } }]
    },
    {
      profile: 'ops', pending: 1, error: null, identity: [], skills: [], staged: [],
      memory: [file('opsmem0000000000', 'memory', 'MEMORY.md', 1, { review: { subsystem: 'memory', key: 'reviewOpsKey0000' } }), file('opsuser000000000', 'memory', 'USER.md')]
    }
  ]
}

const SOUL = { status: 'ok', file: { ...TREE.profiles[1].identity[0] }, text: 'You are terse.\nKeep it short.', version: 'abc:1', limit: { label: 'SOUL.md', max: 200000 } }

function fakeQueryClient() {
  return { invalidated: [], invalidateQueries({ queryKey }) { this.invalidated.push(queryKey) } }
}

function fakeRest(reply) {
  const calls = []
  const rest = async (path, opts) => {
    calls.push({ path, ...opts })
    const out = typeof reply === 'function' ? reply(path, opts) : reply
    if (out instanceof Error) throw out
    return out
  }
  return { calls, rest }
}

const httpError = (status, detail) =>
  new Error(`Error invoking remote method 'hermes:api': Error: ${status}: ${JSON.stringify({ detail })}`)

const reset = () => {
  $mode.set('pending'); $libSelection.set(null); $libEditor.set(null); $libDiscard.set(null); $libOpen.set({})
  $selection.set(null); $hidden.set([]); $kind.set('all'); H.reset()
}

const soulId = libId('dev', 'soul00000000000s')
const fresh = () => librarySession(null, soulId, SOUL)
const dirty = () => ({ ...fresh(), text: 'You are verbose.' })

// --- paths --------------------------------------------------------------------------------------

test('library paths encode the owner and key as single segments', () => {
  assert.equal(libraryPath(), '/library')
  assert.equal(libraryFilePath('dev', 'abc'), '/library/dev/abc')
  assert.equal(libraryFilePath('my profile', 'a/b'), '/library/my%20profile/a%2Fb')
  assert.equal(libId('dev', 'abc'), 'dev/abc')
})

// --- mode switch --------------------------------------------------------------------------------

test('the switch shows Pending with its count and Library, and changes the mode', () => {
  reset()
  const changes = []
  const view = ModeSwitch({ mode: 'pending', onChange: m => changes.push(m), t, total: 5 })
  const [control] = walk(view).filter(n => n.type === SegmentedControl)
  assert.ok(control, 'the SDK segmented control')
  assert.deepEqual(control.props.options.map(o => [o.id, o.label]), [['pending', 'modePending:5'], ['library', 'modeLibrary']])
  assert.equal(control.props.value, 'pending')
  control.props.onChange('library')
  assert.deepEqual(changes, ['library'])
  assert.equal(messages.en.modePending(3), 'Pending 3')
  assert.equal(messages.en.modeLibrary, 'Library')
})

test('setMode switches freely while nothing is unsaved', () => {
  reset()
  setMode('library')
  assert.equal($mode.get(), 'library')
  setMode('pending')
  assert.equal($mode.get(), 'pending')
  setMode('bogus')
  assert.equal($mode.get(), 'pending')
})

test('leaving Library with unsaved text asks first and keeps the mode until confirmed', () => {
  reset()
  $mode.set('library')
  $libSelection.set(soulId)
  $libEditor.set(dirty())
  setMode('pending')
  assert.equal($mode.get(), 'library')
  assert.ok($libDiscard.get(), 'the discard prompt is open')
  cancelDiscard()
  assert.equal($libDiscard.get(), null)
  assert.equal($libEditor.get().text, 'You are verbose.', 'cancel keeps the text')
  setMode('pending')
  confirmDiscard()
  assert.equal($mode.get(), 'pending')
  assert.equal($libEditor.get(), null)
  assert.equal($libDiscard.get(), null)
})

test('the layout shows the Library panes in Library mode and the Pending panes otherwise', () => {
  reset()
  const pending = ReviewLayout({ narrow: false, onBack() {}, selection: null, t })
  assert.equal(named(pending, 'FilesListPane').length, 1)
  assert.equal(named(pending, 'LibraryListPane').length, 0)
  const library = ReviewLayout({ mode: 'library', narrow: false, onBack() {}, selection: null, t })
  assert.equal(named(library, 'LibraryListPane').length, 1)
  assert.equal(named(library, 'LibraryDetailPane').length, 1)
  assert.equal(named(library, 'FilesListPane').length, 0)
  const narrow = ReviewLayout({ mode: 'library', narrow: true, onBack() {}, selection: soulId, t })
  assert.equal(named(narrow, 'LibraryDetailPane').length, 1)
  assert.ok(walk(narrow).some(n => n.props?.['data-review-back']))
})

test('the Pending list header carries the switch in place of its title row', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(pluginPath, 'utf8')
  const list = src.slice(src.indexOf('function FilesListPane()'), src.indexOf('\nfunction ', src.indexOf('function FilesListPane()') + 10))
  const bar = list.slice(list.indexOf('const bar'), list.indexOf('let body'))
  assert.match(bar, /jsx\(ModeControl, \{ total \}\)/)
  const lib = src.slice(src.indexOf('function LibraryListPane()'), src.indexOf('\nfunction ', src.indexOf('function LibraryListPane()') + 10))
  assert.match(lib, /jsx\(ModeControl, \{ total: /)
  assert.ok(typeof FilesListPane === 'function' && typeof LibraryListPane === 'function' && typeof LibraryDetailPane === 'function')
})

// --- tree ---------------------------------------------------------------------------------------

test('tree rows: profiles, then groups with their files; skills fold by default', () => {
  const rows = treeRows(TREE.profiles, {}, '')
  const dev = rows.filter(r => r.profile === 'dev')
  assert.deepEqual(dev.map(r => [r.type, r.label]), [
    ['profile', 'dev'],
    ['group', 'libGroup_identity'], ['file', 'SOUL.md'], ['file', 'AGENTS.md'],
    ['group', 'libGroup_memory'], ['file', 'MEMORY.md'], ['file', 'USER.md'],
    ['group', 'libGroup_skills'], ['skill', 'council'], ['skill', 'shared'],
    ['group', 'libGroup_staged'], ['staged', 'release-notes/SKILL.md']
  ])
  const ops = rows.filter(r => r.profile === 'ops').map(r => r.type)
  assert.deepEqual(ops, ['profile', 'group', 'file', 'file'], 'empty groups are left out')
  const council = dev.find(r => r.label === 'council')
  assert.equal(council.open, false)
  const open = treeRows(TREE.profiles, { [council.id]: true }, '')
  assert.deepEqual(open.filter(r => r.skill === 'council' && r.type === 'file').map(r => r.label), ['SKILL.md', 'references/a.md'])
  const shut = treeRows(TREE.profiles, { 'p:dev': false }, '')
  assert.deepEqual(shut.filter(r => r.profile === 'dev').map(r => r.type), ['profile'], 'a folded profile shows only its row')
})

test('every row carries its own pending count and the counts add up to the Pending total', () => {
  const open = Object.fromEntries(treeRows(TREE.profiles, {}, '').filter(r => r.type === 'skill').map(r => [r.id, true]))
  const rows = treeRows(TREE.profiles, open, '')
  const leaves = rows.filter(r => r.type === 'file' || r.type === 'staged')
  const profiles = rows.filter(r => r.type === 'profile')
  assert.equal(leaves.reduce((s, r) => s + r.pending, 0), TREE.total)
  assert.equal(profiles.reduce((s, r) => s + r.pending, 0), TREE.total)
  assert.equal(rows.find(r => r.label === 'council').pending, 2)
  assert.equal(rows.find(r => r.type === 'file' && r.label === 'MEMORY.md' && r.profile === 'dev').pending, 2)
})

test('the tree view shows badges for pending counts, a blue dot for unsaved text and the selection', () => {
  const rows = treeRows(TREE.profiles, {}, '')
  const memId = libId('dev', 'mem0000000000000')
  const picked = []
  const view = LibraryTree({ dirtyId: soulId, onSelect: id => picked.push(id), onToggle() {}, rows, selection: memId, t })
  const rowNodes = walk(view).filter(n => n.props?.['data-row'])
  const soul = rowNodes.find(n => n.props['data-row'] === soulId)
  assert.ok(walk(soul).some(n => n.props?.['data-dirty']), 'unsaved file has the dot')
  assert.ok(!walk(rowNodes.find(n => n.props['data-row'] === memId)).some(n => n.props?.['data-dirty']))
  assert.equal(rowNodes.find(n => n.props['data-row'] === memId).props['aria-current'], true)
  assert.match(text(rowNodes.find(n => n.props['data-row'] === 'p:dev')), /\b5\b/)
  assert.match(text(rowNodes.find(n => n.props['data-row'] === memId)), /\b2\b/)
  assert.doesNotMatch(text(rowNodes.find(n => n.props['data-row'] === libId('dev', 'user000000000000'))), /\b0\b/, 'no badge at 0')
  rowNodes.find(n => n.props['data-row'] === memId).props.onClick()
  assert.deepEqual(picked, [memId])
})

test('profile and skill rows toggle open', () => {
  reset()
  toggleNode('p:dev', true)
  assert.equal($libOpen.get()['p:dev'], false)
  toggleNode('s:dev:council000000skl', false)
  assert.equal($libOpen.get()['s:dev:council000000skl'], true)
})

test('a staged row (no file on disk yet) opens its review entry in Pending', () => {
  reset()
  $mode.set('library')
  const rows = treeRows(TREE.profiles, {}, '')
  const staged = rows.find(r => r.type === 'staged')
  const view = LibraryTree({ onSelect() {}, onToggle() {}, rows, selection: null, t })
  walk(view).find(n => n.props?.['data-row'] === staged.id).props.onClick()
  assert.equal($mode.get(), 'pending')
  assert.equal($selection.get(), 'skills/dev/reviewNewKey0000')
})

// --- search and profile filter -----------------------------------------------------------------

test('hidden profiles drop out of the tree', () => {
  assert.deepEqual(filterLibrary(TREE.profiles, ['dev'], '').map(p => p.profile), ['default', 'ops'])
})

test('search keeps matching files, whole skills by name, and drops what does not match', () => {
  const soul = filterLibrary(TREE.profiles, [], 'soul')
  assert.deepEqual(soul.map(p => p.profile), ['dev'])
  assert.deepEqual(soul[0].identity.map(f => f.name), ['SOUL.md'])
  assert.deepEqual(soul[0].memory, [])
  const council = filterLibrary(TREE.profiles, [], 'COUNCIL')
  assert.deepEqual(council[0].skills.map(s => [s.name, s.files.length]), [['council', 2]])
  const ref = filterLibrary(TREE.profiles, [], 'references/')
  assert.deepEqual(ref[0].skills.map(s => [s.name, s.files.map(f => f.name)]), [['council', ['references/a.md']]])
  assert.deepEqual(filterLibrary(TREE.profiles, [], 'user.md').map(p => p.profile), ['default', 'dev', 'ops'])
  assert.deepEqual(filterLibrary(TREE.profiles, [], 'nothing-like-this'), [])
  assert.deepEqual(filterLibrary(TREE.profiles, [], 'release').map(p => p.staged.length), [1])
})

test('a search opens every node so matches show without clicking', () => {
  const rows = treeRows(filterLibrary(TREE.profiles, [], 'references'), { 'p:dev': false }, 'references')
  assert.deepEqual(rows.filter(r => r.type === 'file').map(r => r.label), ['references/a.md'])
})

test('findLibraryFile locates a file and its profile by id', () => {
  const found = findLibraryFile(TREE, libId('dev', 'council00000refa'))
  assert.equal(found.profile, 'dev')
  assert.equal(found.file.name, 'references/a.md')
  assert.equal(found.file.skill, 'council')
  assert.equal(findLibraryFile(TREE, 'dev/nope'), null)
  assert.equal(findLibraryFile(null, soulId), null)
})

// --- editor state -------------------------------------------------------------------------------

test('a file opens clean from the server text; typing makes it dirty', () => {
  reset()
  const session = fresh()
  assert.equal(session.id, soulId)
  assert.equal(session.original, SOUL.text)
  assert.equal(session.version, 'abc:1')
  assert.equal(isDirty(session), false)
  changeLibraryText(session, 'new text')
  assert.equal($libEditor.get().text, 'new text')
  assert.equal(isDirty($libEditor.get()), true)
  assert.equal(librarySession($libEditor.get(), soulId, SOUL).text, 'new text', 'the typed text wins over a refetch')
  assert.equal(librarySession($libEditor.get(), 'dev/other', SOUL), null, 'another file has no session until loaded')
  assert.equal(librarySession(null, soulId, { status: 'loading' }), null)
})

test('the editor view: header chips, buttons, line numbers and the footer', () => {
  const meta = { file: SOUL.file, profile: 'dev' }
  const clean = LibraryEditorView({ meta, session: fresh(), t })
  assert.match(text(clean), /SOUL\.md/)
  assert.match(text(clean), /libKind_identity/)
  assert.match(text(clean), /\bdev\b/)
  assert.match(text(clean), /libStraightToFile/)
  assert.match(text(clean), /libLines:2/)
  assert.doesNotMatch(text(clean), /libUnsaved/)
  assert.equal(byLabel(clean, 'libSave').props.disabled, true)
  assert.equal(byLabel(clean, 'libRevert').props.disabled, true)
  const [area] = walk(clean).filter(n => n.type === Textarea)
  assert.equal(area.props.value, SOUL.text)
  assert.equal(area.props.spellCheck, false)
  const gutter = walk(clean).find(n => n.props?.['data-gutter'])
  assert.equal(gutter.props.children, '1\n2')
  const changed = LibraryEditorView({ meta, session: dirty(), t })
  assert.match(text(changed), /libUnsaved/)
  assert.equal(byLabel(changed, 'libSave').props.disabled, false)
  assert.equal(byLabel(changed, 'libRevert').props.disabled, false)
  assert.equal(messages.en.libStraightToFile, 'Saves straight to the file')
  assert.equal(messages.en.libUnsaved, 'Unsaved changes')
})

test('Revert puts the text back as it was opened', () => {
  reset()
  $libEditor.set({ ...dirty(), error: 'old error' })
  revertLibrary($libEditor.get())
  assert.equal($libEditor.get().text, SOUL.text)
  assert.equal($libEditor.get().error, null)
  assert.equal(isDirty($libEditor.get()), false)
})

test('Save sends PUT with the text and version, then the file is clean at the new version', async () => {
  reset()
  const qc = fakeQueryClient()
  const { calls, rest } = fakeRest({ status: 'saved', file: SOUL.file, version: 'def:2' })
  const session = dirty()
  await performLibrarySave({ queryClient: qc, rest, session, t })
  assert.deepEqual(calls, [{ body: { text: 'You are verbose.', version: 'abc:1' }, method: 'PUT', path: '/library/dev/soul00000000000s' }])
  const after = $libEditor.get()
  assert.equal(after.original, 'You are verbose.')
  assert.equal(after.version, 'def:2')
  assert.equal(after.saving, false)
  assert.equal(isDirty(after), false)
  assert.equal(H.toasts[0].kind, 'success')
  assert.equal(H.toasts[0].message, 'libSaved:SOUL.md')
  for (const key of [['skill-review', 'library'], ['skill-review', 'files'], ['skill-review', 'pending']]) {
    assert.ok(qc.invalidated.some(k => JSON.stringify(k) === JSON.stringify(key)), key.join('/'))
  }
})

test('a 409 keeps the text, shows the conflict and offers Reload, which loads the disk text', async () => {
  reset()
  const qc = fakeQueryClient()
  const detail = 'SOUL.md changed on disk since you opened it. Reload it to see the new text.'
  await performLibrarySave({ queryClient: qc, rest: fakeRest(httpError(409, detail)).rest, session: dirty(), t })
  const after = $libEditor.get()
  assert.equal(after.text, 'You are verbose.')
  assert.equal(after.conflict, detail)
  assert.equal(after.saving, false)
  assert.deepEqual(H.errors, [], 'a conflict is shown in place, not as an error toast')
  let reloaded = 0
  const view = LibraryEditorView({ meta: { file: SOUL.file, profile: 'dev' }, onReload: () => { reloaded += 1 }, session: after, t })
  const alert = walk(view).find(n => n.props?.role === 'alert')
  assert.match(text(alert), /changed on disk/)
  byLabel(alert, 'libReload').props.onClick()
  assert.equal(reloaded, 1)
  const disk = { ...SOUL, text: 'Edited elsewhere.', version: 'zzz:9' }
  const { calls, rest } = fakeRest(disk)
  await reloadLibraryFile({ queryClient: qc, rest, session: after, t })
  assert.deepEqual(calls.map(c => c.path), ['/library/dev/soul00000000000s'])
  const fresh2 = $libEditor.get()
  assert.equal(fresh2.text, 'Edited elsewhere.')
  assert.equal(fresh2.original, 'Edited elsewhere.')
  assert.equal(fresh2.version, 'zzz:9')
  assert.equal(fresh2.conflict, null)
})

test("a 422 shows Hermes's reason and keeps the text", async () => {
  reset()
  const reason = 'SKILL.md must start with YAML frontmatter (---). See existing skills for format.'
  await performLibrarySave({ queryClient: fakeQueryClient(), rest: fakeRest(httpError(422, reason)).rest, session: dirty(), t })
  const after = $libEditor.get()
  assert.equal(after.error, reason)
  assert.equal(after.text, 'You are verbose.')
  const view = LibraryEditorView({ meta: { file: SOUL.file, profile: 'dev' }, session: after, t })
  assert.match(text(walk(view).find(n => n.props?.role === 'alert')), /YAML frontmatter/)
})

test('any other failure keeps the text and toasts', async () => {
  reset()
  await performLibrarySave({ queryClient: fakeQueryClient(), rest: fakeRest(new Error('socket hang up')).rest, session: dirty(), t })
  assert.equal($libEditor.get().text, 'You are verbose.')
  assert.equal($libEditor.get().error, 'socket hang up')
  assert.deepEqual(H.errors, ['libSaveFailed'])
})

test('restError reads the status and the detail out of a bridged HTTP error', () => {
  assert.deepEqual(restError(httpError(409, 'stale')), { detail: 'stale', status: 409 })
  assert.deepEqual(restError(new Error('422: {"detail":"too long: 1: 2"}')), { detail: 'too long: 1: 2', status: 422 })
  assert.deepEqual(restError(Object.assign(new Error('boom'), { statusCode: 500 })), { detail: 'boom', status: 500 })
  assert.deepEqual(restError(new Error('404: not json')), { detail: 'not json', status: 404 })
  assert.deepEqual(restError(new Error('socket hang up')), { detail: 'socket hang up', status: null })
})

// --- discard prompt and selection ----------------------------------------------------------------

test('selecting another file with unsaved text asks to discard first', () => {
  reset()
  $libSelection.set(soulId)
  $libEditor.set(dirty())
  const other = libId('dev', 'mem0000000000000')
  selectLibraryFile(other)
  assert.equal($libSelection.get(), soulId)
  assert.ok($libDiscard.get())
  confirmDiscard()
  assert.equal($libSelection.get(), other)
  assert.equal($libEditor.get(), null)
})

test('selecting another file with nothing unsaved switches at once and drops the clean session', () => {
  reset()
  $libSelection.set(soulId)
  $libEditor.set(fresh())
  selectLibraryFile(libId('dev', 'mem0000000000000'))
  assert.equal($libSelection.get(), libId('dev', 'mem0000000000000'))
  assert.equal($libEditor.get(), null)
  assert.equal($libDiscard.get(), null)
})

test('requestLeave runs the action straight away when clean', () => {
  reset()
  let ran = 0
  requestLeave(() => { ran += 1 })
  assert.equal(ran, 1)
  $libEditor.set(dirty())
  requestLeave(() => { ran += 1 })
  assert.equal(ran, 1)
  confirmDiscard()
  assert.equal(ran, 2)
})

test('the detail pane renders the discard dialog from the shared state', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(pluginPath, 'utf8')
  const pane = src.slice(src.indexOf('function LibraryDetailPane()'), src.indexOf('\nfunction ', src.indexOf('function LibraryDetailPane()') + 10))
  assert.match(pane, /jsx\(ConfirmDialog, \{/)
  assert.match(pane, /open: Boolean\(discard\)/)
  assert.match(pane, /onConfirm: confirmDiscard/)
  assert.equal(messages.en.libDiscardTitle, 'Discard unsaved changes?')
})

// --- pending link -------------------------------------------------------------------------------

test('a file with pending changes links to its review, which switches to Pending with it selected', () => {
  reset()
  $mode.set('library')
  $kind.set('skills')
  const mem = TREE.profiles[1].memory[0]
  let asked = 0
  const view = LibraryEditorView({ meta: { file: mem, profile: 'dev' }, onReview: () => { asked += 1 }, session: { ...fresh(), id: libId('dev', mem.key) }, t })
  byLabel(view, 'libPendingLink:2').props.onClick()
  assert.equal(asked, 1)
  assert.equal(messages.en.libPendingLink(2), '2 pending changes: review')
  assert.equal(messages.en.libPendingLink(1), '1 pending change: review')
  openPendingFor('dev', mem.review)
  assert.equal($mode.get(), 'pending')
  assert.equal($selection.get(), 'memory/dev/reviewMemKey0000')
  assert.equal($kind.get(), 'all', 'the kind filter opens up so the file shows in the list')
  const none = LibraryEditorView({ meta: { file: TREE.profiles[1].identity[0], profile: 'dev' }, session: fresh(), t })
  assert.doesNotMatch(text(none), /libPendingLink/)
})

test('the pending link with unsaved text asks to discard first', () => {
  reset()
  $mode.set('library')
  $libEditor.set(dirty())
  openPendingFor('dev', { subsystem: 'memory', key: 'reviewMemKey0000' })
  assert.equal($mode.get(), 'library')
  assert.equal($selection.get(), null)
  confirmDiscard()
  assert.equal($mode.get(), 'pending')
  assert.equal($selection.get(), 'memory/dev/reviewMemKey0000')
})

// --- review cycle 1: late results -----------------------------------------------------------------

const later = () => {
  let settle
  const promise = new Promise((resolve, reject) => { settle = { reject, resolve } })
  return { promise, settle }
}
const OTHER = () => ({ ...fresh(), id: libId('dev', 'mem0000000000000'), key: 'mem0000000000000', name: 'MEMORY.md', original: 'other', text: 'other' })

test('a save that finishes after the user moved to another file leaves that file alone', async () => {
  reset()
  const { promise, settle } = later()
  const qc = fakeQueryClient()
  const run = performLibrarySave({ queryClient: qc, rest: () => promise, session: dirty(), t })
  const other = OTHER()
  $libEditor.set(other)
  settle.resolve({ status: 'saved', version: 'def:2' })
  await run
  assert.deepEqual($libEditor.get(), other)
  assert.equal(H.toasts[0]?.kind, 'success', 'the save still happened, so it still says so')
  assert.ok(qc.invalidated.length, 'and the tree still refreshes')
})

test('a failed save that finishes after the file was closed does not reopen it', async () => {
  reset()
  for (const failure of [httpError(409, 'stale'), httpError(422, 'bad'), new Error('socket hang up')]) {
    const { promise, settle } = later()
    const run = performLibrarySave({ queryClient: fakeQueryClient(), rest: () => promise, session: dirty(), t })
    $libEditor.set(null)
    settle.reject(failure)
    await run
    assert.equal($libEditor.get(), null)
  }
})

test('a reload that finishes after the user moved on is not applied', async () => {
  reset()
  const { promise, settle } = later()
  const run = reloadLibraryFile({ queryClient: fakeQueryClient(), rest: () => promise, session: { ...dirty(), conflict: 'stale' }, t })
  const other = OTHER()
  $libEditor.set(other)
  settle.resolve({ ...SOUL, text: 'disk' })
  await run
  assert.deepEqual($libEditor.get(), other)
})

// --- review cycle 2: POSIX only, one counter per editing session -----------------------------------

test('on a system without folder handles Library shows the backend message, not an empty tree', async () => {
  const detail = 'Library needs Linux or macOS: it opens files through folder handles without following symlinks, and this system cannot do that. Pending works as usual.'
  assert.deepEqual(libraryErrorState(httpError(501, detail), t), { description: detail, retry: false, title: 'libUnsupportedTitle' })
  assert.deepEqual(libraryErrorState(httpError(404, 'Not Found'), t), { description: 'backendMissing', retry: false, title: 'libLoadError' })
  assert.deepEqual(libraryErrorState(new Error('socket hang up'), t), { description: 'socket hang up', retry: true, title: 'libLoadError' })
  assert.equal(messages.en.libUnsupportedTitle, 'Library is not available on this system')
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(pluginPath, 'utf8')
  const pane = src.slice(src.indexOf('function LibraryListPane()'), src.indexOf('\nconst textLines'))
  assert.match(pane, /libraryErrorState\(library\.error, t\)/)
})

test('every opened or reopened file gets its own session number', () => {
  const a = librarySession(null, soulId, SOUL)
  const b = librarySession(null, soulId, SOUL)
  assert.equal(typeof a.gen, 'number')
  assert.notEqual(a.gen, b.gen)
  reset()
  changeLibraryText(a, 'typed')
  assert.equal($libEditor.get().gen, a.gen, 'typing keeps the session')
})

test('a late 409 after discarding and reopening the same file does not bring the discarded text back', async () => {
  reset()
  for (const failure of [httpError(409, 'stale'), httpError(422, 'bad'), new Error('socket hang up')]) {
    const { promise, settle } = later()
    const run = performLibrarySave({ queryClient: fakeQueryClient(), rest: () => promise, session: dirty(), t })
    confirmDiscard()
    const reopened = { ...librarySession(null, soulId, SOUL), text: 'typed after reopening' }
    $libEditor.set(reopened)
    settle.reject(failure)
    await run
    assert.deepEqual($libEditor.get(), reopened)
  }
  const { promise, settle } = later()
  const run = performLibrarySave({ queryClient: fakeQueryClient(), rest: () => promise, session: dirty(), t })
  confirmDiscard()
  const reopened = { ...librarySession(null, soulId, SOUL), text: 'typed after reopening' }
  $libEditor.set(reopened)
  settle.resolve({ status: 'saved', version: 'def:2' })
  await run
  assert.deepEqual($libEditor.get(), reopened, 'a late success does not mark the new text saved either')
})

// --- read-only memory and skill files (no public helper for their save checks yet) -----------------

const MEMORY_READ_ONLY = {
  status: 'ok',
  file: { key: 'memory0000000000', kind: 'memory', name: 'MEMORY.md', skill: null, exists: true, size: 10, mtime: 1,
    read_only: true, read_only_reason: 'Library shows memory files read-only for now.' },
  text: 'alpha fact',
  version: 'v1',
  limit: null
}

test('a read-only file opens without Save or Revert, with a read-only text box and its reason', () => {
  reset()
  const id = libId('dev', 'memory0000000000')
  const session = librarySession(null, id, MEMORY_READ_ONLY)
  assert.equal(session.readOnly, true)
  assert.equal(session.readOnlyReason, 'Library shows memory files read-only for now.')
  const view = LibraryEditorView({ meta: { file: MEMORY_READ_ONLY.file, profile: 'dev' }, session, t })
  assert.equal(byLabel(view, 'libSave'), undefined)
  assert.equal(byLabel(view, 'libRevert'), undefined)
  assert.match(text(view), /libReadOnly/)
  assert.match(text(view), /Library shows memory files read-only for now\./)
  assert.match(text(view), /libReadOnlyFooter/)
  const [area] = walk(view).filter(n => n.type === Textarea)
  assert.equal(area.props.readOnly, true)
  changeLibraryText(session, 'typed anyway')
  assert.equal($libEditor.get(), null, 'typing never starts an edit of a read-only file')
})

test('an identity file stays editable', () => {
  reset()
  const session = fresh()
  assert.equal(session.readOnly, false)
  const view = LibraryEditorView({ meta: { file: SOUL.file, profile: 'dev' }, session, t })
  assert.ok(byLabel(view, 'libSave'))
  assert.doesNotMatch(text(view), /libReadOnly/)
})

test('the read-only and missing-API strings are plain', () => {
  for (const key of ['libReadOnly', 'libReadOnlyFooter', 'libNoReviewApi', 'needsApi', 'needsApiTitle']) {
    assert.equal(typeof messages.en[key], 'string', key)
    assert.doesNotMatch(messages.en[key], /—/, key)
  }
})

test('the Pending list shows the missing-API message before any error or empty state', () => {
  const src = readFileSync(pluginPath, 'utf8')
  const pane = src.slice(src.indexOf('export function FilesListPane()'), src.indexOf('/** Empty list: why'))
  assert.ok(pane.indexOf('v.unavailable') > 0 && pane.indexOf('v.unavailable') < pane.indexOf('v.isError) {'))
  assert.match(pane, /jsx\(EmptyState, \{ description: v\.unavailable, title: t\('needsApiTitle'\) \}\)/)
  assert.match(pane, /t\('needsReview', v\.needsReview\)/)
})
