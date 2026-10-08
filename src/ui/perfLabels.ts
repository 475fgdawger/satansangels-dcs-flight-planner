// Short texts for planned legs and the joker / bingo profiles (aircraft with recorded performance data).

import type { PerfFlag } from '../nav/perf'
import type { Leg, Waypoint } from '../nav/plan'

export const FLAG_TEXT: Record<PerfFlag, string> = {
  wide: 'interpolated across a wide gap in the recorded data',
  fast: 'above max level speed: the jet can\'t hold this speed level at 95 % RPM; plan MIL or AB',
  slow: 'below the slowest level speed recorded at this altitude: plan faster or lower',
  high: 'above the highest altitude recorded',
  short: 'the climb or descent is longer than the leg; it is cut to fit',
  est: 'loaded climb estimated from the No Stores climb (no loaded climb recorded yet)',
}

/** "≈" when any flag makes the figure approximate. */
export const approx = (flags: PerfFlag[] | undefined) => (flags && flags.length > 0 ? '≈' : '')

export const flagTitle = (flags: PerfFlag[] | undefined) => (flags ?? []).map((f) => FLAG_TEXT[f]).join('\n')

export const ft = (n: number) => Math.round(n).toLocaleString('en-US')

export const machText = (m: number) => `M${m.toFixed(2).replace(/^0/, '')}`

/** The leg speed as planned: Mach when typed as Mach, else KIAS. */
export function speedText(leg: Leg, wp: Waypoint): string {
  if (leg.mach === undefined || leg.kias === undefined) return `${Math.round(leg.tas)} KTAS`
  return wp.speed?.unit === 'mach' ? machText(leg.mach) : `${Math.round(leg.kias)} KIAS`
}

/** Power to set: RPM for a cruise leg, MIL or AB, or the typed fuel flow. */
export function powerText(leg: Leg): string {
  if (leg.phase?.id === 'mil') return 'MIL'
  if (leg.phase?.id === 'ab') return 'AB'
  if (!leg.phase) return `${Math.round(leg.ff)} pph`
  return leg.rpm == null ? 'CRZ' : `${leg.rpm.toFixed(1)}%`
}

export const rpmText = (rpm: number | null) => (rpm == null ? '' : `${rpm.toFixed(1)}%`)
