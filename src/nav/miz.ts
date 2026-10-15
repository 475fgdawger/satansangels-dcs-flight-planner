// Writes a planned route into aircraft groups of a DCS mission (.miz). Only each chosen group's
// route.points table is replaced; the rest of the mission file is kept byte for byte.
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { isTable, luaGet, luaList, luaString, parseLuaAssignments, type LuaTable, type LuaValue } from './lua'
import { hasGrid, toDcs } from './dcsgrid'
import { routeAltitudes, type Row } from './plan'
import airdromes from '../data/airdromes.json'

const FT_TO_M = 0.3048
const KT_TO_MS = 1852 / 3600
/** A planned first waypoint this close to the group's start (m) is the start itself and isn't repeated. */
const SAME_PLACE_M = 10_000
/** A planned destination within this distance (m) of an airfield's DCS position lands there. */
const AIRFIELD_M = 3_000

export interface MizGroup {
  /** Stable key: coalition/country/category/index. */
  key: string
  name: string
  coalition: string
  country: string
  category: 'plane' | 'helicopter'
  units: { name: string; type: string; skill: string }[]
  /** Any unit flown by a person (Client or Player). */
  human: boolean
  /** How the group starts: the first route point's type, e.g. TakeOffParking. */
  start: string
  /** DCS airfield id at the start, when it starts on an airfield. */
  airdromeId?: number
  points: number
  /** Span of route.points in the mission text. */
  pointsTable: LuaTable
  /** First route point (the start), kept as is. */
  first: LuaTable | null
}

export interface Miz {
  files: Record<string, Uint8Array>
  missionText: string
  theatre: string
  groups: MizGroup[]
}

export function readMiz(data: Uint8Array): Miz {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(data)
  } catch {
    throw new Error('This file is not a DCS mission (.miz).')
  }
  if (!files.mission) throw new Error('This .miz has no mission file inside.')
  const missionText = strFromU8(files.mission)
  const mission = parseLuaAssignments(missionText).get('mission')
  if (!isTable(mission)) throw new Error('The mission file inside this .miz has no mission table.')
  const theatre = String(luaGet(mission, 'theatre') ?? '')
  return { files, missionText, theatre, groups: groupsOf(mission) }
}

function groupsOf(mission: LuaTable): MizGroup[] {
  const out: MizGroup[] = []
  for (const coalition of ['blue', 'red', 'neutrals']) {
    luaList(luaGet(mission, 'coalition', coalition, 'country')).forEach((country, ci) => {
      for (const category of ['plane', 'helicopter'] as const) {
        luaList(luaGet(country, category, 'group')).forEach((g, gi) => {
          const pointsTable = luaGet(g, 'route', 'points')
          if (!isTable(pointsTable)) return
          const pts = luaList(pointsTable)
          const first = isTable(pts[0]) ? pts[0] : null
          const units = luaList(luaGet(g, 'units')).map((u) => ({
            name: str(luaGet(u, 'name')), type: str(luaGet(u, 'type')), skill: str(luaGet(u, 'skill')),
          }))
          const ad = luaGet(first ?? undefined, 'airdromeId')
          out.push({
            key: `${coalition}/${ci + 1}/${category}/${gi + 1}`,
            name: str(luaGet(g, 'name')),
            coalition,
            country: str(luaGet(country, 'name')),
            category,
            units,
            human: units.some((u) => u.skill === 'Client' || u.skill === 'Player'),
            start: str(luaGet(first ?? undefined, 'type')),
            airdromeId: typeof ad === 'number' ? ad : undefined,
            points: pts.length,
            pointsTable,
            first,
          })
        })
      }
    })
  }
  return out
}

const str = (v: LuaValue | undefined) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** DCS airfields per theatre as [id, name, x, y], from pydcs (each theatre's airports.py). */
export const AIRDROMES = airdromes as unknown as Record<string, [number, string, number, number][]>

export const airdromeName = (theatre: string, id: number) =>
  AIRDROMES[theatre]?.find((a) => a[0] === id)?.[1] ?? `airfield ${id}`

/** A DCS airfield on this theatre within AIRFIELD_M of a DCS position. */
export function airdromeAt(theatre: string, x: number, y: number): { id: number; name: string; x: number; y: number } | null {
  const list = AIRDROMES[theatre] ?? []
  let best: [number, string, number, number] | null = null, bestD = AIRFIELD_M
  for (const a of list) {
    const d = Math.hypot(a[2] - x, a[3] - y)
    if (d <= bestD) { best = a; bestD = d }
  }
  return best && { id: best[0], name: best[1], x: best[2], y: best[3] }
}

export interface RoutePoint {
  name: string
  x: number
  y: number
  /** Metres; above the ground when altType is RADIO. */
  alt: number
  altType: 'BARO' | 'RADIO'
  /** m/s. */
  speed: number
  /** Landing at a DCS airfield. */
  land?: { airdromeId: number }
}

/** The planned route as DCS route points, after the group's own start point. */
export function routePoints(theatre: string, rows: Row[], start: { x: number; y: number } | null): RoutePoint[] {
  if (!hasGrid(theatre)) throw new Error(`The planner can't convert positions for the ${theatre} map yet.`)
  const route = rows.map((r) => r.wp)
  const alts = routeAltitudes(route)
  const out: RoutePoint[] = []
  rows.forEach((r, i) => {
    const p = toDcs(theatre, r.wp.lat, r.wp.lon)
    if (i === 0 && start && Math.hypot(p.x - start.x, p.y - start.y) < SAME_PLACE_M) return
    const agl = r.wp.alt?.ref === 'agl' && r.wp.alt.ft !== undefined
    const speedKt = r.leg?.tas ?? rows[i + 1]?.leg?.tas ?? 300
    const pt: RoutePoint = {
      name: r.wp.name, x: p.x, y: p.y,
      alt: (agl ? r.wp.alt!.ft! : alts[i]) * FT_TO_M,
      altType: agl ? 'RADIO' : 'BARO',
      speed: speedKt * KT_TO_MS,
    }
    if (i === rows.length - 1 && i > 0) {
      const field = airdromeAt(theatre, p.x, p.y)
      if (field) Object.assign(pt, { x: field.x, y: field.y, alt: (r.wp.elevFt ?? 0) * FT_TO_M, altType: 'BARO', land: { airdromeId: field.id } })
    }
    out.push(pt)
  })
  return out
}

const num = (n: number, dp = 3) => String(Number(n.toFixed(dp)))

function pointText(n: number, p: RoutePoint, indent: string, unit: string): string {
  const i1 = indent + unit, i2 = i1 + unit, i3 = i2 + unit
  const fields: [string, string][] = [
    ['alt', num(p.alt)],
    ['action', luaString(p.land ? 'Landing' : 'Turning Point')],
    ['alt_type', luaString(p.altType)],
    ['speed', num(p.speed)],
    ['task', `\n${i1}{\n${i2}["id"] = "ComboTask",\n${i2}["params"] = \n${i2}{\n${i3}["tasks"] = \n${i3}{\n${i3}}, -- end of ["tasks"]\n${i2}}, -- end of ["params"]\n${i1}}, -- end of ["task"]`],
    ['type', luaString(p.land ? 'Land' : 'Turning Point')],
    ['ETA', '0'],
    ['ETA_locked', 'false'],
    ['y', num(p.y)],
    ['x', num(p.x)],
    ['name', luaString(p.name)],
    ['formation_template', '""'],
    ['speed_locked', 'true'],
  ]
  if (p.land) fields.push(['airdromeId', String(p.land.airdromeId)])
  const body = fields.map(([k, v]) => `${i1}["${k}"] = ${v}${v.endsWith('-- end of ["task"]') ? '' : ','}`).join('\n')
  return `${indent}[${n}] = \n${indent}{\n${body}\n${indent}}, -- end of [${n}]`
}

/** The group's start point position, if it has one. */
export function startOf(g: MizGroup): { x: number; y: number } | null {
  const x = luaGet(g.first ?? undefined, 'x'), y = luaGet(g.first ?? undefined, 'y')
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : null
}

/** The mission with a planned route written into each assigned group (group key -> that plan's rows), as a new .miz. */
export function writeRoutes(miz: Miz, plans: Record<string, Row[]>): Uint8Array {
  const chosen = miz.groups.filter((g) => plans[g.key]).sort((a, b) => b.pointsTable.start - a.pointsTable.start)
  let text = miz.missionText
  for (const g of chosen) {
    const t = g.pointsTable
    const outer = /([ \t]*)[^\n]*$/.exec(text.slice(0, t.start))![1]
    // DCS indents with tabs or four spaces depending on the version that saved the mission.
    const unit = outer.includes('\t') || !outer ? '\t' : '    '
    const indent = outer + unit
    const pts = routePoints(miz.theatre, plans[g.key], startOf(g))
    const parts: string[] = []
    if (g.first) parts.push(`${indent}[1] = \n${indent}${text.slice(g.first.start, g.first.end)}, -- end of [1]`)
    for (const p of pts) parts.push(pointText(parts.length + 1, p, indent, unit))
    text = text.slice(0, t.start) + `{\n${parts.join('\n')}\n${outer}}` + text.slice(t.end)
  }
  const files: Zippable = {}
  for (const [name, data] of Object.entries(miz.files)) files[name] = name === 'mission' ? strToU8(text) : data
  return zipSync(files, { level: 6 })
}
