// Fuel flow, RPM and climb / descent figures from recorded DCS performance data (dcs-perf-recorder,
// `perfrec.py export` -> src/data/perf/<aircraft>.json). The same numbers as the squadron performance manual.
//
// Level cruise: No Stores level points per altitude band, standard day. A lookup interpolates along Mach within
// a band and then between bands. Loaded jets use their own level points (curves per altitude band, recorded at
// 7.5 units AoA or less) where they were flown. At a band without a loaded curve they use the drag category factor:
// at the same RPM a loaded jet holds KIAS / sqrt(factor), so its fuel flow and RPM at a speed are the No Stores
// values at KIAS x sqrt(factor). A band with one loaded point takes the factor that point gives.
// Temperature: at the same Mach and pressure altitude, TAS, fuel flow and RPM scale with sqrt(T / T_std).

import f4e from '../data/perf/F-4E.json'
import { isaTempK, kcasFromMach, machFromKcas } from './atmo'

export interface LevelPoint {
  rpm: number | null
  ktas: number
  kias: number
  mach: number
  ff: number
  grade: string | null
}

export interface Band {
  alt_ft: number
  points: LevelPoint[]
  /** Spans of KTAS wider than 100 kt with no level point. */
  gaps: [number, number][]
  /** Level speed at 7.5 units AoA (best range); 20,000 ft and up. */
  cruise_aoa?: { kias: number; ktas: number; mach: number; ff: number; rpm: number; wide: boolean }
}

export interface ProfileRow {
  alt_ft: number
  min: number
  nm: number
  lb: number
}

export interface PerfData {
  schema: number
  aircraft: string
  generated_utc: string
  basis: string
  disclaimer: string
  bands: Band[]
  /** Drag categories; `bands`: the category's own level points per altitude band (7.5 units AoA or less). */
  configs: { name: string; factor: number | null; loadout: string | null; bands?: { alt_ft: number; points: LevelPoint[] }[] }[]
  /** MIL climb, cumulative from the first row's altitude up. */
  climb: ProfileRow[] | null
  /** Idle descent, cumulative from an altitude down to the first row's altitude. */
  descent: ProfileRow[] | null
  ground: { idle_lb_min: number | null; takeoff: { kias: number; min: number; lb: number; nm: number } | null }
  /** [alt ft, Mach, lb/hr] points recorded at MIL and at max afterburner. */
  power: Record<'MIL' | 'ABMAX', [number, number, number][]>
}

export const PERF: Record<string, PerfData | undefined> = { 'F-4E': f4e as unknown as PerfData }

/** Planning flags shown on the nav log. */
export type PerfFlag =
  | 'wide' // interpolated across a wide gap in the data
  | 'fast' // above the fastest level speed recorded (95 % RPM); plan MIL or AB
  | 'slow' // below the slowest level speed recorded
  | 'high' // above the highest altitude recorded
  | 'short' // the climb or descent does not fit in the leg
  | 'est' // loaded climb: No Stores climb scaled by the drag factor (no loaded climb recorded yet)

export const NO_STORES = 'No Stores'

/** Drag categories, lowest drag first. */
export function dragCategories(p: PerfData): { name: string; factor: number; loadout: string | null }[] {
  return p.configs.filter((c) => c.factor !== null)
    .map((c) => ({ name: c.name, factor: c.factor!, loadout: c.loadout }))
    .sort((a, b) => a.factor - b.factor)
}

export function dragFactor(p: PerfData, name: string | undefined): number {
  return p.configs.find((c) => c.name === (name ?? NO_STORES))?.factor ?? 1
}

/** A drag category for the cruise lookups: its overall factor and its own level-point curves by altitude band. */
export interface Drag {
  factor: number
  bands: { alt_ft: number; points: LevelPoint[] }[]
}

export function dragOf(p: PerfData, name: string | undefined): Drag {
  const c = p.configs.find((x) => x.name === (name ?? NO_STORES))
  return { factor: c?.factor ?? 1, bands: (c?.bands ?? []).filter((b) => b.points.length > 0) }
}

const asDrag = (d: number | Drag): Drag => (typeof d === 'number' ? { factor: d, bands: [] } : d)

const lerp = (a: number, b: number, f: number) => a + (b - a) * f

/** Temperature ratio sqrt(T / T_std): TAS, fuel flow and RPM at a fixed Mach scale with it. */
export function tempScale(altFt: number, isaDev = 0): number {
  const t = isaTempK(altFt)
  return Math.sqrt((t + isaDev) / t)
}

interface BandValue { ff: number; rpm: number | null; slow: boolean; fast: boolean; wide: boolean }

/** Standard-day fuel flow and RPM at a Mach within one band; clamped to the slowest / fastest point. */
function inBand(b: Band, mach: number): BandValue {
  const pts = [...b.points].sort((x, y) => x.mach - y.mach)
  const first = pts[0], last = pts[pts.length - 1]
  if (mach <= first.mach) return { ff: first.ff, rpm: first.rpm, slow: mach < first.mach - 0.005, fast: false, wide: false }
  if (mach >= last.mach) return { ff: last.ff, rpm: last.rpm, slow: false, fast: mach > last.mach + 0.005, wide: false }
  const i = pts.findIndex((q) => q.mach >= mach)
  const a = pts[i - 1], c = pts[i]
  const f = (mach - a.mach) / (c.mach - a.mach)
  const rpm = a.rpm !== null && c.rpm !== null ? lerp(a.rpm, c.rpm, f) : (a.rpm ?? c.rpm)
  return { ff: lerp(a.ff, c.ff, f), rpm, slow: false, fast: false, wide: c.ktas - a.ktas > 100 }
}

/** The two bands either side of an altitude and the blend between them (clamped at the ends). */
function bracket(p: PerfData, altFt: number): { lo: Band; hi: Band; f: number } {
  const bands = p.bands
  if (altFt <= bands[0].alt_ft) return { lo: bands[0], hi: bands[0], f: 0 }
  const top = bands[bands.length - 1]
  if (altFt >= top.alt_ft) return { lo: top, hi: top, f: 0 }
  const i = bands.findIndex((b) => b.alt_ft >= altFt)
  const lo = bands[i - 1], hi = bands[i]
  return { lo, hi, f: (altFt - lo.alt_ft) / (hi.alt_ft - lo.alt_ft) }
}

/** Highest altitude with data; a little above it is still accepted without a flag. */
const topAlt = (p: PerfData) => p.bands[p.bands.length - 1].alt_ft + 1500

export interface Cruise {
  /** lb/hr at the planned temperature. */
  ff: number
  /** % RPM to set, at the planned temperature; null when the data has no RPM there. */
  rpm: number | null
  flags: PerfFlag[]
}

/**
 * How a loaded jet maps onto a No Stores band away from its own curve: a factor (at the same RPM it holds
 * KIAS / sqrt(factor) and burns the same fuel), with fuel flow and RPM scaled so the anchor point comes back as
 * recorded. Anchored on the nearest end of the loaded curve, or on the category's overall factor without one.
 */
interface Anchor { factor: number; ffScale: number; rpmScale: number }

function anchorOn(band: Band, q: LevelPoint): Anchor {
  const factor = (kcasFromMach(machAtRpm(band, q.rpm!).mach, band.alt_ft) / kcasFromMach(q.mach, band.alt_ft)) ** 2
  const clean = inBand(band, machFromKcas(kcasFromMach(q.mach, band.alt_ft) * Math.sqrt(factor), band.alt_ft))
  return { factor, ffScale: q.ff / clean.ff, rpmScale: clean.rpm ? q.rpm! / clean.rpm : 1 }
}

/** The loaded curve at a No Stores band (points with RPM, by Mach); empty without one. */
function curveAt(band: Band, drag: Drag): LevelPoint[] {
  const own = drag.bands.find((b) => b.alt_ft === band.alt_ft)
  return (own?.points ?? []).filter((q) => q.rpm !== null).sort((x, y) => x.mach - y.mach)
}

/** Standard-day value at one band for a loaded (or clean) jet, with that band's envelope in the asked-for Mach. */
function atBand(band: Band, drag: Drag, altFt: number, mach: number): BandValue & { lo: number; hi: number } {
  const pts = curveAt(band, drag)
  const ms = band.points.map((q) => q.mach)
  const toClean = (f: number) => (f === 1 ? mach : machFromKcas(kcasFromMach(mach, altFt) * Math.sqrt(f), altFt))
  if (pts.length >= 2 && mach >= pts[0].mach && mach <= pts[pts.length - 1].mach) {
    // On the loaded curve.
    const m = toClean(drag.factor)
    return { ...inBand({ alt_ft: band.alt_ft, points: pts, gaps: [] }, mach), lo: Math.min(...ms) - (m - mach), hi: Math.max(...ms) - (m - mach) }
  }
  const a: Anchor = pts.length === 0 ? { factor: drag.factor, ffScale: 1, rpmScale: 1 }
    : anchorOn(band, mach < pts[0].mach ? pts[0] : pts[pts.length - 1])
  const m = toClean(a.factor)
  const v = inBand(band, m)
  return { ...v, ff: v.ff * a.ffScale, rpm: v.rpm === null ? null : v.rpm * a.rpmScale, lo: Math.min(...ms) - (m - mach), hi: Math.max(...ms) - (m - mach) }
}

/**
 * Level cruise at a Mach and pressure altitude: fuel flow and the RPM that holds it, for a drag category or factor
 * (1 = No Stores) and ISA deviation.
 */
export function cruiseAt(p: PerfData, altFt: number, mach: number, drag: number | Drag = 1, isaDev = 0): Cruise {
  const d = asDrag(drag)
  const { lo, hi, f } = bracket(p, altFt)
  const a = atBand(lo, d, altFt, mach), b = atBand(hi, d, altFt, mach)
  const k = tempScale(altFt, isaDev)
  const rpm = a.rpm !== null && b.rpm !== null ? lerp(a.rpm, b.rpm, f) : (a.rpm ?? b.rpm)
  const flags: PerfFlag[] = []
  // Each band clamps at its own envelope: flag when the blended envelope is exceeded.
  if (mach < lerp(a.lo, b.lo, f) - 0.005) flags.push('slow')
  if (mach > lerp(a.hi, b.hi, f) + 0.005) flags.push('fast')
  if ((a.wide && f < 1) || (b.wide && f > 0)) flags.push('wide')
  if (altFt > topAlt(p)) flags.push('high')
  return { ff: lerp(a.ff, b.ff, f) * k, rpm: rpm === null ? null : rpm * k, flags }
}

/** Standard-day Mach where a band holds a corrected RPM level (front side of the drag curve). */
function machAtRpm(b: Band, rpm: number): { mach: number; fast: boolean } {
  const pts = b.points.filter((q) => q.rpm !== null).sort((x, y) => x.mach - y.mach)
  const last = pts[pts.length - 1]
  if (rpm >= last.rpm!) return { mach: last.mach, fast: rpm > last.rpm! + 0.3 }
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1], c = pts[i]
    if (a.rpm! <= rpm && rpm <= c.rpm! && c.rpm! > a.rpm!) return { mach: lerp(a.mach, c.mach, (rpm - a.rpm!) / (c.rpm! - a.rpm!)), fast: false }
  }
  return { mach: pts[0].mach, fast: false }
}

/** Level speed (Mach) and fuel flow at a set RPM, altitude, drag category or factor and temperature. */
export function levelAtRpm(p: PerfData, altFt: number, rpm: number, drag: number | Drag = 1, isaDev = 0): Cruise & { mach: number } {
  const d = asDrag(drag)
  const corrected = rpm / tempScale(altFt, isaDev)
  const { lo, hi, f } = bracket(p, altFt)
  // At each band: the loaded curve's Mach at the RPM, or the No Stores Mach slowed by the factor (same RPM, same
  // fuel flow, KIAS / sqrt(factor)).
  const at = (band: Band) => {
    const pts = curveAt(band, d)
    if (pts.length >= 2) {
      const rpms = pts.map((q) => q.rpm!)
      if (corrected >= Math.min(...rpms) && corrected <= Math.max(...rpms)) return machAtRpm({ alt_ft: band.alt_ft, points: pts, gaps: [] }, corrected)
    }
    const a: Anchor = pts.length === 0 ? { factor: d.factor, ffScale: 1, rpmScale: 1 }
      : anchorOn(band, corrected < pts[0].rpm! ? pts[0] : pts[pts.length - 1])
    const r = machAtRpm(band, corrected / a.rpmScale)
    const mach = a.factor === 1 ? r.mach : machFromKcas(kcasFromMach(r.mach, altFt) / Math.sqrt(a.factor), altFt)
    return { mach, fast: r.fast }
  }
  const a = at(lo), b = at(hi)
  const mach = lerp(a.mach, b.mach, f)
  const c = cruiseAt(p, altFt, mach, d, isaDev)
  const flags: PerfFlag[] = c.flags.filter((x) => x !== 'fast' && x !== 'slow')
  if (a.fast || b.fast) flags.push('fast')
  return { mach, ff: c.ff, rpm, flags }
}

/** Best-range speed (7.5 units AoA), KIAS, at an altitude. Below the lowest band that has one, that band's speed. */
export function bestRangeKias(p: PerfData, altFt: number): number | undefined {
  const pts = p.bands.filter((b) => b.cruise_aoa).map((b) => ({ alt: b.alt_ft, kias: b.cruise_aoa!.kias }))
  if (pts.length === 0) return undefined
  if (altFt <= pts[0].alt) return pts[0].kias
  const last = pts[pts.length - 1]
  if (altFt >= last.alt) return last.kias
  const i = pts.findIndex((q) => q.alt >= altFt)
  return lerp(pts[i - 1].kias, pts[i].kias, (altFt - pts[i - 1].alt) / (pts[i].alt - pts[i - 1].alt))
}

/**
 * Fuel flow at MIL or max AB, lb/hr: inverse-distance blend of the four nearest recorded points
 * (1,000 ft ~ 0.02 Mach). Not corrected for temperature.
 */
export function powerFf(p: PerfData, state: 'MIL' | 'ABMAX', altFt: number, mach: number): number {
  const near = p.power[state]
    .map(([alt, m, ff]) => ({ d: Math.hypot((alt - altFt) / 10000, (m - mach) / 0.2), ff }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 4)
  if (near[0].d < 1e-6) return near[0].ff
  const w = near.map((q) => 1 / (q.d * q.d))
  return near.reduce((s, q, i) => s + q.ff * w[i], 0) / w.reduce((s, x) => s + x, 0)
}

export interface ClimbDescent {
  /** Minutes, still-air nm and lb. */
  min: number
  nm: number
  lb: number
  flags: PerfFlag[]
}

function cumulative(rows: ProfileRow[], altFt: number): Omit<ProfileRow, 'alt_ft'> {
  if (altFt <= rows[0].alt_ft) return { min: 0, nm: 0, lb: 0 }
  const last = rows[rows.length - 1]
  if (altFt >= last.alt_ft) return { min: last.min, nm: last.nm, lb: last.lb }
  const i = rows.findIndex((r) => r.alt_ft >= altFt)
  const a = rows[i - 1], b = rows[i]
  const f = (altFt - a.alt_ft) / (b.alt_ft - a.alt_ft)
  return { min: lerp(a.min, b.min, f), nm: lerp(a.nm, b.nm, f), lb: lerp(a.lb, b.lb, f) }
}

/**
 * MIL climb between two altitudes. No loaded climb has been recorded yet, so a loaded jet takes the
 * No Stores climb with time, distance and fuel x sqrt(drag factor), flagged as an estimate.
 */
export function climb(p: PerfData, fromFt: number, toFt: number, factor = 1): ClimbDescent {
  if (!p.climb || toFt <= fromFt) return { min: 0, nm: 0, lb: 0, flags: [] }
  const a = cumulative(p.climb, fromFt), b = cumulative(p.climb, toFt)
  const k = Math.sqrt(factor)
  const flags: PerfFlag[] = factor > 1 ? ['est'] : []
  if (toFt > p.climb[p.climb.length - 1].alt_ft + 500) flags.push('high')
  return { min: (b.min - a.min) * k, nm: (b.nm - a.nm) * k, lb: (b.lb - a.lb) * k, flags }
}

/** Idle descent between two altitudes (No Stores; drag shortens it a little, so this is on the safe side for fuel). */
export function descent(p: PerfData, fromFt: number, toFt: number): ClimbDescent {
  if (!p.descent || toFt >= fromFt) return { min: 0, nm: 0, lb: 0, flags: [] }
  const a = cumulative(p.descent, fromFt), b = cumulative(p.descent, toFt)
  return { min: a.min - b.min, nm: a.nm - b.nm, lb: a.lb - b.lb, flags: [] }
}
