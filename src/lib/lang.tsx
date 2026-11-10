import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { LANG_STORAGE, t as translate, type Locale } from './i18n'

type LangCtx = {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const Ctx = createContext<LangCtx | null>(null)

function readStored(): Locale {
  try {
    return localStorage.getItem(LANG_STORAGE) === 'es' ? 'es' : 'en'
  } catch {
    return 'en'
  }
}

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStored)

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try { localStorage.setItem(LANG_STORAGE, l) } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale === 'es' ? 'es' : 'en'
  }, [locale])

  const t = useCallback((key: string, params?: Record<string, string | number>) => translate(locale, key, params), [locale])

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useLang() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useLang outside LangProvider')
  return ctx
}
