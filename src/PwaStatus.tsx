import { useEffect, useState } from 'react'

type InstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone() {
  return typeof window !== 'undefined' && (
    window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  )
}

/** Browser connectivity is separate from the app's server/sync health. */
export function PwaStatus({ locale }: { locale: 'en' | 'es' }) {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const [installed, setInstalled] = useState(isStandalone)
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installFailed, setInstallFailed] = useState(false)
  const es = locale === 'es'

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    const displayMode = window.matchMedia('(display-mode: standalone)')
    const updateInstalled = () => setInstalled(isStandalone())
    const onInstalled = () => { setInstalled(true); setInstallPrompt(null) }
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPrompt)
      setInstallFailed(false)
    }
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    displayMode.addEventListener('change', updateInstalled)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
      displayMode.removeEventListener('change', updateInstalled)
    }
  }, [])

  async function install() {
    if (!installPrompt) return
    setInstalling(true)
    setInstallFailed(false)
    try {
      await installPrompt.prompt()
      await installPrompt.userChoice
    } catch {
      setInstallFailed(true)
    } finally {
      setInstalling(false)
      setInstallPrompt(null)
    }
  }

  return <section aria-label={es ? 'Conexión e instalación' : 'Connection and installation'} className="card rounded-2xl border border-soft px-4 py-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" aria-live="polite" className="flex items-center gap-2">
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-700' : 'bg-warn'}`} />
        {online ? (es ? 'Dispositivo conectado' : 'Device online') : (es ? 'Dispositivo sin conexión' : 'Device offline')}
      </p>
      {installed && <span className="text-ink-muted">{es ? 'App instalada' : 'App installed'}</span>}
      {!installed && installPrompt && <button type="button" className="tap rounded-xl bg-ink px-4 text-paper" onClick={install} disabled={installing}>
        {installing ? (es ? 'Abriendo…' : 'Opening…') : (es ? 'Instalar app' : 'Install app')}
      </button>}
    </div>
    {!online && <p className="mt-1 text-ink-muted">{es ? 'Necesitas conexión para guardar y recibir actualizaciones.' : 'Saving and live updates need a connection.'}</p>}
    {installFailed && <p role="status" className="mt-1 text-warn">{es ? 'Usa el menú del navegador para instalar la app.' : 'Use your browser menu to install the app.'}</p>}
    {!installed && <details className="mt-2 text-ink-muted">
      <summary className="cursor-pointer py-1">{es ? 'Instalar en tu teléfono' : 'Install on your phone'}</summary>
      <p className="mt-2">{es
        ? 'iPhone o iPad: abre esta página en Safari, toca Compartir y luego Agregar a inicio.'
        : 'iPhone or iPad: open this page in Safari, tap Share, then Add to Home Screen.'}</p>
      <p className="mt-2">{es
        ? 'Android: abre esta página en Chrome y elige Instalar app o Agregar a pantalla principal en el menú.'
        : 'Android: open this page in Chrome and choose Install app or Add to Home screen from the menu.'}</p>
    </details>}
  </section>
}
