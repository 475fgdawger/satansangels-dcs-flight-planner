// Route and leg math: course, heading with wind, distance, time and fuel per leg, plus joker and bingo from the
// target waypoint. Aircraft with recorded performance data (perf.ts) plan each leg from its altitude, speed and
// drag category; the others use a fixed fuel flow per phase.

import { inverse, norm360 } from './geodesy'
import { catalog, magVarAt } from './mission'
import type { LatLon, MissionExport } from './types'
import { kcasFromMach, ktasFromMach, machFromKcas, speedOfSoundKt } from './atmo'
import { NO_STORES, PERF, bestRangeKias, climb, cruiseAt, descent, dragFactor, levelAtRpm, powerFf, type ClimbDescent, type PerfData,
  type PerfFlag } from './perf'
import { DEFAULT_INGRESS_AGL, type PopupInputs, type PopupSettings } from './popup'

export type AircraftId = 'F-4E' | 'F-5E' | 'F-100D'
/** 'cruise' uses the recorded level tables; the fixed-flow phases are for aircraft without recorded data. */
export type PhaseId = 'cruise' | 'cruise-high' | 'cruise-low' | 'mil' | 'ab'
/** Loiter power: a leg phase, or combat loiter, (MIL + max AB) / 2. */
export type LoiterPower = PhaseId | 'combat'

export interface Phase {
  id: LoiterPower
  label: string
  /** Short label for the nav log. */
  short: string
  /** Fixed fuel flow, lb/hr, both engines; unset when it comes from the performance tables. */
  ff?: number
  note: string
}

export interface AircraftProfile {
  id: AircraftId
  fuelLoads: { label: string; lb: number }[]
  /** Ground idle burn, lb/min. */
  idleLbMin: number
  /** Default cruise TAS, kt (aircraft without recorded data). */
  tas: number
  /** TAS used for the afterburner egress in the joker calculation, kt (aircraft without recorded data). */
  abTas: number
  phases: Phase[]
  /** Bingo is never lower than this, lb. With recorded data it is the landing reserve added to the bingo and joker profiles. */
  bingoFloor: number
  /** True while the numbers are guesses rather than squadron planning figures. */
  placeholder: boolean
  /** Recorded performance data (level cruise, climb, descent, MIL / AB, drag categories). */
  perf?: PerfData
  /** Drag category the bingo is flown at, whatever the plan's category (stores gone, missiles and tank kept). */
  bingoDrag?: string
}

/** Leg phases for aircraft with recorded data: fuel flow and RPM come from the tables. */
const PERF_PHASES: Phase[] = [
  { id: 'cruise', label: 'Cruise', short: 'CRZ', note: 'level cruise tables: fuel flow and the RPM that holds the planned speed' },
  { id: 'mil', label: 'MIL power', short: 'MIL', note: 'MIL fuel flow at the leg altitude and Mach' },
  { id: 'ab', label: 'Max AB', short: 'AB', note: 'max afterburner fuel flow at the leg altitude and Mach' },
]

export const COMBAT_LOITER: Phase = { id: 'combat', label: 'Combat loiter', short: 'CMBT', note: '(MIL + max AB fuel flow) / 2' }

// F-4E: recorded DCS data (dcs-perf-recorder, the squadron performance manual). Fuel loads and the
// 3,000 lb landing reserve are the squadron's initial planning numbers (Patrick, 2026-10-04).
// F-5E and F-100D: placeholders until their data is recorded.
export const AIRCRAFT: Record<AircraftId, AircraftProfile> = {
  'F-4E': {
    id: 'F-4E',
    fuelLoads: [
      { label: 'Internal', lb: 12200 },
      // 600 gal centerline tank at 6.5 lb/gal JP-4 = 3,900 lb.
      { label: 'Centerline tank', lb: 16100 },
      { label: 'Centerline + outboard tanks', lb: 20800 },
    ],
    idleLbMin: PERF['F-4E']?.ground.idle_lb_min ?? 30,
    tas: 460,
    abTas: 550,
    phases: PERF_PHASES,
    bingoFloor: 3000,
    placeholder: false,
    perf: PERF['F-4E'],
    // Squadron (2026-10-08): bingo at BFM Only drag. A missiles-only (no centerline tank) category may follow.
    bingoDrag: 'BFM Only',
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

/** The aircraft's phase with this id; unknown ids (plans saved before an aircraft got recorded data) get the first. */
export function phaseOf(aircraft: AircraftId, id: LoiterPower): Phase {
  if (id === 'combat') return COMBAT_LOITER
  const phases = AIRCRAFT[aircraft].phases
  return phases.find((p) => p.id === id) ?? phases[0]
}

/** Fixed fuel flow of a phase (aircraft without recorded data). */
const fixedFf = (aircraft: AircraftId, id: PhaseId) => phaseOf(aircraft, id).ff ?? 0

/** Waypoint roles shown on the nav log. TGT and CAP also set where joker and bingo are measured. */
export const WAYPOINT_TAGS = ['IP', 'CAP', 'TGT', 'EP'] as const
export type WaypointTag = (typeof WAYPOINT_TAGS)[number]

/** A planned airspeed: KIAS, or Mach. */
export interface Speed {
  v: number
  unit: 'kias' | 'mach'
}

export interface Waypoint extends LatLon {
  id: string
  name: string
  /** Where it came from: a catalog kind, or "manual" for typed coordinates. */
  source: string
  /** TAS (kt) for the leg INTO this waypoint; aircraft without recorded data (and older plans). */
  tas?: number
  /** KIAS or Mach for the leg INTO this waypoint; unset = the default for the leg altitude. Aircraft with recorded data. */
  speed?: Speed
  /** Flight phase for the leg INTO this waypoint; falls back to the plan default. */
  phase?: PhaseId
  /** Custom fuel flow (lb/hr) for the leg INTO this waypoint; overrides the phase. */
  ff?: number
  /** Time spent holding at this waypoint before the next leg; power unset = same as the leg in. */
  loiter?: { min: number; phase?: LoiterPower }
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

/**
 * The altitude at each waypoint, ft MSL, for the performance tables: as planned, else the one before. The first
 * and last waypoints (takeoff and landing) default to their elevation. An AGL altitude with no elevation counts as MSL.
 */
export function routeAltitudes(route: Waypoint[]): number[] {
  const out: number[] = []
  route.forEach((w, i) => {
    let ft = altMsl(w) ?? w.alt?.ft
    if (ft === undefined) ft = i === 0 || i === route.length - 1 ? (w.elevFt ?? 0) : out[i - 1]
    out.push(ft)
  })
  return out
}

export interface PlanSettings {
  aircraft: AircraftId
  startFuel: number
  /** Minutes at ground idle before takeoff. */
  taxiMin: number
  /** Minutes in full afterburner for takeoff and acceleration to 400 kt (aircraft without recorded data). */
  abTakeoffMin: number
  /** Minutes at MIL power climbing, flown at the start of the first leg (aircraft without recorded data). */
  climbMin: number
  /** Default TAS, kt (aircraft without recorded data). */
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
  /** Drag category (aircraft with recorded data); unset = No Stores. */
  drag?: string
  /** Temperature, °C from ISA (standard day); unset = 0. */
  isaDev?: number
  /** Default speed for legs below 20,000 ft, KIAS; unset = 420. Legs at 20,000 ft and up default to 7.5 units AoA. */
  lowKias?: number
  /** Highest altitude the bingo profile may climb to, ft MSL; unset = 35,000. */
  bingoCapFt?: number
  /** Pop-up attack numbers; unset = defaults. */
  popup?: PopupSettings
  /** Title block on the kneeboard pages; unset = the mission name. */
  title?: string
  /** Flight callsign for the title block, e.g. "Satan 1". */
  callsign?: string
}

/** Legs below this default to lowKias; at and above it, to the best-range speed (7.5 units AoA). */
export const BEST_RANGE_MIN_FT = 20000
export const DEFAULT_LOW_KIAS = 420
export const DEFAULT_BINGO_CAP_FT = 35000

/** The title shown on the kneeboard pages. */
export function planTitle(missionName: string, s: PlanSettings): string {
  return s.title?.trim() || missionName
}

export function defaultSettings(aircraft: AircraftId, takeoff?: number): PlanSettings {
  const a = AIRCRAFT[aircraft]
  return { aircraft, startFuel: a.fuelLoads[0].lb, taxiMin: 10, abTakeoffMin: 0.75, climbMin: 4, tas: a.tas,
    phase: a.phases[0].id as PhaseId, takeoff, windDir: 0, windKt: 0, abTas: a.abTas }
}

/**
 * Departure fuel burned before the first waypoint: taxi at ground idle, then full afterburner for takeoff and
 * acceleration. With recorded data: the recorded max AB takeoff from brake release to 450 KIAS, then the MIL climb is
 * part of the first leg. Without: AB for a set time (to about 400 kt), then a fixed MIL climb at the start of the
 * first leg.
 */
export function departureFuel(s: PlanSettings): { taxi: number; takeoff: number; climb: number; beforeFirstLeg: number; total: number } {
  const a = AIRCRAFT[s.aircraft]
  const taxi = s.taxiMin * a.idleLbMin
  const recorded = a.perf?.ground.takeoff
  if (recorded) return { taxi, takeoff: recorded.lb, climb: 0, beforeFirstLeg: taxi + recorded.lb, total: taxi + recorded.lb }
  const takeoff = (s.abTakeoffMin * fixedFf(s.aircraft, 'ab')) / 60
  const climb = (Math.max(s.climbMin, 0) * fixedFf(s.aircraft, 'mil')) / 60
  return { taxi, takeoff, climb, beforeFirstLeg: taxi + takeoff, total: taxi + takeoff + climb }
}

/** A climb or descent within a leg: minutes, ground nm (with wind) and fuel. */
export interface Segment {
  fromFt: number
  toFt: number
  min: number
  nm: number
  lb: number
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
  /** Cruise TAS and GS. */
  tas: number
  gs: number
  /** Minutes. */
  ete: number
  /** Cruise fuel flow, lb/hr. */
  ff: number
  phase: Phase | null
  /** Minutes of this leg flown at MIL climb. */
  climbMin: number
  fuelUsed: number
  /** Cruise altitude, ft MSL: the higher of the two waypoints (recorded data only, like the fields below). */
  altFt?: number
  kias?: number
  mach?: number
  /** RPM that holds the cruise speed; null at MIL / AB or where the data has none. */
  rpm?: number | null
  /** MIL climb at the start of the leg. */
  climb?: Segment | null
  /** Idle descent at the end of the leg; its nm is the top of descent, nm before the waypoint. */
  descent?: Segment | null
  flags: PerfFlag[]
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

const groundSpeed = (course: number, tas: number, s: PlanSettings) =>
  windTriangle(course, tas, s.windDir, s.windKt) ?? { heading: course, gs: tas }

/** The default speed for a leg at an altitude, KIAS: 7.5 units AoA at 20,000 ft and up, else the plan's low-level speed. */
export function defaultKias(p: PerfData, altFt: number, s: PlanSettings): number {
  const low = s.lowKias ?? DEFAULT_LOW_KIAS
  return altFt >= BEST_RANGE_MIN_FT ? (bestRangeKias(p, altFt) ?? low) : low
}

/** The leg's planned speed at its cruise altitude as Mach, KIAS and KTAS. */
export function legSpeed(p: PerfData, wp: Waypoint, altFt: number, s: PlanSettings): { mach: number; kias: number; ktas: number } {
  const isa = s.isaDev ?? 0
  const mach = wp.speed?.unit === 'mach' ? wp.speed.v
    : wp.speed ? machFromKcas(wp.speed.v, altFt)
    : wp.tas ? wp.tas / speedOfSoundKt(altFt, isa)
    : machFromKcas(defaultKias(p, altFt, s), altFt)
  return { mach, kias: kcasFromMach(mach, altFt), ktas: ktasFromMach(mach, altFt, isa) }
}

/** A table climb or descent flown along a course: ground distance from its average TAS and the wind. */
function onCourse(cd: ClimbDescent, fromFt: number, toFt: number, course: number, s: PlanSettings): Segment {
  if (!(cd.min > 0)) return { fromFt, toFt, min: 0, nm: 0, lb: 0 }
  const gs = groundSpeed(course, (cd.nm / cd.min) * 60, s).gs
  return { fromFt, toFt, min: cd.min, nm: (gs * cd.min) / 60, lb: cd.lb }
}

const scaled = (g: Segment, k: number): Segment => ({ ...g, min: g.min * k, nm: g.nm * k, lb: g.lb * k })

/**
 * Climb, cruise and descent over a distance: MIL climb from fromFt to cruiseFt at the start, cruise, idle descent
 * to toFt at the end. When the climb and descent don't fit, both are cut to the distance and flagged 'short'.
 */
function profile(p: PerfData, s: PlanSettings, fromFt: number, cruiseFt: number, toFt: number, distNm: number, course: number,
  cruise: { mach: number; ff: number; flags: PerfFlag[] }) {
  const flags = new Set<PerfFlag>(cruise.flags)
  const cl = climb(p, fromFt, cruiseFt, dragFactor(p, s.drag))
  cl.flags.forEach((x) => flags.add(x))
  let up = onCourse(cl, fromFt, cruiseFt, course, s)
  let down = onCourse(descent(p, cruiseFt, toFt), cruiseFt, toFt, course, s)
  const ktas = ktasFromMach(cruise.mach, cruiseFt, s.isaDev ?? 0)
  const wind = groundSpeed(course, ktas, s)
  let cruiseNm = distNm - up.nm - down.nm
  if (cruiseNm < 0) {
    const k = distNm / (up.nm + down.nm)
    up = scaled(up, k)
    down = scaled(down, k)
    cruiseNm = 0
    flags.add('short')
  }
  const cruiseMin = (cruiseNm / wind.gs) * 60
  return { ktas, heading: wind.heading, gs: wind.gs, climb: up.min > 0 ? up : null, descent: down.min > 0 ? down : null,
    cruiseNm, min: up.min + cruiseMin + down.min, fuel: up.lb + (cruise.ff * cruiseMin) / 60 + down.lb, flags: [...flags] }
}

export function computeRows(m: MissionExport, route: Waypoint[], s: PlanSettings): Row[] {
  const rows: Row[] = []
  const p = AIRCRAFT[s.aircraft].perf
  const alts = routeAltitudes(route)
  let elapsed = 0
  let totalNm = 0
  let fuel = s.startFuel - departureFuel(s).beforeFirstLeg
  route.forEach((wp, i) => {
    let leg: Leg | null = null
    if (i > 0) {
      const from = route[i - 1]
      const { az, nm } = inverse(from.lat, from.lon, wp.lat, wp.lon)
      const magVar = magVarAt(m, from)
      const l = p ? perfLeg(p, wp, alts[i - 1], alts[i], az, nm, s) : fixedLeg(wp, i, az, nm, s)
      // The leg functions return a true heading; the nav log is magnetic.
      leg = { ...l, to: i, magCourse: norm360(az - magVar), magHeading: norm360(l.magHeading - magVar), magVar }
      elapsed += leg.ete
      totalNm += nm
      fuel -= leg.fuelUsed
    }
    const arrival = { elapsed, fuel }
    const loiter = loiterAt(wp, leg, s, alts[i])
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

/** A leg from the recorded tables. Its magHeading is true; computeRows applies the mag var. */
function perfLeg(p: PerfData, wp: Waypoint, fromFt: number, toFt: number, course: number, nm: number, s: PlanSettings): Leg {
  const altFt = Math.max(fromFt, toFt)
  const spd = legSpeed(p, wp, altFt, s)
  const phase = wp.ff === undefined ? phaseOf(s.aircraft, wp.phase ?? s.phase) : null
  let ff: number, rpm: number | null = null, flags: PerfFlag[] = []
  if (phase?.id === 'mil') ff = powerFf(p, 'MIL', altFt, spd.mach)
  else if (phase?.id === 'ab') ff = powerFf(p, 'ABMAX', altFt, spd.mach)
  else {
    const c = cruiseAt(p, altFt, spd.mach, dragFactor(p, s.drag), s.isaDev ?? 0)
    ff = wp.ff ?? c.ff
    rpm = c.rpm
    flags = c.flags
  }
  const pr = profile(p, s, fromFt, altFt, toFt, nm, course, { mach: spd.mach, ff, flags })
  return { to: 0, trueCourse: course, magCourse: course, magHeading: pr.heading, magVar: 0, nm, tas: pr.ktas, gs: pr.gs,
    ete: pr.min, ff, phase, climbMin: pr.climb?.min ?? 0, fuelUsed: pr.fuel, altFt, kias: spd.kias, mach: spd.mach, rpm,
    climb: pr.climb, descent: pr.descent, flags: pr.flags }
}

/** A leg at a fixed fuel flow per phase (aircraft without recorded data); the MIL climb is flown at the start of the first leg. */
function fixedLeg(wp: Waypoint, i: number, course: number, nm: number, s: PlanSettings): Leg {
  const tas = wp.tas ?? s.tas
  const phase = wp.ff === undefined ? phaseOf(s.aircraft, wp.phase ?? s.phase) : null
  const ff = wp.ff ?? phase!.ff ?? 0
  const wind = groundSpeed(course, tas, s)
  const ete = (nm / wind.gs) * 60
  const climbMin = i === 1 ? Math.min(Math.max(s.climbMin, 0), ete) : 0
  const fuelUsed = (fixedFf(s.aircraft, 'mil') * climbMin + ff * (ete - climbMin)) / 60
  return { to: i, trueCourse: course, magCourse: course, magHeading: wind.heading, magVar: 0, nm, tas, gs: wind.gs, ete, ff,
    phase, climbMin, fuelUsed, flags: [] }
}

/** Loiter at a waypoint: its own power, else whatever the leg in was flown at, else the plan default. */
function loiterAt(wp: Waypoint, leg: Leg | null, s: PlanSettings, altFt: number): Row['loiter'] {
  const min = wp.loiter?.min ?? 0
  if (!(min > 0)) return null
  const power = wp.loiter!.phase
  const phase = power ? phaseOf(s.aircraft, power) : leg ? leg.phase : phaseOf(s.aircraft, s.phase)
  const ff = loiterFf(s, power, leg, altFt)
  return { min, ff, phase, fuel: (ff * min) / 60 }
}

/** Loiter fuel flow, lb/hr. Combat loiter is (MIL + max AB) / 2; with recorded data, at the waypoint altitude and leg Mach. */
export function loiterFf(s: PlanSettings, power: LoiterPower | undefined, leg: Leg | null, altFt: number): number {
  const p = AIRCRAFT[s.aircraft].perf
  if (!p) {
    if (power === 'combat') return (fixedFf(s.aircraft, 'mil') + fixedFf(s.aircraft, 'ab')) / 2
    if (power) return fixedFf(s.aircraft, power)
    return leg ? (leg.phase?.ff ?? leg.ff) : fixedFf(s.aircraft, s.phase)
  }
  const mach = leg?.mach ?? 0.8
  if (power === 'mil') return powerFf(p, 'MIL', altFt, mach)
  if (power === 'ab') return powerFf(p, 'ABMAX', altFt, mach)
  if (power === 'combat') return (powerFf(p, 'MIL', altFt, mach) + powerFf(p, 'ABMAX', altFt, mach)) / 2
  if (power === 'cruise' || !leg) return cruiseAt(p, altFt, mach, dragFactor(p, s.drag), s.isaDev ?? 0).ff
  return leg.ff
}

/** A return home on the recorded tables: climb, cruise, descent. */
export interface HomeProfile {
  /** Cruise altitude, ft MSL, speed and power. */
  altFt: number
  kias: number
  mach: number
  ktas: number
  rpm: number | null
  ff: number
  climb: Segment | null
  /** Its nm is the top of descent, nm before base. */
  descent: Segment | null
  cruiseNm: number
  min: number
  fuel: number
  flags: PerfFlag[]
}

function homeProfile(p: PerfData, s: PlanSettings, fromFt: number, cruiseFt: number, toFt: number, distNm: number, course: number,
  speed: { kias: number } | { rpm: number }): HomeProfile {
  const f = dragFactor(p, s.drag), isa = s.isaDev ?? 0
  let mach: number, c: { ff: number; rpm: number | null; flags: PerfFlag[] }
  if ('rpm' in speed) {
    const l = levelAtRpm(p, cruiseFt, speed.rpm, f, isa)
    mach = l.mach
    c = l
  } else {
    mach = machFromKcas(speed.kias, cruiseFt)
    c = cruiseAt(p, cruiseFt, mach, f, isa)
  }
  const pr = profile(p, s, fromFt, cruiseFt, toFt, distNm, course, { mach, ff: c.ff, flags: c.flags })
  return { altFt: cruiseFt, kias: kcasFromMach(mach, cruiseFt), mach, ktas: pr.ktas, rpm: c.rpm, ff: c.ff, climb: pr.climb,
    descent: pr.descent, cruiseNm: pr.cruiseNm, min: pr.min, fuel: pr.fuel, flags: pr.flags }
}

/**
 * Best-range return: MIL climb to the altitude (up to the cap) that needs the least fuel for the distance, cruise
 * at 7.5 units AoA, idle descent to base. Altitudes whose climb and descent don't fit in the distance, or where the
 * jet (with its drag) can't hold that speed level, are skipped.
 */
export function bingoProfile(p: PerfData, s: PlanSettings, fromFt: number, toFt: number, distNm: number, course: number): HomeProfile {
  const cap = Math.max(s.bingoCapFt ?? DEFAULT_BINGO_CAP_FT, fromFt)
  const alts = [fromFt]
  for (let h = Math.ceil(fromFt / 1000) * 1000; h <= cap; h += 1000) if (h > fromFt) alts.push(h)
  let best: HomeProfile | null = null
  for (const h of alts) {
    const pr = homeProfile(p, s, fromFt, h, toFt, distNm, course, { kias: bestRangeKias(p, h) ?? defaultKias(p, h, s) })
    // Skip altitudes the return can't reach in the distance, or where the jet can't hold the speed level.
    if (h !== fromFt && (pr.flags.includes('short') || pr.flags.includes('fast'))) continue
    if (!best || pr.fuel < best.fuel) best = pr
  }
  return best!
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
    /** Fuel to fly home: high cruise, or the bingo profile with recorded data. */
    rtbFuel: number
    bingo: number
    /** 1 min of (max) afterburner at the target. */
    abLoiter: number
    /** The 30 nm escape: AB, or 95 % RPM low level with recorded data. */
    abEgress: number
    /** The rest of the way home after the escape. */
    cruiseHome: number
    joker: number
  }
  /** The profiles behind joker and bingo (recorded data). */
  profiles?: {
    reserve: number
    /** Drag category the bingo was worked out at. */
    bingoDrag: string
    bingo: HomeProfile
    joker: {
      loiter: number
      ab: number
      escape: { altFt: number; nm: number; kias: number; ktas: number; rpm: number; ff: number; fuel: number; flags: PerfFlag[] }
      home: HomeProfile
    }
  }
}

/** The drag category the bingo uses: the aircraft's bingo category when the data has it, else the plan's. */
export function bingoDragOf(s: PlanSettings): string {
  const a = AIRCRAFT[s.aircraft]
  const known = a.perf?.configs.some((c) => c.name === a.bingoDrag && c.factor !== null)
  return (known ? a.bingoDrag : undefined) ?? s.drag ?? NO_STORES
}

/** Escape distance in the joker definition, nm. */
export const JOKER_AB_EGRESS_NM = 30
/** Joker with recorded data: escape at this RPM and height above the target, then home at this RPM and altitude. */
export const JOKER_ESCAPE_RPM = 95
export const JOKER_ESCAPE_AGL = 500
export const JOKER_RETURN_FT = 20000
/** Minutes of max AB in the target area, in the joker. */
export const JOKER_AB_MIN = 1

/**
 * Squadron definitions, fuel state at the target or CAP station.
 *
 * With recorded data (rows give the planned loiter there):
 * - Bingo: the best-range return (climb to the best altitude up to the cap, 7.5 units AoA, idle descent) plus the
 *   landing reserve, at the aircraft's bingo drag category (F-4E: BFM Only) whatever the plan's category.
 * - Joker: the planned loiter, 1 minute of max AB, a 30 nm escape at 95 % RPM at 500 ft above the target, a MIL climb
 *   to 20,000 ft, home at 95 % RPM, idle descent, plus the landing reserve. Never below bingo.
 *
 * Without (fixed fuel flows):
 * - Bingo: the higher of the bingo floor and the fuel to fly home direct at the most efficient cruise.
 * - Joker: 1 minute of afterburner in the target area, afterburner until 30 nm out, then most efficient cruise home.
 *   Never below bingo.
 */
export function fuelPlan(route: Waypoint[], s: PlanSettings, rows?: Row[]): FuelPlan | null {
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

  if (a.perf) {
    const p = a.perf
    const alts = routeAltitudes(route)
    const baseFt = alts[alts.length - 1]
    const reserve = a.bingoFloor
    const bingoDrag = bingoDragOf(s)
    const home = bingoProfile(p, { ...s, drag: bingoDrag }, alts[target], baseFt, rtbNm, az)
    const bingo = home.fuel + reserve
    const loiter = rows?.[target]?.loiter?.fuel ?? 0
    const ab = (powerFf(p, 'ABMAX', alts[target], rows?.[target]?.leg?.mach ?? 0.9) * JOKER_AB_MIN) / 60
    const isa = s.isaDev ?? 0
    const escFt = (t.elevFt ?? 0) + JOKER_ESCAPE_AGL
    const esc = levelAtRpm(p, escFt, JOKER_ESCAPE_RPM, dragFactor(p, s.drag), isa)
    const escKtas = ktasFromMach(esc.mach, escFt, isa)
    const escNm = Math.min(JOKER_AB_EGRESS_NM, rtbNm)
    const escFuel = (escNm / groundSpeed(az, escKtas, s).gs) * esc.ff
    const back = homeProfile(p, s, escFt, Math.max(JOKER_RETURN_FT, escFt), baseFt, rtbNm - escNm, az, { rpm: JOKER_ESCAPE_RPM })
    const joker = Math.max(bingo, loiter + ab + escFuel + back.fuel + reserve)
    return {
      target, targetKind, rtbNm,
      bingo: s.bingoOverride ?? bingo,
      joker: s.jokerOverride ?? joker,
      calc: { rtbFuel: home.fuel, bingo, abLoiter: ab, abEgress: escFuel, cruiseHome: back.fuel, joker },
      profiles: {
        reserve,
        bingoDrag,
        bingo: home,
        joker: { loiter, ab, home: back,
          escape: { altFt: escFt, nm: escNm, kias: kcasFromMach(esc.mach, escFt), ktas: escKtas, rpm: JOKER_ESCAPE_RPM, ff: esc.ff,
            fuel: escFuel, flags: esc.flags } },
      },
    }
  }

  const cruiseFf = Math.min(...a.phases.map((ph) => ph.ff ?? Infinity))
  const abFf = fixedFf(s.aircraft, 'ab')
  const gsCruise = groundSpeed(az, s.tas, s).gs
  const gsAb = groundSpeed(az, s.abTas, s).gs
  const rtbFuel = (rtbNm / gsCruise) * cruiseFf
  const bingo = Math.max(a.bingoFloor, rtbFuel)
  const abLoiter = abFf / 60
  const egressNm = Math.min(JOKER_AB_EGRESS_NM, rtbNm)
  const abEgress = (egressNm / gsAb) * abFf
  const cruiseHome = ((rtbNm - egressNm) / gsCruise) * cruiseFf
  const joker = Math.max(bingo, abLoiter + abEgress + cruiseHome)

  return {
    target, targetKind, rtbNm,
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
export function attackRun(m: MissionExport, route: Waypoint[], s: PlanSettings, rows?: Row[]): AttackRun | null {
  const tgt = route.findIndex((w) => w.tags?.includes('TGT'))
  if (tgt < 1) return null
  let ip = tgt - 1
  for (let i = tgt - 1; i >= 0; i--) if (route[i].tags?.includes('IP')) { ip = i; break }
  const a = route[ip]
  const t = route[tgt]
  const { az, nm } = inverse(a.lat, a.lon, t.lat, t.lon)
  return { ip, tgt, ipNm: nm, magCourse: norm360(az - magVarAt(m, a)),
    tas: rows?.[tgt]?.leg?.tas ?? t.tas ?? s.tas, elevFt: t.elevFt }
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
