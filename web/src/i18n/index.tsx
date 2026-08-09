import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { translateText, type Locale } from './messages'

const STORAGE_KEY = 'ai-gateway.locale'

function initialLocale(): Locale {
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === 'en' || stored === 'zh-CN') return stored
  return window.navigator.languages.some((language) => language.toLowerCase().startsWith('zh'))
    ? 'zh-CN'
    : 'en'
}

let activeLocale = initialLocale()

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(activeLocale)
  activeLocale = locale

  const setLocale = (nextLocale: Locale) => {
    window.localStorage.setItem(STORAGE_KEY, nextLocale)
    activeLocale = nextLocale
    setLocaleState(nextLocale)
  }

  useEffect(() => {
    document.documentElement.lang = locale
    document.title =
      locale === 'zh-CN' ? 'AI Server 控制台 — Fiber Gateway' : 'AI Server Console — Fiber Gateway'
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    if (description) {
      description.content =
        locale === 'zh-CN'
          ? 'Fiber Gateway ai-server 的管理、配置发布与运行状态控制台。'
          : 'Management, configuration publishing, and runtime status console for Fiber Gateway ai-server.'
    }
  }, [locale])

  const value = useMemo(() => ({ locale, setLocale }), [locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside I18nProvider')
  return value
}

export function currentLocale(): Locale {
  return activeLocale
}

export function localize(value: string): string {
  return translateText(value, activeLocale)
}

export function confirmLocalized(message: string): boolean {
  return window.confirm(localize(message))
}

export function localizeNode(value: ReactNode): ReactNode {
  if (typeof value === 'string') return localize(value)
  if (Array.isArray(value)) return value.map(localizeNode)
  return value
}

export function formatDateTime(value: Date | string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(activeLocale, options).format(
    typeof value === 'string' ? new Date(value) : value,
  )
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat(activeLocale).format(value)
}
