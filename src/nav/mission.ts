// Mission data helpers: validating the export, the list of pickable points,
// mag var at any point, and the TACAN fix / nearby reference for a waypoint.

import { direct, inverse, norm360 } from './geodesy'
import { compass16, heading3 } from './format'
import type { Airbase, LatLon, MissionExport, Tacan } from './types'

export const SUPPORTED_SCHEMA = 1

export function parseMission(json: unknown): MissionExport {
  const m = json as Partial<MissionExport>
  if (!m || typeof m !== 'object' || !m.mission || !Array.isArray(m.tacans)) {
    throw new Error('Not a target list export (missing mission or tacans).')
  }
  if (m.schema !== SUPPORTED_SCHEMA) {
    throw new Error(`Export schema ${m.schema} is not supported (expected ${SUPPORTED_SCHEMA}).`)
  }
  return {
    ...m,
    targets: m.targets ?? [],
    places: m.places ?? [],
    zones: m.zones ?? [],
    labels: m.labels ?? [],
    airbases: m.airbases ?? [],
  } as MissionExport
}

/** The export lists helipads and oil rigs as "Airbase"; only entries with runways are airfields. */
export const airfields = (m: MissionExport): Airbase[] => m.airbases.filter((a) => a.runways.length > 0)

export type PointKind = 'airfield' | 'tacan' | 'target' | 'zone' | 'label' | 'place'

export interface CatalogPoint extends LatLon {
  key: string
  name: string
  kind: PointKind
  detail: string
}

const KIND_LABEL: Record<PointKind, string> = {
  airfield: 'Airfield',
  tacan: 'TACAN',
  target: 'Target',
  zone: 'Zone',
  label: 'Map label',
  place: 'Place',
}

export const kindLabel = (k: PointKind) => KIND_LABEL[k]

/** Every named point a waypoint can be picked from. Zones that duplicate a target are dropped. */
export function catalog(m: MissionExport): CatalogPoint[] {
  const out: CatalogPoint[] = []
  for (const a of airfields(m)) {
    out.push({ key: `airfield:${a.name}`, name: a.name, kind: 'airfield', lat: a.lat, lon: a.lon,
      detail: [a.code, `RWY ${runwayPairs(a.runways).join(', ')}`].filter(Boolean).join(' · ') })
  }
  for (const t of m.tacans) {
    out.push({ key: `tacan:${t.id}`, name: t.id, kind: 'tacan', lat: t.lat, lon: t.lon, detail: `TACAN ${t.chan}` })
  }
  const targetNames = new Set(m.targets.map((t) => t.name))
  for (const t of m.targets) {
    out.push({ key: `target:${t.name}`, name: t.name, kind: 'target', lat: t.lat, lon: t.lon, detail: `${t.section} · ${t.near}` })
  }
  for (const z of m.zones) {
    if (targetNames.has(z.name)) continue
    out.push({ key: `zone:${z.name}`, name: z.name, kind: 'zone', lat: z.lat, lon: z.lon, detail: 'Mission zone' })
  }
  for (const l of m.labels) {
    out.push({ key: `label:${l.text}:${l.lat.toFixed(4)}`, name: l.text, kind: 'label', lat: l.lat, lon: l.lon, detail: 'Map label' })
  }
  for (const p of m.places) {
    out.push({ key: `place:${p.name}`, name: p.name, kind: 'place', lat: p.lat, lon: p.lon, detail: 'Place' })
  }
  return out
}

/** "23","05" -> "05/23"; keeps parallel runways (05L/23R) together. */
export function runwayPairs(runways: string[]): string[] {
  const seen = new Set<string>()
  const pairs: string[] = []
  for (const r of runways) {
    if (seen.has(r)) continue
    const num = parseInt(r, 10)
    const side = r.replace(/^\d+/, '')
    const oppSide = side === 'L' ? 'R' : side === 'R' ? 'L' : side
    const opp = `${String(((num + 17) % 36) + 1).padStart(2, '0')}${oppSide}`
    seen.add(r)
    if (runways.includes(opp)) {
      seen.add(opp)
      pairs.push([r, opp].sort().join('/'))
    } else {
      pairs.push(r)
    }
  }
  return pairs.sort()
}

/**
 * Mag var (deg, east positive) at a point: inverse-distance weighting of the
 * nearest points where the export gives DCS's own value.
 */
export function magVarAt(m: MissionExport, p: LatLon): number {
  const known: { lat: number; lon: number; mv: number }[] = [
    ...m.tacans.map((t) => ({ lat: t.lat, lon: t.lon, mv: t.mag_var })),
    ...m.targets.map((t) => ({ lat: t.lat, lon: t.lon, mv: t.mag_var })),
    ...airfields(m).map((a) => ({ lat: a.lat, lon: a.lon, mv: a.mag_var })),
  ].filter((k) => Number.isFinite(k.mv))
  if (known.length === 0) return m.mag_var.fallback

  const nearest = known
    .map((k) => ({ mv: k.mv, nm: inverse(p.lat, p.lon, k.lat, k.lon).nm }))
    .sort((a, b) => a.nm - b.nm)
    .slice(0, 4)
  if (nearest[0].nm < 0.5) return nearest[0].mv
  let wSum = 0, mvSum = 0
  for (const n of nearest) {
    const w = 1 / (n.nm * n.nm)
    wSum += w
    mvSum += w * n.mv
  }
  return mvSum / wSum
}

/** Stations used for fixes: all of them when there are two or fewer, else the two nearest. */
export function fixStations(m: MissionExport, p: LatLon): Tacan[] {
  if (m.tacans.length <= 2) return m.tacans
  return [...m.tacans]
    .map((t) => ({ t, nm: inverse(t.lat, t.lon, p.lat, p.lon).nm }))
    .sort((a, b) => a.nm - b.nm)
    .slice(0, 2)
    .map((x) => x.t)
}

/** Magnetic radial FROM the station (station's mag var) and DME, e.g. "DAN 287/99". */
export function tacanFixFrom(t: Tacan, p: LatLon): string {
  const { az, nm } = inverse(t.lat, t.lon, p.lat, p.lon)
  return `${t.id} ${heading3(az - t.mag_var)}/${Math.round(nm)}`
}

export function tacanFix(m: MissionExport, p: LatLon): string {
  return fixStations(m, p).map((t) => tacanFixFrom(t, p)).join(', ')
}

/** "8 nm NNW of Aleppo" using the nearest place (compass direction uses mag var at the point). */
export function nearRef(m: MissionExport, p: LatLon, magVar: number): string {
  let best: { name: string; az: number; nm: number } | null = null
  for (const pl of m.places) {
    const { az, nm } = inverse(pl.lat, pl.lon, p.lat, p.lon)
    if (!best || nm < best.nm) best = { name: pl.name, az, nm }
  }
  if (!best) return ''
  const nm = Math.round(best.nm)
  return nm === 0 ? `at ${best.name}` : `${nm} nm ${compass16(norm360(best.az - magVar))} of ${best.name}`
}

/** Parse a typed TACAN fix like "DAN 287/99" or "DAN287099" into a position. */
export function parseTacanFix(m: MissionExport, text: string): LatLon | null {
  const t = text.trim().toUpperCase()
  const match = t.match(/^([A-Z]{2,3})\s*(\d{3})\s*[/\s]?\s*(\d+(?:\.\d+)?)$/) ?? t.match(/^([A-Z]{2,3})\s+(\d{1,3})\s*\/\s*(\d+(?:\.\d+)?)$/)
  if (!match) return null
  const st = m.tacans.find((s) => s.id === match[1])
  if (!st) return null
  const radial = Number(match[2])
  const nm = Number(match[3])
  if (radial > 360 || nm > 400) return null
  return direct(st.lat, st.lon, norm360(radial + st.mag_var), nm)
}
