import { Fragment, jsxDEV as reactJsxDEV, type JSX } from 'react/jsx-dev-runtime'

import { localizeJsxProps } from './jsx-runtime'

export { Fragment }

export function jsxDEV(
  type: Parameters<typeof reactJsxDEV>[0],
  props: Record<string, unknown> | null,
  key: Parameters<typeof reactJsxDEV>[2],
  isStaticChildren: Parameters<typeof reactJsxDEV>[3],
  source: Parameters<typeof reactJsxDEV>[4],
  self: Parameters<typeof reactJsxDEV>[5],
): JSX.Element {
  return reactJsxDEV(type, localizeJsxProps(props), key, isStaticChildren, source, self)
}
