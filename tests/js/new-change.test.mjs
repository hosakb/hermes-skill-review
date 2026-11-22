// A change that arrives while the app runs never takes the user away from what they are doing. It
// shows a toast with an Open action (popup mode) or lights the Review chip (light mode). The old
// autoOpen setting, which opened the review by itself, is gone; a stored value is ignored.
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
globalThis.__host = host
globalThis.__queryClient = {
  data: { items: [] },
  fetchQuery() { return Promise.resolve(this.data) }
}
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const { $lit, $mode, $notifyMode, $selection, messages, notePageMount } = mod
const plugin = mod.default
const src = readFileSync(pluginPath, 'utf8')
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)

const flush = () => new Promise(resolve => setImmediate(resolve))
const nowSec = () => Date.now() / 1000
const item = (id, extra = {}) => ({ subsystem: 'skills', profile: 'default', id, created_at: nowSec() + 5, ...extra })

function start(store = {}) {
  host.reset()
  $selection.set(null)
  $mode.set('pending')
  const timers = []
  const ctx = {
    disposers: [], registered: [],
    i18n: { register() {}, t },
    onDispose: fn => ctx.disposers.push(fn),
    registerMany: list => { ctx.registered.push(...list); return () => {} },
    register: c => { ctx.registered.push(c); return () => {} },
    rest: async () => ({}),
    setInterval: (fn, ms) => { timers.push({ fn, ms, every: true }); return () => {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, every: false }); return () => {} },
    storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v } },
    store,
    timers
  }
  plugin.register(ctx)
  return ctx
}
const stop = ctx => ctx.disposers.forEach(fn => fn())
const poll = async (ctx, items) => {
  globalThis.__queryClient.data = { items }
  ctx.timers.find(x => x.every).fn()
  await flush()
}

test('first poll only records what is already pending: no toast, no navigation, but the chip still lights', async () => {
  const ctx = start({ notifyMode: 'light', lastSeenAt: 1 })
  await poll(ctx, [item('old1'), item('old2')])
  assert.deepEqual(host.navigated, [])
  assert.equal(host.toasts.length, 0)
  assert.deepEqual(ctx.store.announced, ['skills/default/old1', 'skills/default/old2'], 'recorded as known')
  assert.equal($lit.get(), true, 'the chip still shows them as unseen')
  stop(ctx)
})

test('first poll that fails does not count; the first successful one only records', async () => {
  const ctx = start()
  const qc = globalThis.__queryClient
  const real = qc.fetchQuery
  qc.fetchQuery = () => Promise.reject(new Error('down'))
  ctx.timers.find(x => x.every).fn(); await flush()
  qc.fetchQuery = real
  await poll(ctx, [item('was-there')])
  assert.equal(host.toasts.length, 0)
  stop(ctx)
})

test('popup (the default): a new change shows one toast with an Open action and never navigates by itself', async () => {
  const ctx = start()
  assert.equal($notifyMode.get(), 'popup')
  await poll(ctx, [])
  await poll(ctx, [item('p1'), item('p2')])
  assert.equal(host.toasts.length, 1)
  const toast = host.toasts[0]
  assert.equal(toast.kind, 'info')
  assert.equal(toast.message, 'newPending:2')
  assert.equal(toast.action.label, 'open')
  assert.equal(messages.en.open, 'Open')
  assert.deepEqual(host.navigated, [], 'the toast alone does not move the user')
  stop(ctx)
})

test('the toast Open action shows the page in Pending and keeps the selection', async () => {
  const ctx = start()
  await poll(ctx, [])
  $mode.set('library')
  $selection.set('skills/default/SKILL.md')
  await poll(ctx, [item('o1')])
  host.toasts[0].action.onClick()
  assert.deepEqual(host.navigated, ['/skill-review'])
  assert.equal($mode.get(), 'pending')
  assert.equal($selection.get(), 'skills/default/SKILL.md', 'the change the user was reading stays selected')
  stop(ctx)
})

test('light mode: a new change lights the chip, with no toast and no navigation', async () => {
  const ctx = start({ notifyMode: 'light', lastSeenAt: 1 })
  await poll(ctx, [])
  await poll(ctx, [item('l1')])
  assert.equal(host.toasts.length, 0)
  assert.equal($lit.get(), true)
  assert.deepEqual(host.navigated, [])
  stop(ctx)
})

test('a stored autoOpen from 0.2.1 is ignored: the change still only toasts', async () => {
  const ctx = start({ autoOpen: true })
  await poll(ctx, [])
  await poll(ctx, [item('a1')])
  assert.equal(host.toasts.length, 1)
  assert.deepEqual(host.navigated, [])
  stop(ctx)
})

test('the same pending changes are announced once; a new one is announced again', async () => {
  const ctx = start()
  await poll(ctx, [])
  await poll(ctx, [item('c1')])
  await poll(ctx, [item('c1')])
  assert.equal(host.toasts.length, 1)
  await poll(ctx, [item('c1'), item('c2')])
  assert.equal(host.toasts.length, 2)
  assert.equal(host.toasts[1].message, 'newPending:1')
  stop(ctx)
})

test('while the page is on screen, a poll marks everything seen so the chip stays unlit', async () => {
  const ctx = start({ notifyMode: 'light', lastSeenAt: 1 })
  const done = notePageMount()
  await poll(ctx, [])
  await poll(ctx, [item('s1', { created_at: nowSec() - 1 })])
  assert.equal($lit.get(), false)
  done()
  stop(ctx)
})

test('the autoOpen setting is gone from code, settings and storage reads', () => {
  for (const name of ['$autoOpen', 'setAutoOpen', 'AutoOpenRow', 'AutoOpenToggle', 'AutoOpenSwitch', 'AUTO_OPEN_STYLES']) {
    assert.equal(mod[name], undefined, `${name} is removed`)
  }
  assert.doesNotMatch(src, /autoOpen/)
  assert.equal(messages.en.autoOpenLabel, undefined)
  assert.equal(messages.en.autoOpenHelp, undefined)
})
