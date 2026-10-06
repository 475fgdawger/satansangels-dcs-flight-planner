import { describe, expect, it } from 'vitest'
import raw from './fixtures/targets_syria.json'
import { parseMission } from '../src/nav/mission'
import { computeRows, defaultSettings, type Waypoint } from '../src/nav/plan'
import { routeChart } from '../src/nav/chart'

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
const rows = computeRows(m, route, defaultSettings('F-4E'))
const W = 724, H = 862

describe('kneeboard route chart', () => {
  const chart = routeChart(m, rows, { width: W, height: H })

  const marks = [...chart.svg.matchAll(/<rect class="ch-wp( ch-fill)?" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)]

  it('keeps every waypoint on the page, inside the margin, with the return to base sharing the first mark', () => {
    expect(marks).toHaveLength(route.length - 1)
    expect(chart.svg).toContain('>0/5<')
    for (const mk of marks) {
      const x = Number(mk[2]) + Number(mk[4]) / 2, y = Number(mk[3]) + Number(mk[5]) / 2
      expect(x).toBeGreaterThan(W * 0.08)
      expect(x).toBeLessThan(W * 0.92)
      expect(y).toBeGreaterThan(H * 0.08)
      expect(y).toBeLessThan(H * 0.92)
    }
  })

  it('draws the target filled and square, and labels each leg with course and distance', () => {
    expect(marks.filter((mk) => mk[1] && !chart.svg.includes(`x="${mk[2]}" y="${mk[3]}" width="${mk[4]}" height="${mk[5]}" rx`))).toHaveLength(1)
    const legs = [...chart.svg.matchAll(/class="ch-leg"[^>]*>(\d{3})° (\d+)</g)]
    expect(legs.length).toBeGreaterThanOrEqual(3)
    for (const l of legs) expect(rows.some((x) => x.leg && Math.round(x.leg.nm) === Number(l[2]))).toBe(true)
  })

  it('does not repeat a mark that is already the name', () => {
    expect(chart.svg).not.toContain('IP IP')
    expect(chart.svg).toContain('Fire Can 1-1 TGT')
  })

  it('shows the SA-2 ring at its range, scaled to the chart', () => {
    const rings = [...chart.svg.matchAll(/class="ch-threat"[^>]*r="([\d.]+)"/g)].map((x) => Number(x[1]))
    expect(rings.some((r) => Math.abs(r * chart.nmPerPx - 24) < 0.1)).toBe(true)
  })

  it('has a round scale bar and true-north arrow', () => {
    expect([1, 2, 5, 10, 20, 25, 50, 100, 200, 500]).toContain(chart.scaleNm)
    expect(chart.svg).toContain(`${chart.scaleNm} nm`)
    expect(chart.svg).toContain('TRUE N')
  })

  it('escapes names', () => {
    const odd = computeRows(m, [route[0], { ...route[1], name: 'A<b>&"c' }], defaultSettings('F-4E'))
    const svg = routeChart(m, odd, { width: W, height: H }).svg
    expect(svg).not.toContain('A<b>')
  })

  it('gives a one-waypoint route a sensible area', () => {
    const one = routeChart(m, rows.slice(0, 1), { width: W, height: H })
    expect(one.nmPerPx * W).toBeGreaterThanOrEqual(30)
  })
})
