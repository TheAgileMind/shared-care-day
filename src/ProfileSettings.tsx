import { useState } from 'react'
import type { BabyProfile } from './lib/types'
import { getAge, resolveSchedule, validateProfile } from './lib/schedule/profile'
import { useLang } from './lib/lang'

export function ProfileSettings({ profile, asOf, onSave }: {
  profile: BabyProfile
  asOf: string
  onSave: (profile: BabyProfile) => Promise<void>
}) {
  const { t } = useLang()
  const [editing, setEditing] = useState(!profile.dateOfBirth)
  const [draft, setDraft] = useState(profile)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const age = getAge(profile, asOf)
  const plan = !validateProfile(profile, asOf) ? resolveSchedule(profile, asOf) : null
  const normalizedDraft = draft.ageBasis === 'actual' ? { ...draft, dueDate: undefined } : draft
  const draftPlan = resolveSchedule({ ...normalizedDraft, napPattern: undefined }, asOf)
  const valid = !validateProfile(normalizedDraft, asOf)
  const inputClass = 'mt-1 w-full rounded-xl border border-[var(--color-soft)] bg-white px-3 py-2.5 text-base text-[var(--color-ink)]'
  const patch = (value: Partial<BabyProfile>) => { setDraft(current => ({ ...current, ...value })); setError('') }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    setError('')
    try { await onSave(normalizedDraft); setEditing(false) }
    catch { setError(t('profile.saveFailed')) }
    finally { setSaving(false) }
  }

  return (
    <section className="card mx-4 mt-3 rounded-2xl border border-[var(--color-soft)] bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t('profile.heading')}</h2>
          <p className="text-xs text-[var(--color-ink-muted)] mt-1">
            {age ? t('profile.age', { weeks: age.weeks, days: age.days % 7, months: age.months }) : t('profile.setup')}
            {age && <> · {t(profile.ageBasis === 'adjusted' ? 'profile.adjusted' : 'profile.actual')}</>}
          </p>
          <p className="text-xs text-[var(--color-ink-muted)]">{t('profile.asOf', { date: asOf, zone: profile.timezone })}</p>
        </div>
        <button type="button" className="tap shrink-0 text-sm underline" onClick={() => { setDraft(profile); setEditing(!editing); setError('') }}>{t(editing ? 'common.close' : 'profile.edit')}</button>
      </div>
      {!plan && <p role="status" className="text-sm mt-2 text-[var(--color-warn)]">{t('profile.noPlan')}</p>}
      {editing && (
        <form onSubmit={submit} className="mt-3 space-y-3">
          <label className="block text-sm">{t('profile.dob')}
            <input className={inputClass} type="date" value={draft.dateOfBirth ?? ''} max={asOf} required onChange={event => patch({ dateOfBirth: event.target.value })} />
          </label>
          <label className="block text-sm">{t('profile.basis')}
            <select className={inputClass} value={draft.ageBasis} onChange={event => patch({ ageBasis: event.target.value as BabyProfile['ageBasis'] })}>
              <option value="actual">{t('profile.actual')}</option>
              <option value="adjusted">{t('profile.adjusted')}</option>
            </select>
          </label>
          {draft.ageBasis === 'adjusted' && <label className="block text-sm">{t('profile.dueDate')}
            <input className={inputClass} type="date" value={draft.dueDate ?? ''} min={draft.dateOfBirth} required onChange={event => patch({ dueDate: event.target.value })} />
          </label>}
          <label className="block text-sm">{t('profile.naps')}
            <select className={inputClass} value={draft.napPattern ?? ''} onChange={event => patch({ napPattern: event.target.value ? Number(event.target.value) : undefined })}>
              <option value="">{t(draftPlan?.minNaps == null ? 'profile.flexible' : 'profile.chooseNaps')}</option>
              {Array.from({ length: 5 }, (_, index) => index + 1).map(count => <option key={count} value={count} disabled={!!draftPlan && draftPlan.minNaps != null && draftPlan.maxNaps != null && (count < draftPlan.minNaps || count > draftPlan.maxNaps)}>{t('profile.napCount', { count })}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block min-w-0 text-sm">{t('profile.morning')}<input className={inputClass} type="time" value={draft.morningTarget} required onChange={event => patch({ morningTarget: event.target.value })} /></label>
            <label className="block min-w-0 text-sm">{t('profile.bedtime')}<input className={inputClass} type="time" value={draft.bedtimeTarget} required onChange={event => patch({ bedtimeTarget: event.target.value })} /></label>
          </div>
          <p className="text-xs text-[var(--color-ink-muted)]">{t('profile.hint')}</p>
          {!valid && <p role="status" className="text-sm text-[var(--color-warn)]">{t('profile.invalid')}</p>}
          {error && <p role="alert" className="text-sm text-[var(--color-warn)]">{error}</p>}
          <button type="submit" disabled={!valid || saving} className="tap w-full rounded-xl bg-[var(--color-ink)] px-4 py-3 text-white disabled:opacity-40">{t(saving ? 'profile.saving' : 'profile.save')}</button>
        </form>
      )}
    </section>
  )
}
