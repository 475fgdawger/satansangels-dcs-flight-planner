// Route and leg math: course, heading with wind, distance, time and fuel per leg,
// plus joker and bingo from the target waypoint.

import { inverse, norm360 } from './geodesy'
import { catalog, magVarAt } from './mission'
import type { LatLon, MissionExport } from './types'
import { DEFAULT_INGRESS_AGL, type PopupInputs, type PopupSettings } from './popup'

export type AircraftId = 'F-4E' | 'F-5E' | 'F-100D'
export type PhaseId = 'cruise-high' | 'cruise-low' | 'mil' | 'ab'

export interface Phase {
  id: PhaseId
  label: string
  /** Short label for the nav log. */
  short: string
  /** Fuel flow, lb/hr, both engines. */
  ff: number
  note: string
}

export interface AircraftProfile {
  id: AircraftId
  fuelLoads: { label: string; lb: number }[]
  /** Ground idle burn, lb/min. */
  idleLbMin: number
  /** Default cruise TAS, kt. */
  tas: number
  /** TAS used for the afterburner egress in the joker calculation, kt. */
  abTas: number
  phases: Phase[]
  /** Bingo is never lower than this, lb. */
  bingoFloor: number
  /** True while the numbers are guesses rather than squadron planning figures. */
  placeholder: boolean
}

// F-4E: squadron initial planning numbers (Patrick, 2026-10-04). Fuel flows are
// the middle of each range given. abTas is an assumption, editable in the app.
// F-5E and F-100D: placeholders until the squadron has figures.
export const AIRCRAFT: Record<AircraftId, AircraftProfile> = {
  'F-4E': {
    id: 'F-4E',
    fuelLoads: [
      { label: 'Internal', lb: 12200 },
      // 600 gal centerline tank at 6.5 lb/gal JP-4 = 3,900 lb.
      { label: 'Centerline tank', lb: 16100 },
      { label: 'Centerline + outboard tanks', lb: 20800 },
    ],
    idleLbMin: 30,
    tas: 460,
    abTas: 550,
    phases: [
      { id: 'cruise-high', label: 'High cruise', short: 'HI', ff: 4250, note: '30,000+ ft, M0.8, 4,000-4,500 lb/hr' },
      { id: 'cruise-low', label: 'Low transit', short: 'LO', ff: 8250, note: '5,000 ft, 7,500-9,000 lb/hr' },
      { id: 'mil', label: 'MIL power', short: 'MIL', ff: 13000, note: 'sea level, 12,000-14,000 lb/hr' },
      { id: 'ab', label: 'Afterburner', short: 'AB', ff: 65000, note: 'zone 5, 50,000-80,000 lb/hr' },
    ],
    bingoFloor: 3000,
    placeholder: false,
  },
  'F-5E': {
    id: 'F-5E',
    fuelLoads: [{ label: 'Internal', lb: 4400 }],
    idleLbMin: 12,
    tas: 420,
    abTas: 500,
    phases: [
      { id: 'cruise-high', label: 'High cruise', short: 'HI', ff: 2200, note: 'placeholder' },
      { id: 'cruise-low', label: 'Low transit', short: 'LO', ff: 3800, note: 'placeholder' },
      { id: 'mil', label: 'MIL power', short: 'MIL', ff: 6000, note: 'placeholder' },
      { id: 'ab', label: 'Afterburner', short: 'AB', ff: 20000, note: 'placeholder' },
    ],
    bingoFloor: 1200,
    placeholder: true,
  },
  'F-100D': {
    id: 'F-100D',
    fuelLoads: [{ label: 'Internal', lb: 7700 }],
    idleLbMin: 20,
    tas: 420,
    abTas: 500,
    phases: [
      { id: 'cruise-high', label: 'High cruise', short: 'HI', ff: 4000, note: 'placeholder' },
      { id: 'cruise-low', label: 'Low transit', short: 'LO', ff: 7000, note: 'placeholder' },
      { id: 'mil', label: 'MIL power', short: 'MIL', ff: 9000, note: 'placeholder' },
      { id: 'ab', label: 'Afterburner', short: 'AB', ff: 30000, note: 'placeholder' },
    ],
    bingoFloor: 2000,
    placeholder: true,
  },
}

export function phaseOf(aircraft: AircraftId, id: PhaseId): Phase {
  const phases = AIRCRAFT[aircraft].phases
  return phases.find((p) => p.id === id) ?? phases[0]
}

/** Waypoint roles shown on the nav log. TGT and CAP also set where joker and bingo are measured. */
export const WAYPOINT_TAGS = ['IP', 'CAP', 'TGT', 'EP'] as const
export type WaypointTag = (typeof WAYPOINT_TAGS)[number]

export interface Waypoint extends LatLon {
  id: string
  name: string
  /** Where it came from: a catalog kind, or "manual" for typed coordinates. */
  source: string
  /** TAS (kt) for the leg INTO this waypoint; falls back to the plan default. */
  tas?: number
  /** Flight phase for the leg INTO this waypoint; falls back to the plan default. */
  phase?: PhaseId
  /** Custom fuel flow (lb/hr) for the leg INTO this waypoint; overrides the phase. */
  ff?: number
  /** Time spent holding at this waypoint before the next leg; phase unset = same as the leg in. */
  loiter?: { min: number; phase?: PhaseId }
  /** Initial point, CAP station, target, egress point. */
  tags?: WaypointTag[]
  /** Ground elevation, ft MSL. */
  elevFt?: number
  /** Where elevFt came from: the DCS export, a real-world terrain lookup, or typed by the crew. */
  elevSource?: 'dcs' | 'dem' | 'typed'
  /** Planned altitude at this waypoint, ft, as typed: above sea level or above the ground. */
  alt?: { ft?: number; ref: AltRef }
}

export type AltRef = 'msl' | 'agl'

/** The planned altitude as ft MSL; an AGL altitude needs the waypoint's elevation. */
export function altMsl(wp: Waypoint): number | undefined {
  const ft = wp.alt?.ft
  if (ft === undefined) return undefined
  if (wp.alt!.ref === 'msl') return ft
  return wp.elevFt === undefined ? undefined : ft + wp.elevFt
}

/** The planned altitude as ft above the ground; an MSL altitude needs the waypoint's elevation. */
export function altAgl(wp: Waypoint): number | undefined {
  const ft = wp.alt?.ft
  if (ft === undefined) return undefined
  if (wp.alt!.ref === 'agl') return ft
  return wp.elevFt === undefined ? undefined : ft - wp.elevFt
}

export interface PlanSettings {
  aircraft: AircraftId
  startFuel: number
  /** Minutes at ground idle before takeoff. */
  taxiMin: number
  /** Minutes in full afterburner for takeoff and acceleration to 400 kt. */
  abTakeoffMin: number
  /** Minutes at MIL power climbing, flown at the start of the first leg. */
  climbMin: number
  tas: number
  /** Default flight phase for legs. */
  phase: PhaseId
  /** Takeoff time, seconds after midnight (mission local time); unset = T/O and ETAs left blank. */
  takeoff?: number
  /** Wind FROM, degrees true, and speed in kt. */
  windDir: number
  windKt: number
  /** Waypoint id of the target or CAP station; unset = farthest waypoint from the last one. */
  targetId?: string
  abTas: number
  /** Typed values replace the calculated joker / bingo. */
  jokerOverride?: number
  bingoOverride?: number
  /** Pop-up attack numbers; unset = defaults. */
  popup?: PopupSettings
}

export function defaultSettings(aircraft: AircraftId, takeoff?: number): PlanSettings {
  const a = AIRCRAFT[aircraft]
  return { aircraft, startFuel: a.fuelLoads[0].lb, taxiMin: 10, abTakeoffMin: 0.75, climbMin: 4, tas: a.tas,
    phase: a.phases[0].id, takeoff, windDir: 0, windKt: 0, abTas: a.abTas }
}

/**
 * Departure fuel: taxi at idle and full afterburner for takeoff and acceleration to
 * 400 kt are burned on the ground roll (before the first waypoint); the MIL climb
 * is flown at the start of the first leg. Squadron sanity check: about 2,000 lb in
 * total for a climb to 30,000 ft.
 */
export function departureFuel(s: PlanSettings): { taxi: number; takeoff: number; climb: number; beforeFirstLeg: number; total: number } {
  const a = AIRCRAFT[s.aircraft]
  const taxi = s.taxiMin * a.idleLbMin
  const takeoff = (s.abTakeoffMin * phaseOf(s.aircraft, 'ab').ff) / 60
  const climb = (Math.max(s.climbMin, 0) * phaseOf(s.aircraft, 'mil').ff) / 60
  return { taxi, takeoff, climb, beforeFirstLeg: taxi + takeoff, total: taxi + takeoff + climb }
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
  ff: number
  phase: Phase | null
  /** Minutes of this leg flown at MIL climb (first leg only). */
  climbMin: number
  fuelUsed: number
}

export interface Row {
  wp: Waypoint
  leg: Leg | null
  /** Minutes since takeoff at this waypoint. */
  elapsed: number
  /** Seconds after midnight; null when no takeoff time is set. */
  eta: number | null
  totalNm: number
  /** Fuel on arrival at this waypoint. */
  fuelRemaining: number
  /** Holding at this waypoint; null when the waypoint has no loiter. */
  loiter: { min: number; ff: number; phase: Phase | null; fuel: number } | null
  /** Fuel when leaving this waypoint (after any loiter). */
  fuelAfter: number
  /** Minutes since takeoff when leaving this waypoint (after any loiter). */
  elapsedAfter: number
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
  let fuel = s.startFuel - departureFuel(s).beforeFirstLeg
  const milFf = phaseOf(s.aircraft, 'mil').ff
  route.forEach((wp, i) => {
    let leg: Leg | null = null
    if (i > 0) {
      const from = route[i - 1]
      const { az, nm } = inverse(from.lat, from.lon, wp.lat, wp.lon)
      const magVar = magVarAt(m, from)
      const tas = wp.tas ?? s.tas
      const phase = wp.ff === undefined ? phaseOf(s.aircraft, wp.phase ?? s.phase) : null
      const ff = wp.ff ?? phase!.ff
      const wind = windTriangle(az, tas, s.windDir, s.windKt) ?? { heading: az, gs: tas }
      const ete = (nm / wind.gs) * 60
      // The climb at MIL is flown at the start of the first leg; the rest of the leg uses its own phase.
      const climbMin = i === 1 ? Math.min(Math.max(s.climbMin, 0), ete) : 0
      const fuelUsed = (milFf * climbMin + ff * (ete - climbMin)) / 60
      elapsed += ete
      totalNm += nm
      fuel -= fuelUsed
      leg = { to: i, trueCourse: az, magCourse: norm360(az - magVar), magHeading: norm360(wind.heading - magVar),
        magVar, nm, tas, gs: wind.gs, ete, ff, phase, climbMin, fuelUsed }
    }
    const arrival = { elapsed, fuel }
    const loiter = loiterAt(wp, leg, s)
    if (loiter) {
      elapsed += loiter.min
      fuel -= loiter.fuel
    }
    rows.push({
      wp,
      leg,
      elapsed: arrival.elapsed,
      eta: s.takeoff === undefined ? null : s.takeoff + arrival.elapsed * 60,
      totalNm,
      fuelRemaining: arrival.fuel,
      loiter,
      fuelAfter: fuel,
      elapsedAfter: elapsed,
    })
  })
  return rows
}

/** Loiter fuel flow: the loiter's own phase, else whatever the leg in was flown at, else the plan default. */
function loiterAt(wp: Waypoint, leg: Leg | null, s: PlanSettings): Row['loiter'] {
  const min = wp.loiter?.min ?? 0
  if (!(min > 0)) return null
  const phase = wp.loiter!.phase ? phaseOf(s.aircraft, wp.loiter!.phase)
    : leg ? leg.phase : phaseOf(s.aircraft, s.phase)
  const ff = phase ? phase.ff : leg!.ff
  return { min, ff, phase, fuel: (ff * min) / 60 }
}

export interface FuelPlan {
  /** Route index of the target / CAP station. */
  target: number
  /** How the target was chosen: a TGT or CAP mark, or the farthest point from base. */
  targetKind: 'TGT' | 'CAP' | 'auto'
  /** Direct distance target -> last waypoint (base), nm. */
  rtbNm: number
  bingo: number
  joker: number
  /** The calculated values and their parts, before any override. */
  calc: {
    rtbFuel: number
    bingo: number
    abLoiter: number
    abEgress: number
    cruiseHome: number
    joker: number
  }
}

/** Afterburner egress distance in the joker definition, nm. */
export const JOKER_AB_EGRESS_NM = 30

/**
 * Squadron definitions, fuel state at the target or CAP station:
 * - Bingo: the higher of the bingo floor and the fuel to fly home direct at the most
 *   efficient cruise.
 * - Joker: 1 minute of afterburner in the target area, afterburner until 30 nm out,
 *   then most efficient cruise home. Never below bingo.
 */
export function fuelPlan(route: Waypoint[], s: PlanSettings): FuelPlan | null {
  if (route.length < 2) return null
  const base = route[route.length - 1]
  // The first waypoint marked TGT or CAP; plans saved before tags existed use targetId.
  let target = route.slice(0, -1).findIndex((w) => w.tags?.includes('TGT') || w.tags?.includes('CAP'))
  if (target < 0) target = route.findIndex((w) => w.id === s.targetId)
  if (target < 0 || target === route.length - 1) {
    target = 0
    let best = -1
    route.slice(0, -1).forEach((w, i) => {
      const nm = inverse(w.lat, w.lon, base.lat, base.lon).nm
      if (nm > best) { best = nm; target = i }
    })
  }
  const t = route[target]
  const targetKind = t.tags?.includes('TGT') ? 'TGT' : t.tags?.includes('CAP') ? 'CAP' : 'auto'
  const { az, nm: rtbNm } = inverse(t.lat, t.lon, base.lat, base.lon)
  const a = AIRCRAFT[s.aircraft]
  const cruise = a.phases.reduce((lo, p) => (p.ff < lo.ff ? p : lo))
  const ab = phaseOf(s.aircraft, 'ab')
  const gsCruise = (windTriangle(az, s.tas, s.windDir, s.windKt) ?? { gs: s.tas }).gs
  const gsAb = (windTriangle(az, s.abTas, s.windDir, s.windKt) ?? { gs: s.abTas }).gs

  const rtbFuel = (rtbNm / gsCruise) * cruise.ff
  const bingo = Math.max(a.bingoFloor, rtbFuel)
  const abLoiter = ab.ff / 60
  const egressNm = Math.min(JOKER_AB_EGRESS_NM, rtbNm)
  const abEgress = (egressNm / gsAb) * ab.ff
  const cruiseHome = ((rtbNm - egressNm) / gsCruise) * cruise.ff
  const joker = Math.max(bingo, abLoiter + abEgress + cruiseHome)

  return {
    target,
    targetKind,
    rtbNm,
    bingo: s.bingoOverride ?? bingo,
    joker: s.jokerOverride ?? joker,
    calc: { rtbFuel, bingo, abLoiter, abEgress, cruiseHome, joker },
  }
}

/** The IP-to-target run for the pop-up attack, taken from the route. */
export interface AttackRun {
  /** Route indexes of the IP and the target. */
  ip: number
  tgt: number
  ipNm: number
  /** Magnetic course IP to target. */
  magCourse: number
  /** TAS on the leg into the target. */
  tas: number
  /** Target waypoint elevation, ft MSL, when known. */
  elevFt?: number
}

/** The first waypoint marked TGT, run in from the nearest earlier waypoint marked IP (else the waypoint before it). */
export function attackRun(m: MissionExport, route: Waypoint[], s: PlanSettings): AttackRun | null {
  const tgt = route.findIndex((w) => w.tags?.includes('TGT'))
  if (tgt < 1) return null
  let ip = tgt - 1
  for (let i = tgt - 1; i >= 0; i--) if (route[i].tags?.includes('IP')) { ip = i; break }
  const a = route[ip]
  const t = route[tgt]
  const { az, nm } = inverse(a.lat, a.lon, t.lat, t.lon)
  return { ip, tgt, ipNm: nm, magCourse: norm360(az - magVarAt(m, a)), tas: t.tas ?? s.tas, elevFt: t.elevFt }
}

/** Pop-up inputs with the route filling IP range, ingress speed and heading unless the crew overrode them. */
export function popupInputs(run: AttackRun | null, p: PopupSettings): PopupInputs {
  const tgtElev = run?.elevFt ?? NaN
  return {
    dive: p.dive, ktas: p.ktas, track: p.track, tgtElev,
    relAgl: p.relRef === 'agl' ? p.rel : p.rel - tgtElev,
    g: p.g, ingAlt: p.ingAlt ?? tgtElev + DEFAULT_INGRESS_AGL,
    ipNm: p.ipNm ?? run?.ipNm ?? NaN,
    ingressKt: p.ingressKt ?? run?.tas ?? NaN,
    hdg: p.hdg ?? (run ? Math.round(run.magCourse) || 360 : NaN),
  }
}

/** Waypoints sitting on a mission point take its DCS elevation, unless the crew typed one. */
export function refreshElevations(m: MissionExport, route: Waypoint[]): Waypoint[] {
  const pts = catalog(m).filter((p) => p.elevFt !== undefined)
  return route.map((w) => {
    if (w.elevSource === 'typed') return w
    const hit = pts.find((p) => Math.abs(p.lat - w.lat) < 1e-5 && Math.abs(p.lon - w.lon) < 1e-5)
    return hit ? { ...w, elevFt: Math.round(hit.elevFt!), elevSource: 'dcs' } : w
  })
}
