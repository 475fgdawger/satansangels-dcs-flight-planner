// What a flight's mission briefing sheet says, worked out from the plan and the mission export: times, the
// departure, recovery and divert fields, the target, threats along the route and fuel. The page itself is
// src/ui/Briefing.tsx.

import { inverse } from './geodesy'
import { airfields, magVarAt, M_TO_FT, nearRef, runwayPairs, tacanFix } from './mission'
import { threatRing } from './map'
import { missionFuel, type AttackRun, type FuelPlan, type PlanSettings, type Row } from './plan'
import type { Airbase, LatLon, MissionExport, Target } from './types'

/** A waypoint this close (nm) to an airfield or target is that place. */
const SAME_NM = 3
/** Threats whose ring comes this close (nm) to the route are listed. */
const THREAT_MARGIN_NM = 10

export interface FieldInfo {
  name: string
  code: string
  elevFt: number
  runways: string
  /** DCS ATC frequencies, e.g. "122.100 AM". */
  freqs: string[]
  /** TACAN on the field, e.g. "DAN 21X". */
  tacan?: string
}

export interface Divert extends FieldInfo {
  /** From the destination: magnetic bearing and distance. */
  magBearing: number
  nm: number
}

export interface ThreatInfo {
  name: string
  system: string
  ringNm: number
  /** Closest the planned route passes, nm, and the leg it happens on (route index of its end). */
  closestNm: number
  leg: number
  inside: boolean
  tacan: string
}

export interface TimePoint {
  /** Minutes after takeoff. */
  elapsed: number
  /** Seconds after midnight, when a takeoff time is planned. */
  clock: number | null
}

export interface Briefing {
  date: string
  /** Mission start, seconds after midnight. */
  missionStart: number
  takeoff: number | null
  tot: (TimePoint & { name: string; kind: FuelPlan['targetKind'] }) | null
  land: TimePoint
  totalNm: number
  departure: FieldInfo | null
  destination: FieldInfo | null
  divert: Divert | null
  target: (LatLon & { name: string; kind?: string; elevFt?: number; tacan: string; near: string; group?: string | null }) | null
  attack: { ip: string; ipNm: number; magCourse: number } | null
  /** Route indexes of the attack: IP, target and egress point. */
  attackLegs: { ip: number; tgt: number; ep: number } | null
  threats: ThreatInfo[]
  fuel: { start: number; required: number | null; margin: number | null; joker: number | null; bingo: number | null }
}

const fieldAt = (m: MissionExport, p: LatLon): Airbase | undefined =>
  airfields(m).find((a) => inverse(a.lat, a.lon, p.lat, p.lon).nm < SAME_NM)

function fieldInfo(m: MissionExport, a: Airbase): FieldInfo {
  const tacan = m.tacans.find((t) => inverse(t.lat, t.lon, a.lat, a.lon).nm < SAME_NM)
  return {
    name: a.name,
    code: a.code,
    elevFt: Math.round(a.elev_m * M_TO_FT),
    runways: runwayPairs(a.runways).join(', '),
    freqs: a.frequencies_hz.map(([hz, mod]) => `${(hz / 1e6).toFixed(3)} ${mod === 1 ? 'FM' : 'AM'}`),
    tacan: tacan && `${tacan.id} ${tacan.chan}`,
  }
}

/** Closest approach (nm) of the leg a->b to a point, sampled every half mile or so. */
function closestOnLeg(a: LatLon, b: LatLon, p: LatLon): number {
  const len = inverse(a.lat, a.lon, b.lat, b.lon).nm
  const n = Math.max(1, Math.ceil(len * 2))
  let best = Infinity
  for (let i = 0; i <= n; i++) {
    const f = i / n
    // Linear in lat/lon is close enough to the great circle over one leg for a threat check.
    const q = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }
    best = Math.min(best, inverse(q.lat, q.lon, p.lat, p.lon).nm)
  }
  return best
}

/** SAMs and AAA whose rings come within THREAT_MARGIN_NM of the route, nearest to their ring first. */
export function routeThreats(m: MissionExport, rows: Row[]): ThreatInfo[] {
  const out: ThreatInfo[] = []
  for (const t of m.targets) {
    const ring = threatRing(t)
    if (!ring) continue
    let closest = Infinity, leg = 0
    for (let i = 1; i < rows.length; i++) {
      const d = closestOnLeg(rows[i - 1].wp, rows[i].wp, t)
      if (d < closest) { closest = d; leg = i }
    }
    if (closest > ring.nm + THREAT_MARGIN_NM) continue
    out.push({ name: t.name, system: ring.system, ringNm: ring.nm, closestNm: closest, leg, inside: closest < ring.nm, tacan: t.tacan })
  }
  return out.sort((a, b) => (a.closestNm - a.ringNm) - (b.closestNm - b.ringNm))
}

/** The egress point: the first waypoint marked EP after the target, else the waypoint after it. */
export function egressIndex(rows: Row[], tgt: number): number {
  for (let i = tgt + 1; i < rows.length; i++) if (rows[i].wp.tags?.includes('EP')) return i
  return Math.min(tgt + 1, rows.length - 1)
}

const timeAt = (r: Row): TimePoint => ({ elapsed: r.elapsed, clock: r.eta })

export function briefing(m: MissionExport, rows: Row[], s: PlanSettings, fuel: FuelPlan | null, run: AttackRun | null): Briefing {
  const first = rows[0], last = rows[rows.length - 1]
  const dep = first && fieldAt(m, first.wp)
  const dest = last && rows.length > 1 ? fieldAt(m, last.wp) : undefined

  let divert: Divert | null = null
  if (dest) {
    const mv = magVarAt(m, dest)
    const near = airfields(m)
      .filter((a) => a.name !== dest.name)
      .map((a) => ({ a, ...inverse(dest.lat, dest.lon, a.lat, a.lon) }))
      .sort((x, y) => x.nm - y.nm)[0]
    if (near) divert = { ...fieldInfo(m, near.a), magBearing: (near.az - mv + 360) % 360, nm: near.nm }
  }

  let target: Briefing['target'] = null
  const tgtRow = fuel ? rows[fuel.target] : undefined
  if (tgtRow) {
    const p = tgtRow.wp
    const known: Target | undefined = m.targets.find((t) => inverse(t.lat, t.lon, p.lat, p.lon).nm < 0.5)
    target = {
      name: p.name, lat: p.lat, lon: p.lon,
      kind: known?.kind, group: known?.group,
      elevFt: p.elevFt ?? known?.elev_ft,
      tacan: tacanFix(m, p),
      near: nearRef(m, p, magVarAt(m, p)),
    }
  }

  const need = missionFuel(rows, s)
  return {
    date: m.mission.date.slice(0, 10),
    missionStart: m.mission.start_time,
    takeoff: s.takeoff ?? null,
    tot: tgtRow && fuel ? { ...timeAt(tgtRow), name: tgtRow.wp.name, kind: fuel.targetKind } : null,
    land: last ? timeAt(last) : { elapsed: 0, clock: null },
    totalNm: last?.totalNm ?? 0,
    departure: dep ? fieldInfo(m, dep) : null,
    destination: dest ? fieldInfo(m, dest) : null,
    divert,
    target,
    attack: run ? { ip: rows[run.ip].wp.name, ipNm: run.ipNm, magCourse: run.magCourse } : null,
    attackLegs: run ? { ip: run.ip, tgt: run.tgt, ep: egressIndex(rows, run.tgt) } : null,
    threats: routeThreats(m, rows),
    fuel: {
      start: s.startFuel,
      required: need?.required ?? null,
      margin: need?.margin ?? null,
      joker: fuel?.joker ?? null,
      bingo: fuel?.bingo ?? null,
    },
  }
}
