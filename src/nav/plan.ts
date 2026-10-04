// Route and leg math: course, heading with wind, distance, time and fuel per leg.

import { inverse, norm360 } from './geodesy'
import { magVarAt } from './mission'
import type { LatLon, MissionExport } from './types'

export type AircraftId = 'F-4E' | 'F-5E' | 'F-100D'

export interface AircraftProfile {
  id: AircraftId
  /** Internal fuel, lb. */
  fuel: number
  taxi: number
  tas: number
  /** Cruise fuel flow, lb/hr. */
  ff: number
  joker: number
  bingo: number
}

// Placeholder planning numbers, not from the flight manuals. Every one is
// editable in the app; replace these once the squadron has real figures.
export const AIRCRAFT: Record<AircraftId, AircraftProfile> = {
  'F-4E': { id: 'F-4E', fuel: 12000, taxi: 600, tas: 420, ff: 6000, joker: 5000, bingo: 4000 },
  'F-5E': { id: 'F-5E', fuel: 4400, taxi: 250, tas: 420, ff: 2800, joker: 2000, bingo: 1500 },
  'F-100D': { id: 'F-100D', fuel: 7700, taxi: 400, tas: 400, ff: 5000, joker: 3000, bingo: 2200 },
}

export interface Waypoint extends LatLon {
  id: string
  name: string
  /** Where it came from: a catalog kind, or "manual" for typed coordinates. */
  source: string
  /** TAS (kt) for the leg INTO this waypoint; falls back to the plan default. */
  tas?: number
  /** Fuel flow (lb/hr) for the leg INTO this waypoint; falls back to the plan default. */
  ff?: number
}

export interface PlanSettings {
  aircraft: AircraftId
  startFuel: number
  taxiFuel: number
  tas: number
  ff: number
  joker: number
  bingo: number
  /** Takeoff time, seconds after midnight (mission local time). */
  takeoff: number
  /** Wind FROM, degrees true, and speed in kt. */
  windDir: number
  windKt: number
}

export function defaultSettings(aircraft: AircraftId, takeoff: number): PlanSettings {
  const a = AIRCRAFT[aircraft]
  return { aircraft, startFuel: a.fuel, taxiFuel: a.taxi, tas: a.tas, ff: a.ff, joker: a.joker, bingo: a.bingo,
    takeoff, windDir: 0, windKt: 0 }
}

export interface Leg {
  /** Index of the waypoint this leg ends at. */
  to: number
  trueCourse: number
  magCourse: number
  magHeading: number
  /** Mag var used for this leg (at its start point). */
  magVar: number
  nm: number
  tas: number
  gs: number
  /** Minutes. */
  ete: number
  fuelUsed: number
}

export interface Row {
  wp: Waypoint
  leg: Leg | null
  /** Minutes since takeoff at this waypoint. */
  elapsed: number
  /** Seconds after midnight. */
  eta: number
  totalNm: number
  fuelRemaining: number
}

/** Wind triangle. Returns true heading and ground speed; null when the wind is stronger than TAS allows. */
export function windTriangle(trueCourse: number, tas: number, windFrom: number, windKt: number):
  { heading: number; gs: number } | null {
  if (windKt === 0) return { heading: trueCourse, gs: tas }
  const rel = ((windFrom - trueCourse) * Math.PI) / 180
  const sinWca = (windKt * Math.sin(rel)) / tas
  if (Math.abs(sinWca) >= 1) return null
  const wca = Math.asin(sinWca)
  const gs = tas * Math.cos(wca) - windKt * Math.cos(rel)
  if (gs <= 0) return null
  return { heading: norm360(trueCourse + (wca * 180) / Math.PI), gs }
}

export function computeRows(m: MissionExport, route: Waypoint[], s: PlanSettings): Row[] {
  const rows: Row[] = []
  let elapsed = 0
  let totalNm = 0
  let fuel = s.startFuel - s.taxiFuel
  route.forEach((wp, i) => {
    if (i === 0) {
      rows.push({ wp, leg: null, elapsed: 0, eta: s.takeoff, totalNm: 0, fuelRemaining: fuel })
      return
    }
    const from = route[i - 1]
    const { az, nm } = inverse(from.lat, from.lon, wp.lat, wp.lon)
    const magVar = magVarAt(m, from)
    const tas = wp.tas ?? s.tas
    const ff = wp.ff ?? s.ff
    const wind = windTriangle(az, tas, s.windDir, s.windKt) ?? { heading: az, gs: tas }
    const ete = (nm / wind.gs) * 60
    const fuelUsed = (ff * ete) / 60
    elapsed += ete
    totalNm += nm
    fuel -= fuelUsed
    rows.push({
      wp,
      leg: { to: i, trueCourse: az, magCourse: norm360(az - magVar), magHeading: norm360(wind.heading - magVar),
        magVar, nm, tas, gs: wind.gs, ete, fuelUsed },
      elapsed,
      eta: s.takeoff + elapsed * 60,
      totalNm,
      fuelRemaining: fuel,
    })
  })
  return rows
}
