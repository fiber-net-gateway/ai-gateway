import { Fragment, jsx as reactJsx, jsxs as reactJsxs, type JSX } from 'react/jsx-runtime'

import { localize, localizeNode } from './index'

export { Fragment }

// Centralizing the translation boundary keeps user-facing copy consistent across the existing
// component tree, including JSX text, placeholders, titles, and accessible labels.
const localizableProps = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'children',
  'label',
  'placeholder',
  'title',
])

export function localizeJsxProps(
  props: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!props) return props
  let localized: Record<string, unknown> | undefined

  for (const property of localizableProps) {
    const value = props[property]
    const next = property === 'children' ? localizeNode(value as never) : localizeProp(value)
    if (next === value) continue
    localized ??= { ...props }
    localized[property] = next
  }

  return localized ?? props
}

function localizeProp(value: unknown): unknown {
  return typeof value === 'string' ? localize(value) : value
}

export function jsx(
  type: Parameters<typeof reactJsx>[0],
  props: Record<string, unknown> | null,
  key?: string,
): JSX.Element {
  return reactJsx(type, localizeJsxProps(props), key)
}

export function jsxs(
  type: Parameters<typeof reactJsxs>[0],
  props: Record<string, unknown> | null,
  key?: string,
): JSX.Element {
  return reactJsxs(type, localizeJsxProps(props), key)
}
