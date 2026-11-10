import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BabyProfile, CareEvent, DayState, HistoryResponse, ParentId } from './lib/types'
import { profileFromConfig, EXAMPLE_CONFIG } from './lib/config'
import { api, AuthError } from './lib/api'
import { resolveZone, zonedDate, zonedHour, zonedLocal } from './lib/clock'
import { ProfileSettings } from './ProfileSettings'
import { buildDay } from './lib/schedule/engine'
import { format } from 'date-fns'
import { es, enUS } from 'date-fns/locale'
import { initialsAvatar } from './lib/avatar'
import {
  BOTTLE_CHIPS,
  BREAST_CHIPS,
  DEFAULT_FEED_DRAFT,
  FEED_MAX_MINUTES,
  FEED_MAX_OZ,
  FEED_MIN_MINUTES,
  FEED_MIN_OZ,
  FEED_OZ_STEP,
  dayHasProbiotic,
  draftFromMeta,
  formatEventLabel,
  formatOz,
  metaFromDraft,
  type BreastSide,
  type FeedDraft,
} from './lib/feed'
import { translateError, type Locale } from './lib/i18n'
import { useLang } from './lib/lang'
import { displayTranscript, parseCareSpeech, type DraftEvent } from './lib/voiceParse'


type Session = { parentId: ParentId; email: string; name: string; persistentStorage?: boolean }
type DrawerKind = null | 'log' | 'feed' | 'truewake' | 'edit' | 'voice'
const DAYS_BACKUP = 'shared-care-day-backup'

async function apiAuth(email: string, pin: string) {
  return api<{ ok: true; email: string; name: string; parentId: ParentId; persistentStorage?: boolean }>('/api/auth', {
    method: 'POST', body: JSON.stringify({ email, pin }),
  })
}
async function apiMe() {
  return api<{ ok: true; email: string; name: string; parentId: ParentId; persistentStorage?: boolean }>('/api/me')
}
async function apiLogout() {
  try { await api('/api/logout', { method: 'POST' }) } catch {}
}
async function apiDay(): Promise<DayState> { return api('/api/day') }
async function apiHistory(): Promise<HistoryResponse> { return api('/api/history') }
async function apiEvent(type: string, meta?: CareEvent['meta'], at?: string) {
  const data = await api<{ day: DayState }>('/api/event', {
    method: 'POST', body: JSON.stringify({ type, meta, at }),
  })
  return data.day
}
async function apiPatchEvent(id: string, patch: { at?: string; meta?: CareEvent['meta'] }) {
  const data = await api<{ day: DayState }>('/api/event/' + id, {
    method: 'PATCH', body: JSON.stringify(patch),
  })
  return data.day
}
async function apiDeleteEvent(id: string) {
  const data = await api<{ day: DayState }>('/api/event/' + id, { method: 'DELETE' })
  return data.day
}

function readDayBackups(): DayState[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DAYS_BACKUP) || '[]') as DayState[]
    return Array.isArray(parsed) ? parsed.filter((d) => d?.date && Array.isArray(d.events)) : []
  } catch {
    return []
  }
}

function upsertDayBackup(day: DayState | null | undefined) {
  if (!day?.date || !day.events?.length) return
  const next = readDayBackups().filter((d) => d.date !== day.date)
  next.push(day)
  next.sort((a, b) => a.date.localeCompare(b.date))
  try { localStorage.setItem(DAYS_BACKUP, JSON.stringify(next.slice(-14))) } catch { /* quota */ }
}

let restoreTried = false

async function restoreMissing(server: DayState): Promise<DayState> {
  if (server.events.length > 0) upsertDayBackup(server)
  if (restoreTried) return server
  const backups = readDayBackups()
  if (!backups.length) return server
  restoreTried = true
  try {
    const res = await api<{ day: DayState }>('/api/restore', {
      method: 'PUT', body: JSON.stringify({ days: backups }),
    })
    if (res.day?.events?.length) upsertDayBackup(res.day)
    return res.day || server
  } catch {
    return server
  }
}

function toTimeInput(d: Date) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
function fromTimeInput(timeStr: string, base = new Date()) {
  const [h, m] = timeStr.split(':').map(Number)
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d
}
function fmtMin(m: number, locale: Locale) {
  const h = Math.floor(m / 60)
  const min = m % 60
  const unit = locale === 'es' ? ' min' : 'm'
  if (h <= 0) return `${min}${unit}`
  return min ? `${h}h ${min}${unit}` : `${h}h`
}
function prettyDate(dateStr: string, locale: Locale) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  return format(new Date(y, mo - 1, d), locale === 'es' ? 'EEE d MMM' : 'EEE, MMM d', { locale: locale === 'es' ? es : enUS })
}
function fmtTime(d: Date, locale: Locale) {
  return format(d, 'h:mm a', { locale: locale === 'es' ? es : enUS })
}

type Recog = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean; length: number }> }) => void) | null
  onerror: ((ev: { error: string }) => void) | null
  onend: (() => void) | null
}

function makeRec(): Recog | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recog; webkitSpeechRecognition?: new () => Recog }
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition
  return Ctor ? new Ctor() : null
}

export default function App() {
  const { locale, t } = useLang()
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [day, setDay] = useState<DayState | null>(null)
  const [profile, setProfile] = useState<BabyProfile | null>(null)
  const [profileError, setProfileError] = useState(false)
  const [apiConnected, setApiConnected] = useState(false)
  const [lastSync, setLastSync] = useState(0)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [drawer, setDrawer] = useState<DrawerKind>(null)
  const [logType, setLogType] = useState<CareEvent['type']>('wake')
  const [manualTime, setManualTime] = useState('')
  const [useManual, setUseManual] = useState(false)
  const [editEvent, setEditEvent] = useState<CareEvent | null>(null)
  const [editTime, setEditTime] = useState('')
  const [feedDraft, setFeedDraft] = useState<FeedDraft>(DEFAULT_FEED_DRAFT)
  const [syncing, setSyncing] = useState(false)
  const [tab, setTab] = useState<'now' | 'schedule' | 'history'>('now')
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [heard, setHeard] = useState('')
  const [typed, setTyped] = useState('')
  const [voiceDrafts, setVoiceDrafts] = useState<DraftEvent[]>([])
  const [voiceError, setVoiceError] = useState('')
  const recRef = useRef<Recog | null>(null)
  const finalRef = useRef('')
  const interimRef = useRef('')
  const handledRef = useRef(false)

  const signOut = useCallback(async () => {
    await apiLogout()
    setSession(null)
    setDay(null)
    setHistory(null)
    setProfile(null)
    setApiConnected(false)
    setSaveError('')
  }, [])

  useEffect(() => {
    let cancelled = false
    apiMe()
      .then((s) => { if (!cancelled) setSession({ parentId: s.parentId, email: s.email, name: s.name, persistentStorage: s.persistentStorage }) })
      .catch(() => { if (!cancelled) setSession(null) })
      .finally(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => { const tmr = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(tmr) }, [])

  const refresh = useCallback(async () => {
    try {
      setSyncing(true)
      setDay(await restoreMissing(await apiDay()))
      setApiConnected(true)
      setLastSync(Date.now())
      try {
        setProfile(await api<BabyProfile>('/api/profile'))
        setProfileError(false)
      } catch (e) {
        if (e instanceof AuthError) throw e
        setProfileError(true)
      }
    } catch (e) {
      if (e instanceof AuthError) { await signOut(); return }
      setApiConnected(false)
    } finally { setSyncing(false) }
  }, [signOut])

  const refreshHistory = useCallback(async () => {
    try { setHistory(await apiHistory()) }
    catch (e) {
      if (e instanceof AuthError) { await signOut(); return }
      console.error(e)
    }
  }, [signOut])

  useEffect(() => {
    if (!session) return
    refresh()
    const tmr = setInterval(refresh, 4000)
    return () => clearInterval(tmr)
  }, [session, refresh])

  useEffect(() => { upsertDayBackup(day ?? undefined) }, [day])

  useEffect(() => {
    const y = history?.yesterday
    if (y?.events?.length) upsertDayBackup({ date: y.date, events: y.events, previousDaySleepMin: undefined })
  }, [history])

  useEffect(() => {
    if (!session || tab !== 'history') return
    refreshHistory()
    const tmr = setInterval(refreshHistory, 15000)
    return () => clearInterval(tmr)
  }, [session, tab, refreshHistory])

  // Household zone from the server profile (config.json / APP_TIMEZONE), else the browser's zone.
  const zone = resolveZone(profile?.timezone)
  const state = useMemo(() => day ? buildDay(
    day.date === zonedDate(now, zone) ? now : zonedLocal(day.date, '12:00', zone),
    day.events, profile ?? { ...profileFromConfig(EXAMPLE_CONFIG), timezone: zone }, day.previousDaySleepMin
  ) : null, [now, day, profile, zone])
  const localHour = zonedHour(now, zone)
  const isNight = localHour >= 20 || localHour < 6
  const probioticToday = !!day && dayHasProbiotic(day.events)
  const poopCountToday = day?.events.filter((event) => event.type === 'diaper').length || 0
  const shared = apiConnected && now.getTime() - lastSync < 30_000

  async function saveChange(operation: () => Promise<DayState>, done: () => void) {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    try { setDay(await operation()); done() }
    catch (e) {
      if (e instanceof AuthError) await signOut()
      else { setSaveError(t('save.failed')); setApiConnected(false) }
    } finally { savingRef.current = false; setSaving(false) }
  }

  async function saveProfile(next: BabyProfile) {
    try {
      const saved = await api<BabyProfile>('/api/profile', { method: 'PUT', body: JSON.stringify(next) })
      setProfile(saved)
      setProfileError(false)
    } catch (e) {
      if (e instanceof AuthError) await signOut()
      throw e
    }
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault(); setError('')
    try {
      const res = await apiAuth(email, pin)
      setPin('')
      setSession({ parentId: res.parentId, email: res.email, name: res.name, persistentStorage: res.persistentStorage })
    } catch (err: unknown) { setError(translateError(locale, err instanceof Error ? err.message : '')) }
  }

  function openLog(type: CareEvent['type']) {
    if (savingRef.current) return
    setLogType(type); setUseManual(false); setManualTime(toTimeInput(now))
    if (type === 'feed') {
      setFeedDraft(DEFAULT_FEED_DRAFT)
      setDrawer('feed')
    } else if (type === 'nap_end') setDrawer('truewake')
    else setDrawer('log')
  }

  async function submitLog(meta?: CareEvent['meta']) {
    if (!session) return
    const at = useManual ? fromTimeInput(manualTime) : new Date()
    await saveChange(() => apiEvent(logType, meta, at.toISOString()), () => setDrawer(null))
  }

  function openEdit(eventId: string) {
    if (savingRef.current) return
    if (!day) return
    const ev = day.events.find(e => e.id === eventId)
    if (!ev) return
    setEditEvent(ev)
    setEditTime(toTimeInput(new Date(ev.at)))
    if (ev.type === 'feed') setFeedDraft(draftFromMeta(ev.meta))
    setDrawer('edit')
  }

  async function saveEdit() {
    if (!session || !editEvent) return
    const at = fromTimeInput(editTime, new Date(editEvent.at))
    const patch: { at: string; meta?: CareEvent['meta'] } = { at: at.toISOString() }
    if (editEvent.type === 'feed') patch.meta = metaFromDraft(feedDraft)
    await saveChange(() => apiPatchEvent(editEvent.id, patch), () => { setDrawer(null); setEditEvent(null) })
  }

  async function deleteEdit() {
    if (!session || !editEvent) return
    if (!confirm(t('edit.confirmDelete'))) return
    await saveChange(() => apiDeleteEvent(editEvent.id), () => { setDrawer(null); setEditEvent(null) })
  }

  function applyTranscript(text: string) {
    if (savingRef.current) return
    const cleaned = text.trim()
    setHeard(cleaned ? displayTranscript(cleaned) || cleaned : '')
    setVoiceDrafts(cleaned ? parseCareSpeech(cleaned, new Date(), zone) : [])
    setVoiceError('')
    setDrawer('voice')
  }

  function finishListen(text: string) {
    if (handledRef.current) return
    handledRef.current = true
    setListening(false)
    applyTranscript(text)
  }

  function stopListen() {
    try { recRef.current?.stop() } catch { /* ignore */ }
    finishListen((finalRef.current + ' ' + interimRef.current).trim())
  }

  function startListen() {
    if (savingRef.current) return
    setVoiceError('')
    setInterim('')
    setHeard('')
    setTyped('')
    finalRef.current = ''
    interimRef.current = ''
    handledRef.current = false
    const rec = makeRec()
    if (!rec) {
      setVoiceError(t('voice.unsupported'))
      setDrawer('voice')
      return
    }
    rec.lang = locale === 'es' ? 'es-US' : 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (ev) => {
      let fin = ''
      let mid = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const row = ev.results[i]
        const piece = row[0]?.transcript || ''
        if (row.isFinal) fin += piece + ' '
        else mid += piece + ' '
      }
      if (fin) finalRef.current = (finalRef.current + ' ' + fin).trim()
      const shown = (finalRef.current + ' ' + mid).trim()
      interimRef.current = mid.trim()
      setInterim(shown)
    }
    rec.onerror = (ev) => {
      setListening(false)
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        setVoiceError(t('voice.micDenied'))
        setDrawer('voice')
      }
    }
    rec.onend = () => {
      finishListen((finalRef.current + ' ' + interimRef.current).trim())
    }
    recRef.current = rec
    try {
      rec.start()
      setListening(true)
    } catch {
      setVoiceError(t('voice.unsupported'))
      setDrawer('voice')
    }
  }

  async function saveVoice() {
    if (!session || voiceDrafts.length === 0 || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    let saved = 0
    try {
      for (const d of voiceDrafts) {
        setDay(await apiEvent(d.type, d.meta, d.at.toISOString()))
        saved++
        setVoiceDrafts(remaining => remaining.slice(1))
      }
      setDrawer(null)
      setVoiceDrafts([])
      setHeard('')
    } catch (e) {
      if (e instanceof AuthError) await signOut()
      else { setSaveError(t(saved ? 'save.partial' : 'save.failed')); setApiConnected(false) }
    } finally { savingRef.current = false; setSaving(false) }
  }

  if (checking) {
    return <div className="min-h-full flex items-center justify-center text-[var(--color-ink-muted)]">{t('app.loading')}</div>
  }

  if (!session) {
    return (
      <div className={'min-h-full flex flex-col ' + (isNight ? 'night' : '')}>
        <div className="flex justify-end px-4 pt-4"><LangSwitch /></div>
        <div className="h-56 bg-gradient-to-br from-[#c4a484] via-[#e8d8c4] to-[var(--color-paper)] relative">
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--color-paper)] via-transparent to-transparent" />
        </div>
        <div className="px-6 -mt-8 relative z-10 flex-1">
          <p className="text-xs tracking-[0.2em] uppercase text-[var(--color-ink-muted)] mb-2">{t('app.title')}</p>
          <h1 className="font-display text-3xl font-semibold mb-2">{t('app.tagline')}</h1>
          <p className="text-[var(--color-ink-muted)] text-sm leading-relaxed mb-8">{t('app.loginBody')}</p>
          <form onSubmit={signIn} className="space-y-3">
            <input type="email" placeholder={t('app.email')} value={email} onChange={e => setEmail(e.target.value)}
              className="w-full rounded-2xl border border-[var(--color-soft)] bg-white px-4 py-3.5 text-base outline-none" autoComplete="email" required />
            <input type="password" placeholder={t('app.pin')} value={pin} onChange={e => setPin(e.target.value)}
              className="w-full rounded-2xl border border-[var(--color-soft)] bg-white px-4 py-3.5 text-base outline-none" autoComplete="current-password" required />
            {error && <p className="text-sm text-[var(--color-warn)]">{error}</p>}
            <button type="submit" className="w-full rounded-2xl bg-[var(--color-ink)] text-white py-3.5 font-medium tap">{t('app.signIn')}</button>
          </form>
          <p className="text-center text-xs text-[var(--color-ink-muted)] mt-6">{t('app.privateTo')}</p>
        </div>
      </div>
    )
  }

  if (!state || !day) {
    return <div className="min-h-full px-4 pt-4 text-[var(--color-ink-muted)]"><p>{t('app.loadingDay')}</p><p role="status">{t('app.disconnected')}</p><button className="tap underline" onClick={refresh}>{t('app.retry')}</button><button className="tap ml-4 underline" onClick={signOut}>{t('app.signOut')}</button></div>
  }

  const schedule = (state as ReturnType<typeof buildDay>).schedule || []
  const nowLabel = state.nextAction.copy ? t(state.nextAction.copy.key, state.nextAction.copy.params) : state.nextAction.label

  return (
    <div className={'min-h-full flex flex-col ' + (isNight ? 'night' : '')}>
      <header className="flex items-center gap-3 px-4 pt-4 pb-2">
        <img src={initialsAvatar(profile?.name || t('app.title'))} alt="" className="w-11 h-11 rounded-full object-cover border-2 border-white shadow" />
        <div className="flex-1 min-w-0">
          <p className="font-display font-semibold text-lg leading-tight">{profile?.name || t('app.title')}</p>
          <p className="text-xs text-[var(--color-ink-muted)]">
            {session.name} · {fmtTime(now, locale)} <span className="opacity-60">{syncing ? t('app.syncing') : shared ? t('app.shared') : t('app.disconnected')}</span>
          </p>
        </div>
        <LangSwitch />
        <button onClick={signOut} className="text-xs text-[var(--color-ink-muted)] px-2 py-1">{t('app.signOut')}</button>
      </header>
      {!shared && <p role="status" className="mx-4 mt-2 text-sm text-[var(--color-warn)]">{t('app.disconnected')}</p>}
      {saveError && <p role="alert" className="mx-4 mt-2 text-sm text-[var(--color-warn)]">{saveError}</p>}
      {profileError && <p role="alert" className="mx-4 mt-2 text-sm text-[var(--color-warn)]">{t('profile.unavailable')}</p>}
      {profile && <ProfileSettings profile={profile} asOf={day.date} onSave={saveProfile} />}

      {session.persistentStorage === false && (
        <div className="mx-4 mt-2 rounded-2xl bg-[var(--color-warn)]/15 border border-[var(--color-warn)]/40 px-4 py-3">
          <p className="text-sm">{t('app.storageWarn')}</p>
        </div>
      )}

      <div className="mx-4 mt-2 flex gap-1 p-1 rounded-2xl bg-[var(--color-soft)]/50">
        <button className={'flex-1 py-2 rounded-xl text-sm font-medium ' + (tab === 'now' ? 'bg-white shadow-sm' : 'text-[var(--color-ink-muted)]')} onClick={() => setTab('now')}>{t('tab.now')}</button>
        <button className={'flex-1 py-2 rounded-xl text-sm font-medium ' + (tab === 'schedule' ? 'bg-white shadow-sm' : 'text-[var(--color-ink-muted)]')} onClick={() => setTab('schedule')}>{t('tab.schedule')}</button>
        <button className={'flex-1 py-2 rounded-xl text-sm font-medium ' + (tab === 'history' ? 'bg-white shadow-sm' : 'text-[var(--color-ink-muted)]')} onClick={() => setTab('history')}>{t('tab.history')}</button>
      </div>

      {state.shouldWake && (
        <div className="mx-4 mt-2 rounded-2xl bg-[var(--color-warn)]/15 border border-[var(--color-warn)]/40 px-4 py-3">
          <p className="font-medium text-sm">{t('wake.shouldI')}</p>
          <p className="text-sm mt-0.5">{state.shouldWake.copy ? t(state.shouldWake.copy.key, state.shouldWake.copy.params) : state.shouldWake.reason}</p>
          <button onClick={() => openLog('wake')} className="mt-2 text-sm font-semibold underline">{t('wake.log')}</button>
        </div>
      )}

      {tab === 'now' && (
        <>
          <section className="mx-4 mt-3 card rounded-3xl border border-[var(--color-soft)] bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)] mb-1">{t('now.title')}</p>
            <p className="font-display text-2xl font-semibold leading-snug">{nowLabel}</p>
            {state.guidance.map((g, i) => <p key={i} className="text-sm text-[var(--color-ink-muted)] mt-2">{t(g.key, g.params)}</p>)}
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-4 text-xs text-[var(--color-ink-muted)]">
              <span>{t('now.awake', { n: state.awakeMin })}</span><span>·</span>
              {state.schedulePlan && <><span>{t('now.ww', { short: state.wakeWindowMin.short, long: state.wakeWindowMin.long })}</span><span>·</span></>}
              <span>{t('now.daySleep', { n: state.daySleepMin })}</span><span>·</span>
              <span>{t('now.feeds', { n: state.feedCount })}</span><span>·</span>
              <span>{t('now.poops', { n: poopCountToday })}</span>
            </div>
            <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
              {probioticToday ? t('now.probioticYes') : t('now.probioticNo')}
            </p>
          </section>

          <section className="mx-4 mt-4 grid grid-cols-2 gap-2">
            <Btn label={t('btn.wake')} onClick={() => openLog('wake')} />
            <Btn label={t('btn.feed')} onClick={() => openLog('feed')} />
            <Btn label={state.status === 'asleep' ? t('btn.endNap') : t('btn.startNap')} onClick={() => openLog(state.status === 'asleep' ? 'nap_end' : 'nap_start')} />
            <Btn label={t('btn.poop')} onClick={() => openLog('diaper')} />
            <Btn label={t('btn.tummy')} onClick={() => openLog('tummy')} className="col-span-2" />
          </section>

          <section className="mx-4 mt-6 mb-36">
            <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)] mb-2">{t('log.heading')}</p>
            <ul className="space-y-1">
              {day.events.length === 0 && <li className="text-sm text-[var(--color-ink-muted)]">{t('log.empty')}</li>}
              {[...day.events].reverse().map(ev => (
                <li key={ev.id}>
                  <button className="w-full flex items-baseline gap-3 text-sm py-2 text-left active:bg-[var(--color-soft)]/40 rounded-xl px-1" onClick={() => openEdit(ev.id)}>
                    <span className="w-16 tabular-nums text-[var(--color-ink-muted)] shrink-0">{fmtTime(new Date(ev.at), locale)}</span>
                    <span className="flex-1 min-w-0">{formatEventLabel(ev, locale)}</span>
                    <span className="text-xs text-[var(--color-ink-muted)] shrink-0">{ev.by}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {tab === 'schedule' && (
        <section className="mx-4 mt-3 mb-36">
          <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)] mb-2">{t('sched.heading')}</p>
          <p className="text-sm text-[var(--color-ink-muted)] mb-4">{t('sched.hint')}</p>
          {state.schedulePlan && <p className="text-sm text-[var(--color-ink-muted)] mb-4">{t('sched.range', { short: state.schedulePlan.window.short, long: state.schedulePlan.window.long, naps: state.schedulePlan.napCount ?? t('profile.flexible') })}{state.schedulePlan.sourceUrl && <> <a className="underline" href={state.schedulePlan.sourceUrl} target="_blank" rel="noreferrer">{t('sched.source')}</a></>}</p>}
          <ul className="space-y-1">
            {schedule.map((row, i) => {
              const ev = row.eventId ? day.events.find(e => e.id === row.eventId) : undefined
              const label = ev ? formatEventLabel(ev, locale) : row.copy ? t(row.copy.key, row.copy.params) : row.label
              return (
                <li key={i} className={'flex items-baseline gap-3 text-sm py-1.5 ' + (row.predicted ? 'opacity-50 italic' : '')}>
                  <span className="w-16 tabular-nums text-[var(--color-ink-muted)] shrink-0">{fmtTime(row.time, locale)}</span>
                  <span className="flex-1">{label}</span>
                  {row.by && <span className="text-xs text-[var(--color-ink-muted)]">{row.by}</span>}
                  {row.eventId && <button className="text-xs underline text-[var(--color-ink-muted)]" onClick={() => openEdit(row.eventId!)}>{t('common.edit')}</button>}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {tab === 'history' && (
        <HistoryPanel history={history} />
      )}

      {listening && (
        <div className="fixed inset-x-4 bottom-28 z-40 rounded-3xl bg-[var(--color-ink)] text-white px-5 py-4 shadow-lg">
          <p className="text-xs uppercase tracking-wider opacity-70">{t('voice.listening')}</p>
          <p className="mt-1 text-sm min-h-10">{interim || t('voice.saySomething')}</p>
          <button className="mt-3 w-full rounded-2xl bg-white text-[var(--color-ink)] py-3 font-medium tap" onClick={stopListen}>{t('voice.stop')}</button>
        </div>
      )}

      <div className="fixed z-40 left-1/2 -translate-x-1/2 bottom-4 flex flex-col items-center">
        <span className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">{t('voice.listen')}</span>
        <button
          type="button"
          className={'mic-fab w-16 h-16 rounded-full tap shadow-lg flex items-center justify-center ' + (listening ? 'listening' : '')}
          disabled={saving}
          onClick={() => listening ? stopListen() : startListen()}
          aria-label={t('voice.listen')}
        >
          <MicIcon />
        </button>
      </div>

      {drawer === 'log' && (
        <Drawer busy={saving} error={saveError} title={t('common.log', { type: t('event.' + logType) })} onClose={() => setDrawer(null)}>
          <div className="space-y-3">
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={useManual} onChange={e => setUseManual(e.target.checked)} />
              {t('common.pastTime')}
            </label>
            {useManual && <input type="time" value={manualTime} onChange={e => setManualTime(e.target.value)} className="w-full rounded-2xl border border-[var(--color-soft)] bg-white px-4 py-3 text-base" />}
            <button className="w-full rounded-2xl bg-[var(--color-ink)] text-white py-3.5" onClick={() => submitLog()}>{useManual ? t('common.saveTime') : t('common.logNow')}</button>
          </div>
        </Drawer>
      )}

      {drawer === 'feed' && (
        <Drawer busy={saving} error={saveError}
          title={t('feed.title')}
          onClose={() => setDrawer(null)}
          footer={(
            <div className="space-y-3">
              <label className="flex items-center gap-3 text-sm min-h-11">
                <input type="checkbox" checked={useManual} onChange={e => setUseManual(e.target.checked)} />
                {t('common.pastTime')}
              </label>
              {useManual && <input type="time" value={manualTime} onChange={e => setManualTime(e.target.value)} className="w-full rounded-2xl border border-[var(--color-soft)] bg-white px-4 py-3 text-base" />}
              <button className="w-full rounded-2xl bg-[var(--color-ink)] text-white py-3.5 font-medium tap" onClick={() => submitLog(metaFromDraft(feedDraft))}>
                {useManual ? t('feed.save') : t('feed.log')}
              </button>
            </div>
          )}
        >
          <FeedFields draft={feedDraft} onChange={setFeedDraft} />
        </Drawer>
      )}

      {drawer === 'truewake' && (
        <Drawer busy={saving} error={saveError} title={t('nap.endTitle')} onClose={() => setDrawer(null)}>
          <div className="space-y-3">
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={useManual} onChange={e => setUseManual(e.target.checked)} />
              {t('common.pastTime')}
            </label>
            {useManual && <input type="time" value={manualTime} onChange={e => setManualTime(e.target.value)} className="w-full rounded-2xl border border-[var(--color-soft)] bg-white px-4 py-3 text-base" />}
            <button className="w-full rounded-2xl bg-[var(--color-ink)] text-white py-3.5" onClick={() => { setLogType('nap_end'); submitLog() }}>{t('nap.wasAsleep')}</button>
            <button className="w-full rounded-2xl border border-[var(--color-soft)] py-3.5" onClick={() => { setLogType('nap_end'); submitLog({ trueWake: new Date(Date.now() - 15 * 60000).toISOString() }) }}>{t('nap.trueWake')}</button>
          </div>
        </Drawer>
      )}

      {drawer === 'edit' && editEvent && (
        <Drawer busy={saving} error={saveError} title={t('edit.title', { type: t('event.' + editEvent.type) })} onClose={() => { setDrawer(null); setEditEvent(null) }}>
          <div className="space-y-3">
            {editEvent.type === 'feed' && <FeedFields draft={feedDraft} onChange={setFeedDraft} />}
            <label className="text-sm text-[var(--color-ink-muted)]">{t('common.time')}</label>
            <input type="time" value={editTime} onChange={e => setEditTime(e.target.value)} className="w-full rounded-2xl border border-[var(--color-soft)] bg-white px-4 py-3 text-base" />
            <button className="w-full rounded-2xl bg-[var(--color-ink)] text-white py-3.5 tap" onClick={saveEdit}>{t('common.save')}</button>
            <button className="w-full rounded-2xl border border-red-300 text-red-700 py-3.5 tap" onClick={deleteEdit}>{t('common.delete')}</button>
          </div>
        </Drawer>
      )}

      {drawer === 'voice' && (
        <Drawer busy={saving} error={saveError}
          title={t('voice.review')}
          onClose={() => { setDrawer(null); setVoiceDrafts([]) }}
          footer={(
            <div className="space-y-2">
              <button
                className="w-full rounded-2xl bg-[var(--color-ink)] text-white py-3.5 font-medium tap disabled:opacity-40"
                disabled={voiceDrafts.length === 0 || saving}
                onClick={saveVoice}
              >
                {t('voice.saveAll')}
              </button>
              <button className="w-full rounded-2xl border border-[var(--color-soft)] py-3 tap" onClick={() => { setDrawer(null); startListen() }}>{t('voice.again')}</button>
            </div>
          )}
        >
          <VoiceReview
            heard={heard}
            voiceError={voiceError}
            voiceDrafts={voiceDrafts}
            typed={typed}
            setTyped={setTyped}
            onParse={() => { if (typed.trim()) applyTranscript(typed) }}
          />
        </Drawer>
      )}
    </div>
  )
}

function VoiceReview({
  heard, voiceError, voiceDrafts, typed, setTyped, onParse,
}: {
  heard: string
  voiceError: string
  voiceDrafts: DraftEvent[]
  typed: string
  setTyped: (s: string) => void
  onParse: () => void
}) {
  const { locale, t } = useLang()
  const typeBox = (
    <label className="block">
      <span className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">{t('voice.type')}</span>
      <textarea
        value={typed}
        onChange={e => setTyped(e.target.value)}
        placeholder={t('voice.typePlaceholder')}
        rows={3}
        className="mt-1.5 w-full rounded-2xl border border-[var(--color-soft)] bg-white px-4 py-3 text-base outline-none"
      />
      <button type="button" className="mt-2 rounded-2xl border border-[var(--color-soft)] px-4 py-2.5 text-sm tap" onClick={onParse}>
        {t('voice.parse')}
      </button>
    </label>
  )

  return (
    <div className="space-y-4">
      {voiceError && <p className="text-sm text-[var(--color-warn)]">{voiceError}</p>}
      {heard && (
        <div>
          <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">{t('voice.heard')}</p>
          <p className="text-sm italic mt-1">“{heard}”</p>
        </div>
      )}
      {voiceDrafts.length === 0 ? (
        <>
          <div>
            <p className="text-sm">{t('voice.nothing')}</p>
            <p className="text-sm text-[var(--color-ink-muted)] mt-1">{t('voice.hint')}</p>
          </div>
          {typeBox}
        </>
      ) : (
        <>
          <ul className="space-y-2">
            {voiceDrafts.map((d, i) => (
              <li key={i} className="rounded-2xl border border-[var(--color-soft)] bg-white px-4 py-3">
                <p className="text-xs tabular-nums text-[var(--color-ink-muted)]">{fmtTime(d.at, locale)}</p>
                <p className="font-medium">{formatEventLabel({ type: d.type, meta: d.meta }, locale)}</p>
              </li>
            ))}
          </ul>
          {typeBox}
        </>
      )}
    </div>
  )
}

function HistoryPanel({ history }: { history: HistoryResponse | null }) {
  const { locale, t } = useLang()
  if (!history) {
    return <div className="mx-4 mt-6 mb-36 text-sm text-[var(--color-ink-muted)]">{t('hist.loading')}</div>
  }
  const y = history.yesterday
  const weekSleep = history.days.reduce((n, d) => n + d.sleepMin, 0)
  const weekFeeds = history.days.reduce((n, d) => n + d.feedCount, 0)
  const weekNaps = history.days.reduce((n, d) => n + d.napCount, 0)
  const weekPoops = history.days.reduce((n, d) => n + d.poopCount, 0)

  return (
    <section className="mx-4 mt-3 mb-36">
      <div className="card rounded-3xl border border-[var(--color-soft)] bg-white p-5 shadow-sm">
        <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)] mb-1">{t('hist.yesterday')}</p>
        <p className="font-display text-2xl font-semibold leading-snug">{y ? prettyDate(y.date, locale) : t('hist.yesterday')}</p>
        {y && y.summary.hasData ? (
          <>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-sm text-[var(--color-ink-muted)]">
              <span>{t('hist.sleep', { n: fmtMin(y.summary.sleepMin, locale) })}</span><span>·</span>
              <span>{t('hist.naps', { n: y.summary.napCount })}</span><span>·</span>
              <span>{t('hist.feeds', { n: y.summary.feedCount })}</span><span>·</span>
              <span>{t('hist.poops', { n: y.summary.poopCount })}</span>
            </div>
            <ul className="mt-4 space-y-1">
              {y.events.length === 0 && <li className="text-sm text-[var(--color-ink-muted)]">{t('hist.emptyDay')}</li>}
              {y.events.map(ev => (
                <li key={ev.id} className="flex items-baseline gap-3 text-sm py-1">
                  <span className="w-16 tabular-nums text-[var(--color-ink-muted)] shrink-0">{fmtTime(new Date(ev.at), locale)}</span>
                  <span className="flex-1 min-w-0">{formatEventLabel(ev, locale)}</span>
                  <span className="text-xs text-[var(--color-ink-muted)] shrink-0">{ev.by}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-[var(--color-ink-muted)] mt-2">{t('hist.none')}</p>
        )}
      </div>

      <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)] mt-6 mb-2">{t('hist.week')}</p>
      <p className="text-sm text-[var(--color-ink-muted)] mb-3">
        {t('hist.weekSummary', { sleep: fmtMin(weekSleep, locale), naps: weekNaps, feeds: weekFeeds, poops: weekPoops })}
      </p>
      <ul className="space-y-1">
        {[...history.days].reverse().map(d => (
          <li key={d.date} className="flex items-baseline gap-3 text-sm py-2 border-b border-[var(--color-soft)]/70 last:border-0">
            <span className="w-24 shrink-0">{prettyDate(d.date, locale)}</span>
            {d.hasData ? (
              <span className="flex-1 text-[var(--color-ink-muted)]">
                {t('hist.daySummary', { sleep: fmtMin(d.sleepMin, locale), naps: d.napCount, feeds: d.feedCount, poops: d.poopCount })}
              </span>
            ) : (
              <span className="flex-1 text-[var(--color-ink-muted)]">{t('hist.noLog')}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function FeedFields({ draft, onChange }: { draft: FeedDraft; onChange: (next: FeedDraft) => void }) {
  const { t } = useLang()
  const set = (patch: Partial<FeedDraft>) => onChange({ ...draft, ...patch })
  const sides: { id: BreastSide; label: string }[] = [
    { id: 'L', label: t('feed.left') },
    { id: 'R', label: t('feed.right') },
    { id: 'both', label: t('feed.both') },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-[var(--color-soft)]/60">
        {(['breast', 'bottle'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={'rounded-xl py-2.5 text-sm font-medium tap ' + (draft.mode === mode ? 'bg-white shadow-sm' : 'text-[var(--color-ink-muted)]')}
            onClick={() => set({ mode })}
          >
            {mode === 'breast' ? t('feed.breast') : t('feed.bottle')}
          </button>
        ))}
      </div>

      {draft.mode === 'breast' ? (
        <>
          <div>
            <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)] mb-2">{t('feed.side')}</p>
            <div className="grid grid-cols-3 gap-2">
              {sides.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={'rounded-2xl py-3 text-sm font-medium tap border ' + (draft.side === s.id
                    ? 'bg-[var(--color-ink)] text-white border-transparent'
                    : 'bg-white border-[var(--color-soft)]')}
                  onClick={() => set({ side: s.id })}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <Scale
            label={t('feed.duration')}
            value={draft.minutes}
            min={FEED_MIN_MINUTES}
            max={FEED_MAX_MINUTES}
            step={1}
            display={t('feed.minUnit', { n: draft.minutes })}
            chips={BREAST_CHIPS}
            chipLabel={(n) => `${n}`}
            onChange={(minutes) => set({ minutes })}
          />
        </>
      ) : (
        <Scale
          label={t('feed.volume')}
          value={draft.ounces}
          min={FEED_MIN_OZ}
          max={FEED_MAX_OZ}
          step={FEED_OZ_STEP}
          display={t('feed.ozUnit', { n: formatOz(draft.ounces) })}
          chips={BOTTLE_CHIPS}
          chipLabel={(n) => formatOz(n)}
          onChange={(ounces) => set({ ounces })}
        />
      )}

      <button
        type="button"
        className={'w-full flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left tap ' + (draft.probiotic
          ? 'border-[var(--color-ink)] bg-white'
          : 'border-[var(--color-soft)] bg-white')}
        onClick={() => set({ probiotic: !draft.probiotic })}
        aria-pressed={draft.probiotic}
      >
        <span
          className={'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ' + (draft.probiotic
            ? 'bg-[var(--color-ink)] border-[var(--color-ink)] text-white'
            : 'border-[var(--color-ink-muted)] bg-white')}
          aria-hidden
        >
          {draft.probiotic && (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 7.2 5.6 10 11 3.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{t('feed.probiotic')}</span>
          <span className="block text-xs text-[var(--color-ink-muted)]">{t('feed.probioticHint')}</span>
        </span>
      </button>
    </div>
  )
}

function Scale({
  label, value, min, max, step, display, chips, chipLabel, onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  chips: number[]
  chipLabel: (n: number) => string
  onChange: (n: number) => void
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">{label}</p>
      <p className="font-display text-2xl font-semibold tabular-nums leading-tight mt-0.5">{display}</p>
      <input
        type="range"
        className="feed-scale"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="flex flex-wrap gap-1.5 mt-1">
        {chips.map((n) => (
          <button
            key={n}
            type="button"
            className={'rounded-full px-3 py-1.5 text-sm min-h-9 ' + (n === value
              ? 'bg-[var(--color-ink)] text-white'
              : 'bg-[var(--color-soft)] text-[var(--color-ink)]')}
            onClick={() => onChange(n)}
          >
            {chipLabel(n)}
          </button>
        ))}
      </div>
    </div>
  )
}

function Btn({ label, onClick, className = '' }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button onClick={onClick} className={'w-full rounded-2xl border border-[var(--color-soft)] bg-white py-4 text-sm font-medium tap shadow-sm active:scale-[0.98] transition ' + className}>{label}</button>
  )
}

function LangSwitch() {
  const { locale, setLocale } = useLang()
  return (
    <div className="inline-flex p-0.5 rounded-full bg-[var(--color-soft)]/80 shrink-0">
      <button type="button" className={'rounded-full px-3 py-1.5 text-xs font-medium min-h-10 min-w-10 ' + (locale === 'en' ? 'bg-white shadow-sm' : 'text-[var(--color-ink-muted)]')} onClick={() => setLocale('en')}>EN</button>
      <button type="button" className={'rounded-full px-3 py-1.5 text-xs font-medium min-h-10 min-w-10 ' + (locale === 'es' ? 'bg-white shadow-sm' : 'text-[var(--color-ink-muted)]')} onClick={() => setLocale('es')}>ES</button>
    </div>
  )
}

function MicIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 17v3.5M9 20.5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function Drawer({ title, children, footer, error, busy, onClose }: { title: string; children: React.ReactNode; footer?: React.ReactNode; error?: string; busy?: boolean; onClose: () => void }) {
  const close = () => { if (!busy) onClose() }
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={close}>
      <div className="w-full max-h-[92dvh] flex flex-col overflow-hidden rounded-t-3xl bg-[var(--color-paper)]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <button disabled={busy} onClick={close} className="text-sm text-[var(--color-ink-muted)]"><CloseLabel /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
          {error && <p role="alert" className="mb-3 text-sm text-[var(--color-warn)]">{error}</p>}
          <fieldset disabled={busy} className="min-w-0 border-0 p-0 m-0">{children}</fieldset>
        </div>
        {footer ? (
          <div className="shrink-0 px-5 pt-3 pb-8 border-t border-[var(--color-soft)]">
            <fieldset disabled={busy} className="min-w-0 border-0 p-0 m-0">{footer}</fieldset>
          </div>
        ) : (
          <div className="px-5 pb-8" />
        )}
      </div>
    </div>
  )
}

function CloseLabel() {
  const { t } = useLang()
  return <>{t('common.close')}</>
}
