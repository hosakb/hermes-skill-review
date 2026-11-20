/**
 * Skill Review: Hermes Desktop half.
 *
 * Shows every skill and memory write that Hermes staged under skills.write_approval and
 * memory.write_approval. One pane on the workspace's right edge holds a list of every pending write
 * and, beside it, the diff of the selected one with Accept and Reject. The pane opens only from the
 * status-bar Review chip, the palette or a toast, or by itself when a new change arrives and autoOpen
 * is on. Otherwise a new change shows as a toast or a lit chip. Nothing takes over the main view.
 * The backend is dashboard/plugin_api.py (/api/plugins/skill-review).
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls. Only @hermes/plugin-sdk, react and
 * react/jsx-runtime resolve. Layout and colour use inline styles with theme variables only, because
 * a disk plugin's utility classes are not part of the app's compiled stylesheet.
 */

import {
  atom,
  Badge,
  Button,
  Checkbox,
  Codicon,
  ConfirmDialog,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuTrigger,
  EmptyState,
  ErrorState,
  haptic,
  host,
  Input,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  queryClient,
  relativeTime,
  ROUTES_AREA,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  STATUSBAR_AREAS,
  Textarea,
  Tip,
  useMutation,
  usePluginI18n,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'skill-review'
const ROUTE = '/skill-review'
const POLL_MS = 3000

export const LIST_PANE = `${ID}:list`
/** The second pane. Desktop turns a plugin off when its only pane is closed (closeTreePane in the
 *  tree store), so with two registered panes every Close only dismisses the pane it was used on. */
export const SETTINGS_PANE = `${ID}:settings`

let CTX = null
let useRouteFallback = false

/** UI state shared by both panes. Module-level atoms, so a pane remount (drag, tab switch, reload of
 *  the layout) keeps the selection and filters. */
export const $selection = atom(null)
const $scope = atom(null) // null: follow the focused profile while it has items, else all
export const $kind = atom('all')
const $confirming = atom(null) // key of the item whose reject dialog is open

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for the node tests)
// ---------------------------------------------------------------------------------------------

// The id is unique only inside one profile's queue for one subsystem, so the key carries all three.
export const itemKey = item => `${item.subsystem}/${item.profile}/${item.id}`

export const KINDS = ['all', 'skills', 'memory']

export const countBySubsystem = items => ({
  all: items.length,
  memory: items.filter(item => item.subsystem === 'memory').length,
  skills: items.filter(item => item.subsystem === 'skills').length
})

export const pendingPath = (item, verb) =>
  `/pending/${encodeURIComponent(item.subsystem)}/${encodeURIComponent(item.profile)}/${encodeURIComponent(item.id)}/${verb}`

/** Keys that were not announced before, and the announced set to keep (pruned to what is still pending). */
export function planAutoOpen(items, announced) {
  const known = new Set(announced)
  const current = items.map(itemKey)
  const fresh = current.filter(key => !known.has(key))
  const keep = current.filter(key => known.has(key) || fresh.includes(key))

  return { fresh, keep }
}

/** Items for the chosen profile scope ('focused' | 'all') and kind ('all' | 'skills' | 'memory'). */
/** After resolving `key`, the item to select next: the following one, else the previous, else none. */
export function nextKeyAfter(items, key) {
  const keys = items.map(itemKey)
  const index = keys.indexOf(key)

  if (index < 0) {
    return keys[0] ?? null
  }

  return keys[index + 1] ?? keys[index - 1] ?? null
}

export function visibleItems(items, scope, focused, kind = 'all') {
  const inScope = scope === 'all' ? items : items.filter(item => item.profile === focused)

  return kind === 'all' ? inScope : inScope.filter(item => item.subsystem === kind)
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const splitLines = text => {
  const lines = String(text ?? '').split('\n')

  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines
}

/**
 * Turn one backend section ({ kind, text }) into display rows.
 * Row kinds: add, remove, context, hunk, file, note. `create` is all added, `delete` all removed.
 */
export function parseSection(section) {
  const lines = splitLines(section.text)

  if (section.kind === 'create') {
    return lines.map((text, i) => ({ kind: 'add', text, newNo: i + 1 }))
  }

  if (section.kind === 'delete') {
    return lines.map(text => ({ kind: 'remove', text }))
  }

  const rows = []
  let oldLeft = 0
  let newLeft = 0
  let oldNo = 0
  let newNo = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const inHunk = oldLeft > 0 || newLeft > 0

    if (inHunk) {
      const sign = line[0]

      if (sign === '\\') {
        rows.push({ kind: 'note', text: line.slice(1).trim() })
      } else if (sign === '+') {
        rows.push({ kind: 'add', text: line.slice(1), newNo })
        newNo += 1
        newLeft -= 1
      } else if (sign === '-') {
        rows.push({ kind: 'remove', text: line.slice(1), oldNo })
        oldNo += 1
        oldLeft -= 1
      } else {
        rows.push({ kind: 'context', text: line.slice(1), oldNo, newNo })
        oldNo += 1
        newNo += 1
        oldLeft -= 1
        newLeft -= 1
      }

      continue
    }

    const hunk = HUNK.exec(line)

    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[3])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      rows.push({ kind: 'hunk', text: line.replace(/^(@@[^@]*@@).*$/, '$1') })
    } else if (line.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) {
      rows.push({ kind: 'file', text: lines[i + 1].slice(4).replace(/^b\//, '') })
      i += 1
    } else if (line.trim()) {
      rows.push({ kind: 'note', text: line })
    }
  }

  return rows
}

// ---------------------------------------------------------------------------------------------
// Word marks inside a change block. intralineSegments diffs one removed line against one added
// line by tokens; pairLines decides which removed line is compared with which added line. Both are
// pure. Every pair is capped (tokens per side, DP cells) and so is a whole block, so a huge line
// falls back to plain tinting instead of freezing the UI.
// ---------------------------------------------------------------------------------------------

const TOKEN = /\s+|[\p{L}\p{M}\p{N}_']+|[^]/gu
const WORD = /^[\p{L}\p{M}\p{N}_']+$/u
const SPACE = /^\s+$/u

export const INTRALINE_LIMITS = { tokens: 2500, cells: 4_000_000, blockCells: 16_000_000, pairChecks: 2500, similarity: 0.4 }

/** Whitespace runs, word runs (letters, digits, underscore, apostrophe) and single other characters. */
export const tokenize = text => String(text ?? '').match(TOKEN) ?? []

const plain = text => [{ text, changed: false }]

/** Shared token ratio of two lines (whitespace ignored): 2 * shared / (count a + count b). */
export function lineSimilarity(a, b) {
  const left = tokenize(a).filter(x => !SPACE.test(x))
  const right = tokenize(b).filter(x => !SPACE.test(x))

  if (!left.length || !right.length) {
    return 0
  }

  const counts = new Map()
  left.forEach(x => counts.set(x, (counts.get(x) ?? 0) + 1))
  let shared = 0

  for (const x of right) {
    const n = counts.get(x)

    if (n) {
      shared += 1
      counts.set(x, n - 1)
    }
  }

  return (2 * shared) / (left.length + right.length)
}

// Edit script over tokens: 0 equal, 1 only in a (removed), 2 only in b (added). Null when the
// middle left after trimming the common prefix and suffix needs more DP cells than `cells`.
function tokenOps(a, b, cells) {
  let pre = 0

  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    pre += 1
  }

  let suf = 0

  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    suf += 1
  }

  const n = a.length - pre - suf
  const m = b.length - pre - suf

  if ((n + 1) * (m + 1) > cells) {
    return null
  }

  // lcs[i * w + j] = length of the longest common subsequence of a[pre+i..] and b[pre+j..].
  const w = m + 1
  const lcs = new Uint16Array((n + 1) * w)

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * w + j] = a[pre + i] === b[pre + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }

  const ops = []

  for (let k = 0; k < pre; k += 1) ops.push({ op: 0, text: a[k] })

  let i = 0
  let j = 0

  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) {
      ops.push({ op: 0, text: a[pre + i] })
      i += 1
      j += 1
    } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      ops.push({ op: 1, text: a[pre + i] })
      i += 1
    } else {
      ops.push({ op: 2, text: b[pre + j] })
      j += 1
    }
  }

  for (let k = a.length - suf; k < a.length; k += 1) ops.push({ op: 0, text: a[k] })

  return { ops, cost: (n + 1) * (m + 1) }
}

// A pure removal or addition bounded by the same whitespace on both ends could take either one.
// Always take the space before it, so "a b c" to "a c" marks " b", wherever the diff matched.
function slideToLeadingSpace(ops) {
  let start = 0

  while (start < ops.length) {
    if (ops[start].op === 0) {
      start += 1
      continue
    }

    let end = start

    while (end < ops.length && ops[end].op !== 0) end += 1

    const kind = ops[start].op
    const pure = ops.slice(start, end).every(o => o.op === kind)

    while (pure && start > 0 && ops[start - 1].op === 0 && SPACE.test(ops[start - 1].text) && ops[start - 1].text === ops[end - 1].text) {
      ops[start - 1].op = kind
      ops[end - 1].op = 0
      start -= 1
      end -= 1
    }

    start = end
  }
}

// A changed word of 4+ characters whose shared prefix + suffix covers at least half of it is
// marked only where the characters differ. Returns [prefix, suffix] lengths in code points.
function charSplit(left, right) {
  if (!WORD.test(left) || !WORD.test(right)) {
    return null
  }

  const a = [...left]
  const b = [...right]

  if (a.length < 4 || b.length < 4) {
    return null
  }

  let pre = 0

  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1

  let suf = 0

  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1

  return 2 * (pre + suf) >= Math.max(a.length, b.length) ? [pre, suf] : null
}

// One side's tokens with changed flags: merge, absorb a lone space between two changed spans,
// drop a span that is only whitespace, then build segments.
function sideSegments(tokens) {
  const changed = i => tokens[i]?.changed === true

  for (let i = 1; i < tokens.length - 1; i += 1) {
    if (!tokens[i].changed && SPACE.test(tokens[i].text) && changed(i - 1) && changed(i + 1)) {
      tokens[i].changed = true
      tokens[i].absorbed = true
    }
  }

  for (let i = 0; i < tokens.length; ) {
    if (!tokens[i].changed) {
      i += 1
      continue
    }

    let end = i

    while (end < tokens.length && tokens[end].changed) end += 1

    if (tokens.slice(i, end).every(x => SPACE.test(x.text))) {
      tokens.slice(i, end).forEach(x => { x.changed = false })
    }

    i = end
  }

  const segments = []
  const push = (text, isChanged) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last && last.changed === isChanged) last.text += text
    else segments.push({ text, changed: isChanged })
  }

  tokens.forEach((token, i) => {
    if (token.changed && token.split && !changed(i - 1) && !changed(i + 1)) {
      const chars = [...token.text]
      const [pre, suf] = token.split
      push(chars.slice(0, pre).join(''), false)
      push(chars.slice(pre, chars.length - suf).join(''), true)
      push(chars.slice(chars.length - suf).join(''), false)
    } else {
      push(token.text, token.changed)
    }
  })

  return segments.length ? segments : plain('')
}

/**
 * Word marks for one removed line against one added line. Returns { old, new, capped, cost }:
 * `old` and `new` are segment arrays ({ text, changed }) that join back to the input exactly.
 * `capped` is true when a limit was hit; then nothing is marked.
 */
export function intralineSegments(oldText, newText, limits = INTRALINE_LIMITS) {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const fallback = { old: plain(String(oldText ?? '')), new: plain(String(newText ?? '')), capped: true, cost: 0 }

  if (a.length > limits.tokens || b.length > limits.tokens) {
    return fallback
  }

  const result = tokenOps(a, b, limits.cells)

  if (!result) {
    return fallback
  }

  const { ops, cost } = result
  slideToLeadingSpace(ops)

  const left = []
  const right = []

  for (let k = 0; k < ops.length; ) {
    if (ops[k].op === 0) {
      left.push({ text: ops[k].text, changed: false })
      right.push({ text: ops[k].text, changed: false })
      k += 1
      continue
    }

    let end = k

    while (end < ops.length && ops[end].op !== 0) end += 1

    const removed = ops.slice(k, end).filter(o => o.op === 1).map(o => ({ text: o.text, changed: true }))
    const added = ops.slice(k, end).filter(o => o.op === 2).map(o => ({ text: o.text, changed: true }))

    if (removed.length === 1 && added.length === 1) {
      const split = charSplit(removed[0].text, added[0].text)
      if (split) {
        removed[0].split = split
        added[0].split = split
      }
    }

    left.push(...removed)
    right.push(...added)
    k = end
  }

  return { old: sideSegments(left), new: sideSegments(right), capped: false, cost }
}

/**
 * Which removed line to compare with which added line, as [removedIndex, addedIndex] pairs.
 * Equal counts pair by position; otherwise each removed line, in order, takes its most similar
 * unused added line. A pair under the similarity threshold is left out (no marks).
 */
export function pairLines(removed, added, limits = INTRALINE_LIMITS) {
  if (!removed.length || !added.length) {
    return []
  }

  if (removed.length === added.length) {
    return removed.map((_, i) => [i, i]).filter(([i, j]) => lineSimilarity(removed[i], added[j]) >= limits.similarity)
  }

  if (removed.length * added.length > limits.pairChecks) {
    return []
  }

  const used = new Set()
  const pairs = []

  removed.forEach((text, i) => {
    let best = -1
    let score = limits.similarity

    added.forEach((other, j) => {
      if (used.has(j)) return
      const s = lineSimilarity(text, other)
      if (s > score || (s === score && best < 0)) {
        best = j
        score = s
      }
    })

    if (best >= 0) {
      used.add(best)
      pairs.push([i, best])
    }
  })

  return pairs
}

/**
 * Marks for a whole block: { removed, added }, one entry per line, a segment array for a paired
 * line with at least one changed span, else null. A pure addition or removal gets no marks.
 */
export function blockMarks(removed, added, limits = INTRALINE_LIMITS) {
  const out = { removed: removed.map(() => null), added: added.map(() => null) }
  let budget = limits.blockCells

  for (const [i, j] of pairLines(removed, added, limits)) {
    if (budget <= 0) break

    const r = intralineSegments(removed[i], added[j], { ...limits, cells: Math.min(limits.cells, budget) })

    budget -= r.cost

    if (r.old.some(s => s.changed) || r.new.some(s => s.changed)) {
      out.removed[i] = r.old
      out.added[j] = r.new
    }
  }

  return out
}

// Marks are computed once per block or section object (both come from a cached query).
const MARK_CACHE = new WeakMap()

/** Add `marks` to each run of removed rows followed by added rows (notes may sit between them). */
export function markRows(rows, owner) {
  const out = rows.map(row => ({ ...row }))
  const groups = []
  let group = null

  out.forEach((row, index) => {
    if (row.kind === 'remove' && (!group || group.added.length)) {
      group = { removed: [], added: [] }
      groups.push(group)
    }

    if (row.kind === 'remove') group.removed.push(index)
    else if (row.kind === 'add' && group) group.added.push(index)
    else if (row.kind !== 'note') group = null
  })

  const all = owner ? (MARK_CACHE.get(owner) ?? null) : null
  const computed = all ?? groups.map(g => blockMarks(g.removed.map(i => out[i].text), g.added.map(i => out[i].text)))

  if (owner && !all) {
    MARK_CACHE.set(owner, computed)
  }

  groups.forEach((g, k) => {
    g.removed.forEach((index, n) => { if (computed[k]?.removed[n]) out[index].marks = computed[k].removed[n] })
    g.added.forEach((index, n) => { if (computed[k]?.added[n]) out[index].marks = computed[k].added[n] })
  })

  return out
}

/** `text` as a sentence that ends exactly once: Hermes's error text often ends with its own period,
 *  so one is added only when no terminal punctuation is there already. */
export function endSentence(text) {
  const trimmed = String(text ?? '').trim().replace(/[\s,;:]+$/, '')

  if (!trimmed) {
    return ''
  }

  return /[.!?…]["')\]]*$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** One toast per backend status. Returns { kind, message }. */
export function resultToast(verb, result, t) {
  const name = result?.item?.subject || ''

  switch (result?.status) {
    case 'applied':
      return { kind: 'success', message: t('accepted', name) }
    case 'rejected':
      return { kind: 'info', message: t('rejected', name) }
    case 'already_handled':
      return { kind: 'info', message: t('alreadyHandled') }
    default: {
      // A Skills Guard block is a multi-line report: headline in the toast, full report as detail.
      const error = String(result?.error || '')
      const [headline] = error.split('\n')

      return { kind: 'error', message: t('failed', headline), ...(error.includes('\n') ? { detail: error } : {}) }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Styles (theme variables only). Every flex or grid child on the path from a pane root to a diff
// row's text has minWidth: 0, so a long unbroken line can never push a parent wider than the pane.
// ---------------------------------------------------------------------------------------------

const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const PAD = '0.75rem'

export const STYLES = {
  paneRoot: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' },
  bar: {
    borderBottom: '1px solid var(--ui-stroke-secondary)',
    display: 'flex',
    flex: 'none',
    flexDirection: 'column',
    gap: '0.4rem',
    minWidth: 0,
    padding: `0.5rem ${PAD}`
  },
  barRow: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.35rem', minWidth: 0 },
  // A button never shrinks below its label and never grows past its row: a label longer than the
  // pane is cut with an ellipsis inside the button instead of by the pane edge.
  button: { flexShrink: 0, maxWidth: '100%', minWidth: 0 },
  ellipsis: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // Row actions stay together at the row's right end; when the row is too narrow they wrap onto a
  // line of their own, still right-aligned, before any button is squeezed.
  actions: {
    alignItems: 'center',
    display: 'flex',
    flex: '0 0 auto',
    flexWrap: 'wrap',
    gap: '0.3rem',
    justifyContent: 'flex-end',
    marginLeft: 'auto',
    maxWidth: '100%',
    minWidth: 0
  },
  listScroll: { flex: '1 1 auto', minHeight: 0, minWidth: 0, overflowX: 'hidden', overflowY: 'auto' },
  detailScroll: { flex: '1 1 auto', minHeight: 0, minWidth: 0, overflowX: 'hidden', overflowY: 'auto', padding: PAD },
  listRow: {
    background: 'none',
    border: 0,
    borderBottom: '1px solid var(--ui-stroke-tertiary)',
    borderLeft: '2px solid transparent',
    color: 'var(--ui-text-primary)',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    minWidth: 0,
    padding: `0.5rem ${PAD}`,
    textAlign: 'left',
    width: '100%'
  },
  listRowSelected: { background: 'var(--ui-bg-tertiary)', borderLeft: '2px solid var(--ui-accent)' },
  listTitle: { fontSize: '0.8125rem', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listMeta: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.3rem', minWidth: 0 },
  muted: { color: 'var(--ui-text-tertiary)', fontSize: '0.7rem' },
  // Header block: the title row, then the summary line, each padded off the pane edge on its own.
  headerWrap: { borderBottom: '1px solid var(--ui-stroke-secondary)', display: 'flex', flex: 'none', flexDirection: 'column', minWidth: 0, paddingBottom: '0.6rem' },
  header: {
    alignItems: 'center',
    display: 'flex',
    flex: 'none',
    flexWrap: 'wrap',
    gap: '0.4rem 0.5rem',
    minWidth: 0,
    paddingBottom: '0.4rem',
    paddingLeft: PAD,
    paddingRight: PAD,
    paddingTop: '0.6rem'
  },
  headerTitle: {
    flex: '1 1 10rem',
    fontSize: '0.9375rem',
    fontWeight: 600,
    minWidth: 0,
    overflowWrap: 'anywhere'
  },
  summary: {
    color: 'var(--ui-text-tertiary)',
    fontSize: '0.75rem',
    minWidth: 0,
    overflowWrap: 'anywhere',
    paddingLeft: PAD,
    paddingRight: PAD
  },
  sections: { display: 'flex', flexDirection: 'column', gap: '0.75rem', minWidth: 0 },
  sectionTitle: { color: 'var(--ui-text-secondary)', fontSize: '0.75rem', fontWeight: 500, marginBottom: '0.25rem', overflowWrap: 'anywhere' },
  // Last-resort guard: a string that cannot break at all scrolls inside the box instead of being clipped.
  diffBox: {
    background: 'var(--ui-editor-surface-background)',
    border: '1px solid var(--ui-stroke-secondary)',
    borderRadius: '6px',
    boxSizing: 'border-box',
    maxWidth: '100%',
    minWidth: 0,
    overflowX: 'auto',
    paddingBottom: '0.25rem'
  },
  // Fixed gutters (old no, new no, sign) and a text column that shrinks and wraps; a wrapped
  // continuation line stays in the text column, under the text, not under the gutter.
  row: {
    display: 'grid',
    fontFamily: mono,
    fontSize: '0.75rem',
    gridTemplateColumns: '4ch 4ch 2ch minmax(0, 1fr)',
    lineHeight: 1.55,
    minWidth: 0
  },
  gutter: { color: 'var(--ui-text-quaternary)', paddingRight: '0.5ch', textAlign: 'right', userSelect: 'none', whiteSpace: 'nowrap' },
  sign: { paddingLeft: '0.5ch', userSelect: 'none', whiteSpace: 'nowrap' },
  rowText: { minWidth: 0, overflowWrap: 'anywhere', paddingRight: '0.75ch', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  fileRow: {
    alignItems: 'center',
    background: 'var(--ui-bg-tertiary)',
    color: 'var(--ui-text-primary)',
    display: 'flex',
    fontFamily: mono,
    fontSize: '0.75rem',
    fontWeight: 600,
    gap: '0.5rem',
    minWidth: 0,
    overflowWrap: 'anywhere',
    padding: '0.35rem 0.75rem'
  },
  hunkRow: { background: 'var(--ui-bg-quaternary)', color: 'var(--ui-text-tertiary)', fontFamily: mono, fontSize: '0.7rem', overflowWrap: 'anywhere', padding: '0.15rem 0.75rem' },
  noteRow: { color: 'var(--ui-text-tertiary)', fontFamily: mono, fontSize: '0.75rem', overflowWrap: 'anywhere', padding: '0.35rem 0.75rem', whiteSpace: 'pre-wrap' }
}

const ROW_TONE = {
  add: {
    background: 'var(--ui-diff-add-background)',
    borderLeft: '2px solid var(--ui-diff-add-border)',
    color: 'var(--ui-diff-add-foreground)'
  },
  remove: {
    background: 'var(--ui-diff-remove-background)',
    borderLeft: '2px solid var(--ui-diff-remove-border)',
    color: 'var(--ui-diff-remove-foreground)'
  },
  context: { borderLeft: '2px solid transparent', color: 'var(--ui-text-secondary)' }
}

const SIGN = { add: '+', remove: '-', context: ' ' }

// A changed span inside a tinted row: a stronger wash of the row's own hue (its border colour mixed
// over the row tint), plus line-through or underline so the change does not rely on colour alone.
// No padding, margin or border, so marking a span never moves the text; clone keeps rounded ends
// on each piece of a span that wraps. Stale blocks use the dim pair.
const mark = (tone, weight, line) => ({
  background: `color-mix(in srgb, var(--ui-diff-${tone}-border) ${weight}%, transparent)`,
  borderRadius: '2px',
  boxDecorationBreak: 'clone',
  textDecorationColor: `color-mix(in srgb, var(--ui-diff-${tone}-foreground) ${weight + 30}%, transparent)`,
  textDecorationLine: line,
  textDecorationThickness: '1px',
  textUnderlineOffset: '0.2em',
  WebkitBoxDecorationBreak: 'clone'
})

export const MARK_STYLES = {
  add: mark('add', 30, 'underline'),
  remove: mark('remove', 30, 'line-through'),
  addDim: mark('add', 15, 'underline'),
  removeDim: mark('remove', 15, 'line-through')
}

const MARK_TAG = { add: 'ins', remove: 'del' }

function rowText(row, dim) {
  if (!row.marks) {
    return row.text || ' '
  }

  const style = MARK_STYLES[dim ? `${row.kind}Dim` : row.kind]

  return row.marks.map((segment, i) =>
    segment.changed ? jsx(MARK_TAG[row.kind], { 'data-mark': row.kind, style, children: segment.text }, i) : segment.text
  )
}

// ---------------------------------------------------------------------------------------------
// Diff view (pure components: props in, tree out)
// ---------------------------------------------------------------------------------------------

export function DiffRow({ row, t, dim = false }) {
  if (row.kind === 'file') {
    return jsxs('div', { style: STYLES.fileRow, children: [jsx(Codicon, { name: 'file' }), row.text] })
  }

  if (row.kind === 'hunk') {
    return jsx('div', { style: STYLES.hunkRow, children: row.text })
  }

  if (row.kind === 'note') {
    return jsx('div', { style: STYLES.noteRow, children: row.text })
  }

  return jsxs('div', {
    'aria-label': t(`row_${row.kind}`),
    style: { ...STYLES.row, ...ROW_TONE[row.kind] },
    children: [
      jsx('span', { style: STYLES.gutter, children: row.oldNo ?? '' }),
      jsx('span', { style: STYLES.gutter, children: row.newNo ?? '' }),
      jsx('span', { style: STYLES.sign, children: SIGN[row.kind] }),
      jsx('span', { style: STYLES.rowText, children: rowText(row, dim) })
    ]
  })
}

export function DiffView({ sections, newFileLabel, t }) {
  return jsx('div', {
    style: STYLES.sections,
    children: sections.map((section, index) => {
      const lead = section.kind === 'create' ? [{ kind: 'file', text: newFileLabel }] : []
      const rows = [...lead, ...markRows(parseSection(section), section)]

      return jsxs(
        'div',
        {
          style: { minWidth: 0 },
          children: [
            section.title ? jsx('div', { style: STYLES.sectionTitle, children: section.title }) : null,
            jsx('div', { style: STYLES.diffBox, children: rows.map((row, i) => jsx(DiffRow, { row, t }, i)) })
          ]
        },
        index
      )
    })
  })
}

// ---------------------------------------------------------------------------------------------
// List pane
// ---------------------------------------------------------------------------------------------

export function ListRow({ item, selected, onSelect, t }) {
  const key = itemKey(item)

  return jsxs('button', {
    'aria-current': selected,
    onClick: () => onSelect(key),
    style: selected ? { ...STYLES.listRow, ...STYLES.listRowSelected } : STYLES.listRow,
    type: 'button',
    children: [
      jsx('span', { style: STYLES.listTitle, children: item.subject }),
      jsxs('span', {
        style: STYLES.listMeta,
        children: [
          jsx(Badge, { size: 'xs', variant: item.subsystem === 'memory' ? 'default' : 'muted', children: t(`kind_${item.subsystem}`) }),
          jsx(Badge, { size: 'xs', variant: 'muted', children: t(`action_${item.action}`) }),
          jsx(Badge, { size: 'xs', variant: 'outline', children: item.profile }),
          item.origin === 'background_review' ? jsx(Badge, { size: 'xs', variant: 'muted', children: t('auto') }) : null,
          jsx('span', { style: STYLES.muted, children: relativeTime(item.created_at * 1000) })
        ]
      })
    ]
  })
}

const pendingKey = profile => [ID, 'pending', profile]
const fetchPending = () => CTX.rest('/pending')

function usePending() {
  const profile = useValue(host.state.profile)

  return useQuery({
    queryFn: fetchPending,
    queryKey: pendingKey(profile),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true
  })
}

/** Items the list shows, with the same filters for both panes (the detail needs them to pick the
 *  next item after an accept or reject). */
function useVisible() {
  const query = usePending()
  const focused = useValue(host.state.focusedSessionProfile) || 'default'
  const scope = useValue($scope)
  const kind = useValue($kind)
  const items = query.data?.items ?? []
  const focusedCount = visibleItems(items, 'focused', focused).length
  const effective = scope ?? (focusedCount > 0 ? 'focused' : 'all')
  const inScope = visibleItems(items, effective, focused)

  return {
    ...query,
    effective,
    focused,
    focusedCount,
    inScope,
    items,
    kind,
    kindCounts: countBySubsystem(inScope),
    shown: visibleItems(items, effective, focused, kind)
  }
}

export function FilterButton({ active, label, onClick }) {
  return jsx(Button, {
    'aria-pressed': active,
    onClick,
    size: 'xs',
    style: STYLES.button,
    title: label,
    type: 'button',
    variant: active ? 'chip' : 'ghost',
    children: jsx('span', { style: STYLES.ellipsis, children: label })
  })
}

function ListPane() {
  const t = usePluginI18n(ID)
  const v = useVisible()
  const selection = useValue($selection)
  const missing = v.isError && /404/.test(String(v.error?.message || ''))
  const gateOn = (v.data?.profiles ?? []).some(p => Object.values(p.gates ?? {}).some(Boolean))

  // Keep a selection while anything is listed: the detail pane is never blank by accident.
  useEffect(() => {
    if (v.shown.length && !v.shown.some(item => itemKey(item) === selection)) {
      $selection.set(itemKey(v.shown[0]))
    }
  }, [v.shown, selection])

  const bar = jsxs('div', {
    style: STYLES.bar,
    children: [
      jsxs('div', {
        style: STYLES.barRow,
        children: [
          jsx('span', { style: { fontSize: '0.875rem', fontWeight: 600, minWidth: 0 }, children: t('paneTitle') }),
          v.items.length ? jsx(Badge, { variant: 'warn', children: v.items.length }) : null
        ]
      }),
      jsxs('div', {
        'aria-label': t('scopeGroup'),
        role: 'group',
        style: STYLES.barRow,
        children: [
          jsx(FilterButton, { active: v.effective === 'focused', label: t('scopeFocused', v.focused, v.focusedCount), onClick: () => $scope.set('focused') }),
          jsx(FilterButton, { active: v.effective === 'all', label: t('scopeAll', v.items.length), onClick: () => $scope.set('all') })
        ]
      }),
      jsx('div', {
        'aria-label': t('kindGroup'),
        role: 'group',
        style: STYLES.barRow,
        children: KINDS.map(k =>
          jsx(FilterButton, { active: v.kind === k, label: t('kindFilter', t(`kind_${k}`), v.kindCounts[k]), onClick: () => $kind.set(k) }, k)
        )
      }),
      jsx(NotifyModeControl, {})
    ]
  })

  let body

  if (missing) {
    body = jsx(ErrorState, { description: t('backendMissing'), title: t('loadError') })
  } else if (v.isError) {
    body = jsx(ErrorState, {
      children: jsx(Button, { onClick: () => v.refetch(), size: 'sm', type: 'button', variant: 'outline', children: t('retry') }),
      description: String(v.error?.message || ''),
      title: t('loadError')
    })
  } else if (v.isLoading) {
    body = jsx('div', { style: { ...STYLES.muted, padding: PAD }, children: t('loading') })
  } else if (!v.shown.length) {
    const description = v.inScope.length
      ? t('emptyKind', t(`kind_${v.kind}`))
      : v.items.length
        ? t('emptyElsewhere', v.items.length)
        : gateOn
          ? t('emptyBody')
          : t('gateOff')

    body = jsx(EmptyState, { description, title: t('emptyTitle') })
  } else {
    body = v.shown.map(item =>
      jsx(ListRow, { item, onSelect: key => $selection.set(key), selected: itemKey(item) === selection, t }, itemKey(item))
    )
  }

  return jsxs('div', {
    style: STYLES.paneRoot,
    children: [bar, jsx('div', { style: STYLES.listScroll, children: body })]
  })
}

// ---------------------------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------------------------

export function DetailHeader({ item, busy, onAccept, onReject, t }) {
  const row = jsxs('header', {
    style: STYLES.header,
    children: [
      jsx('span', { style: STYLES.headerTitle, children: item.subject }),
      jsx(Button, { disabled: busy, onClick: onAccept, size: 'sm', type: 'button', children: t('accept') }),
      jsx(Button, { disabled: busy, onClick: onReject, size: 'sm', type: 'button', variant: 'outline', children: t('reject') }),
      jsxs('div', {
        style: { ...STYLES.listMeta, flexBasis: '100%' },
        children: [
          jsx(Badge, { variant: item.subsystem === 'memory' ? 'default' : 'muted', children: t(`kind_${item.subsystem}`) }),
          jsx(Badge, { variant: 'muted', children: t(`action_${item.action}`) }),
          jsx(Badge, { variant: 'outline', children: item.profile }),
          item.origin === 'background_review'
            ? jsx(Tip, { label: t('autoTip'), children: jsx(Badge, { variant: 'muted', children: t('auto') }) })
            : null,
          jsx('span', { style: STYLES.muted, children: relativeTime(item.created_at * 1000) })
        ]
      })
    ]
  })

  return jsxs('div', {
    style: STYLES.headerWrap,
    children: [row, item.summary ? jsx('div', { style: STYLES.summary, children: item.summary }) : null]
  })
}

function Detail({ item, shown }) {
  const t = usePluginI18n(ID)
  const queryClient = useQueryClient()
  const confirming = useValue($confirming)

  const diff = useQuery({
    queryFn: () => CTX.rest(pendingPath(item, 'diff')),
    queryKey: [ID, 'diff', item.subsystem, item.profile, item.id],
    refetchOnWindowFocus: false,
    staleTime: Infinity
  })

  const resolve = useMutation({
    mutationFn: verb => CTX.rest(pendingPath(item, verb), { method: 'POST' }).then(result => ({ result, verb })),
    onError: (error, verb) => host.notifyError(error, t(verb === 'accept' ? 'acceptError' : 'rejectError')),
    onSuccess: ({ result, verb }) => {
      host.notify(resultToast(verb, result, t))

      if (result?.status !== 'failed') {
        $selection.set(nextKeyAfter(shown, itemKey(item)))
      }

      queryClient.invalidateQueries({ queryKey: [ID, 'pending'] })
    }
  })

  const gone = diff.data?.status === 'already_handled'

  useEffect(() => {
    if (gone) {
      queryClient.invalidateQueries({ queryKey: [ID, 'pending'] })
    }
  }, [gone, queryClient])

  const body = diff.isError
    ? jsx(ErrorState, { description: String(diff.error?.message || ''), title: t('diffError') })
    : diff.isLoading
      ? jsx('div', { style: STYLES.muted, children: t('loading') })
      : gone
        ? jsx('div', { style: STYLES.muted, children: t('alreadyHandled') })
        : jsx(DiffView, { newFileLabel: t(item.subsystem === 'memory' ? 'newEntry' : 'newFile'), sections: diff.data?.sections ?? [], t })

  return jsxs('div', {
    style: STYLES.paneRoot,
    children: [
      jsx(DetailHeader, {
        busy: resolve.isPending,
        item,
        onAccept: () => {
          haptic('tap')
          resolve.mutate('accept')
        },
        onReject: () => $confirming.set(itemKey(item)),
        t
      }),
      jsx('div', { style: STYLES.detailScroll, children: body }),
      jsx(ConfirmDialog, {
        confirmLabel: t('reject'),
        description: t('rejectBody', item.subject),
        destructive: true,
        dismissOnConfirm: true,
        onClose: () => $confirming.set(null),
        onConfirm: () => resolve.mutateAsync('reject'),
        open: confirming === itemKey(item),
        title: t('rejectTitle')
      })
    ]
  })
}


function DetailPane() {
  const t = usePluginI18n(ID)
  const v = useVisible()
  const selection = useValue($selection)
  const item = v.items.find(i => itemKey(i) === selection)

  if (!item) {
    return jsx('div', {
      style: STYLES.paneRoot,
      children: jsx(EmptyState, { description: v.items.length ? t('selectBody') : t('emptyBody'), title: t('selectTitle') })
    })
  }

  // Keyed by item, so the diff query, mutation and dialog state belong to exactly one pending write.
  return jsx(Detail, { item, shown: v.shown }, itemKey(item))
}

/** Route page for desktops without the pane APIs: the same list and diff as the pane. */
/** Desktops without the pane APIs: one route page with the settings above the review. */
function FallbackPage() {
  return jsxs('div', { style: STYLES.paneRoot, children: [jsx(SettingsPane, {}), jsx(ReviewPane, {})] })
}

// ---------------------------------------------------------------------------------------------
// File view: the list shows each (profile, file) once; the detail shows one composite diff of that
// file, its current text as grey context with every pending change drawn where it applies, and an
// Accept and Reject per change. Backend contract v1:
//   GET  /files?kind=all                                         list of files; each has a `version`
//                                                                that changes whenever its diff can
//   GET  /files/{profile}/{subsystem}/{key}/diff                 segments, or { status: 'gone' }
//   POST /files/{profile}/{subsystem}/{key}/blocks/{id}/{accept|reject}
//   POST /files/{profile}/{subsystem}/{key}/{accept-all|reject-all}
// New versus Older is decided here, from a per-file last-opened mark in ctx.storage.
// ---------------------------------------------------------------------------------------------

export const fileKey = file => `${file.subsystem}/${file.profile}/${file.key}`
export const filesPath = () => '/files?kind=all'
export const filesKey = profile => [ID, 'files', profile]
export const diffKey = file => [ID, 'file', file.profile, file.subsystem, file.key]

const fileBase = file =>
  `/files/${encodeURIComponent(file.profile)}/${encodeURIComponent(file.subsystem)}/${encodeURIComponent(file.key)}`

export const fileDiffPath = file => `${fileBase(file)}/diff`

/** action: { verb: 'accept' | 'reject', blockId } or { verb: 'accept-all' | 'reject-all' }. */
export function actionPath(file, action) {
  if (action.verb === 'accept' || action.verb === 'reject') {
    return `${fileBase(file)}/blocks/${encodeURIComponent(action.blockId)}/${action.verb}`
  }

  if (action.verb === 'accept-all' || action.verb === 'reject-all') {
    return `${fileBase(file)}/${action.verb}`
  }

  throw new Error(`unknown action ${action.verb}`)
}

const LAST_OPENED = 'lastOpened'

function readOpened(storage) {
  try {
    const value = storage.get(LAST_OPENED, {})

    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export const lastOpenedAt = (storage, key) => {
  const value = readOpened(storage)[key]

  return typeof value === 'number' ? value : null
}

// The file currently open and the mark it had before this visit. A re-render or pane remount
// during the visit keeps comparing with that earlier mark, so blocks do not flip to Older while
// the user reads them. Selecting another file (or none) ends the visit.
let visit = null

$selection.listen(next => {
  if (visit && visit.key !== next) {
    visit = null
  }
})

/** Bumped after a file is opened, so the list re-reads the marks and drops its New badge. */
const $opened = atom(0)

/**
 * Record that the user opened `key` and return the mark from before this visit (null if never).
 * `mark` is the file's latest staged_at, which is on the backend's clock like every block's
 * staged_at, so a desktop whose clock differs from the gateway's still labels blocks right.
 */
export function openVisit(storage, key, mark) {
  if (visit?.key === key) {
    return visit.prior
  }

  const prior = lastOpenedAt(storage, key)
  visit = { key, prior }

  try {
    storage.set(LAST_OPENED, { ...readOpened(storage), [key]: mark })
  } catch {
    // storage unavailable: every block keeps showing as New, nothing breaks
  }

  return prior
}

/** A block is New if the file was never opened, or it was staged after the last open. */
export const isNewBlock = (block, prior) => prior == null || block.staged_at > prior

const canAcceptBlock = block => block.can_accept === true && block.state !== 'stale'

/** Rows for DiffRow: context and removed lines number in the first gutter, added lines in the second. */
export function segmentRows(segment) {
  if (segment.type === 'context') {
    return (segment.lines ?? []).map(line => ({ kind: 'context', oldNo: line.no, text: line.text }))
  }

  const block = segment.block ?? {}
  const rows = [
    ...(block.removed ?? []).map(line => ({ kind: 'remove', oldNo: line.no, text: line.text })),
    ...(block.added ?? []).map(line => ({ kind: 'add', newNo: line.no, text: line.text }))
  ]

  return markRows(rows, segment.block)
}

const formatStaged = seconds =>
  new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const originLabel = (origin, t) => (FILE_EN[`origin_${origin}`] ? t(`origin_${origin}`) : String(origin || ''))

/** Toast for a block action or a bulk action. */
export function actionToast(action, result, file, t) {
  if (action.verb === 'accept' || action.verb === 'reject') {
    return resultToast(action.verb, { ...result, item: { subject: file.file } }, t)
  }

  const results = result?.results ?? []

  if (!results.length) {
    return { kind: 'info', message: t('bulkNone') }
  }

  const done = results.filter(r => r.status === (action.verb === 'accept-all' ? 'applied' : 'rejected')).length
  const failed = results.filter(r => r.status === 'failed')
  const message = t(action.verb === 'accept-all' ? 'bulkAccepted' : 'bulkRejected', done, results.length)

  if (failed.length) {
    return { kind: 'error', message, detail: failed.map(r => `${r.block_id}: ${r.error || ''}`).join('\n') }
  }

  return { kind: action.verb === 'accept-all' ? 'success' : 'info', message }
}

/** Back to the list: clear the selection if it still points at this file. */
function leaveFile(file) {
  if (!file || $selection.get() === fileKey(file)) {
    $selection.set(null)
  }
}

/** POST one action, toast the result, refetch the file and the list, leave the file if it is gone. */
export async function performAction({ action, file, queryClient, rest, t }) {
  const result = await rest(actionPath(file, action), { method: 'POST' })

  host.notify(actionToast(action, result, file, t))
  queryClient.invalidateQueries({ queryKey: diffKey(file) })
  queryClient.invalidateQueries({ queryKey: [ID, 'files'] })
  queryClient.invalidateQueries({ queryKey: [ID, 'pending'] })

  if (result?.file_gone) {
    leaveFile(file)
  }

  return result
}

/** A diff that comes back gone (all changes handled, for example from chat) returns to the list. */
export function handleDiffData(data, queryClient, file) {
  if (data?.status !== 'gone') {
    return false
  }

  leaveFile(file)
  queryClient.invalidateQueries({ queryKey: [ID, 'files'] })

  return true
}

// Block edge: accent for New, a plain stroke for Older, dashed and dimmed for stale.
export const FILE_STYLES = {
  block: {
    borderBottom: '1px solid var(--ui-stroke-tertiary)',
    borderLeft: '3px solid var(--ui-stroke-primary)',
    borderTop: '1px solid var(--ui-stroke-tertiary)',
    display: 'flex',
    flexDirection: 'column',
    margin: '0.25rem 0',
    minWidth: 0
  },
  blockNew: { borderLeft: '3px solid var(--ui-accent)' },
  blockOlder: { borderLeft: '3px solid var(--ui-stroke-primary)' },
  blockStale: { borderLeft: '3px dashed var(--ui-stroke-secondary)', opacity: 0.55 },
  blockHead: {
    alignItems: 'center',
    background: 'var(--ui-bg-tertiary)',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.3rem 0.4rem',
    minWidth: 0,
    padding: '0.3rem 0.6rem'
  },
  blockSummary: { color: 'var(--ui-text-secondary)', flex: '1 1 8rem', fontSize: '0.75rem', minWidth: 0, overflowWrap: 'anywhere' },
  blockNote: { color: 'var(--ui-text-tertiary)', fontSize: '0.7rem', minWidth: 0, overflowWrap: 'anywhere', padding: '0.2rem 0.6rem' },
  fileTitle: { flex: '1 1 10rem', fontFamily: mono, fontSize: '0.875rem', fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' },
  context: { minWidth: 0 }
}

export function FileListRow({ file, hasNew, selected, onSelect, t }) {
  const c = file.counts ?? {}

  return jsxs('button', {
    'aria-current': selected,
    onClick: () => onSelect(fileKey(file)),
    style: selected ? { ...STYLES.listRow, ...STYLES.listRowSelected } : STYLES.listRow,
    type: 'button',
    children: [
      jsx('span', { style: STYLES.listTitle, children: file.file }),
      jsxs('span', {
        style: STYLES.listMeta,
        children: [
          hasNew ? jsx(Badge, { size: 'xs', variant: 'default', children: t('new') }) : null,
          jsx(Badge, { size: 'xs', variant: file.subsystem === 'memory' ? 'default' : 'muted', children: t(`kind_${file.subsystem}`) }),
          jsx(Badge, { size: 'xs', variant: 'outline', children: file.profile }),
          jsx('span', { style: STYLES.muted, children: t('changes', c.total ?? 0) }),
          c.stale ? jsx('span', { style: STYLES.muted, children: t('staleCount', c.stale) }) : null,
          c.conflict ? jsx('span', { style: STYLES.muted, children: t('conflictCount', c.conflict) }) : null,
          jsx('span', { style: STYLES.muted, children: relativeTime(file.latest_staged_at * 1000) })
        ]
      })
    ]
  })
}

export function FileList({ files, lastOpened, selection, onSelect, t }) {
  return jsx('div', {
    style: { minWidth: 0 },
    children: files.map(file => {
      const key = fileKey(file)
      const mark = lastOpened[key]

      return jsx(FileListRow, { file, hasNew: typeof mark !== 'number' || file.latest_staged_at > mark, onSelect, selected: key === selection, t }, key)
    })
  })
}

export function BlockView({ block, isNew, busy, onAccept, onReject, removal, t, edit = null }) {
  const stale = block.state === 'stale'
  const editing = Boolean(edit?.session)
  const tone = stale && !editing ? FILE_STYLES.blockStale : isNew ? FILE_STYLES.blockNew : FILE_STYLES.blockOlder

  const head = jsxs('div', {
    style: FILE_STYLES.blockHead,
    children: [
      jsx(Badge, { size: 'xs', variant: isNew ? 'default' : 'muted', children: t(isNew ? 'new' : 'older') }),
      jsx('span', { style: STYLES.muted, children: isNew ? relativeTime(block.staged_at * 1000) : t('staged', formatStaged(block.staged_at)) }),
      jsx(Badge, { size: 'xs', variant: 'outline', children: originLabel(block.origin, t) }),
      stale ? jsx(Badge, { size: 'xs', variant: 'muted', children: t('stale') }) : null,
      block.state === 'conflict' ? jsx(Badge, { size: 'xs', variant: 'warn', children: t('conflict') }) : null,
      jsx('span', { style: FILE_STYLES.blockSummary, children: block.summary || '' }),
      jsxs('span', {
        style: STYLES.actions,
        children: [
          edit && !editing && !removalFor(removal?.current, removal?.file, block.id) ? jsx(EditButton, { busy, edit, t }) : null,
          canAcceptBlock(block) && !editing
            ? jsx(Button, { disabled: busy, onClick: onAccept, size: 'xs', style: STYLES.button, type: 'button', children: t('accept') })
            : null,
          jsx(Button, { disabled: busy, onClick: onReject, size: 'xs', style: STYLES.button, type: 'button', variant: 'outline', children: t('reject') }),
          removal && !editing ? jsx(RemoveEntryButton, { block, busy, removal, t }) : null
        ]
      })
    ]
  })

  return jsxs('div', {
    'aria-label': t('blockLabel', block.summary || block.id),
    'data-block': block.id,
    'data-new': isNew,
    role: 'group',
    style: { ...FILE_STYLES.block, ...tone },
    children: [
      head,
      removal && !editing ? jsx(RemoveEntryRow, { block, removal, t }) : null,
      block.state === 'conflict' ? jsx('div', { style: FILE_STYLES.blockNote, children: t('conflictAbove') }) : null,
      stale && block.reason ? jsx('div', { style: FILE_STYLES.blockNote, children: t('staleReason', block.reason) }) : null,
      ...segmentRows({ type: 'block', block: editing ? { ...block, added: [] } : block }).map((row, i) => jsx(DiffRow, { dim: stale && !editing, row, t }, i)),
      editing ? jsx(BlockEditor, { info: edit.info, onCancel: edit.onCancel, onChange: edit.onChange, onSave: edit.onSave, session: edit.session, t }) : null
    ]
  })
}

export function FileDiffView({ segments, prior, busy, onBlock, gaps, onExpand, removal, t, edit = null }) {
  return jsx('div', {
    style: STYLES.diffBox,
    children: contextPlan(segments, gaps).map(segment => {
      if (segment.type === 'gap') {
        return jsx(ExpandRow, { gap: segment, onExpand: onExpand ?? (() => {}), t }, `g${segment.id}`)
      }

      if (segment.type === 'block') {
        const block = segment.block

        return jsx(
          BlockView,
          {
            block,
            busy,
            edit: blockEdit(edit, block),
            isNew: isNewBlock(block, prior),
            onAccept: () => onBlock({ blockId: block.id, verb: 'accept' }),
            onReject: () => onBlock({ blockId: block.id, verb: 'reject' }),
            removal,
            t
          },
          block.id
        )
      }

      return jsx('div', { 'data-context': segment.key, style: FILE_STYLES.context, children: segmentRows(segment).map((row, i) => jsx(DiffRow, { row, t }, i)) }, `c${segment.key}`)
    })
  })
}

export function FileHeader({ file, acceptable, busy, onAcceptAll, onRejectAll, t, extra = null }) {
  const c = file.counts ?? {}

  const row = jsxs('header', {
    style: STYLES.header,
    children: [
      jsx('span', { style: FILE_STYLES.fileTitle, children: file.file }),
      jsxs('div', {
        style: STYLES.actions,
        children: [
          extra,
          jsx(Button, { disabled: busy || !acceptable, onClick: onAcceptAll, size: 'sm', style: STYLES.button, type: 'button', children: t('acceptAll') }),
          jsx(Button, { disabled: busy, onClick: onRejectAll, size: 'sm', style: STYLES.button, type: 'button', variant: 'outline', children: t('rejectAll') })
        ]
      }),
      jsxs('div', {
        style: { ...STYLES.listMeta, flexBasis: '100%' },
        children: [
          jsx(Badge, { variant: file.subsystem === 'memory' ? 'default' : 'muted', children: t(`kind_${file.subsystem}`) }),
          jsx(Badge, { variant: 'outline', children: file.profile }),
          jsx('span', { style: STYLES.muted, children: t('changes', c.total ?? 0) }),
          c.stale ? jsx('span', { style: STYLES.muted, children: t('staleCount', c.stale) }) : null,
          c.conflict ? jsx('span', { style: STYLES.muted, children: t('conflictCount', c.conflict) }) : null
        ]
      })
    ]
  })

  return jsx('div', { style: STYLES.headerWrap, children: row })
}

/** The whole detail pane for one file, as a pure view: data and callbacks in, tree out. */
export function FileDetailView({ file, data, loading, error, prior, busy, confirmOpen, onAction, onAskRejectAll, onCloseConfirm, expansion, onExpand, removal, t, edit = null, openButton = null }) {
  // A response for another file (a late answer after the user moved on) counts as not loaded yet.
  const own = data && diffMatches(data, file) ? data : undefined
  const shownFile = own?.status === 'ok' ? own.file : file
  const segments = own?.status === 'ok' ? own.segments ?? [] : []
  const blockList = segments.filter(s => s.type === 'block').map(s => s.block)

  const body = error
    ? jsx(ErrorState, { description: String(error?.message || ''), title: t('diffError') })
    : loading || !own
      ? jsx(DiffSkeleton, { t })
      : own.status === 'gone'
        ? jsx('div', { style: STYLES.muted, children: t('fileGone') })
        : jsx(FileDiffView, {
            busy,
            edit,
            gaps: expansionFor(expansion, shownFile).gaps,
            onBlock: onAction,
            onExpand: (gapId, dir) => onExpand?.(shownFile, gapId, dir),
            prior,
            removal,
            segments,
            t
          })

  return jsxs('div', {
    style: STYLES.paneRoot,
    children: [
      jsx(FileHeader, {
        acceptable: blockList.filter(canAcceptBlock).length,
        busy,
        extra: openButton,
        file: shownFile,
        onAcceptAll: () => onAction({ verb: 'accept-all' }),
        onRejectAll: onAskRejectAll,
        t
      }),
      jsx('div', { style: STYLES.detailScroll, children: body }),
      jsx(ConfirmDialog, {
        confirmLabel: t('rejectAll'),
        description: t('rejectAllBody', blockList.length, shownFile.file),
        destructive: true,
        dismissOnConfirm: true,
        onClose: onCloseConfirm,
        onConfirm: () => onAction({ verb: 'reject-all' }),
        open: confirmOpen,
        title: t('rejectAllTitle')
      })
    ]
  })
}

// ---------------------------------------------------------------------------------------------
// Remove entirely: on a memory block that replaces or patches one existing entry, a third action
// deletes that entry and drops the proposal, so neither the red line nor the green one stays.
//   POST /files/{profile}/{subsystem}/{key}/blocks/{id}/remove-entry
//        -> { status: 'removed' | 'already_handled' | 'failed', error, file_gone }
// It asks first, in a row under the block head. Skill blocks never offer it.
// ---------------------------------------------------------------------------------------------

/** null, or { key: fileKey, blockId, phase: 'confirm' | 'busy' | 'error', error }. One block at a time. */
export const $removal = atom(null)

$selection.listen(next => {
  if ($removal.get() && $removal.get().key !== next) {
    $removal.set(null)
  }
})

export const removeEntryPath = (file, blockId) => `${fileBase(file)}/blocks/${encodeURIComponent(blockId)}/remove-entry`

/** A pending or conflicting memory block that swaps one existing line for new text. An add has no
 *  removed line, a plain remove no added one; a multi-line entry has several removed lines. */
export function canRemoveEntry(block, subsystem) {
  return (
    subsystem === 'memory' &&
    (block?.state === 'pending' || block?.state === 'conflict') &&
    (block.removed?.length ?? 0) === 1 &&
    (block.added?.length ?? 0) > 0
  )
}

/** The removal state of this one block, or null. */
export const removalFor = (current, file, blockId) =>
  current && current.key === fileKey(file) && current.blockId === blockId ? current : null

/**
 * POST the removal. Success toasts, refetches and returns to the list when the file is gone. A
 * failure leaves the file open and puts the error in the block's own row, where the user is.
 */
export async function performRemove({ file, blockId, queryClient, rest, t }) {
  const base = { blockId, key: fileKey(file) }
  let result = null

  $removal.set({ ...base, phase: 'busy', error: null })

  try {
    result = await rest(removeEntryPath(file, blockId), { method: 'POST' })
  } catch (error) {
    $removal.set({ ...base, phase: 'error', error: String(error?.message || '') || t('removeError') })

    return null
  }

  const done = result?.status === 'removed' || result?.status === 'already_handled'

  if (done) {
    $removal.set(null)
    host.notify(result.status === 'removed' ? { kind: 'success', message: t('entryRemoved') } : { kind: 'info', message: t('alreadyHandled') })
  } else {
    $removal.set({ ...base, phase: 'error', error: String(result?.error || '') || t('removeError') })
  }

  queryClient.invalidateQueries({ queryKey: diffKey(file) })

  if (done) {
    queryClient.invalidateQueries({ queryKey: [ID, 'files'] })
    queryClient.invalidateQueries({ queryKey: [ID, 'pending'] })

    if (result.file_gone) {
      leaveFile(file)
    }
  }

  return result
}

export const REMOVE_STYLES = {
  // Quiet like Reject; the label carries the theme's removed-line red.
  button: { ...STYLES.button, color: 'var(--ui-diff-remove-foreground)' },
  // Continues the block head, so the question sits directly above the lines it deletes.
  row: {
    alignItems: 'center',
    background: 'var(--ui-bg-tertiary)',
    borderTop: '1px solid var(--ui-stroke-tertiary)',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.3rem 0.5rem',
    minWidth: 0,
    padding: '0.3rem 0.6rem'
  },
  question: { color: 'var(--ui-text-primary)', flex: '1 1 12rem', fontSize: '0.75rem', fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' },
  error: {
    color: 'var(--ui-diff-remove-foreground)',
    flex: '1 1 12rem',
    fontSize: '0.75rem',
    minWidth: 0,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap'
  }
}

/** removal: { file, current ($removal value), onAsk(blockId), onConfirm(blockId), onCancel() }. */
export function RemoveEntryButton({ block, busy, removal, t }) {
  if (!canRemoveEntry(block, removal.file?.subsystem)) {
    return null
  }

  const mine = removalFor(removal.current, removal.file, block.id)
  const open = mine?.phase === 'confirm' || mine?.phase === 'busy'

  return jsx(Tip, {
    label: t('removeEntryTip'),
    children: jsx(Button, {
      'aria-expanded': open,
      disabled: busy || open,
      onClick: () => removal.onAsk(block.id),
      size: 'xs',
      style: REMOVE_STYLES.button,
      type: 'button',
      variant: 'outline',
      children: t('removeEntry')
    })
  })
}

/** The confirm question with Delete and Cancel, or the error of a removal that failed. */
export function RemoveEntryRow({ block, removal, t }) {
  const mine = removalFor(removal.current, removal.file, block.id)

  if (!mine) {
    return null
  }

  if (mine.phase === 'error') {
    return jsxs('div', {
      role: 'alert',
      style: REMOVE_STYLES.row,
      children: [
        jsx('span', { style: REMOVE_STYLES.error, children: mine.error }),
        jsx('span', {
          style: STYLES.actions,
          children: jsx(Button, { onClick: removal.onCancel, size: 'xs', style: STYLES.button, type: 'button', variant: 'ghost', children: t('removeDismiss') })
        })
      ]
    })
  }

  const working = mine.phase === 'busy'

  return jsxs('div', {
    'aria-label': t('removeConfirm'),
    onKeyDown: event => {
      if (event.key === 'Escape' && !working) {
        removal.onCancel()
      }
    },
    role: 'group',
    style: REMOVE_STYLES.row,
    children: [
      jsx('span', { style: REMOVE_STYLES.question, children: t('removeConfirm') }),
      jsxs('span', {
        style: STYLES.actions,
        children: [
          jsx(Button, {
            disabled: working,
            loading: working,
            onClick: () => removal.onConfirm(block.id),
            size: 'xs',
            style: STYLES.button,
            type: 'button',
            variant: 'destructive',
            children: t('removeDelete')
          }),
          // Focus lands on Cancel, the safe choice, when the question opens.
          jsx(Button, { autoFocus: true, disabled: working, onClick: removal.onCancel, size: 'xs', style: STYLES.button, type: 'button', variant: 'outline', children: t('removeCancel') })
        ]
      })
    ]
  })
}

const REMOVE_EN = {
  entryRemoved: 'Entry removed',
  removeCancel: 'Cancel',
  removeConfirm: 'Delete this entry and drop the proposal?',
  removeDelete: 'Delete',
  removeDismiss: 'Dismiss',
  removeEntry: 'Remove entirely',
  removeEntryTip: 'Deletes the existing entry and drops this proposal. Neither version is kept.',
  removeError: 'Could not remove the entry'
}

// ---------------------------------------------------------------------------------------------
// List controls: which profiles the list shows, and its order. Both persist in ctx.storage.
// Profiles are stored as the HIDDEN set, so a profile that first stages a change later shows up.
// They filter and order the list only; the status-bar chip still counts every profile.
// ---------------------------------------------------------------------------------------------

export const SORTS = ['newest', 'oldest', 'name', 'changes']
export const $sort = atom('newest')
export const $hidden = atom([])

const byName = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })

const SORT_ORDER = {
  newest: (a, b) => (b.latest_staged_at ?? 0) - (a.latest_staged_at ?? 0),
  oldest: (a, b) => (a.latest_staged_at ?? 0) - (b.latest_staged_at ?? 0),
  name: (a, b) => byName(a.file, b.file),
  changes: (a, b) => (b.counts?.total ?? 0) - (a.counts?.total ?? 0)
}

/** A sorted copy. Array.prototype.sort is stable, so files that tie keep the backend's order. */
export function sortFiles(files, sort) {
  return [...files].sort(SORT_ORDER[sort] ?? SORT_ORDER.newest)
}

/** Files outside the hidden profiles, then of the chosen kind ('all' | 'skills' | 'memory'). */
export function filterFiles(files, hidden, kind = 'all') {
  const off = new Set(hidden)

  return files.filter(file => !off.has(file.profile) && (kind === 'all' || file.subsystem === kind))
}

/** What the list shows, in order: profile selection, then kind, then the sort. */
export const shownFiles = (files, hidden, kind, sort) => sortFiles(filterFiles(files, hidden, kind), sort)

/** One row per profile that has pending files: { profile, count } with 'default' first. */
export function profileSummary(files) {
  const counts = new Map()

  for (const file of files) {
    counts.set(file.profile, (counts.get(file.profile) ?? 0) + 1)
  }

  return [...counts]
    .map(([profile, count]) => ({ count, profile }))
    .sort((a, b) => (a.profile === 'default' ? -1 : b.profile === 'default' ? 1 : byName(a.profile, b.profile)))
}

/** The hidden list after checking (shown = true) or unchecking one profile. */
export function toggleHidden(hidden, profile, shown) {
  const rest = hidden.filter(p => p !== profile)

  return shown ? rest : [...rest, profile]
}

/** Hide every listed profile except the focused chat's. */
export const onlyProfile = (profiles, focused) => profiles.map(p => p.profile).filter(p => p !== focused)

function writeStored(key, value) {
  try {
    CTX?.storage.set(key, value)
  } catch {
    // storage full or unavailable: the choice holds for this session
  }
}

export function setSort(sort) {
  if (SORTS.includes(sort)) {
    $sort.set(sort)
    writeStored('sortOrder', sort)
  }
}

export function setHiddenProfiles(hidden) {
  const clean = [...new Set((Array.isArray(hidden) ? hidden : []).filter(p => typeof p === 'string'))]

  $hidden.set(clean)
  writeStored('hiddenProfiles', clean)
}

export function loadListSettings(ctx) {
  const sort = readStored(ctx, 'sortOrder', 'newest')
  const hidden = readStored(ctx, 'hiddenProfiles', [])

  $sort.set(SORTS.includes(sort) ? sort : 'newest')
  $hidden.set(Array.isArray(hidden) ? hidden.filter(p => typeof p === 'string') : [])
}

export const LIST_STYLES = {
  controls: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.35rem', minWidth: 0 },
  trigger: { flexShrink: 0, maxWidth: '100%', minWidth: 0, width: 'auto' },
  popover: { display: 'flex', flexDirection: 'column', gap: '0.35rem', maxWidth: 'calc(100vw - 2rem)', minWidth: 0, width: '16rem' },
  shortcuts: { display: 'flex', flexWrap: 'wrap', gap: '0.25rem', minWidth: 0 },
  checklist: { display: 'flex', flexDirection: 'column', maxHeight: 'min(20rem, 60vh)', minWidth: 0, overflowY: 'auto' },
  check: { alignItems: 'center', borderRadius: '4px', cursor: 'pointer', display: 'flex', fontSize: '0.75rem', gap: '0.5rem', minWidth: 0, padding: '0.3rem 0.35rem' },
  checkName: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  checkCount: { color: 'var(--ui-text-tertiary)', flex: 'none', fontVariantNumeric: 'tabular-nums' }
}

/** The sort menu as a pure view. The trigger shows the active choice. */
export function SortMenu({ value, onChange, t }) {
  const active = SORTS.includes(value) ? value : 'newest'

  return jsxs(Select, {
    onValueChange: onChange,
    value: active,
    children: [
      jsx(SelectTrigger, {
        'aria-label': t('sortLabel'),
        size: 'xs',
        style: LIST_STYLES.trigger,
        title: t('sortLabel'),
        children: jsx(SelectValue, { children: jsx('span', { style: STYLES.ellipsis, children: t(`sort_${active}`) }) })
      }),
      jsx(SelectContent, { children: SORTS.map(id => jsx(SelectItem, { value: id, children: t(`sort_${id}`) }, id)) })
    ]
  })
}

/** Sort control for the settings pane. Its own component, so a sort change re-renders only it. */
export function SortControl() {
  const t = usePluginI18n(ID)
  const sort = useValue($sort)

  return jsx(SortMenu, { onChange: setSort, t, value: sort })
}

/** The profile picker as a pure view: a trigger that says how many profiles show, and a popover
 *  with All, Only the focused chat's profile, and one checkbox per profile with its file count. */
export function profileLabel(profiles, hidden, t) {
  const off = new Set(hidden)
  const shown = profiles.filter(p => !off.has(p.profile)).length

  return shown === profiles.length ? t('profilesAll', profiles.length) : t('profilesShown', shown, profiles.length)
}

export function ProfilePicker({ profiles, hidden, focused, onChange, t }) {
  const off = new Set(hidden)
  const shown = profiles.filter(p => !off.has(p.profile)).length
  const label = profileLabel(profiles, hidden, t)
  const hasFocused = profiles.some(p => p.profile === focused)

  return jsxs(Popover, {
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsxs(Button, {
          'aria-label': `${t('scopeGroup')}: ${label}`,
          size: 'xs',
          style: STYLES.button,
          title: label,
          type: 'button',
          variant: shown < profiles.length ? 'chip' : 'ghost',
          children: [jsx('span', { style: STYLES.ellipsis, children: label }), jsx(Codicon, { name: 'chevron-down' })]
        })
      }),
      jsxs(PopoverContent, {
        align: 'start',
        style: LIST_STYLES.popover,
        children: [
          jsxs('div', {
            style: LIST_STYLES.shortcuts,
            children: [
              jsx(FilterButton, { active: hidden.length === 0, label: t('showAll'), onClick: () => onChange([]) }),
              jsx(Button, {
                disabled: !hasFocused,
                onClick: () => onChange(onlyProfile(profiles, focused)),
                size: 'xs',
                style: STYLES.button,
                title: hasFocused ? t('onlyFocused', focused) : t('onlyFocusedNone', focused),
                type: 'button',
                variant: 'ghost',
                children: jsx('span', { style: STYLES.ellipsis, children: t('onlyFocused', focused) })
              })
            ]
          }),
          jsx('div', {
            'aria-label': t('scopeGroup'),
            role: 'group',
            style: LIST_STYLES.checklist,
            children: profiles.map(({ profile, count }) =>
              jsxs(
                'label',
                {
                  style: LIST_STYLES.check,
                  title: t('profileRow', profile, count),
                  children: [
                    jsx(Checkbox, { checked: !off.has(profile), onCheckedChange: on => onChange(toggleHidden(hidden, profile, on === true)) }),
                    jsx('span', { style: LIST_STYLES.checkName, children: profile }),
                    profile === focused ? jsx('span', { style: STYLES.muted, children: t('focusedMark') }) : null,
                    jsx('span', { style: LIST_STYLES.checkCount, children: count })
                  ]
                },
                profile
              )
            )
          })
        ]
      })
    ]
  })
}

export function ProfileControl({ profiles, focused }) {
  const t = usePluginI18n(ID)
  const hidden = useValue($hidden)

  return jsx(ProfilePicker, { focused, hidden, onChange: setHiddenProfiles, profiles, t })
}

/** Placeholder lines in the diff box's shape while a file's diff loads. */
const SKELETON_WIDTHS = ['62%', '88%', '74%', '40%', '81%', '93%', '55%', '70%']

export function DiffSkeleton({ t }) {
  return jsx('div', {
    'aria-busy': true,
    'aria-label': t('loadingDiff'),
    role: 'status',
    style: { ...STYLES.diffBox, display: 'flex', flexDirection: 'column', gap: '0.45rem', padding: '0.6rem 0.75rem' },
    children: SKELETON_WIDTHS.map((width, i) => jsx(Skeleton, { style: { height: '0.7rem', maxWidth: '100%', width } }, i))
  })
}

/** A token that changes whenever the file's diff can have changed: the backend's version, or (from
 *  a backend without it) the counts and the latest staged time. */
export function diffVersion(file) {
  if (file.version) {
    return String(file.version)
  }

  const c = file.counts ?? {}

  return `${file.latest_staged_at ?? 0}:${c.total ?? 0}:${c.pending ?? 0}:${c.stale ?? 0}:${c.conflict ?? 0}`
}

export const diffQueryKey = file => [...diffKey(file), diffVersion(file)]

/** True when a diff response belongs to `file`; a late answer for another file is never shown. */
export function diffMatches(data, file) {
  if (data?.status === 'gone') {
    return true
  }

  const got = data?.file

  return data?.status === 'ok' && !!got && got.key === file.key && got.profile === file.profile && got.subsystem === file.subsystem
}

const LIST_EN = {
  emptyHidden: n => `${n} file${n === 1 ? '' : 's'} waiting in hidden profiles.`,
  emptyKind: kind => `Nothing under ${kind} in the shown profiles.`,
  focusedMark: 'this chat',
  loadingDiff: 'Loading the changes in this file',
  onlyFocused: profile => `Only ${profile}`,
  onlyFocusedNone: profile => `${profile} has no pending files`,
  profileRow: (profile, n) => `${profile}: ${n} file${n === 1 ? '' : 's'} with changes`,
  profilesAll: n => `All ${n} profile${n === 1 ? '' : 's'}`,
  profilesShown: (n, total) => `${n} of ${total} profile${total === 1 ? '' : 's'}`,
  sortLabel: 'Sort files',
  sort_changes: 'Most changes',
  sort_name: 'File name A to Z',
  sort_newest: 'Newest first',
  sort_oldest: 'Oldest first'
}

function useFiles() {
  const profile = useValue(host.state.profile)

  return useQuery({
    queryFn: () => CTX.rest(filesPath()),
    queryKey: filesKey(profile),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true
  })
}

/** Files the list shows: the profile selection, then the kind filter, then the sort order. Both
 *  panes use it (the detail needs the shown order to pick the next file). */
function useVisibleFiles() {
  const query = useFiles()
  const focused = useValue(host.state.focusedSessionProfile) || 'default'
  const hidden = useValue($hidden)
  const kind = useValue($kind)
  const sort = useValue($sort)
  const files = query.data?.files ?? []
  const inScope = filterFiles(files, hidden)

  return {
    ...query,
    files,
    focused,
    hidden,
    inScope,
    kind,
    kindCounts: countBySubsystem(inScope),
    profileErrors: query.data?.profile_errors ?? [],
    profiles: profileSummary(files),
    shown: shownFiles(files, hidden, kind, sort),
    sort
  }
}

function FilesListPane() {
  const t = usePluginI18n(ID)
  const v = useVisibleFiles()
  const selection = useValue($selection)
  useValue($opened)
  // Gates are not part of /files; /pending (the status chip's query) still reports them.
  const gateOn = (usePending().data?.profiles ?? []).some(p => Object.values(p.gates ?? {}).some(Boolean))
  const missing = v.isError && /404/.test(String(v.error?.message || ''))
  const total = v.files.reduce((sum, f) => sum + (f.counts?.total ?? 0), 0)

  // Desktops without paneVisibility: the list mounting is the best sign the user opened it.
  useEffect(() => {
    if (typeof host.paneVisibility !== 'function') {
      markSeen()
    }
  }, [])

  const bar = jsxs('div', {
    style: STYLES.bar,
    children: [
      jsxs('div', {
        style: STYLES.barRow,
        children: [
          jsx('span', { style: { fontSize: '0.875rem', fontWeight: 600, minWidth: 0 }, children: t('paneTitle') }),
          total ? jsx(Badge, { variant: 'warn', children: total }) : null
        ]
      }),
      // The settings live in their own pane; the header says what they are set to.
      jsxs('div', {
        style: LIST_STYLES.controls,
        children: [
          jsx(SettingsSummary, { hidden: v.hidden, profiles: v.profiles, sort: v.sort, t }),
          useRouteFallback ? null : jsx(SettingsGearButton, { onOpen: openSettings, t })
        ]
      }),
      jsx('div', {
        'aria-label': t('kindGroup'),
        role: 'group',
        style: STYLES.barRow,
        children: KINDS.map(k =>
          jsx(FilterButton, { active: v.kind === k, label: t('kindFilter', t(`kind_${k}`), v.kindCounts[k]), onClick: () => $kind.set(k) }, k)
        )
      }),
      v.profileErrors.length
        ? jsx('div', { style: { ...STYLES.muted, overflowWrap: 'anywhere' }, children: t('profileErrors', v.profileErrors.map(e => e.profile).join(', ')) })
        : null
    ]
  })

  let body

  if (missing) {
    body = jsx(ErrorState, { description: t('backendMissing'), title: t('loadError') })
  } else if (v.isError) {
    body = jsx(ErrorState, {
      children: jsx(Button, { onClick: () => v.refetch(), size: 'sm', type: 'button', variant: 'outline', children: t('retry') }),
      description: String(v.error?.message || ''),
      title: t('loadError')
    })
  } else if (v.isLoading) {
    body = jsx('div', { style: { ...STYLES.muted, padding: PAD }, children: t('loading') })
  } else if (!v.shown.length) {
    body = jsx(FilesEmpty, { files: v.files.length, gateOn, inScope: v.inScope.length, kind: v.kind, onShowAll: () => setHiddenProfiles([]), t })
  } else {
    body = jsx(FileList, { files: v.shown, lastOpened: CTX ? readOpened(CTX.storage) : {}, onSelect: key => $selection.set(key), selection, t })
  }

  return jsxs('div', {
    style: STYLES.paneRoot,
    children: [bar, jsx('div', { style: STYLES.listScroll, children: body })]
  })
}

/** Empty list: why, and when hidden profiles hold files, a way to show them. */
export function FilesEmpty({ files, gateOn, inScope, kind, onShowAll, t }) {
  if (inScope) {
    return jsx(EmptyState, { description: t('emptyKind', t(`kind_${kind}`)), title: t('emptyTitle') })
  }

  if (files) {
    return jsxs('div', {
      style: { alignItems: 'center', display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0, paddingBottom: PAD },
      children: [
        jsx(EmptyState, { description: t('emptyHidden', files), title: t('emptyTitle') }),
        jsx(Button, { onClick: onShowAll, size: 'sm', style: STYLES.button, type: 'button', variant: 'outline', children: t('showAll') })
      ]
    })
  }

  return jsx(EmptyState, { description: gateOn ? t('emptyBody') : t('gateOff'), title: t('emptyTitle') })
}

function FileDetail({ file }) {
  const t = usePluginI18n(ID)
  const queryClient = useQueryClient()
  const confirming = useValue($confirming)
  const key = fileKey(file)
  const prior = openVisit(CTX.storage, key, file.latest_staged_at)

  useEffect(() => {
    $opened.set($opened.get() + 1)
  }, [key])

  // No polling of its own: the 3-second list poll carries each file's version, and the key holds
  // it, so the diff is fetched again only when it can have changed. Until that answer arrives the
  // previous diff of this same file stays up (the component is keyed by file).
  const diff = useQuery({
    placeholderData: previous => previous,
    queryFn: () => CTX.rest(fileDiffPath(file)),
    queryKey: diffQueryKey(file),
    refetchOnWindowFocus: false,
    staleTime: Infinity
  })

  useEffect(() => {
    handleDiffData(diff.data, queryClient, file)
  }, [diff.data, queryClient])

  const act = useMutation({
    mutationFn: action => performAction({ action, file, queryClient, rest: (path, opts) => CTX.rest(path, opts), t }),
    onError: (error, action) => host.notifyError(error, t(action.verb.startsWith('accept') ? 'acceptError' : 'rejectError'))
  })

  const confirmId = `reject-all:${key}`
  const removing = useValue($removal)

  const removal = {
    current: removing,
    file,
    onAsk: blockId => $removal.set({ blockId, error: null, key, phase: 'confirm' }),
    onCancel: () => $removal.set(null),
    onConfirm: blockId => performRemove({ blockId, file, queryClient, rest: (path, opts) => CTX.rest(path, opts), t })
  }

  // Which context gaps are open; reset when the shown diff's version changes (expansionFor).
  const [expansion, setExpansion] = useState(null)
  const edit = useBlockEdit(file, queryClient, t)

  return jsx(FileDetailView, {
    busy: act.isPending || removing?.phase === 'busy' || Boolean(edit.session?.saving),
    confirmOpen: confirming === confirmId,
    data: diff.data,
    error: diff.isError ? diff.error : null,
    file,
    loading: diff.isLoading,
    onAction: action => {
      if (action.verb.startsWith('accept')) {
        haptic('tap')
      }

      return act.mutateAsync(action).catch(() => null) // onError already toasted
    },
    edit,
    onAskRejectAll: () => $confirming.set(confirmId),
    onCloseConfirm: () => $confirming.set(null),
    expansion,
    onExpand: (shown, gapId, dir) => setExpansion(prev => expandGap(prev, shown, gapId, dir)),
    openButton: jsx(OpenInEditorControl, { file }),
    prior,
    removal,
    t
  })
}

function FileDetailPane() {
  const t = usePluginI18n(ID)
  const v = useVisibleFiles()
  const selection = useValue($selection)
  const file = v.files.find(f => fileKey(f) === selection)
  const dangling = Boolean(selection) && !file && v.isSuccess

  // A selected file that left the list (handled elsewhere, or a key from the old per-item view)
  // is dropped, so it never reopens, and stamps its open time, without a click.
  useEffect(() => {
    if (dangling) {
      $selection.set(null)
    }
  }, [dangling])

  if (!file) {
    return jsx('div', {
      style: STYLES.paneRoot,
      children: jsx(EmptyState, { description: v.files.length ? t('selectFileBody') : t('emptyBody'), title: t('selectFileTitle') })
    })
  }

  // Keyed by file, so the diff query, mutation and dialog state belong to exactly one file.
  return jsx(FileDetail, { file }, fileKey(file))
}

// ---------------------------------------------------------------------------------------------
// The review tab: list and diff side by side in one pane, stacked when the pane is narrow
// ---------------------------------------------------------------------------------------------

/** Pane width (px) below which the list and the diff take turns in one column. */
export const REVIEW_NARROW_PX = 560

/** A 0 width means the pane is hidden or not laid out yet; keep the wide layout then. */
export const isNarrowWidth = width => typeof width === 'number' && width > 0 && width < REVIEW_NARROW_PX

/** Report the node's content width on every resize. Returns the cleanup, or undefined when there
 *  is no node or no ResizeObserver (the pane then stays side by side). */
export function observeWidth(node, onWidth, RO = globalThis.ResizeObserver) {
  if (!node || typeof RO !== 'function') {
    return undefined
  }

  const observer = new RO(entries => {
    const width = entries[entries.length - 1]?.contentRect?.width

    if (typeof width === 'number') {
      onWidth(width)
    }
  })

  observer.observe(node)

  return () => observer.disconnect()
}

const COLUMN = { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }

export const REVIEW_STYLES = {
  root: { display: 'flex', flexDirection: 'row', height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden', position: 'relative' },
  list: { ...COLUMN, borderRight: '1px solid var(--ui-stroke-secondary)', flex: '0 0 300px' },
  detail: { ...COLUMN, flex: '1 1 0' },
  // Narrow: the one visible column fills the pane.
  alone: { borderRight: 0, flex: '1 1 0' },
  // Narrow with a file open: the list stays mounted, out of sight, so its scroll position survives.
  parked: { inset: 0, pointerEvents: 'none', position: 'absolute', visibility: 'hidden' },
  back: { ...STYLES.bar, alignItems: 'flex-start', flex: 'none', padding: `0.35rem ${PAD}` },
  body: { ...COLUMN, flex: '1 1 auto' }
}

/** Pure layout, so tests can drive both widths. The selection atom decides what narrow shows. */
export function ReviewLayout({ narrow, selection, onBack, rootRef, t }) {
  const open = Boolean(selection)

  if (!narrow) {
    return jsxs('div', {
      ref: rootRef,
      style: REVIEW_STYLES.root,
      children: [
        jsx('div', { style: REVIEW_STYLES.list, children: jsx(FilesListPane, {}) }, 'list'),
        jsx('div', { style: REVIEW_STYLES.detail, children: jsx(FileDetailPane, {}) }, 'detail')
      ]
    })
  }

  const list = open
    ? jsx('div', { 'aria-hidden': true, style: { ...REVIEW_STYLES.list, ...REVIEW_STYLES.parked }, children: jsx(FilesListPane, {}) }, 'list')
    : jsx('div', { style: { ...REVIEW_STYLES.list, ...REVIEW_STYLES.alone }, children: jsx(FilesListPane, {}) }, 'list')

  return jsxs('div', {
    ref: rootRef,
    style: REVIEW_STYLES.root,
    children: [
      list,
      open
        ? jsxs('div', {
            style: REVIEW_STYLES.detail,
            children: [
              jsx('div', {
                'data-review-back': true,
                style: REVIEW_STYLES.back,
                children: jsxs(Button, {
                  onClick: onBack,
                  size: 'sm',
                  style: STYLES.button,
                  type: 'button',
                  variant: 'ghost',
                  children: [jsx(Codicon, { name: 'arrow-left' }), t('backToList')]
                })
              }),
              jsx('div', { style: REVIEW_STYLES.body, children: jsx(FileDetailPane, {}) })
            ]
          }, 'detail')
        : null
    ]
  })
}

/** The single review pane: measures its own width and picks side by side or stacked. */
export function ReviewPane() {
  const t = usePluginI18n(ID)
  const selection = useValue($selection)
  const [node, setNode] = useState(null)
  const [narrow, setNarrow] = useState(false)

  useEffect(() => observeWidth(node, width => setNarrow(isNarrowWidth(width))), [node])

  return jsx(ReviewLayout, { narrow, onBack: () => $selection.set(null), rootRef: setNode, selection, t })
}

const FILE_EN = {
  acceptAll: 'Accept all',
  blockLabel: summary => `Change: ${summary}`,
  bulkAccepted: (n, total) => `Accepted ${n} of ${total} change${total === 1 ? '' : 's'}`,
  bulkNone: 'Nothing left to handle in this file.',
  bulkRejected: (n, total) => `Rejected ${n} of ${total} change${total === 1 ? '' : 's'}`,
  changes: n => `${n} change${n === 1 ? '' : 's'}`,
  conflict: 'conflict',
  conflictAbove: 'Conflicts with the block above',
  conflictCount: n => `${n} conflict${n === 1 ? '' : 's'}`,
  fileGone: 'No changes left in this file.',
  new: 'new',
  older: 'older',
  origin_background_review: 'background review',
  profileErrors: names => `Could not read pending changes for: ${names}`,
  rejectAll: 'Reject all',
  rejectAllBody: (n, name) => `All ${n} proposed change${n === 1 ? '' : 's'} to ${name} are discarded. Hermes can propose them again.`,
  rejectAllTitle: 'Reject every change in this file?',
  selectFileBody: 'Pick a file in the list to see its changes.',
  selectFileTitle: 'No file selected',
  staged: date => `staged ${date}`,
  stale: 'stale',
  staleCount: n => `${n} stale`,
  staleReason: reason => `Can no longer apply: ${reason}`
}

// ---------------------------------------------------------------------------------------------
// Edit a proposed change in place, and open the live file in VS Code. Routes beside contract v1:
//   GET  /files/{profile}/{subsystem}/{key}/edits              editable blocks, their text and limit
//   POST /files/{profile}/{subsystem}/{key}/blocks/{id}/edit   { text, apply }
//   GET  /files/{profile}/{subsystem}/{key}/location           { path, exists, host, user }
// The editor replaces a block's added lines; its removed lines stay above it as the reference.
// ---------------------------------------------------------------------------------------------

export const editsPath = file => `${fileBase(file)}/edits`
export const editPath = (file, blockId) => `${fileBase(file)}/blocks/${encodeURIComponent(blockId)}/edit`
export const locationPath = file => `${fileBase(file)}/location`
// Under diffKey, so every refetch of the file after an action also refetches these.
const editsKey = file => [...diffKey(file), 'edits', diffVersion(file)]
const locationKey = file => [...diffKey(file), 'location', diffVersion(file)]

/** The one block being edited: { file, blockId, info, text, error, saving }. Kept outside the pane,
 *  so a refetch or a remount of the detail pane keeps what the user typed. */
export const $editing = atom(null)

export function startEdit(file, blockId, info) {
  $editing.set({ blockId, error: null, file: fileKey(file), info, saving: null, text: info?.text ?? '' })
}

export function changeEdit(text) {
  const session = $editing.get()

  if (session && !session.saving) {
    $editing.set({ ...session, text })
  }
}

export const cancelEdit = () => $editing.set(null)

/** Edit props for one block, or null when it has nothing to edit. An open editor stays up while
 *  /edits reloads after a version change. */
export function blockEdit(edit, block) {
  if (!edit) {
    return null
  }

  const session = edit.session?.blockId === block.id ? edit.session : null
  const info = edit.blocks?.[block.id] ?? session?.info

  if (!info) {
    return null
  }

  return { info, onCancel: edit.onCancel, onChange: edit.onChange, onSave: edit.onSave, onStart: () => edit.onStart(block.id, info), session }
}

/** Toast for an edit. The verbs match the buttons: Save and accept, Save as proposal. */
export function editToast(apply, result, file, t) {
  switch (result?.status) {
    case 'applied':
      return { kind: 'success', message: t('editApplied', file.file) }
    case 'saved':
      return { kind: 'info', message: t('editSaved', file.file) }
    case 'already_handled':
      return { kind: 'info', message: t('alreadyHandled') }
    default:
      return { detail: result?.error || '', kind: 'error', message: t(apply ? 'editApplyFailed' : 'editSaveFailed') }
  }
}

/** POST the edit. Applied, saved or already handled closes the editor; anything else keeps it open
 *  with the user's text and Hermes's reason, so a failed Save and accept loses nothing. */
export async function performEdit({ apply, file, session, queryClient, rest, t }) {
  $editing.set({ ...session, error: null, saving: apply ? 'apply' : 'save' })
  let result

  try {
    result = await rest(editPath(file, session.blockId), { body: { apply, text: session.text }, method: 'POST' })
  } catch (error) {
    $editing.set({ ...session, error: String(error?.message || error || t('editSaveFailed')), saving: null })
    host.notifyError(error, t(apply ? 'editApplyFailed' : 'editSaveFailed'))

    return null
  }

  const done = ['applied', 'saved', 'already_handled'].includes(result?.status)
  $editing.set(done ? null : { ...session, error: result?.error || t(apply ? 'editApplyFailed' : 'editSaveFailed'), saving: null })
  host.notify(editToast(apply, result, file, t))
  queryClient.invalidateQueries({ queryKey: diffKey(file) })
  queryClient.invalidateQueries({ queryKey: [ID, 'files'] })
  queryClient.invalidateQueries({ queryKey: [ID, 'pending'] })

  if (result?.file_gone) {
    leaveFile(file)
  }

  return result
}

const wordCount = text => (text.trim() ? text.trim().split(/\s+/).length : 0)

/** Live count. With Hermes's limit: the total after this change (base + this text, trimmed as
 *  Hermes trims it). Without one: words and characters of the text. */
export function editCount(text, limit) {
  if (!limit) {
    return { chars: text.length, words: wordCount(text) }
  }

  const chars = limit.strip ? text.trim().length : text.length
  const total = limit.base + chars

  return { chars, label: limit.label, max: limit.max, over: total > limit.max, total }
}

const countLabel = (count, t) => {
  if (count.max == null) {
    return t('editCount', count.words, count.chars)
  }

  const n = v => v.toLocaleString('en-US')

  return count.over ? t('editTotalOver', count.label, n(count.total), n(count.max), n(count.total - count.max)) : t('editTotal', count.label, n(count.total), n(count.max))
}

export const EDIT_STYLES = {
  editor: {
    borderTop: '1px solid var(--ui-stroke-tertiary)',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
    minWidth: 0,
    padding: '0.5rem 0.6rem'
  },
  label: { color: 'var(--ui-text-secondary)', fontSize: '0.7rem', minWidth: 0, overflowWrap: 'anywhere' },
  // Same face, size and leading as the diff rows, so the text does not jump when the editor opens.
  textarea: {
    background: 'var(--ui-editor-surface-background)',
    boxSizing: 'border-box',
    color: 'var(--ui-text-primary)',
    fontFamily: mono,
    fontSize: '0.75rem',
    lineHeight: 1.55,
    maxWidth: '100%',
    minWidth: 0,
    overflowWrap: 'anywhere',
    padding: '0.4rem 0.5rem',
    resize: 'vertical',
    whiteSpace: 'pre-wrap',
    width: '100%',
    wordBreak: 'break-word'
  },
  footer: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.3rem 0.5rem', minWidth: 0 },
  count: { color: 'var(--ui-text-tertiary)', flex: '1 1 10rem', fontSize: '0.7rem', fontVariantNumeric: 'tabular-nums', minWidth: 0, overflowWrap: 'anywhere' },
  over: { color: 'var(--ui-red, var(--ui-diff-remove-foreground))' },
  // Hermes's Skills Guard report runs to many lines: it scrolls inside its own box.
  error: {
    color: 'var(--ui-red, var(--ui-diff-remove-foreground))',
    fontSize: '0.75rem',
    maxHeight: '12rem',
    minWidth: 0,
    overflowWrap: 'anywhere',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap'
  },
  tipWrap: { display: 'inline-flex', maxWidth: '100%', minWidth: 0 },
  field: { fontFamily: mono, fontSize: '0.7rem', minWidth: 0, width: '100%' },
  help: { color: 'var(--ui-text-tertiary)', fontSize: '0.7rem', minWidth: 0, overflowWrap: 'anywhere' }
}

const EDITOR_MIN_ROWS = 3
const EDITOR_MAX_ROWS = 24

export function EditButton({ busy, edit, t }) {
  return jsx(Button, { disabled: busy, onClick: edit.onStart, size: 'xs', style: STYLES.button, type: 'button', variant: 'outline', children: t('edit') })
}

/** The in-place editor as a pure view. Grows with the text up to 24 lines, then scrolls; the user
 *  can still drag it taller. */
export function BlockEditor({ session, info, onChange, onSave, onCancel, t }) {
  const saving = Boolean(session.saving)
  const count = editCount(session.text, info.limit)
  const rows = Math.min(Math.max(session.text.split('\n').length + 1, EDITOR_MIN_ROWS), EDITOR_MAX_ROWS)
  const id = `skill-review-edit-${session.blockId}`

  return jsxs('div', {
    'data-editor': session.blockId,
    style: EDIT_STYLES.editor,
    children: [
      jsx('label', { htmlFor: id, style: EDIT_STYLES.label, children: t(`editScope_${info.scope || 'file'}`) }),
      jsx(Textarea, {
        'aria-invalid': Boolean(session.error) || Boolean(count.over),
        autoFocus: true,
        id,
        onChange: event => onChange(event.target.value),
        readOnly: saving,
        rows,
        spellCheck: false,
        style: { ...EDIT_STYLES.textarea, minHeight: `${(rows * 1.55 * 0.75 + 0.8).toFixed(2)}rem` },
        value: session.text,
        wrap: 'soft'
      }),
      session.error ? jsx('div', { role: 'alert', style: EDIT_STYLES.error, children: session.error }) : null,
      jsxs('div', {
        style: EDIT_STYLES.footer,
        children: [
          jsx('span', { 'aria-live': 'polite', style: count.over ? { ...EDIT_STYLES.count, ...EDIT_STYLES.over } : EDIT_STYLES.count, children: countLabel(count, t) }),
          jsxs('span', {
            style: STYLES.actions,
            children: [
              jsx(Button, { disabled: saving, onClick: () => onSave(true), size: 'xs', style: STYLES.button, type: 'button', children: t('editApply') }),
              jsx(Button, { disabled: saving, onClick: () => onSave(false), size: 'xs', style: STYLES.button, type: 'button', variant: 'outline', children: t('editSave') }),
              jsx(Button, { disabled: saving, onClick: onCancel, size: 'xs', style: STYLES.button, type: 'button', variant: 'ghost', children: t('editCancel') })
            ]
          })
        ]
      })
    ]
  })
}

/** Edit wiring for one open file: the editable blocks from /edits and the session for this file. */
function useBlockEdit(file, queryClient, t) {
  const editing = useValue($editing)
  const key = fileKey(file)
  const edits = useQuery({
    placeholderData: previous => previous,
    queryFn: () => CTX.rest(editsPath(file)),
    queryKey: editsKey(file),
    refetchOnWindowFocus: false,
    retry: false, // a backend from before this feature has no /edits: no Edit buttons
    staleTime: Infinity
  })
  const session = editing?.file === key ? editing : null

  return {
    blocks: edits.data?.status === 'ok' ? edits.data.blocks ?? {} : {},
    onCancel: cancelEdit,
    onChange: changeEdit,
    onSave: apply => {
      const current = $editing.get()

      if (!current || current.file !== key || current.saving) {
        return null
      }

      if (apply) {
        haptic('tap')
      }

      return performEdit({ apply, file, queryClient, rest: (path, opts) => CTX.rest(path, opts), session: current, t })
    },
    onStart: (blockId, info) => startEdit(file, blockId, info),
    session
  }
}

// --- Open in VS Code -----------------------------------------------------------------------------

export const EDITOR_PRESETS = {
  remote: 'vscode://vscode-remote/ssh-remote+{host}{path}', // Desktop on another machine, over SSH
  local: 'vscode://file{path}' // Desktop on the machine Hermes runs on
}
export const DEFAULT_EDITOR_TEMPLATE = EDITOR_PRESETS.remote
export const $editorTemplate = atom(DEFAULT_EDITOR_TEMPLATE)
const EDITOR_STORAGE_KEY = 'editorUrlTemplate'
const SCRIPT_SCHEMES = /^(javascript|data|vbscript|blob):/i

/** Each path segment percent-encoded (spaces, unicode, '#', '?', '%'); the slashes stay. */
export const encodePath = path => String(path).split('/').map(encodeURIComponent).join('/')

/** The message key for what is wrong with a link template, or null when it can be used. */
export function templateProblem(template) {
  const value = typeof template === 'string' ? template.trim() : ''

  if (!value) {
    return 'editorTemplateEmpty'
  }

  if (!value.includes('{path}')) {
    return 'editorTemplateNoPath'
  }

  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return 'editorTemplateNoScheme'
  }

  return SCRIPT_SCHEMES.test(value) ? 'editorTemplateScheme' : null
}

/** The link for a location: {host}, {path} and {user} filled in, each encoded. */
export function buildEditorUrl(template, location) {
  const problem = templateProblem(template)

  if (problem) {
    throw new Error(problem)
  }

  const path = location?.path

  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('editorNoPath')
  }

  const values = { host: encodeURIComponent(location.host || ''), path: encodePath(path), user: encodeURIComponent(location.user || '') }

  return template.trim().replace(/\{(host|path|user)\}/g, (_, name) => values[name])
}

export const presetOf = template => Object.keys(EDITOR_PRESETS).find(id => EDITOR_PRESETS[id] === template) ?? 'custom'

export function loadEditorSettings(ctx) {
  const stored = readStored(ctx, EDITOR_STORAGE_KEY, DEFAULT_EDITOR_TEMPLATE)

  $editorTemplate.set(templateProblem(stored) ? DEFAULT_EDITOR_TEMPLATE : stored.trim())
}

/** Use and store a template; an unusable one is refused and the previous one stays. */
export function setEditorTemplate(template) {
  if (templateProblem(template)) {
    return false
  }

  $editorTemplate.set(template.trim())
  writeStored(EDITOR_STORAGE_KEY, template.trim())

  return true
}

async function copyLink(url, os, notify, message) {
  let copied = false

  if (typeof os?.writeClipboard === 'function') {
    try {
      copied = (await os.writeClipboard(url)) === true
    } catch {
      copied = false
    }
  }

  notify(copied ? { detail: url, kind: 'info', message: message.copied } : { detail: url, kind: 'error', message: message.failed })

  return copied ? 'copied' : 'failed'
}

/**
 * Hand the link to the OS. When Desktop cannot open it (no openExternal, or it answers false, as
 * Desktop does for any scheme besides http, https, mailto and file), the link is copied instead and
 * a toast says so. Returns 'opened' | 'copied' | 'failed' | 'bad-template'.
 */
export async function openInEditor({ location, template, os, notify, t }) {
  let url

  try {
    url = buildEditorUrl(template, location)
  } catch (error) {
    notify({ detail: t(error.message), kind: 'error', message: t('editorBadTemplate') })

    return 'bad-template'
  }

  if (typeof os?.openExternal !== 'function') {
    return copyLink(url, os, notify, { copied: t('editorNoOpenCopied'), failed: t('editorOpenFailed') })
  }

  let opened = false

  try {
    opened = (await os.openExternal(url)) === true
  } catch {
    opened = false
  }

  return opened ? 'opened' : copyLink(url, os, notify, { copied: t('editorRefusedCopied'), failed: t('editorOpenFailed') })
}

/** { disabled, state, tip, text? } for the button, from the /location answer. */
export function editorButtonState(location, loading, error) {
  if (loading) {
    return { disabled: true, state: 'loading', tip: 'editorFinding' }
  }

  if (error || !location) {
    return { disabled: true, state: 'error', tip: 'editorUnknown' }
  }

  if (location.status === 'refused') {
    return { disabled: true, state: 'refused', text: location.error, tip: 'editorRefused' }
  }

  if (location.status !== 'ok') {
    return { disabled: true, state: 'gone', tip: 'fileGone' }
  }

  if (!location.exists || !location.path) {
    return { disabled: true, state: 'missing', tip: 'editorMissing' }
  }

  return { disabled: false, state: 'ready', tip: 'editorTip' }
}

/** One per file, in the file header. A disabled button sits in a focusable span so its tooltip
 *  still explains why. */
export function OpenInEditorButton({ file, location, loading, error, onOpen, t }) {
  const s = editorButtonState(location, loading, error)
  const tip = s.text || t(s.tip, file.file)

  const button = jsxs(Button, {
    'aria-label': `${t('openInEditor')}. ${tip}`,
    'data-editor-state': s.state,
    disabled: s.disabled,
    onClick: onOpen,
    size: 'sm',
    style: STYLES.button,
    type: 'button',
    variant: 'outline',
    children: [jsx(Codicon, { name: 'link-external' }), jsx('span', { style: STYLES.ellipsis, children: t('openInEditor') })]
  })

  return jsx(Tip, { label: tip, children: s.disabled ? jsx('span', { style: EDIT_STYLES.tipWrap, tabIndex: 0, children: button }) : button })
}

function OpenInEditorControl({ file }) {
  const t = usePluginI18n(ID)
  const template = useValue($editorTemplate)
  const location = useQuery({
    queryFn: () => CTX.rest(locationPath(file)),
    queryKey: locationKey(file),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity
  })

  return jsx(OpenInEditorButton, {
    error: location.isError,
    file,
    loading: location.isLoading,
    location: location.data,
    onOpen: () => openInEditor({ location: location.data, notify: toast => host.notify(toast), os: CTX?.os, t, template }),
    t
  })
}

/** The link settings as a pure view: the two presets, Custom, and a text field for Custom. */
export function EditorLinkSettings({ mode, draft, onMode, onDraft, t }) {
  const problem = mode === 'custom' ? templateProblem(draft) : null

  return jsxs('div', {
    'aria-label': t('editorSettings'),
    role: 'group',
    style: SETTINGS_STYLES.section,
    children: [
      jsx('span', { style: SETTINGS_STYLES.label, children: t('editorSettings') }),
      jsxs(Select, {
        onValueChange: onMode,
        value: mode,
        children: [
          jsx(SelectTrigger, {
            'aria-label': t('editorSettings'),
            size: 'xs',
            style: LIST_STYLES.trigger,
            children: jsx(SelectValue, { children: jsx('span', { style: STYLES.ellipsis, children: t(`editorPreset_${mode}`) }) })
          }),
          jsx(SelectContent, {
            children: ['remote', 'local', 'custom'].map(id => jsx(SelectItem, { value: id, children: t(`editorPreset_${id}`) }, id))
          })
        ]
      }),
      jsx('span', { style: EDIT_STYLES.help, children: t(`editorPresetHelp_${mode}`) }),
      mode === 'custom'
        ? jsx(Input, {
            'aria-invalid': Boolean(problem),
            'aria-label': t('editorCustomLabel'),
            onChange: event => onDraft(event.target.value),
            placeholder: DEFAULT_EDITOR_TEMPLATE,
            spellCheck: false,
            style: EDIT_STYLES.field,
            value: draft
          })
        : null,
      mode === 'custom' ? jsx('span', { style: problem ? { ...EDIT_STYLES.help, ...EDIT_STYLES.over } : EDIT_STYLES.help, children: t(problem || 'editorPlaceholders') }) : null
    ]
  })
}

export function EditorLinkControl() {
  const t = usePluginI18n(ID)
  const template = useValue($editorTemplate)
  const [mode, setMode] = useState(presetOf(template))
  const [draft, setDraft] = useState(template)

  return jsx(EditorLinkSettings, {
    draft,
    mode,
    onDraft: value => {
      setDraft(value)
      setEditorTemplate(value) // saved only once it is usable; the field shows why until then
    },
    onMode: next => {
      setMode(next)

      if (next !== 'custom') {
        setDraft(EDITOR_PRESETS[next])
        setEditorTemplate(EDITOR_PRESETS[next])
      }
    },
    t
  })
}

const EDIT_EN = {
  edit: 'Edit',
  editApplied: name => `Accepted your edited change to ${name}`,
  editApply: 'Save and accept',
  editApplyFailed: 'Your edit was not accepted. The proposal is unchanged.',
  editCancel: 'Cancel',
  editCount: (words, chars) => `${words} word${words === 1 ? '' : 's'}, ${chars} character${chars === 1 ? '' : 's'}`,
  editSave: 'Save as proposal',
  editSaveFailed: 'Your edit was not saved. The proposal is unchanged.',
  editSaved: name => `Saved your edit to the proposed change to ${name}. It is still pending.`,
  editScope_entry: 'The whole entry after this change',
  editScope_file: 'The whole file after this change',
  editScope_span: 'The new text for the part this change replaces',
  editTotal: (label, total, max) => `${label} after this change: ${total} of ${max} characters`,
  editTotalOver: (label, total, max, over) => `${label} after this change: ${total} of ${max} characters, ${over} over the limit`,
  editorBadTemplate: 'The VS Code link setting cannot be used',
  editorCustomLabel: 'Custom link',
  editorFinding: 'Finding the file',
  editorMissing: name => `${name} does not exist yet. Accept the change to create it, then open it.`,
  editorNoOpenCopied: 'This Desktop cannot open links, so the VS Code link was copied. Paste it into a browser address bar.',
  editorNoPath: 'The file has no absolute path.',
  editorOpenFailed: 'Could not open or copy the VS Code link',
  editorPlaceholders: 'Use {host}, {path} and {user}. {path} is required.',
  editorPresetHelp_custom: 'Any editor link. Hermes fills in the placeholders and encodes the path.',
  editorPresetHelp_local: 'For a Desktop on the same computer as Hermes.',
  editorPresetHelp_remote: 'For a Desktop on another computer that reaches the Hermes host over SSH. Needs the Remote SSH extension in VS Code.',
  editorPreset_custom: 'Custom link',
  editorPreset_local: 'VS Code on this computer',
  editorPreset_remote: 'VS Code over SSH',
  editorRefused: 'This file is outside the profile folder, so it is not opened.',
  editorRefusedCopied: 'Desktop did not open the VS Code link, so it was copied. Paste it into a browser address bar.',
  editorSettings: 'How Open in VS Code links',
  editorTemplateEmpty: 'Enter a link.',
  editorTemplateNoPath: 'The link needs {path}.',
  editorTemplateNoScheme: 'The link needs a scheme, such as vscode://.',
  editorTemplateScheme: 'Script and data links are not allowed.',
  editorTip: name => `Opens the current ${name} in VS Code. The proposed changes are not in it until you accept them.`,
  editorUnknown: 'Could not find where this file is.',
  openInEditor: 'Open in VS Code'
}

// ---------------------------------------------------------------------------------------------
// Context expansion. The diff (contract v1) already carries every line of the current file as
// context segments, numbered as Hermes reads the file, so folding and unfolding is local: no extra
// request, and the lines always match the version on screen. Next to each change CONTEXT_LINES stay
// visible; the rest of each gap folds into one expand row. State is per file, per gap, and resets
// when the shown diff's version changes, because a new version can move lines.
// ---------------------------------------------------------------------------------------------

export const CONTEXT_LINES = 3
export const EXPAND_STEP = 10

/** The open gaps of `file` at its current version: { key, version, gaps: { [gapId]: { up, down, all } } }. */
export function expansionFor(state, file) {
  const key = fileKey(file)
  const version = diffVersion(file)

  return state && state.key === key && state.version === version ? state : { gaps: {}, key, version }
}

/** One more step (`up` or `down`) or the whole gap (`all`) for `gapId`. */
export function expandGap(state, file, gapId, dir) {
  const current = expansionFor(state, file)
  const gap = current.gaps[gapId] ?? { all: false, down: 0, up: 0 }
  const next = dir === 'all' ? { ...gap, all: true } : { ...gap, [dir]: gap[dir] + EXPAND_STEP }

  return { ...current, gaps: { ...current.gaps, [gapId]: next } }
}

/**
 * Segments to render: blocks as they are, each context segment as visible `context` runs around at most
 * one `gap`. A gap is `top` (above the first change: it opens upward), `bottom` (below the last:
 * it opens downward) or `between` (both). `down` lines extend from the upper edge, `up` lines from
 * the lower edge. A gap's id is its first and last line number.
 */
export function contextPlan(segments, gaps = {}) {
  const blockAt = segments.map(s => s.type === 'block')
  const first = blockAt.indexOf(true)
  const last = blockAt.lastIndexOf(true)
  const out = []

  segments.forEach((segment, index) => {
    if (segment.type !== 'context') {
      out.push(segment)

      return
    }

    const lines = segment.lines ?? []
    const n = lines.length

    if (!n) {
      return
    }

    const id = `${lines[0].no}-${lines[n - 1].no}`
    const position = first < 0 ? null : index < first ? 'top' : index > last ? 'bottom' : 'between'
    const open = gaps?.[id] ?? {}
    let head = position === 'top' ? 0 : CONTEXT_LINES
    let tail = position === 'bottom' ? 0 : CONTEXT_LINES
    head = Math.min(n, head + (open.down ?? 0))
    tail = Math.min(n - head, tail + (open.up ?? 0))

    if (!position || open.all || head + tail >= n) {
      out.push({ key: id, lines, type: 'context' })

      return
    }

    if (head) {
      out.push({ key: `${id}:head`, lines: lines.slice(0, head), type: 'context' })
    }

    out.push({ firstHidden: lines[head].no, hidden: n - head - tail, id, lastHidden: lines[n - tail - 1].no, position, type: 'gap' })

    if (tail) {
      out.push({ key: `${id}:tail`, lines: lines.slice(n - tail), type: 'context' })
    }
  })

  return out
}

export const EXPAND_STYLES = {
  // Same tone as the hunk header row: a slim band across the diff box that reads as "lines here".
  row: {
    alignItems: 'center',
    background: 'var(--ui-bg-quaternary)',
    borderLeft: '2px solid transparent',
    color: 'var(--ui-text-tertiary)',
    display: 'flex',
    flexWrap: 'wrap',
    fontFamily: mono,
    fontSize: '0.7rem',
    minWidth: 0
  },
  button: {
    alignItems: 'center',
    background: 'none',
    border: 0,
    color: 'inherit',
    cursor: 'pointer',
    display: 'inline-flex',
    font: 'inherit',
    gap: '0.35rem',
    lineHeight: 1.55,
    maxWidth: '100%',
    minWidth: 0,
    overflowWrap: 'anywhere',
    padding: '0.15rem 0.75rem',
    textAlign: 'left',
    whiteSpace: 'normal'
  },
  // Show all sits at the row's right end, apart from the step buttons.
  all: { marginLeft: 'auto', minWidth: 0 }
}

const STEP_ICON = { down: 'fold-down', up: 'fold-up' }

/** One folded gap: step buttons (alt-click shows everything) and Show all, or only Show all when
 *  the gap is no bigger than one step. */
export function ExpandRow({ gap, onExpand, t }) {
  const { hidden, position } = gap
  const button = (dir, label, aria, style) =>
    jsxs(
      'button',
      {
        'aria-label': aria,
        'data-expand': dir,
        onClick: event => onExpand(gap.id, dir !== 'all' && event?.altKey ? 'all' : dir),
        style: style ? { ...EXPAND_STYLES.button, ...style } : EXPAND_STYLES.button,
        title: dir === 'all' ? undefined : t('expandAltHint'),
        type: 'button',
        children: [STEP_ICON[dir] ? jsx(Codicon, { name: STEP_ICON[dir] }) : null, label]
      },
      dir
    )

  const steps = []

  if (hidden > EXPAND_STEP) {
    if (position === 'top') {
      steps.push(button('up', t('expandAbove', EXPAND_STEP), t('expandAboveAria', EXPAND_STEP, hidden)))
    } else if (position === 'bottom') {
      steps.push(button('down', t('expandBelow', EXPAND_STEP), t('expandBelowAria', EXPAND_STEP, hidden)))
    } else {
      steps.push(button('down', t('expandMore', EXPAND_STEP), t('expandDownAria', EXPAND_STEP, hidden)))
      steps.push(button('up', t('expandMore', EXPAND_STEP), t('expandUpAria', EXPAND_STEP, hidden)))
    }
  }

  return jsxs('div', {
    'data-gap': gap.id,
    style: EXPAND_STYLES.row,
    children: [...steps, button('all', t('expandAll', hidden), t(`expandAll_${position}`, hidden), steps.length ? EXPAND_STYLES.all : null)]
  })
}

const lineCount = n => `${n} hidden line${n === 1 ? '' : 's'}`

const EXPAND_EN = {
  expandAbove: n => `Show ${n} more lines above`,
  expandAboveAria: (n, hidden) => `Show ${n} more lines above, ${hidden} hidden`,
  expandAll: n => `Show all ${lineCount(n)}`,
  expandAll_between: n => `Show all ${lineCount(n)} between these changes`,
  expandAll_bottom: n => `Show all ${lineCount(n)} below`,
  expandAll_top: n => `Show all ${lineCount(n)} above`,
  expandAltHint: 'Alt-click shows every hidden line',
  expandBelow: n => `Show ${n} more lines below`,
  expandBelowAria: (n, hidden) => `Show ${n} more lines below, ${hidden} hidden`,
  expandDownAria: (n, hidden) => `Show ${n} more lines below the change above, ${hidden} hidden`,
  expandMore: n => `Show ${n} more lines`,
  expandUpAria: (n, hidden) => `Show ${n} more lines above the change below, ${hidden} hidden`
}

// ---------------------------------------------------------------------------------------------
// Reveal, watcher, status chip
// ---------------------------------------------------------------------------------------------

/**
 * The review pane. register() does not register it: Desktop docks every registered pane at launch
 * and restores a saved layout, so a pane registered at startup would appear on its own. It is
 * registered on demand (first Review press or first new change with autoOpen on), the way Bot Mode
 * registers its Routines pane. Until then a saved layout entry for it stays hidden and its zone
 * collapses, because Desktop draws no unregistered pane.
 *
 * defaultCollapsed makes it arrive as the right edge's slim vertical tab when it first enters the
 * layout. Desktop applies it only on that first entry: a layout that already holds the pane keeps
 * its saved state. openReview reveals it right after registering, and revealPane expands a
 * collapsed zone, so in practice it opens straight away.
 *
 * Desktop cannot dismiss a pane for a plugin at startup. Closing a plugin's ONLY pane turns the
 * plugin off (closeTreePane in the Desktop tree store counts the plugin's registered panes), so the
 * settings pane is always registered with this one: Close (X, cmd-W, any menu) then only dismisses.
 */
export function reviewPaneContribution() {
  return {
    id: 'list', // skill-review:list, the same id as before, so saved layouts still match it
    area: 'panes',
    title: en.listTitle,
    // Its own tiling column on the workspace's right edge, like Bots' Routines pane. 'right'
    // placement is the collapsible right sidebar's role, so this docks explicitly instead.
    data: { placement: 'main', dock: { pane: 'workspace', pos: 'right' }, defaultCollapsed: true, width: '720px', minWidth: '240px' },
    render: () => jsx(ReviewPane, {})
  }
}

/**
 * The second pane: the review settings, a tab in the list's zone. Registered and unregistered
 * together with the list, so the plugin always has two panes. It is adopted after the list (its dock
 * names the list) as an inactive tab, so it never takes the zone from the list; defaultCollapsed only
 * matters if it ever lands in a zone of its own.
 */
export function settingsPaneContribution() {
  return {
    id: 'settings', // skill-review:settings
    area: 'panes',
    title: en.settingsTitle,
    data: { placement: 'main', dock: { pane: LIST_PANE, pos: 'center' }, defaultCollapsed: true, minWidth: '240px' },
    render: () => jsx(SettingsPane, {})
  }
}

let unregisterPane = null

function ensureReviewPane() {
  if (unregisterPane || !CTX) {
    return
  }

  const disposers = [CTX.register(reviewPaneContribution()), CTX.register(settingsPaneContribution())]

  unregisterPane = () => disposers.forEach(dispose => typeof dispose === 'function' && dispose())
}

/** Bring one of the two panes on screen: forget a Close, register both panes, then reveal (which
 *  expands a collapsed zone). The undismiss runs first so a closed list is back in the layout before
 *  the settings pane, which docks next to it, is adopted. */
function showPane(id) {
  if (typeof host.undismissPane === 'function') {
    host.undismissPane(id)
  }

  ensureReviewPane()

  if (typeof host.revealPane === 'function') {
    host.revealPane(id)
  }
}

/** Show the review pane (registering it, bringing it back if closed, expanding it if collapsed) and
 *  optionally select an item. Never opens a main-workspace tab. Desktops without the pane APIs get
 *  the route page instead. */
export function openReview(key) {
  if (key) {
    $selection.set(key)
  }

  markSeen()

  if (useRouteFallback || typeof host.openWorkspace !== 'function') {
    host.navigate(ROUTE)

    return
  }

  showPane(LIST_PANE)
}

/** The list header's gear: show the settings pane the same way. */
export function openSettings() {
  if (useRouteFallback || typeof host.openWorkspace !== 'function') {
    host.navigate(ROUTE)

    return
  }

  showPane(SETTINGS_PANE)
}

/**
 * Announce each new pending write once. Keys already announced (and still pending) are never
 * announced again; the set survives restarts through plugin storage. So a pane the user closed is not
 * reopened for the same changes. With recordOnly (the watcher's first poll after startup) the
 * pending keys are only recorded: changes that were waiting before the app started never open the
 * pane or toast. How a new change is announced:
 *   autoOpen on:  the review pane opens (no toast, the pane is the signal).
 *   autoOpen off: notifyMode decides, a toast ('popup') or the lit chip ('light').
 * Returns the number of new items.
 */
export function announce(ctx, items, { recordOnly = false } = {}) {
  if (!Array.isArray(items)) {
    return 0
  }

  let announced = []

  try {
    const value = ctx.storage.get('announced', [])
    announced = Array.isArray(value) ? value : []
  } catch {
    announced = []
  }

  const { fresh, keep } = planAutoOpen(items, announced)

  ctx.storage.set('announced', keep)

  if (recordOnly || !fresh.length) {
    return 0
  }

  // Old desktops show the review as a route page; opening it would take over the main view.
  if ($autoOpen.get() && !useRouteFallback) {
    // Keep the change the user is reading; select the new one only when nothing is selected.
    openReview($selection.get() ? undefined : fresh[0])
  } else if ($notifyMode.get() === 'popup') {
    const first = fresh[0]

    host.notify({
      action: { label: ctx.i18n.t('review'), onClick: () => openReview(first) },
      kind: 'info',
      message: ctx.i18n.t('newPending', fresh.length)
    })
  }

  return fresh.length
}

/**
 * Background watcher, started in register(): it runs whether or not either pane is mounted. It
 * reads through the shared query client with the panes' own key, so they share one request.
 */
function startWatcher(ctx) {
  // The first successful poll after startup only records what is already pending.
  let primed = false

  const tick = () => {
    const profile = host.state.profile?.get?.() ?? null

    return queryClient
      .fetchQuery({ queryFn: fetchPending, queryKey: pendingKey(profile), staleTime: POLL_MS - 500 })
      .then(data => {
        if (listPaneVisible()) {
          markSeen() // the user is looking at the list: nothing in it is unseen
        }

        const fresh = announce(ctx, data?.items, { recordOnly: !primed })

        primed = primed || Array.isArray(data?.items)

        $lit.set($notifyMode.get() === 'light' && hasUnseen(data?.items, $lastSeenAt.get()))

        return fresh
      })
      .catch(() => 0) // backend off or unreachable: the list pane shows the error
  }

  ctx.setTimeout(tick, 1500)
  ctx.setInterval(tick, POLL_MS)

  // The pane coming on screen by any route (its tab, a drag, the layout restoring) counts as opening it.
  if (typeof host.paneVisibility === 'function') {
    const visible = host.paneVisibility(LIST_PANE)
    const stop = visible?.listen?.(on => {
      if (on) {
        markSeen()
      }
    })

    if (typeof stop === 'function') {
      ctx.onDispose(stop)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Notification mode: 'popup' toasts each new change, 'light' lights the status-bar chip instead
// until the user opens the review pane. A change is unseen when it was staged after lastSeenAt.
// ---------------------------------------------------------------------------------------------

export const NOTIFY_MODES = ['popup', 'light']
export const $notifyMode = atom('popup')
export const $lit = atom(false)
const $lastSeenAt = atom(0) // ms; 0 means the pane was never opened

// autoOpen (default on): a change that arrives while the app runs opens the review pane, and
// notifyMode is not used for it. Off: notifyMode applies as before, a toast ('popup') or the lit
// chip ('light'). The chip lights by the unseen rule in both cases, and opening the pane clears it.
export const $autoOpen = atom(true)

const listPaneVisible = () =>
  typeof host.paneVisibility === 'function' && host.paneVisibility(LIST_PANE)?.get?.() === true

/** True when any item was staged (created_at, seconds) after lastSeenAt (milliseconds). */
export const hasUnseen = (items, lastSeenAt) =>
  Array.isArray(items) && items.some(item => Number(item?.created_at) * 1000 > lastSeenAt)

function readStored(ctx, key, fallback) {
  try {
    return ctx.storage.get(key, fallback)
  } catch {
    return fallback
  }
}

function loadNotifySettings(ctx) {
  const mode = readStored(ctx, 'notifyMode', 'popup')
  const seen = Number(readStored(ctx, 'lastSeenAt', 0))

  const autoOpen = readStored(ctx, 'autoOpen', true)

  $notifyMode.set(NOTIFY_MODES.includes(mode) ? mode : 'popup')
  $autoOpen.set(typeof autoOpen === 'boolean' ? autoOpen : true)
  $lastSeenAt.set(Number.isFinite(seen) ? seen : 0)
  $lit.set(false)
}

export function setNotifyMode(mode) {
  if (!NOTIFY_MODES.includes(mode)) {
    return
  }

  $notifyMode.set(mode)
  CTX?.storage.set('notifyMode', mode)

  if (mode !== 'light') {
    $lit.set(false)
  }
}

export function setAutoOpen(on) {
  $autoOpen.set(on === true)

  try {
    CTX?.storage.set('autoOpen', on === true)
  } catch {
    // storage unavailable: the choice holds for this session
  }
}

/** The user has looked at the review pane: everything staged until now is seen. */
export function markSeen() {
  const now = Date.now()

  $lastSeenAt.set(now)
  $lit.set(false)

  try {
    CTX?.storage.set('lastSeenAt', now)
  } catch {
    // storage full or unavailable: the light still clears for this session
  }
}

export function NotifyModeSwitch({ mode, onChange, t }) {
  return jsxs('div', {
    'aria-label': t('notifyLabel'),
    role: 'group',
    style: STYLES.barRow,
    children: [
      jsx('span', { style: STYLES.muted, children: t('notifyLabel') }),
      jsx(SegmentedControl, {
        onChange,
        options: NOTIFY_MODES.map(id => ({ id, label: t(id === 'popup' ? 'notifyPopup' : 'notifyLight') })),
        sizing: 'content',
        value: mode
      })
    ]
  })
}

/** The settings pane's notify control. */
export function NotifyModeControl() {
  const t = usePluginI18n(ID)
  const mode = useValue($notifyMode)

  return jsx(NotifyModeSwitch, { mode, onChange: setNotifyMode, t })
}

export const AUTO_OPEN_STYLES = {
  row: { alignItems: 'center', cursor: 'pointer', display: 'flex', gap: '0.4rem', minWidth: 0 },
  text: { ...STYLES.muted, color: 'var(--ui-text-secondary)', minWidth: 0, overflowWrap: 'anywhere' }
}

export function AutoOpenSwitch({ on, onChange, t }) {
  return jsxs('label', {
    style: AUTO_OPEN_STYLES.row,
    children: [
      jsx(Checkbox, { checked: on, onCheckedChange: value => onChange(value === true) }),
      jsx('span', { style: AUTO_OPEN_STYLES.text, children: t('autoOpenLabel') })
    ]
  })
}

/** The settings pane's autoOpen checkbox, below the notify control. */
export function AutoOpenControl() {
  const t = usePluginI18n(ID)
  const on = useValue($autoOpen)

  return jsx(AutoOpenSwitch, { on, onChange: setAutoOpen, t })
}

export const SETTINGS_STYLES = {
  body: { display: 'flex', flexDirection: 'column', gap: '0.9rem', minWidth: 0, padding: PAD },
  section: { display: 'flex', flexDirection: 'column', gap: '0.35rem', minWidth: 0 },
  label: { fontSize: '0.75rem', fontWeight: 600, minWidth: 0 }
}

/** What the settings are set to, for the list header: the profile subset and the sort order. */
export function SettingsSummary({ profiles, hidden, sort, t }) {
  const sortText = t(`sort_${SORTS.includes(sort) ? sort : 'newest'}`)

  return jsx('span', {
    style: { ...STYLES.muted, ...STYLES.ellipsis },
    children: profiles.length ? t('settingsSummary', profileLabel(profiles, hidden, t), sortText) : sortText
  })
}

/** The list header's gear. */
export function SettingsGearButton({ onOpen, t }) {
  return jsx(Button, {
    'aria-label': t('openSettings'),
    onClick: onOpen,
    size: 'xs',
    style: STYLES.button,
    title: t('openSettings'),
    type: 'button',
    variant: 'ghost',
    children: jsx(Codicon, { name: 'settings-gear' })
  })
}

function SettingsSection({ label, children }) {
  return jsxs('div', { style: SETTINGS_STYLES.section, children: [jsx('span', { style: SETTINGS_STYLES.label, children: label }), children] })
}

/** The settings pane's content. Every control reads and writes the same persisted atoms the list
 *  reads, so the two panes always agree. */
export function SettingsView({ profiles, focused, t }) {
  return jsxs('div', {
    style: STYLES.paneRoot,
    children: [
      jsx('div', { style: STYLES.bar, children: jsx('span', { style: { fontSize: '0.875rem', fontWeight: 600, minWidth: 0 }, children: t('settingsTitle') }) }),
      jsxs('div', {
        style: { ...STYLES.listScroll, ...SETTINGS_STYLES.body },
        children: [
          jsxs(SettingsSection, {
            label: t('scopeGroup'),
            children: [
              jsx('div', { style: STYLES.barRow, children: jsx(ProfileControl, { focused, profiles }) }),
              profiles.length ? null : jsx('span', { style: STYLES.muted, children: t('settingsNoProfiles') })
            ]
          }),
          jsx(SettingsSection, { label: t('sortLabel'), children: jsx('div', { style: STYLES.barRow, children: jsx(SortControl, {}) }) }),
          jsxs('div', { style: SETTINGS_STYLES.section, children: [jsx(NotifyModeControl, {}), jsx(AutoOpenControl, {})] }),
          jsx(EditorLinkControl, {})
        ]
      })
    ]
  })
}

export function SettingsPane() {
  const t = usePluginI18n(ID)
  const v = useVisibleFiles()

  return jsx(SettingsView, { focused: v.focused, profiles: v.profiles, t })
}

const SETTINGS_EN = {
  openSettings: 'Review settings',
  settingsNoProfiles: 'Profiles show up here once they have pending changes.',
  settingsSummary: (profiles, sort) => `${profiles}, ${sort}`,
  settingsTitle: 'Review settings'
}

export const CHIP_STYLES = {
  button: {
    alignItems: 'center',
    background: 'none',
    border: 0,
    color: 'var(--ui-text-secondary)',
    cursor: 'pointer',
    display: 'inline-flex',
    fontSize: '0.6875rem',
    gap: '0.3rem',
    height: '100%',
    padding: '0 0.4rem'
  },
  lit: { color: 'var(--ui-accent)', fontWeight: 600 },
  dot: { background: 'var(--ui-accent)', borderRadius: '50%', display: 'inline-block', flex: 'none', height: '6px', width: '6px' },
  menuLabel: { color: 'var(--ui-text-tertiary)', fontSize: '0.6875rem', padding: '0.3rem 0.5rem' }
}

/** Status-bar chip: click opens the review panes, right-click picks the notification mode. */
export function ReviewChip({ count, counts, lit, mode, onOpen, onMode, t }) {
  const button = jsxs('button', {
    'aria-label': lit ? `${t('chipTip', count, counts)}. ${t('chipUnseen')}` : t('chipTip', count, counts),
    'data-lit': lit,
    onClick: onOpen,
    style: lit ? { ...CHIP_STYLES.button, ...CHIP_STYLES.lit } : CHIP_STYLES.button,
    type: 'button',
    children: [
      jsx(Codicon, { name: 'git-pull-request' }),
      t('chipLabel'),
      lit ? jsx('span', { 'aria-hidden': true, style: CHIP_STYLES.dot }) : null,
      count ? jsx(Badge, { size: 'xs', variant: 'warn', children: count }) : null
    ]
  })

  return jsxs(ContextMenu, {
    children: [
      jsx(Tip, {
        label: lit ? `${t('chipTip', count, counts)}. ${t('chipUnseen')}` : t('chipTip', count, counts),
        children: jsx(ContextMenuTrigger, { asChild: true, children: button })
      }),
      jsxs(ContextMenuContent, {
        children: [
          jsx('div', { style: CHIP_STYLES.menuLabel, children: t('notifyLabel') }),
          ...NOTIFY_MODES.map(id =>
            jsx(
              ContextMenuCheckboxItem,
              {
                checked: mode === id,
                onCheckedChange: () => onMode(id),
                children: t(id === 'popup' ? 'notifyPopup' : 'notifyLight')
              },
              id
            )
          )
        ]
      })
    ]
  })
}

function StatusChip() {
  const t = usePluginI18n(ID)
  const { data, isError } = usePending()
  const lit = useValue($lit)
  const mode = useValue($notifyMode)
  // Always shown, so Review can open the pane with nothing pending; no badge at 0 or on error.
  const items = isError || !Array.isArray(data?.items) ? [] : data.items

  return jsx(ReviewChip, {
    count: items.length,
    counts: countBySubsystem(items),
    lit,
    mode,
    onMode: setNotifyMode,
    onOpen: () => {
      haptic('tap')
      openReview()
    },
    t
  })
}

const NOTIFY_EN = {
  autoOpenLabel: 'Open this tab automatically when a change arrives',
  chipUnseen: 'New changes since you last opened Review',
  notifyLabel: 'When a new change arrives',
  notifyLight: 'Light up icon',
  notifyPopup: 'Popup'
}

// ---------------------------------------------------------------------------------------------

export const messages = { en: null }

const en = {
  ...FILE_EN,
  accept: 'Accept',
  acceptError: 'Could not accept the change',
  accepted: name => `Accepted change to ${name}`,
  action_add: 'add',
  action_batch: 'batch',
  action_create: 'new skill',
  action_delete: 'delete',
  action_edit: 'rewrite',
  action_patch: 'patch',
  action_remove: 'remove',
  action_replace: 'replace',
  action_remove_file: 'remove file',
  action_unknown: 'change',
  action_write_file: 'write file',
  alreadyHandled: 'Already handled, for example from chat.',
  auto: 'auto',
  autoTip: 'Proposed by the background review, not a chat turn',
  backendMissing:
    'The review backend is not running. Add skill-review to plugins.enabled in config.yaml and restart the gateway.',
  chipLabel: 'Review',
  chipTip: (n, c) => `${n} pending write${n === 1 ? '' : 's'} (${c.skills} skills, ${c.memory} memory)`,
  diffError: 'Could not load the diff',
  emptyBody: 'When Hermes proposes a skill or memory change, it shows up here to accept or reject.',
  emptyElsewhere: n => `Nothing for this profile. ${n} waiting in other profiles.`,
  emptyKind: kind => `Nothing under ${kind} for this profile.`,
  emptyTitle: 'No changes waiting',
  failed: reason => (endSentence(reason) ? `Change not applied: ${endSentence(reason)} It stays pending.` : 'Change not applied. It stays pending.'),
  gateOff: 'Writes are saved right away. Set skills.write_approval or memory.write_approval to true to review them first.',
  kindFilter: (label, n) => `${label} (${n})`,
  kindGroup: 'Kind of change',
  kind_all: 'All',
  kind_memory: 'Memory',
  kind_skills: 'Skills',
  loadError: 'Could not load pending changes',
  loading: 'Loading…',
  newEntry: 'New entry',
  newFile: 'New file',
  newPending: n => `${n} new change${n === 1 ? '' : 's'} to review`,
  backToList: 'Back to list',
  listTitle: 'Pending writes',
  paneTitle: 'Pending writes',
  reject: 'Reject',
  rejectBody: name => `The proposed change to ${name} is discarded. Hermes can propose it again.`,
  rejectError: 'Could not reject the change',
  rejectTitle: 'Reject this change?',
  rejected: name => `Rejected change to ${name}`,
  retry: 'Retry',
  review: 'Review',
  row_add: 'added line',
  row_context: 'unchanged line',
  row_remove: 'removed line',
  scopeAll: n => `All profiles (${n})`,
  scopeGroup: 'Profiles',
  scopeFocused: (profile, n) => `${profile} (${n})`,
  selectBody: 'Pick a change in the list to see its diff.',
  selectTitle: 'No change selected',
  showAll: 'Show all profiles',
  showEveryKind: 'Show all kinds'
}

messages.en = en
Object.assign(en, NOTIFY_EN, LIST_EN, EDIT_EN, SETTINGS_EN)
Object.assign(en, REMOVE_EN)
Object.assign(en, EXPAND_EN)

export default {
  id: ID,
  name: 'Skill Review',
  register(ctx) {
    CTX = ctx
    useRouteFallback = typeof host.openWorkspace !== 'function'
    ctx.i18n.register({ en })
    ctx.onDispose(() => {
      CTX = null
      unregisterPane?.()
      unregisterPane = null
    })

    loadNotifySettings(ctx)
    loadListSettings(ctx)
    loadEditorSettings(ctx)
    startWatcher(ctx)

    // No panes here: openReview registers both on demand (see reviewPaneContribution). A saved entry
    // for the old detail pane is never registered again, so Desktop collapses its zone.
    const contributions = [
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 110, render: () => jsx(StatusChip, {}) },
      {
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          keywords: ['skill', 'memory', 'review', 'pending', 'diff', 'approve'],
          label: 'Review pending skill and memory changes',
          run: () => openReview()
        },
        id: 'open'
      }
    ]

    if (useRouteFallback) {
      contributions.push({ id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(FallbackPage, {}) })
    }

    ctx.registerMany(contributions)
  }
}
