import { Languages } from 'lucide-react'

import { useI18n } from '../i18n'

export function LanguageSwitcher({ dark = false }: { dark?: boolean }) {
  const { locale, setLocale } = useI18n()
  return (
    <div
      className={`language-switcher${dark ? ' language-switcher-dark' : ''}`}
      role="group"
      aria-label="切换语言"
      title={locale === 'zh-CN' ? '当前语言：中文' : '当前语言：英文'}
    >
      <Languages size={14} aria-hidden="true" />
      <button
        type="button"
        lang="zh-CN"
        className={locale === 'zh-CN' ? 'active' : ''}
        aria-pressed={locale === 'zh-CN'}
        onClick={() => setLocale('zh-CN')}
      >
        中
      </button>
      <i aria-hidden="true" />
      <button
        type="button"
        lang="en"
        className={locale === 'en' ? 'active' : ''}
        aria-pressed={locale === 'en'}
        onClick={() => setLocale('en')}
      >
        EN
      </button>
    </div>
  )
}
