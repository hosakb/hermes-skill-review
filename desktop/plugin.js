/**
 * Skill Review: Hermes Desktop half.
 *
 * Shows every skill write that Hermes staged under skills.write_approval as a visual diff, with Accept
 * and Reject buttons. It opens a review tab by itself when a new pending write appears, and shows a
 * count in the status bar. The backend is dashboard/plugin_api.py (/api/plugins/skill-review).
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls. Only @hermes/plugin-sdk, react and
 * react/jsx-runtime resolve. Layout and colour use inline styles with theme variables only, because
 * a disk plugin's utility classes are not part of the app's compiled stylesheet.
 */

import {
  Badge,
  Button,
  Codicon,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  haptic,
  host,
  PALETTE_AREA,
  relativeTime,
  ROUTES_AREA,
  ScrollArea,
  STATUSBAR_AREAS,
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
const TITLE = 'Skill review'

let CTX = null
let closeTab = null

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for the node tests)
// ---------------------------------------------------------------------------------------------

export const itemKey = item => `${item.profile}/${item.id}`

/** Keys that were not announced before, and the announced set to keep (pruned to what is still pending). */
export function planAutoOpen(items, announced) {
  const known = new Set(announced)
  const current = items.map(itemKey)
  const fresh = current.filter(key => !known.has(key))
  const keep = current.filter(key => known.has(key) || fresh.includes(key))

  return { fresh, keep }
}

export function visibleItems(items, scope, focused) {
  return scope === 'all' ? items : items.filter(item => item.profile === focused)
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
  const name = result?.item?.skill || ''

  switch (result?.status) {
    case 'applied':
      return { kind: 'success', message: t('accepted', name) }
    case 'rejected':
      return { kind: 'info', message: t('rejected', name) }
    case 'already_handled':
      return { kind: 'info', message: t('alreadyHandled') }
    default:
      return { kind: 'error', message: t('failed', result?.error || '') }
  }
}

// ---------------------------------------------------------------------------------------------
// Styles (theme variables only)
// ---------------------------------------------------------------------------------------------

const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

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

const gutter = {
  color: 'var(--ui-text-quaternary)',
  flex: 'none',
  minWidth: '3.25ch',
  padding: '0 0.5ch',
  textAlign: 'right',
  userSelect: 'none'
}

// ---------------------------------------------------------------------------------------------
// Diff view
// ---------------------------------------------------------------------------------------------

function DiffRow({ row, t }) {
  if (row.kind === 'file') {
    return jsxs('div', {
      style: {
        alignItems: 'center',
        background: 'var(--ui-bg-tertiary)',
        color: 'var(--ui-text-primary)',
        display: 'flex',
        fontFamily: mono,
        fontSize: '0.75rem',
        fontWeight: 600,
        gap: '0.5rem',
        padding: '0.35rem 0.75rem'
      },
      children: [jsx(Codicon, { name: 'file' }), row.text]
    })
  }

  if (row.kind === 'hunk') {
    return jsx('div', {
      style: {
        background: 'var(--ui-bg-quaternary)',
        color: 'var(--ui-text-tertiary)',
        fontFamily: mono,
        fontSize: '0.7rem',
        padding: '0.15rem 0.75rem'
      },
      children: row.text
    })
  }

  if (row.kind === 'note') {
    return jsx('div', {
      style: {
        color: 'var(--ui-text-tertiary)',
        fontFamily: mono,
        fontSize: '0.75rem',
        padding: '0.35rem 0.75rem',
        whiteSpace: 'pre-wrap'
      },
      children: row.text
    })
  }

  return jsxs('div', {
    'aria-label': t(`row_${row.kind}`),
    style: {
      ...ROW_TONE[row.kind],
      display: 'flex',
      fontFamily: mono,
      fontSize: '0.75rem',
      lineHeight: 1.55,
      whiteSpace: 'pre'
    },
    children: [
      jsx('span', { style: gutter, children: row.oldNo ?? '' }),
      jsx('span', { style: gutter, children: row.newNo ?? '' }),
      jsx('span', { style: { flex: 'none', width: '2ch' }, children: SIGN[row.kind] }),
      jsx('span', { children: row.text || ' ' })
    ]
  })
}

function DiffView({ sections, newFileLabel, t }) {
  return jsx('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
    children: sections.map((section, index) => {
      const rows = parseSection(section)
      const lead = section.kind === 'create' ? [{ kind: 'file', text: newFileLabel }] : []

      return jsxs(
        'div',
        {
          children: [
            section.title
              ? jsx('div', {
                  style: {
                    color: 'var(--ui-text-secondary)',
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    marginBottom: '0.25rem'
                  },
                  children: section.title
                })
              : null,
            jsx('div', {
              style: {
                background: 'var(--ui-editor-surface-background)',
                border: '1px solid var(--ui-stroke-secondary)',
                borderRadius: '6px',
                overflowX: 'auto'
              },
              children: jsx('div', {
                style: { minWidth: 'max-content', padding: '0 0 0.25rem' },
                children: [...lead, ...rows].map((row, i) => jsx(DiffRow, { row, t }, i))
              })
            })
          ]
        },
        index
      )
    })
  })
}

// ---------------------------------------------------------------------------------------------
// One pending item
// ---------------------------------------------------------------------------------------------

function ItemCard({ item, open, onToggle }) {
  const t = usePluginI18n(ID)
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  const diff = useQuery({
    enabled: open,
    queryFn: () => CTX.rest(`/pending/${encodeURIComponent(item.profile)}/${encodeURIComponent(item.id)}/diff`),
    queryKey: [ID, 'diff', item.profile, item.id],
    refetchOnWindowFocus: false,
    staleTime: Infinity
  })

  const resolve = useMutation({
    mutationFn: verb =>
      CTX.rest(`/pending/${encodeURIComponent(item.profile)}/${encodeURIComponent(item.id)}/${verb}`, {
        method: 'POST'
      }).then(result => ({ result, verb })),
    onError: (error, verb) => host.notifyError(error, t(verb === 'accept' ? 'acceptError' : 'rejectError')),
    onSuccess: ({ result, verb }) => {
      host.notify(resultToast(verb, result, t))
      queryClient.invalidateQueries({ queryKey: [ID, 'pending'] })
    }
  })

  const busy = resolve.isPending
  const gone = diff.data?.status === 'already_handled'

  useEffect(() => {
    if (gone) {
      queryClient.invalidateQueries({ queryKey: [ID, 'pending'] })
    }
  }, [gone, queryClient])

  return jsxs('section', {
    style: {
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '8px',
      margin: '0 0.75rem 0.75rem'
    },
    children: [
      jsxs('header', {
        style: {
          alignItems: 'center',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          padding: '0.5rem 0.75rem'
        },
        children: [
          jsxs('button', {
            'aria-expanded': open,
            onClick: onToggle,
            style: {
              alignItems: 'center',
              background: 'none',
              border: 0,
              color: 'var(--ui-text-primary)',
              cursor: 'pointer',
              display: 'flex',
              flex: '1 1 12rem',
              gap: '0.4rem',
              minWidth: 0,
              padding: 0,
              textAlign: 'left'
            },
            type: 'button',
            children: [
              jsx(Codicon, { name: open ? 'chevron-down' : 'chevron-right' }),
              jsx('span', {
                style: { fontSize: '0.875rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' },
                children: item.skill
              }),
              jsx(Badge, { variant: 'muted', children: t(`action_${item.action}`) }),
              jsx(Badge, { variant: 'outline', children: item.profile }),
              item.origin === 'background_review'
                ? jsx(Tip, { label: t('autoTip'), children: jsx(Badge, { variant: 'muted', children: t('auto') }) })
                : null
            ]
          }),
          jsx('span', {
            style: { color: 'var(--ui-text-tertiary)', fontSize: '0.7rem' },
            children: relativeTime(item.created_at * 1000)
          }),
          jsx(Button, {
            disabled: busy,
            onClick: () => {
              haptic('tap')
              resolve.mutate('accept')
            },
            size: 'sm',
            type: 'button',
            children: t('accept')
          }),
          jsx(Button, {
            disabled: busy,
            onClick: () => setConfirming(true),
            size: 'sm',
            type: 'button',
            variant: 'outline',
            children: t('reject')
          })
        ]
      }),
      item.summary
        ? jsx('div', {
            style: { color: 'var(--ui-text-tertiary)', fontSize: '0.75rem', padding: '0 0.75rem 0.5rem 2rem' },
            children: item.summary
          })
        : null,
      open
        ? jsx('div', {
            style: { padding: '0 0.75rem 0.75rem' },
            children: diff.isError
              ? jsx(ErrorState, { description: String(diff.error?.message || ''), title: t('diffError') })
              : diff.isLoading
                ? jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: '0.75rem' }, children: t('loading') })
                : gone
                  ? jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: '0.75rem' }, children: t('alreadyHandled') })
                  : jsx(DiffView, { newFileLabel: t('newFile'), sections: diff.data?.sections ?? [], t })
          })
        : null,
      jsx(ConfirmDialog, {
        confirmLabel: t('reject'),
        description: t('rejectBody', item.skill),
        destructive: true,
        dismissOnConfirm: true,
        onClose: () => setConfirming(false),
        onConfirm: () => resolve.mutateAsync('reject'),
        open: confirming,
        title: t('rejectTitle')
      })
    ]
  })
}

// ---------------------------------------------------------------------------------------------
// Data hook, pane, status chip
// ---------------------------------------------------------------------------------------------

function usePending() {
  const profile = useValue(host.state.profile)

  return useQuery({
    queryFn: () => CTX.rest('/pending'),
    queryKey: [ID, 'pending', profile],
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true
  })
}

function ReviewPane() {
  const t = usePluginI18n(ID)
  const { data, error, isError, isLoading, refetch } = usePending()
  const focused = useValue(host.state.focusedSessionProfile) || 'default'
  const [scope, setScope] = useState(null)
  const [openKeys, setOpenKeys] = useState({})

  const items = data?.items ?? []
  const focusedCount = visibleItems(items, 'focused', focused).length
  const effective = scope ?? (focusedCount > 0 ? 'focused' : 'all')
  const shown = visibleItems(items, effective, focused)
  const gateOn = (data?.profiles ?? []).some(p => p.gate)
  const missing = isError && /404/.test(String(error?.message || ''))

  const isOpen = (item, index) => openKeys[itemKey(item)] ?? (index === 0 && shown.length === 1)

  const header = jsxs('div', {
    style: {
      alignItems: 'center',
      borderBottom: '1px solid var(--ui-stroke-secondary)',
      display: 'flex',
      flexWrap: 'wrap',
      gap: '0.5rem',
      padding: '0.5rem 0.75rem'
    },
    children: [
      jsx('span', { style: { fontSize: '0.875rem', fontWeight: 600 }, children: t('paneTitle') }),
      items.length ? jsx(Badge, { variant: 'warn', children: items.length }) : null,
      jsx('span', { style: { flex: 1 } }),
      jsx(Button, {
        onClick: () => setScope('focused'),
        size: 'xs',
        type: 'button',
        variant: effective === 'focused' ? 'chip' : 'ghost',
        children: t('scopeFocused', focused, focusedCount)
      }),
      jsx(Button, {
        onClick: () => setScope('all'),
        size: 'xs',
        type: 'button',
        variant: effective === 'all' ? 'chip' : 'ghost',
        children: t('scopeAll', items.length)
      })
    ]
  })

  let body

  if (missing) {
    body = jsx(ErrorState, { description: t('backendMissing'), title: t('loadError') })
  } else if (isError) {
    body = jsx(ErrorState, {
      children: jsx(Button, { onClick: () => refetch(), size: 'sm', type: 'button', variant: 'outline', children: t('retry') }),
      description: String(error?.message || ''),
      title: t('loadError')
    })
  } else if (isLoading) {
    body = jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: '0.75rem', padding: '1rem' }, children: t('loading') })
  } else if (!shown.length) {
    body = jsxs('div', {
      children: [
        jsx(EmptyState, {
          description: items.length ? t('emptyElsewhere', items.length) : gateOn ? t('emptyBody') : t('gateOff'),
          title: t('emptyTitle')
        }),
        items.length && effective === 'focused'
          ? jsx('div', {
              style: { display: 'flex', justifyContent: 'center' },
              children: jsx(Button, {
                onClick: () => setScope('all'),
                size: 'sm',
                type: 'button',
                variant: 'outline',
                children: t('showAll')
              })
            })
          : null
      ]
    })
  } else {
    body = jsx('div', {
      style: { paddingTop: '0.75rem' },
      children: shown.map((item, index) =>
        jsx(
          ItemCard,
          {
            item,
            onToggle: () => setOpenKeys(prev => ({ ...prev, [itemKey(item)]: !isOpen(item, index) })),
            open: isOpen(item, index)
          },
          itemKey(item)
        )
      )
    })
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    children: [header, jsx(ScrollArea, { style: { flex: 1, minHeight: 0 }, children: body })]
  })
}

export function openReview() {
  if (typeof host.openWorkspace === 'function') {
    // Re-calling with the same id refreshes the tab in place and brings it to the front.
    closeTab = host.openWorkspace(`${ID}:review`, {
      onClose: () => {
        closeTab = null
      },
      render: () => jsx(ReviewPane, {}),
      title: TITLE
    })

    return
  }

  host.navigate(ROUTE)
}

function readAnnounced() {
  try {
    const value = CTX.storage.get('announced', [])

    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function StatusChip() {
  const t = usePluginI18n(ID)
  const { data, isError } = usePending()
  const items = data?.items

  // Opens the review tab once per new pending write. Keys already announced (and still pending) never
  // reopen it, and the announced set survives restarts through plugin storage.
  useEffect(() => {
    if (!items) {
      return
    }

    const { fresh, keep } = planAutoOpen(items, readAnnounced())

    CTX.storage.set('announced', keep)

    if (fresh.length) {
      openReview()
      host.notify({ kind: 'info', message: t('newPending', fresh.length) })
    }
  }, [items])

  if (isError || !items || !items.length) {
    return null
  }

  return jsx(Tip, {
    label: t('chipTip', items.length),
    children: jsxs('button', {
      onClick: () => {
        haptic('tap')
        openReview()
      },
      style: {
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
      type: 'button',
      children: [jsx(Codicon, { name: 'git-pull-request' }), t('chipLabel'), jsx(Badge, { size: 'xs', variant: 'warn', children: items.length })]
    })
  })
}

// ---------------------------------------------------------------------------------------------

const en = {
  accept: 'Accept',
  acceptError: 'Could not accept the skill change',
  accepted: name => `Accepted change to ${name}`,
  action_batch: 'batch',
  action_create: 'new skill',
  action_delete: 'delete',
  action_edit: 'rewrite',
  action_patch: 'patch',
  action_remove_file: 'remove file',
  action_unknown: 'change',
  action_write_file: 'write file',
  alreadyHandled: 'Already handled, for example from chat.',
  auto: 'auto',
  autoTip: 'Proposed by the background review, not a chat turn',
  backendMissing:
    'The review backend is not running. Add skill-review to plugins.enabled in config.yaml and restart the gateway.',
  chipLabel: 'Skill review',
  chipTip: n => `${n} skill change${n === 1 ? '' : 's'} waiting for review`,
  diffError: 'Could not load the diff',
  emptyBody: 'When Hermes proposes a skill change, it shows up here to accept or reject.',
  emptyElsewhere: n => `Nothing for this profile. ${n} waiting in other profiles.`,
  emptyTitle: 'No skill changes waiting',
  failed: reason => `Change not applied${reason ? `: ${reason}` : ''}. It stays pending.`,
  gateOff: 'Skill writes are saved right away. Set skills.write_approval to true to review them first.',
  loadError: 'Could not load skill changes',
  loading: 'Loading…',
  newFile: 'New file',
  newPending: n => `${n} new skill change${n === 1 ? '' : 's'} to review`,
  paneTitle: 'Skill review',
  reject: 'Reject',
  rejectBody: name => `The proposed change to ${name} is discarded. Hermes can propose it again.`,
  rejectError: 'Could not reject the skill change',
  rejectTitle: 'Reject this change?',
  rejected: name => `Rejected change to ${name}`,
  retry: 'Retry',
  row_add: 'added line',
  row_context: 'unchanged line',
  row_remove: 'removed line',
  scopeAll: n => `All profiles (${n})`,
  scopeFocused: (profile, n) => `${profile} (${n})`,
  showAll: 'Show all profiles'
}

export default {
  id: ID,
  name: 'Skill Review',
  register(ctx) {
    CTX = ctx
    ctx.i18n.register({ en })
    ctx.onDispose(() => {
      if (closeTab) {
        closeTab()
      }

      closeTab = null
      CTX = null
    })

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(ReviewPane, {}) },
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 110, render: () => jsx(StatusChip, {}) },
      {
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          keywords: ['skill', 'review', 'pending', 'diff', 'approve'],
          label: 'Review pending skill changes',
          run: openReview
        },
        id: 'open'
      }
    ])
  }
}
