// Resolves the three specifiers a desktop plugin may import to in-memory stubs.
const SDK_NAMES = ['Badge', 'Button', 'Codicon', 'ConfirmDialog', 'EmptyState', 'ErrorState', 'ScrollArea', 'Tip',
  'PALETTE_AREA', 'ROUTES_AREA', 'STATUSBAR_AREAS', 'haptic', 'host', 'relativeTime', 'useMutation',
  'usePluginI18n', 'useQuery', 'useQueryClient', 'useValue', 'queryClient', 'atom',
  'SegmentedControl', 'ContextMenu', 'ContextMenuCheckboxItem', 'ContextMenuContent', 'ContextMenuTrigger',
  'Checkbox', 'Popover', 'PopoverContent', 'PopoverTrigger', 'Select', 'SelectContent', 'SelectItem', 'SelectTrigger',
  'SelectValue', 'Skeleton', 'Input', 'Textarea', 'ListRow', 'ToggleRow']

const sdk = `
${SDK_NAMES.filter(n => !['PALETTE_AREA', 'ROUTES_AREA', 'STATUSBAR_AREAS', 'host', 'haptic', 'relativeTime', 'queryClient', 'atom'].includes(n))
  .map(n => `export const ${n} = () => null`).join('\n')}
export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const haptic = () => {}
// Same output as pluginSettingsHref in apps/desktop/src/contrib/settings-pages.ts.
export const pluginSettingsHref = (plugin, page) => {
  const params = new URLSearchParams({ tab: 'plugins' })
  if (plugin) { params.set('plugin', plugin); if (page) params.set('ppage', page) }
  return "/settings?" + params
}
export const relativeTime = () => 'now'
export const host = globalThis.__host
export const queryClient = globalThis.__queryClient
// A minimal nanostores-compatible atom, so module-level selection state behaves for real.
export const atom = initial => {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set: next => { value = next; listeners.forEach(fn => fn(value)) },
    listen: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    subscribe: fn => { listeners.add(fn); fn(value); return () => listeners.delete(fn) }
  }
}
`
const react = `export const useState = v => [v, () => {}]; export const useEffect = () => {}`
const runtime = `export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx`

const STUBS = { '@hermes/plugin-sdk': sdk, react, 'react/jsx-runtime': runtime }

export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: `stub:${specifier}`, shortCircuit: true }
  if (/^[a-z@]/i.test(specifier) && !specifier.startsWith('node:') && !specifier.startsWith('file:')) {
    throw new Error(`unsupported import: ${specifier}`) // same rule as the desktop loader
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith('stub:')) return { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true }
  if (url.endsWith('/desktop/plugin.js')) return next(url, { ...context, format: 'module' })
  return next(url, context)
}
