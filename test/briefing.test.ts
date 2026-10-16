import { describe, expect, it } from 'vitest'
import raw from './fixtures/targets_syria.json'
import { parseMission } from '../src/nav/mission'
import { attackRun, computeRows, defaultSettings, fuelPlan, type Waypoint } from '../src/nav/plan'
import { briefing } from '../src/nav/briefing'
import { overviewProjection, routeOverview, routeSections, SECTION_NM_PER_PX } from '../src/nav/chart'

const m = parseMission(raw)
const af = (name: string) => m.airbases.find((a) => a.name === name)!
const tg = (name: string) => m.targets.find((t) => t.name === name)!
const wp = (id: string, name: string, p: { lat: number; lon: number }, tags?: Waypoint['tags']): Waypoint =>
  ({ id, name, source: 'manual', lat: p.lat, lon: p.lon, tags })
const route: Waypoint[] = [
  wp('a', 'Incirlik', af('Incirlik')),
  wp('b', 'Hatay', af('Hatay')),
  wp('c', 'IP', { lat: 36.42, lon: 36.75 }, ['IP']),
  wp('d', 'Fire Can 1-1', tg('Aleppo Fire Can 1-1'), ['TGT']),
  wp('e', 'EP', { lat: 36.6, lon: 36.9 }, ['EP']),
  wp('f', 'Incirlik', af('Incirlik')),
]
const s = defaultSettings('F-4E')
const rows = computeRows(m, route, s)
const fuel = fuelPlan(route, s, rows)
const run = attackRun(m, route, s, rows)

describe('mission briefing', () => {
  const b = briefing(m, rows, s, fuel, run)

  it('names the fields, with a divert nearest the recovery base', () => {
    expect(b.departure?.name).toBe('Incirlik')
    expect(b.departure?.tacan).toBe('DAN 21X')
    expect(b.departure?.freqs).toContain('122.100 AM')
    expect(b.destination?.name).toBe('Incirlik')
    expect(b.divert && b.divert.name).not.toBe('Incirlik')
    expect(b.divert!.nm).toBeGreaterThan(0)
  })

  it('describes the target and the run in from the IP', () => {
    expect(b.target?.name).toBe('Fire Can 1-1')
    expect(b.target?.kind).toBe('AAA')
    expect(b.tot?.name).toBe('Fire Can 1-1')
    expect(b.tot?.clock).toBeNull()
    expect(b.attack?.ip).toBe('IP')
  })

  it('lists the threats the route goes near, flagging the ones it enters', () => {
    expect(b.threats.length).toBeGreaterThan(0)
    const fc = b.threats.find((t) => t.name === 'Aleppo Fire Can 1-1')!
    expect(fc.inside).toBe(true)
    expect(fc.closestNm).toBeLessThan(0.1)
    for (let i = 1; i < b.threats.length; i++) {
      const prev = b.threats[i - 1], t = b.threats[i]
      expect(t.closestNm - t.ringNm).toBeGreaterThanOrEqual(prev.closestNm - prev.ringNm)
    }
  })

  it('draws the whole route on the overview with a box per leg', () => {
    const ov = routeOverview(m, rows, { width: 776, height: 980 })
    const marks = [...ov.svg.matchAll(/<rect class="ch-wp[^"]*" x="([\d.-]+)" y="([\d.-]+)"/g)].map((x) => [Number(x[1]), Number(x[2])])
    expect(marks.length).toBe(5) // Incirlik start and finish share a mark
    for (const [x, y] of marks) {
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(776)
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(980)
    }
    expect((ov.svg.match(/class="ch-route"/g) ?? []).length).toBe(5)
    expect(ov.svg).toContain(`>${String(Math.round(rows[1].leg!.magCourse)).padStart(3, '0')}°<`)
  })

  it('splits a route too big to read into closer sections, end to end', () => {
    const size = { width: 776, height: 980 }
    expect(overviewProjection(rows, size).nmPerPx).toBeGreaterThan(SECTION_NM_PER_PX)
    const secs = routeSections(rows, size)
    expect(secs.length).toBeGreaterThan(1)
    expect(secs[0].from).toBe(0)
    expect(secs.at(-1)!.to).toBe(rows.length - 1)
    for (let i = 1; i < secs.length; i++) expect(secs[i].from).toBe(secs[i - 1].to)
    for (const sec of secs) {
      if (sec.to - sec.from > 1) expect(overviewProjection(rows, size, sec).nmPerPx).toBeLessThanOrEqual(SECTION_NM_PER_PX)
      const svg = routeOverview(m, rows, size, undefined, sec).svg
      expect((svg.match(/class="ch-route"/g) ?? []).length).toBe(sec.to - sec.from)
    }
  })

  it('keeps a short route on one page', () => {
    const short = computeRows(m, [route[2], route[3], route[4]], s)
    expect(routeSections(short, { width: 776, height: 980 })).toEqual([])
  })
})
