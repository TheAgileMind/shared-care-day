/// <reference types="vite/client" />
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { LangProvider, useLang } from './lib/lang'
import { PwaStatus } from './PwaStatus'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // An install/update failure must not interrupt the live app or reload a draft.
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {})
  })
}

function Shell() {
  const { locale } = useLang()
  return <>
    <div className="mx-auto max-w-3xl px-4 pt-4"><PwaStatus locale={locale} /></div>
    <App />
  </>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LangProvider>
      <Shell />
    </LangProvider>
  </StrictMode>,
)
