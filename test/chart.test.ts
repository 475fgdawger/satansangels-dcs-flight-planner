import { describe, expect, it } from 'vitest'
import raw from './fixtures/targets_syria.json'
import { parseMission, tacanFixFrom } from '../src/nav/mission'
import { direct } from '../src/nav/geodesy'
import { computeRows, defaultSettings, type Waypoint } from '../src/nav/plan'
import { legStrip } from '../src/nav/chart'

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
const W = 724, H = 764

/** Centres of the waypoint marks, in drawing order. */
const marks = (svg: string) => [...svg.matchAll(/<rect class="ch-wp[^"]*" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)]
  .map((mk) => ({ x: Number(mk[1]) + Number(mk[3]) / 2, y: Number(mk[2]) + Number(mk[4]) / 2 }))

describe('kneeboard leg strip', () => {
  it.each([1, 2, 3, 4, 5])('leg into %i runs straight up the middle of the page', (to) => {
    const { svg } = legStrip(m, rows, to, { width: W, height: H })
    const line = /class="ch-route" x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/.exec(svg)!
    const [x1, y1, x2, y2] = line.slice(1).map(Number)
    expect(x1).toBeCloseTo(W / 2, 0)
    expect(x2).toBeCloseTo(W / 2, 0)
    expect(y1).toBeGreaterThan(y2) // from at the bottom, to at the top
    expect(y1).toBeLessThanOrEqual(H - 60)
    expect(y2).toBeGreaterThanOrEqual(60)
  })

  it('ticks show distance to go and the TACAN fix at that point', () => {
    const to = 5
    const leg = rows[to].leg!
    const strip = legStrip(m, rows, to, { width: W, height: H })
    expect(strip.tickNm).toBe(15)
    const togo = [...strip.svg.matchAll(/class="ch-togo"[^>]*>(\d+)</g)].map((x) => Number(x[1]))
    expect(togo).toEqual([15, 30, 45, 60].map((d) => Math.round(leg.nm - d)))
    // First checkpoint: 15 nm out of EP, from the station nearest the leg.
    const fixes = [...strip.svg.matchAll(/class="ch-fix"[^>]*>([^<]+)</g)].map((x) => x[1])
    expect(fixes).toHaveLength(togo.length)
    const dan = m.tacans.find((t) => t.id === 'DAN')!
    expect(fixes[0]).toBe(tacanFixFrom(dan, direct(route[4].lat, route[4].lon, leg.trueCourse, 15)))
  })

  it('draws the return to base on the first mark, the target square, and no "IP IP"', () => {
    expect(legStrip(m, rows, 1, { width: W, height: H }).svg).toContain('>0/5<')
    expect(legStrip(m, rows, 2, { width: W, height: H }).svg).not.toContain('IP IP')
    const target = legStrip(m, rows, 3, { width: W, height: H }).svg
    expect(target).toContain('Fire Can 1-1 TGT')
    expect(target).toMatch(/<rect class="ch-wp ch-fill" x="[\d.-]+" y="[\d.-]+" width="[\d.]+" height="20"\/>/)
  })

  it('turns true north with the course', () => {
    // Leg 1 is flown about 127 magnetic / 132 true: north points up and to the left.
    const { svg } = legStrip(m, rows, 1, { width: W, height: H })
    const turn = Number(/rotate\(([-\d.]+) /.exec(svg)![1])
    expect(turn).toBeCloseTo(-rows[1].leg!.trueCourse, -1)
  })

  it('shows the SA-2 ring at its range on the attack leg', () => {
    const strip = legStrip(m, rows, 3, { width: W, height: H })
    const rings = [...strip.svg.matchAll(/class="ch-threat"[^>]*r="([\d.]+)"/g)].map((x) => Number(x[1]))
    expect(rings.some((r) => Math.abs(r * strip.nmPerPx - 24) < 0.1)).toBe(true)
  })

  it('keeps a short leg wide enough to see around it', () => {
    const short = computeRows(m, [route[0], { ...route[0], id: 'z', lat: route[0].lat + 0.05 }], defaultSettings('F-4E'))
    const strip = legStrip(m, short, 1, { width: W, height: H })
    expect(strip.nmPerPx * W).toBeGreaterThanOrEqual(24)
    expect(marks(strip.svg).length).toBeGreaterThanOrEqual(1)
  })

  it('escapes names', () => {
    const odd = computeRows(m, [route[0], { ...route[1], name: 'A<b>&"c' }], defaultSettings('F-4E'))
    expect(legStrip(m, odd, 1, { width: W, height: H }).svg).not.toContain('A<b>')
  })
})
