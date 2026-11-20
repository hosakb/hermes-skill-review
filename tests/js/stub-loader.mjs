// Resolves the three specifiers a desktop plugin may import to in-memory stubs.
const SDK_NAMES = ['Badge', 'Button', 'Codicon', 'ConfirmDialog', 'EmptyState', 'ErrorState', 'ScrollArea', 'Tip',
  'PALETTE_AREA', 'ROUTES_AREA', 'STATUSBAR_AREAS', 'haptic', 'host', 'relativeTime', 'useMutation',
  'usePluginI18n', 'useQuery', 'useQueryClient', 'useValue', 'queryClient']

const sdk = `
${SDK_NAMES.filter(n => !['PALETTE_AREA', 'ROUTES_AREA', 'STATUSBAR_AREAS', 'host', 'haptic', 'relativeTime', 'queryClient'].includes(n))
  .map(n => `export const ${n} = () => null`).join('\n')}
export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const haptic = () => {}
export const relativeTime = () => 'now'
export const host = globalThis.__host
export const queryClient = globalThis.__queryClient
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
