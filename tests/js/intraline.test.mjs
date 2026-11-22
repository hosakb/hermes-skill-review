// Tests for word-level marks inside a change block: the token diff, line pairing, the caps, and
// how DiffRow and BlockView render the marks. Same stub setup as the other test files.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = fileURLToPath(new URL('../../desktop/plugin.js', import.meta.url))

globalThis.__host ??= {
  navigate() {}, notify() {}, notifyError() {},
  state: { profile: { get: () => 'default' } }
}
globalThis.__queryClient ??= { fetchQuery: () => Promise.resolve({ items: [] }) }
register(pathToFileURL(here + 'stub-loader.mjs'))
const mod = await import(pathToFileURL(pluginPath).href)
const { BlockView, DiffRow, DiffView, MARK_STYLES, STYLES, blockMarks, intralineSegments, lineSimilarity, pairLines, segmentRows, tokenize } = mod
const t = (k, ...a) => (a.length ? `${k}:${a.join(',')}` : k)

const marked = segs => segs.filter(s => s.changed).map(s => s.text)
const joined = segs => segs.map(s => s.text).join('')
const marks = (a, b) => {
  const r = intralineSegments(a, b)
  assert.equal(joined(r.old), a, 'old segments cover the old text exactly')
  assert.equal(joined(r.new), b, 'new segments cover the new text exactly')
  return { old: marked(r.old), new: marked(r.new), capped: r.capped }
}

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
const markNodes = tree => walk(tree).filter(n => n.props?.['data-mark'])

// --- Ben's example ----------------------------------------------------------------------------

const BEN_OLD = 'B expects autonomous coding workflows to continue through quota recovery and agent handoffs without reminders; recovery prompts are continuation signals, not new requests. Report only when blocked or at a delivery milestone.'
const BEN_NEW = 'B expects autonomous coding to continue through quota recovery/handoffs without reminders; recovery prompts are continuation signals. Report only when blocked or at a milestone.'

// The brief lists 'delivery ' for the last mark. "at a delivery milestone" to "at a milestone" has the
// same shape as "coding workflows to" to "coding to" (word, space, removed word, space, word), and a
// rule that does not look at the words themselves gives both the same side. The plugin always
// takes the space before a removed or added span, so this mark is ' delivery', like ' workflows'.
test("Ben's MEMORY.md replace marks only the changed words", () => {
  const m = marks(BEN_OLD, BEN_NEW)
  assert.deepEqual(m.old, [' workflows', ' and agent ', ', not new requests', ' delivery'])
  assert.deepEqual(m.new, ['/'])
  assert.equal(m.capped, false)
})

// --- tokens and the diff ----------------------------------------------------------------------

test('tokenize splits whitespace runs, word runs and single punctuation characters', () => {
  assert.deepEqual(tokenize("it's  foo_bar2, (x)"), ["it's", '  ', 'foo_bar2', ',', ' ', '(', 'x', ')'])
  assert.deepEqual(tokenize('a--b'), ['a', '-', '-', 'b'])
  assert.deepEqual(tokenize('naïve café 日本語 😀!'), ['naïve', ' ', 'café', ' ', '日本語', ' ', '😀', '!'])
})

test('identical lines give no marks', () => {
  assert.deepEqual(marks('same line, same words', 'same line, same words'), { old: [], new: [], capped: false })
  assert.deepEqual(marks('', ''), { old: [], new: [], capped: false })
})

test('punctuation is its own token', () => {
  assert.deepEqual(marks('call(a, b);', 'call(a; b);'), { old: [','], new: [';'], capped: false })
  assert.deepEqual(marks('done.', 'done!'), { old: ['.'], new: ['!'], capped: false })
})

test('a whitespace-only change gets no mark', () => {
  assert.deepEqual(marks('alpha beta gamma', 'alpha   beta\tgamma'), { old: [], new: [], capped: false })
  assert.deepEqual(marks('alpha beta', 'alpha beta '), { old: [], new: [], capped: false })
})

test('a joined word marks the word, not a lone space', () => {
  const m = marks('alpha beta', 'alphabeta')
  assert.deepEqual(m.new, ['alphabeta'])
  assert.deepEqual(m.old, ['alpha beta'])
})

test('changed words separated by one unchanged space merge into one span', () => {
  const m = marks('keep red green blue keep', 'keep cyan magenta yellow keep')
  assert.deepEqual(m.old, ['red green blue'])
  assert.deepEqual(m.new, ['cyan magenta yellow'])
  // An unchanged word between two changes keeps them apart.
  assert.deepEqual(marks('one red two blue three', 'one cyan two pink three').old, ['red', 'blue'])
})

test('character-level marks for a long word that mostly matches', () => {
  assert.deepEqual(marks('use foo_bar here', 'use foo_baz here'), { old: ['r'], new: ['z'], capped: false })
  assert.deepEqual(marks('pin api_v1 now', 'pin api_v2 now'), { old: ['1'], new: ['2'], capped: false })
  assert.deepEqual(marks('the colour', 'the color'), { old: ['u'], new: [], capped: false })
})

test('short words and words that share too little are marked whole', () => {
  // Under 4 characters: v1 to v2 marks the whole word.
  assert.deepEqual(marks('pin v1 now', 'pin v2 now'), { old: ['v1'], new: ['v2'], capped: false })
  assert.deepEqual(marks('a cat b', 'a car b'), { old: ['cat'], new: ['car'], capped: false })
  // 4 characters, prefix + suffix 2 of 4: exactly half, so character marks.
  assert.deepEqual(marks('x abcd y', 'x abzz y'), { old: ['cd'], new: ['zz'], capped: false })
  // 4 characters, prefix + suffix 1 of 4: under half, whole word.
  assert.deepEqual(marks('x abcd y', 'x azzz y'), { old: ['abcd'], new: ['azzz'], capped: false })
  // Long but unrelated words.
  assert.deepEqual(marks('x planning y', 'x shipping y'), { old: ['planning'], new: ['shipping'], capped: false })
})

test('unicode text is diffed by code point and never split inside one', () => {
  assert.deepEqual(marks('café olé', 'café ole'), { old: ['olé'], new: ['ole'], capped: false })
  assert.deepEqual(marks('größer werden', 'größte werden'), { old: ['er'], new: ['te'], capped: false })
  assert.deepEqual(marks('mood 😀 ok', 'mood 😢 ok'), { old: ['😀'], new: ['😢'], capped: false })
  assert.deepEqual(marks('東京 大阪', '東京 京都'), { old: ['大阪'], new: ['京都'], capped: false })
})

test('a 2,000-token line with a change in the middle is marked and fast', () => {
  const words = Array.from({ length: 1000 }, (_, i) => `w${i}`)
  const a = words.join(' ')
  const b = words.map((w, i) => (i % 2 ? `z${i}` : w)).join(' ')
  const started = performance.now()
  const r = intralineSegments(a, b)
  const ms = performance.now() - started
  assert.equal(r.capped, false)
  assert.ok(marked(r.old).length > 0)
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`)
  console.log(`# 2,000-token line: ${ms.toFixed(1)} ms`)
})

test('a 5,000-token pair hits the cap and falls back to no marks without hanging', () => {
  const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join(' ')
  const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join(' ')
  const started = performance.now()
  const r = intralineSegments(a, b)
  const ms = performance.now() - started
  assert.equal(r.capped, true)
  assert.deepEqual(marked(r.old), [])
  assert.deepEqual(marked(r.new), [])
  assert.equal(joined(r.old), a)
  assert.ok(ms < 200, `took ${ms.toFixed(0)} ms`)
  console.log(`# 5,000-token pair: ${ms.toFixed(1)} ms`)
  // Same tokens on both sides except one word in the middle: still over the token cap, no marks.
  const long = Array.from({ length: 5000 }, (_, i) => `t${i % 97}`)
  const changed = [...long]
  changed[2500] = 'other'
  assert.equal(intralineSegments(long.join(' '), changed.join(' ')).capped, true)
})

test('the DP cell cap and the per-block budget also fall back to plain rows', () => {
  const a = Array.from({ length: 60 }, (_, i) => `a${i}`).join(' ')
  const b = Array.from({ length: 60 }, (_, i) => `b${i}`).join(' ')
  const tight = { ...mod.INTRALINE_LIMITS, cells: 1000 }
  assert.equal(intralineSegments(a, b, tight).capped, true, '119 x 119 cells is over 1,000')
  assert.equal(intralineSegments('same start x same end', 'same start y same end', tight).capped, false, 'trimming keeps a small middle under the cap')
  // Two similar pairs; a budget that covers only the first leaves the second line plain.
  const lines = ['one two three four five', 'six seven eight nine ten']
  const changed = ['one two three four FIVE', 'six seven eight nine TEN']
  const full = blockMarks(lines, changed)
  assert.ok(full.removed[0] && full.removed[1])
  const cost = intralineSegments(lines[0], changed[0]).cost
  const limited = blockMarks(lines, changed, { ...mod.INTRALINE_LIMITS, blockCells: cost + 1 })
  assert.ok(limited.removed[0])
  assert.equal(limited.removed[1], null)
})

// --- pairing ----------------------------------------------------------------------------------

test('line similarity is the shared token ratio over words and punctuation', () => {
  assert.equal(lineSimilarity('a b c d', 'a b c d'), 1)
  assert.equal(lineSimilarity('a b c d', 'a b x y'), 0.5)
  assert.equal(lineSimilarity('a b', 'x y'), 0)
  assert.equal(lineSimilarity('', ''), 0)
})

test('equal counts pair 1:1 by position', () => {
  assert.deepEqual(pairLines(['alpha beta gamma', 'one two three'], ['alpha beta delta', 'one two four']), [[0, 0], [1, 1]])
})

test('equal counts: a pair below the 0.4 threshold stays plain', () => {
  // 'a b c d e' vs 'a x y z w': 1 of 5 shared, 0.2.
  assert.deepEqual(pairLines(['alpha beta gamma', 'a b c d e'], ['alpha beta delta', 'a x y z w']), [[0, 0]])
  // Exactly 0.4 pairs: 2 of 5 words shared on both sides.
  assert.deepEqual(pairLines(['a b c d e'], ['a b x y z']), [[0, 0]])
  // Just under: 1 of 3 shared, 0.33.
  assert.deepEqual(pairLines(['a b c'], ['a x y']), [])
})

test('unequal counts pair each removed line with its most similar added line, without reuse', () => {
  const removed = ['the quick brown fox', 'jumps over the lazy dog']
  const added = ['a new intro line here', 'jumps over the sleepy dog', 'the quick red fox', 'trailing words']
  assert.deepEqual(pairLines(removed, added), [[0, 2], [1, 1]])
  // Two removed lines want the same added line: the first takes it, the second takes the next best.
  assert.deepEqual(pairLines(['x y z w', 'x y z v'], ['x y z w', 'x y z q', 'other']), [[0, 0], [1, 1]])
  // Below threshold everywhere: nothing pairs.
  assert.deepEqual(pairLines(['a b c'], ['x y z', 'p q r']), [])
})

test('a pure addition or removal gets no word marks', () => {
  assert.deepEqual(blockMarks([], ['new line one', 'new line two']), { removed: [], added: [null, null] })
  assert.deepEqual(blockMarks(['gone'], []), { removed: [null], added: [] })
})

test('blockMarks marks paired lines and leaves unpaired lines plain', () => {
  const r = blockMarks(['keep these words red'], ['keep these words blue', 'brand new unrelated text'])
  assert.deepEqual(marked(r.removed[0]), ['red'])
  assert.deepEqual(marked(r.added[0]), ['blue'])
  assert.equal(r.added[1], null)
})

// --- rendering --------------------------------------------------------------------------------

const replaceBlock = (fields = {}) => ({
  id: 'b1', state: 'pending', can_accept: true, staged_at: 1, origin: 'background_review', summary: 'replace',
  removed: [{ no: 4, text: BEN_OLD }], added: [{ no: 4, text: BEN_NEW }], ...fields
})

test('segmentRows attaches marks to paired block rows, not to context rows', () => {
  const rows = segmentRows({ type: 'block', block: replaceBlock() })
  assert.deepEqual(marked(rows[0].marks), [' workflows', ' and agent ', ', not new requests', ' delivery'])
  assert.deepEqual(marked(rows[1].marks), ['/'])
  assert.equal(rows[0].text, BEN_OLD, 'row text is unchanged')
  const ctx = segmentRows({ type: 'context', lines: [{ no: 1, text: 'a' }] })
  assert.equal(ctx[0].marks, undefined)
  const create = segmentRows({ type: 'block', block: replaceBlock({ removed: [], added: [{ no: 1, text: 'new' }] }) })
  assert.equal(create[0].marks, undefined)
})

test('DiffRow wraps changed spans in del/ins with the mark style and keeps the visible text', () => {
  const [oldRow, newRow] = segmentRows({ type: 'block', block: replaceBlock() })
  const oldTree = expand(DiffRow({ row: oldRow, t }))
  const spans = markNodes(oldTree)
  assert.deepEqual(spans.map(s => s.props.children), [' workflows', ' and agent ', ', not new requests', ' delivery'])
  assert.ok(spans.every(s => s.type === 'del' && s.props.style === MARK_STYLES.remove))
  assert.ok(spans.every(s => !('aria-label' in s.props) && !('title' in s.props)), 'no extra text on marks')
  const textCell = kids(oldTree)[3]
  const visible = kids(textCell).length ? textCell.props.children.flat(Infinity).map(c => (typeof c === 'string' ? c : c.props.children)).join('') : ''
  assert.equal(visible, BEN_OLD)
  assert.equal(kids(oldTree)[2].props.children, '-', 'the gutter sign stays')
  const ins = markNodes(expand(DiffRow({ row: newRow, t })))
  assert.equal(ins[0].type, 'ins')
  assert.equal(ins[0].props.style, MARK_STYLES.add)
})

test('wrapped long lines still wrap with marks inside them', () => {
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
  const block = replaceBlock({ removed: [{ no: 1, text: long }], added: [{ no: 1, text: long.replace('word100', 'changed100') }] })
  const tree = expand(DiffRow({ row: segmentRows({ type: 'block', block })[0], t }))
  const textCell = kids(tree)[3]
  assert.equal(textCell.props.style, STYLES.rowText)
  assert.equal(STYLES.rowText.whiteSpace, 'pre-wrap')
  assert.equal(STYLES.rowText.overflowWrap, 'anywhere')
  assert.equal(STYLES.rowText.minWidth, 0)
  assert.equal(markNodes(tree).length, 1)
  for (const style of Object.values(MARK_STYLES)) {
    assert.ok(!style.display || style.display === 'inline', 'marks stay inline so the line can break inside them')
    assert.equal(style.whiteSpace, undefined)
    for (const prop of ['padding', 'margin', 'border', 'paddingLeft', 'paddingRight', 'marginLeft', 'marginRight']) {
      assert.equal(style[prop], undefined, `${prop} would shift the layout`)
    }
    assert.equal(style.boxDecorationBreak, 'clone', 'each wrapped piece gets its own rounded ends')
  }
})

test('mark styles use theme variables and no colour literals', () => {
  assert.match(MARK_STYLES.add.background, /color-mix\(in srgb, var\(--ui-diff-add-border\) \d+%, transparent\)/)
  assert.match(MARK_STYLES.remove.background, /color-mix\(in srgb, var\(--ui-diff-remove-border\) \d+%, transparent\)/)
  for (const [name, style] of Object.entries(MARK_STYLES)) {
    for (const [prop, value] of Object.entries(style)) {
      if (typeof value !== 'string') continue
      assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i, `${name}.${prop}`)
      if (/color|background/i.test(prop)) assert.match(value, /var\(--ui-diff-(add|remove)-[a-z]+\)/, `${name}.${prop}`)
    }
    assert.ok(style.borderRadius, `${name} has a radius`)
  }
  assert.equal(MARK_STYLES.remove.textDecorationLine, 'line-through')
  assert.equal(MARK_STYLES.add.textDecorationLine, 'underline')
  const src = readFileSync(pluginPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/)
})

test('a stale block keeps its grey treatment, shows dimmed marks and no Accept', () => {
  const tree = expand(BlockView({ block: replaceBlock({ state: 'stale', reason: 'file changed' }), busy: false, isNew: false, onAccept() {}, onReject() {}, t }))
  assert.equal(tree.props.style.opacity, 0.55)
  const spans = markNodes(tree)
  assert.equal(spans.length, 5)
  assert.ok(spans.every(s => s.props.style === MARK_STYLES[s.type === 'del' ? 'removeDim' : 'addDim']))
  const weight = s => Number(/(\d+)%/.exec(s.background)[1])
  assert.ok(weight(MARK_STYLES.removeDim) < weight(MARK_STYLES.remove))
  assert.ok(weight(MARK_STYLES.addDim) < weight(MARK_STYLES.add))
  assert.equal(walk(tree).find(n => n.props?.children === 'accept'), undefined)
  const live = markNodes(expand(BlockView({ block: replaceBlock(), busy: false, isNew: true, onAccept() {}, onReject() {}, t })))
  assert.ok(live.every(s => s.props.style === MARK_STYLES[s.type === 'del' ? 'remove' : 'add']))
})

test('the per-item diff view marks a replaced line in a unified hunk, and not a new file', () => {
  const patch = { kind: 'patch', text: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,3 +1,3 @@\n keep\n-use foo_bar here\n+use foo_baz here\n keep2\n' }
  const spans = markNodes(expand(DiffView({ sections: [patch], newFileLabel: 'new', t })))
  assert.deepEqual(spans.map(s => [s.type, s.props.children]), [['del', 'r'], ['ins', 'z']])
  const create = { kind: 'create', text: 'line one\nline two\n' }
  assert.equal(markNodes(expand(DiffView({ sections: [create], newFileLabel: 'new', t }))).length, 0)
})
