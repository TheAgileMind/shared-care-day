export type CopyRef = { key: string; params?: Record<string, string | number> }
export type EventType = 'wake' | 'feed' | 'nap_start' | 'nap_end' | 'tummy' | 'diaper' | 'note' | 'bedtime'
export interface CareEvent {
  id: string; type: EventType; at: string; by: string
  meta?: {
    ounces?: number
    side?: 'L' | 'R' | 'both' | 'bottle'
    durationMin?: number
    leftMin?: number
    rightMin?: number
    probiotic?: boolean
    held?: boolean
    trueWake?: string
    cues?: string[]
    note?: string
  }
}
export interface BabyProfile {
  name: string
  dateOfBirth?: string
  ageBasis: 'actual' | 'adjusted'
  dueDate?: string
  napPattern?: number
  timezone: string
  bedtimeTarget: string
  morningTarget: string
}
export interface DayState { date: string; events: CareEvent[]; previousDaySleepMin?: number; updatedAt?: string }
export interface DaySummary {
  date: string
  sleepMin: number
  feedCount: number
  napCount: number
  poopCount: number
  eventCount: number
  hasData: boolean
}
export interface HistoryResponse {
  days: DaySummary[]
  yesterday: { date: string; summary: DaySummary; events: CareEvent[] } | null
}
export interface NowState {
  status: 'asleep'|'awake'|'feeding'|'unknown'
  lastWake?: Date; lastNapEnd?: Date; lastFeed?: Date; currentNapStart?: Date
  awakeMin: number
  wakeWindowMin: { short: number; target: number; long: number }
  nextAction: { kind: 'feed'|'nap'|'wake'|'bedtime'|'wind_down'|'none'; label: string; at?: Date; urgency: 'now'|'soon'|'later'; copy?: CopyRef }
  guidance: CopyRef[]
  timeline: { time: Date; label: string; predicted: boolean; by?: string }[]
  daySleepMin: number; feedCount: number
  shouldWake?: { by: Date; reason: string; copy?: CopyRef }
}
export type ParentId = string
