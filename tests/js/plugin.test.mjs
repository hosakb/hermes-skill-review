import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

globalThis.__host = {
  navigate(path) { this.navigated = path },
  notify() {},
  notifyError() {},
  openWorkspace(id, opts) { this.opened = { id, opts }; return () => { this.closed = true } },
  state: {}
}
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const { parseSection, planAutoOpen, visibleItems, itemKey, resultToast, openReview } = mod

const plugin = mod.default

test('default export has the contract fields', () => {
  assert.equal(plugin.id, 'skill-review')
  assert.equal(typeof plugin.register, 'function')
})

test('register contributes route, status chip and palette command, and tears down on dispose', () => {
  const registered = []
  const disposers = []
  const store = {}
  const ctx = {
    i18n: { register: bundle => assert.ok(bundle.en.accept) },
    onDispose: fn => disposers.push(fn),
    registerMany: list => registered.push(...list),
    rest: async () => ({}),
    storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } }
  }
  plugin.register(ctx)
  assert.deepEqual(registered.map(c => c.area).sort(), ['palette', 'routes', 'statusBar.right'])
  assert.equal(registered.find(c => c.area === 'routes').data.path, '/skill-review')
  assert.equal(registered.find(c => c.area === 'palette').data.id, 'skill-review.open')
  assert.equal(disposers.length, 1)
  disposers[0]()
})

test('openReview uses openWorkspace when present and navigates otherwise', () => {
  const h = globalThis.__host
  openReview()
  assert.equal(h.opened.id, 'skill-review:review')
  assert.equal(typeof h.opened.opts.render, 'function')
  const saved = h.openWorkspace
  h.openWorkspace = undefined
  openReview()
  assert.equal(h.navigated, '/skill-review')
  h.openWorkspace = saved
})

test('planAutoOpen announces only keys that are new', () => {
  const a = { profile: 'dev', id: 'a1' }
  const b = { profile: 'ops', id: 'a1' } // same id in another profile is a different item
  let r = planAutoOpen([a], [])
  assert.deepEqual(r.fresh, ['dev/a1'])
  assert.deepEqual(planAutoOpen([a], r.keep).fresh, [], 'seen items never reopen')
  r = planAutoOpen([a, b], r.keep)
  assert.deepEqual(r.fresh, ['ops/a1'])
  assert.deepEqual(planAutoOpen([b], r.keep).keep, ['ops/a1'], 'resolved items are pruned')
  assert.deepEqual(planAutoOpen([], ['dev/a1']).keep, [])
})

test('visibleItems filters by focused profile unless scope is all', () => {
  const items = [{ profile: 'dev', id: '1' }, { profile: 'ops', id: '2' }]
  assert.deepEqual(visibleItems(items, 'focused', 'ops').map(itemKey), ['ops/2'])
  assert.equal(visibleItems(items, 'all', 'ops').length, 2)
})

test('parseSection: create is all added with line numbers', () => {
  const rows = parseSection({ kind: 'create', text: 'a\nb\n' })
  assert.deepEqual(rows.map(r => [r.kind, r.text, r.newNo]), [['add', 'a', 1], ['add', 'b', 2]])
})

test('parseSection: delete is all removed', () => {
  const rows = parseSection({ kind: 'delete', text: "delete skill 'x'" })
  assert.deepEqual(rows, [{ kind: 'remove', text: "delete skill 'x'" }])
})

test('parseSection: unified diff gives file header, hunk, and numbered rows', () => {
  const text = '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail\n'
  const rows = parseSection({ kind: 'diff', text })
  assert.deepEqual(rows.map(r => r.kind), ['file', 'hunk', 'context', 'remove', 'add', 'context'])
  assert.equal(rows[0].text, 'SKILL.md')
  assert.deepEqual([rows[3].oldNo, rows[4].newNo], [2, 2])
})

test('parseSection: a removed line that starts with "-- " is not mistaken for a file header', () => {
  const text = '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n--- not a header\n+++ also not\n same\n'
  const rows = parseSection({ kind: 'diff', text })
  assert.deepEqual(rows.map(r => r.kind), ['file', 'hunk', 'remove', 'add', 'context'])
  assert.equal(rows[2].text, '-- not a header')
})

test('parseSection: two files in one section keep both headers', () => {
  const text = '--- a/one\n+++ b/one\n@@ -1 +1 @@\n-x\n+y\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-p\n+q\n'
  const rows = parseSection({ kind: 'diff', text })
  assert.deepEqual(rows.filter(r => r.kind === 'file').map(r => r.text), ['one', 'two'])
})

test('parseSection: notes such as a failed patch render as note rows', () => {
  assert.deepEqual(parseSection({ kind: 'diff', text: '(patch would fail: no match)' }),
    [{ kind: 'note', text: '(patch would fail: no match)' }])
  assert.deepEqual(parseSection({ kind: 'diff', text: '(no textual change)' }).map(r => r.kind), ['note'])
})

test('resultToast maps every backend status', () => {
  const t = (k, a) => `${k}:${a ?? ''}`
  assert.deepEqual(resultToast('accept', { status: 'applied', item: { skill: 's' } }, t), { kind: 'success', message: 'accepted:s' })
  assert.deepEqual(resultToast('reject', { status: 'rejected', item: { skill: 's' } }, t), { kind: 'info', message: 'rejected:s' })
  assert.equal(resultToast('accept', { status: 'already_handled' }, t).kind, 'info')
  assert.equal(resultToast('accept', { status: 'failed', error: 'x' }, t).kind, 'error')
})

test('source has no hardcoded colours and imports only allowed specifiers', () => {
  const src = readFileSync(pluginPath, 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, 'hex colour')
  assert.doesNotMatch(code, /\b(?:rgb|rgba|hsl|hsla|oklch)\(/, 'colour function')
  assert.doesNotMatch(code, /:\s*'(?:white|black|red|green|blue|gray|grey|yellow|orange)'/, 'named colour')
  const specs = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
  assert.deepEqual([...new Set(specs)].sort(), ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
  assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|WebSocket|window\./, 'no direct network or window access')
})
