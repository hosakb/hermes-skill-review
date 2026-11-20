/**
 * Skill Review: Hermes Desktop half.
 *
 * Shows every skill and memory write that Hermes staged under skills.write_approval and
 * memory.write_approval. Two panes split the workspace's right edge: a list of every pending write,
 * and beside it the diff of the selected one with Accept and Reject. A new pending write is announced
 * by a toast and the status-bar count; nothing takes over the main view.
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
  PALETTE_AREA,
  queryClient,
  relativeTime,
  ROUTES_AREA,
  SegmentedControl,
  STATUSBAR_AREAS,
  Tip,
  useMutation,
  usePluginI18n,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'skill-review'
const ROUTE = '/skill-review'
const POLL_MS = 3000

export const LIST_PANE = `${ID}:list`
export const DETAIL_PANE = `${ID}:detail`

let CTX = null
let useRouteFallback = false

/** UI state shared by both panes. Module-level atoms, so a pane remount (drag, tab switch, reload of
 *  the layout) keeps the selection and filters. */
export const $selection = atom(null)
const $scope = atom(null) // null: follow the focused profile while it has items, else all
const $kind = atom('all')
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

// ---------------------------------------------------------------------------------------------
// Diff view (pure components: props in, tree out)
// ---------------------------------------------------------------------------------------------

export function DiffRow({ row, t }) {
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
      jsx('span', { style: STYLES.rowText, children: row.text || ' ' })
    ]
  })
}

export function DiffView({ sections, newFileLabel, t }) {
  return jsx('div', {
    style: STYLES.sections,
    children: sections.map((section, index) => {
      const lead = section.kind === 'create' ? [{ kind: 'file', text: newFileLabel }] : []
      const rows = [...lead, ...parseSection(section)]

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

function FilterButton({ active, label, onClick }) {
  return jsx(Button, {
    'aria-pressed': active,
    onClick,
    size: 'xs',
    type: 'button',
    variant: active ? 'chip' : 'ghost',
    children: label
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

/** Route page for desktops without the pane APIs: both panes side by side in one page. */
function FallbackPage() {
  return jsxs('div', {
    style: { display: 'flex', height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' },
    children: [
      jsx('div', { style: { borderRight: '1px solid var(--ui-stroke-secondary)', flex: '0 0 300px', minHeight: 0, minWidth: 0 }, children: jsx(FilesListPane, {}) }),
      jsx('div', { style: { flex: '1 1 auto', minHeight: 0, minWidth: 0 }, children: jsx(FileDetailPane, {}) })
    ]
  })
}

// ---------------------------------------------------------------------------------------------
// File view: the list shows each (profile, file) once; the detail shows one composite diff of that
// file, its current text as grey context with every pending change drawn where it applies, and an
// Accept and Reject per change. Backend contract v1:
//   GET  /files?kind=all                                         list of files
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

  return [
    ...(block.removed ?? []).map(line => ({ kind: 'remove', oldNo: line.no, text: line.text })),
    ...(block.added ?? []).map(line => ({ kind: 'add', newNo: line.no, text: line.text }))
  ]
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

export function BlockView({ block, isNew, busy, onAccept, onReject, t }) {
  const stale = block.state === 'stale'
  const tone = stale ? FILE_STYLES.blockStale : isNew ? FILE_STYLES.blockNew : FILE_STYLES.blockOlder

  const head = jsxs('div', {
    style: FILE_STYLES.blockHead,
    children: [
      jsx(Badge, { size: 'xs', variant: isNew ? 'default' : 'muted', children: t(isNew ? 'new' : 'older') }),
      jsx('span', { style: STYLES.muted, children: isNew ? relativeTime(block.staged_at * 1000) : t('staged', formatStaged(block.staged_at)) }),
      jsx(Badge, { size: 'xs', variant: 'outline', children: originLabel(block.origin, t) }),
      stale ? jsx(Badge, { size: 'xs', variant: 'muted', children: t('stale') }) : null,
      block.state === 'conflict' ? jsx(Badge, { size: 'xs', variant: 'warn', children: t('conflict') }) : null,
      jsx('span', { style: FILE_STYLES.blockSummary, children: block.summary || '' }),
      canAcceptBlock(block)
        ? jsx(Button, { disabled: busy, onClick: onAccept, size: 'xs', type: 'button', children: t('accept') })
        : null,
      jsx(Button, { disabled: busy, onClick: onReject, size: 'xs', type: 'button', variant: 'outline', children: t('reject') })
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
      block.state === 'conflict' ? jsx('div', { style: FILE_STYLES.blockNote, children: t('conflictAbove') }) : null,
      stale && block.reason ? jsx('div', { style: FILE_STYLES.blockNote, children: t('staleReason', block.reason) }) : null,
      ...segmentRows({ type: 'block', block }).map((row, i) => jsx(DiffRow, { row, t }, i))
    ]
  })
}

export function FileDiffView({ segments, prior, busy, onBlock, t }) {
  return jsx('div', {
    style: STYLES.diffBox,
    children: segments.map((segment, index) => {
      if (segment.type === 'block') {
        const block = segment.block

        return jsx(
          BlockView,
          {
            block,
            busy,
            isNew: isNewBlock(block, prior),
            onAccept: () => onBlock({ blockId: block.id, verb: 'accept' }),
            onReject: () => onBlock({ blockId: block.id, verb: 'reject' }),
            t
          },
          block.id
        )
      }

      return jsx('div', { style: FILE_STYLES.context, children: segmentRows(segment).map((row, i) => jsx(DiffRow, { row, t }, i)) }, `c${index}`)
    })
  })
}

export function FileHeader({ file, acceptable, busy, onAcceptAll, onRejectAll, t }) {
  const c = file.counts ?? {}

  const row = jsxs('header', {
    style: STYLES.header,
    children: [
      jsx('span', { style: FILE_STYLES.fileTitle, children: file.file }),
      jsx(Button, { disabled: busy || !acceptable, onClick: onAcceptAll, size: 'sm', type: 'button', children: t('acceptAll') }),
      jsx(Button, { disabled: busy, onClick: onRejectAll, size: 'sm', type: 'button', variant: 'outline', children: t('rejectAll') }),
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
export function FileDetailView({ file, data, loading, error, prior, busy, confirmOpen, onAction, onAskRejectAll, onCloseConfirm, t }) {
  const shownFile = data?.status === 'ok' && data.file ? data.file : file
  const segments = data?.status === 'ok' ? data.segments ?? [] : []
  const blockList = segments.filter(s => s.type === 'block').map(s => s.block)

  const body = error
    ? jsx(ErrorState, { description: String(error?.message || ''), title: t('diffError') })
    : loading
      ? jsx('div', { style: STYLES.muted, children: t('loading') })
      : data?.status === 'gone'
        ? jsx('div', { style: STYLES.muted, children: t('fileGone') })
        : jsx(FileDiffView, { busy, onBlock: onAction, prior, segments, t })

  return jsxs('div', {
    style: STYLES.paneRoot,
    children: [
      jsx(FileHeader, {
        acceptable: blockList.filter(canAcceptBlock).length,
        busy,
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

function useFiles() {
  const profile = useValue(host.state.profile)

  return useQuery({
    queryFn: () => CTX.rest(filesPath()),
    queryKey: filesKey(profile),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true
  })
}

/** Files the list shows, with the same profile scope and kind filter as before. */
function useVisibleFiles() {
  const query = useFiles()
  const focused = useValue(host.state.focusedSessionProfile) || 'default'
  const scope = useValue($scope)
  const kind = useValue($kind)
  const files = query.data?.files ?? []
  const focusedCount = visibleItems(files, 'focused', focused).length
  const effective = scope ?? (focusedCount > 0 ? 'focused' : 'all')
  const inScope = visibleItems(files, effective, focused)

  return {
    ...query,
    effective,
    files,
    focused,
    focusedCount,
    inScope,
    kind,
    kindCounts: countBySubsystem(inScope),
    profileErrors: query.data?.profile_errors ?? [],
    shown: visibleItems(files, effective, focused, kind)
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
      jsxs('div', {
        'aria-label': t('scopeGroup'),
        role: 'group',
        style: STYLES.barRow,
        children: [
          jsx(FilterButton, { active: v.effective === 'focused', label: t('scopeFocused', v.focused, v.focusedCount), onClick: () => $scope.set('focused') }),
          jsx(FilterButton, { active: v.effective === 'all', label: t('scopeAll', v.files.length), onClick: () => $scope.set('all') })
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
    const description = v.inScope.length
      ? t('emptyKind', t(`kind_${v.kind}`))
      : v.files.length
        ? t('emptyElsewhere', v.files.length)
        : gateOn
          ? t('emptyBody')
          : t('gateOff')

    body = jsx(EmptyState, { description, title: t('emptyTitle') })
  } else {
    body = jsx(FileList, { files: v.shown, lastOpened: CTX ? readOpened(CTX.storage) : {}, onSelect: key => $selection.set(key), selection, t })
  }

  return jsxs('div', {
    style: STYLES.paneRoot,
    children: [bar, jsx('div', { style: STYLES.listScroll, children: body })]
  })
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

  const diff = useQuery({
    queryFn: () => CTX.rest(fileDiffPath(file)),
    queryKey: diffKey(file),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: false
  })

  useEffect(() => {
    handleDiffData(diff.data, queryClient, file)
  }, [diff.data, queryClient])

  const act = useMutation({
    mutationFn: action => performAction({ action, file, queryClient, rest: (path, opts) => CTX.rest(path, opts), t }),
    onError: (error, action) => host.notifyError(error, t(action.verb.startsWith('accept') ? 'acceptError' : 'rejectError'))
  })

  const confirmId = `reject-all:${key}`

  return jsx(FileDetailView, {
    busy: act.isPending,
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
    onAskRejectAll: () => $confirming.set(confirmId),
    onCloseConfirm: () => $confirming.set(null),
    prior,
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
// Reveal, watcher, status chip
// ---------------------------------------------------------------------------------------------

/** Show both panes (bringing back a closed one) and optionally select an item. Never opens a
 *  main-workspace tab. Desktops without the pane APIs get the route page instead. */
export function openReview(key) {
  if (key) {
    $selection.set(key)
  }

  markSeen()

  if (useRouteFallback || typeof host.openWorkspace !== 'function') {
    host.navigate(ROUTE)

    return
  }

  for (const pane of [LIST_PANE, DETAIL_PANE]) {
    if (typeof host.undismissPane === 'function') {
      host.undismissPane(pane)
    }

    if (typeof host.revealPane === 'function') {
      host.revealPane(pane)
    }
  }
}

/**
 * Announce each new pending write once with a toast whose action reveals it. Keys already announced
 * (and still pending) are never announced again; the set survives restarts through plugin storage.
 * Returns the number of new items.
 */
export function announce(ctx, items) {
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

  if (fresh.length && $notifyMode.get() === 'popup') {
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
  const tick = () => {
    const profile = host.state.profile?.get?.() ?? null

    return queryClient
      .fetchQuery({ queryFn: fetchPending, queryKey: pendingKey(profile), staleTime: POLL_MS - 500 })
      .then(data => {
        if (listPaneVisible()) {
          markSeen() // the user is looking at the list: nothing in it is unseen
        }

        const fresh = announce(ctx, data?.items)

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

  $notifyMode.set(NOTIFY_MODES.includes(mode) ? mode : 'popup')
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

/** The list pane header's control. Its own component, so list-pane changes stay apart from it. */
function NotifyModeControl() {
  const t = usePluginI18n(ID)
  const mode = useValue($notifyMode)

  // Desktops without paneVisibility: the list mounting is the best sign the user opened it.
  useEffect(() => {
    if (typeof host.paneVisibility !== 'function') {
      markSeen()
    }
  }, [])

  return jsx(NotifyModeSwitch, { mode, onChange: setNotifyMode, t })
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
      jsx(Badge, { size: 'xs', variant: 'warn', children: count })
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
  const items = data?.items

  if (isError || !items || !items.length) {
    return null
  }

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
  failed: reason => `Change not applied${reason ? `: ${reason}` : ''}. It stays pending.`,
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
  detailTitle: 'Change',
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
Object.assign(en, NOTIFY_EN)

export default {
  id: ID,
  name: 'Skill Review',
  register(ctx) {
    CTX = ctx
    useRouteFallback = typeof host.openWorkspace !== 'function'
    ctx.i18n.register({ en })
    ctx.onDispose(() => {
      CTX = null
    })

    loadNotifySettings(ctx)
    startWatcher(ctx)

    const contributions = [
      {
        id: 'list',
        area: 'panes',
        title: en.listTitle,
        // Its own tiling column on the workspace's right edge, like Bots' Routines pane. 'right'
        // placement is the collapsible right sidebar's role, so this docks explicitly instead.
        data: { placement: 'main', dock: { pane: 'workspace', pos: 'right' }, width: '300px', minWidth: '240px' },
        render: () => jsx(FilesListPane, {})
      },
      {
        id: 'detail',
        area: 'panes',
        title: en.detailTitle,
        // A second column immediately right of the list, not a tab stacked on it.
        data: { placement: 'main', dock: { pane: LIST_PANE, pos: 'right' }, width: '560px', minWidth: '320px' },
        render: () => jsx(FileDetailPane, {})
      },
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
