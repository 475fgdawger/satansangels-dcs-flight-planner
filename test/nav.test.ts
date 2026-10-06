import { describe, expect, it } from 'vitest'
import raw from './fixtures/targets_syria.json'
import { direct, inverse } from '../src/nav/geodesy'
import { compass16, ddm, dms, duration, heading3, parseClock, parseLatLon } from '../src/nav/format'
import { airfields, catalog, magVarAt, nearRef, parseMission, parseTacanFix, runwayPairs, tacanFix } from '../src/nav/mission'
import { AIRCRAFT, altAgl, altMsl, computeRows, defaultSettings, departureFuel, fuelPlan, windTriangle, type Waypoint } from '../src/nav/plan'

const m = parseMission(raw)

describe('matches the bot target list (Syria export)', () => {
  it.each(m.targets.map((t) => [t.name, t]))('%s TACAN fix', (_name, t) => {
    expect(tacanFix(m, t)).toBe(t.tacan)
  })

  it.each(m.targets.map((t) => [t.name, t]))('%s DMS', (_name, t) => {
    expect(dms(t)).toBe(t.latlon)
  })

  // Targets whose bot reference is a place (others reference a nearby target).
  it.each(m.targets.filter((t) => / of (Aleppo|Latakia|Damascus)$|^at (Aleppo|Bassel Al-Assad|Minakh|Shayrat)$/.test(t.near))
    .map((t) => [t.name, t]))('%s nearby reference', (_name, t) => {
    expect(nearRef(m, t, t.mag_var)).toBe(t.near)
  })
})

describe('geodesy', () => {
  it('direct inverts inverse', () => {
    const a = { lat: 37.015611, lon: 35.448194 }
    const b = { lat: 37.617523, lon: 33.510843 }
    const { az, nm } = inverse(a.lat, a.lon, b.lat, b.lon)
    const back = direct(a.lat, a.lon, az, nm)
    expect(back.lat).toBeCloseTo(b.lat, 7)
    expect(back.lon).toBeCloseTo(b.lon, 7)
  })
})

describe('formats', () => {
  it('degrees and decimal minutes', () => {
    expect(ddm({ lat: 36.298043, lon: 37.158964 })).toBe("N36°17.88' E037°09.54'")
    expect(ddm({ lat: 36.999999, lon: -0.5 })).toBe("N37°00.00' W000°30.00'")
  })
  it('headings write 000 as 360', () => {
    expect(heading3(0)).toBe('360')
    expect(heading3(359.6)).toBe('360')
    expect(heading3(5.2)).toBe('005')
  })
  it('compass points', () => {
    expect(compass16(337.5)).toBe('NNW')
    expect(compass16(359)).toBe('N')
  })
  it('durations and clock', () => {
    expect(duration(14.25)).toBe('14:15')
    expect(duration(75)).toBe('1:15:00')
    expect(parseClock('1205')).toBe(12 * 3600 + 5 * 60)
    expect(parseClock('25:00')).toBeNull()
  })
  it('parses typed coordinates', () => {
    const want = { lat: 37.617523, lon: 33.510843 }
    for (const text of [`N37°37'03" E033°30'39"`, 'N37 37.05 E033 30.65', '37.617523, 33.510843']) {
      const p = parseLatLon(text)!
      expect(p.lat).toBeCloseTo(want.lat, 3)
      expect(p.lon).toBeCloseTo(want.lon, 3)
    }
    expect(parseLatLon('hello')).toBeNull()
  })
  it('parses a TACAN fix back to the target', () => {
    const t1 = m.targets.find((t) => t.name === 'T-1')!
    const p = parseTacanFix(m, 'DAN 287/99')!
    expect(inverse(p.lat, p.lon, t1.lat, t1.lon).nm).toBeLessThan(1.5)
    expect(parseTacanFix(m, 'XYZ 100/10')).toBeNull()
  })
})

describe('mission data', () => {
  it('drops helipads from the airfield list', () => {
    const names = airfields(m).map((a) => a.name)
    expect(names).toContain('Incirlik')
    expect(names).toContain('Konya')
    expect(names).not.toContain('HC01')
  })
  it('pairs runway ends', () => {
    expect(runwayPairs(['23', '05'])).toEqual(['05/23'])
    expect(runwayPairs(['19L', '01L', '19R', '01R'])).toEqual(['01L/19R', '01R/19L'])
  })
  it('does not list range targets twice', () => {
    expect(catalog(m).filter((p) => p.name === 'T-1')).toHaveLength(1)
  })
  it('mag var at a known point is DCS value, between points is interpolated', () => {
    expect(magVarAt(m, { lat: 37.015611, lon: 35.448194 })).toBe(5.23)
    const mid = magVarAt(m, { lat: 37.3, lon: 34.5 })
    expect(mid).toBeGreaterThan(5.1)
    expect(mid).toBeLessThan(5.3)
  })
})

describe('legs', () => {
  it('wind triangle: direct headwind slows GS, crosswind adds WCA', () => {
    expect(windTriangle(90, 400, 90, 50)).toEqual({ heading: 90, gs: 350 })
    const x = windTriangle(360, 400, 90, 40)!
    expect(x.heading).toBeCloseTo(5.74, 1)
  })
  const inc = airfields(m).find((a) => a.name === 'Incirlik')!
  const t5 = m.targets.find((t) => t.name === 'T-5')!
  const route: Waypoint[] = [
    { id: 'a', name: 'Incirlik', source: 'airfield', lat: inc.lat, lon: inc.lon },
    { id: 'b', name: 'T-5', source: 'target', lat: t5.lat, lon: t5.lon },
    { id: 'c', name: 'Incirlik', source: 'airfield', lat: inc.lat, lon: inc.lon },
  ]

  it('F-4E departure (taxi, AB takeoff, MIL climb) is about 2,000 lb', () => {
    const d = departureFuel(defaultSettings('F-4E', 43200))
    expect(d.total).toBeGreaterThan(1800)
    expect(d.total).toBeLessThan(2200)
  })

  it('computes time, distance and fuel along a route, with the climb on the first leg', () => {
    const s = { ...defaultSettings('F-4E', 43200), tas: 420 }
    const d = departureFuel(s)
    const rows = computeRows(m, route, s)
    const leg = rows[1].leg!
    expect(leg.nm).toBeGreaterThan(90)
    expect(leg.nm).toBeLessThan(95)
    expect(leg.ete).toBeCloseTo((leg.nm / 420) * 60, 6)
    expect(leg.climbMin).toBe(4)
    const want = 12200 - d.beforeFirstLeg - (13000 * 4 + 4250 * (leg.ete - 4)) / 60
    expect(rows[1].fuelRemaining).toBeCloseTo(want, 6)
    expect(rows[2].leg!.climbMin).toBe(0)
    expect(leg.magCourse).toBeCloseTo(leg.trueCourse - 5.23, 6)
  })

  it('leaves ETAs blank without a takeoff time', () => {
    expect(computeRows(m, route, defaultSettings('F-4E')).map((r) => r.eta)).toEqual([null, null, null])
    const rows = computeRows(m, route, defaultSettings('F-4E', 43200))
    expect(rows[0].eta).toBe(43200)
    expect(rows[1].eta).toBeCloseTo(43200 + rows[1].elapsed * 60, 6)
  })

  it('a custom fuel flow overrides the leg phase', () => {
    const s = defaultSettings('F-4E', 43200)
    const rows = computeRows(m, [route[0], { ...route[1], phase: 'ab', ff: 5000 }], s)
    expect(rows[1].leg!.ff).toBe(5000)
    expect(rows[1].leg!.phase).toBeNull()
  })

  it('loiter adds time and fuel at the waypoint, at its own phase or the leg in', () => {
    const s = defaultSettings('F-4E', 43200)
    const plain = computeRows(m, route, s)
    const held = computeRows(m, [route[0], { ...route[1], phase: 'cruise-low', loiter: { min: 10 } }, route[2]], s)
    const lo = held[1].loiter!
    expect(lo.ff).toBe(8250)
    expect(lo.fuel).toBeCloseTo(8250 * 10 / 60, 6)
    expect(held[1].fuelAfter).toBeCloseTo(held[1].fuelRemaining - lo.fuel, 6)
    expect(held[1].elapsedAfter).toBeCloseTo(held[1].elapsed + 10, 6)
    expect(held[2].elapsed).toBeCloseTo(plain[2].elapsed + 10, 6)
    expect(held[2].eta).toBeCloseTo(plain[2].eta! + 600, 6)
    const hi = computeRows(m, [route[0], { ...route[1], loiter: { min: 6, phase: 'mil' } }], s)[1].loiter!
    expect(hi.fuel).toBeCloseTo(13000 * 6 / 60, 6)
    expect(computeRows(m, [route[0], { ...route[1], loiter: { min: 0 } }], s)[1].loiter).toBeNull()
    expect(plain[1].loiter).toBeNull()
    expect(plain[1].fuelAfter).toBe(plain[1].fuelRemaining)
  })

  it('joker and bingo follow the squadron definitions', () => {
    const s = { ...defaultSettings('F-4E', 43200), tas: 460, abTas: 550 }
    const f = fuelPlan(route, s)!
    expect(f.target).toBe(1)
    const rtb = f.rtbNm
    expect(f.calc.rtbFuel).toBeCloseTo((rtb / 460) * 4250, 6)
    expect(f.bingo).toBe(Math.max(3000, f.calc.rtbFuel))
    const joker = 65000 / 60 + (30 / 550) * 65000 + ((rtb - 30) / 460) * 4250
    expect(f.joker).toBeCloseTo(Math.max(joker, f.bingo), 6)
    expect(fuelPlan(route, { ...s, jokerOverride: 7000 })!.joker).toBe(7000)
  })

  it('the first TGT or CAP mark sets where joker and bingo are measured', () => {
    const s = defaultSettings('F-4E', 0)
    const four: Waypoint[] = [route[0], { ...route[0], id: 'ip', lat: inc.lat + 0.5 }, route[1], route[2]]
    expect(fuelPlan(four, s)).toMatchObject({ target: 2, targetKind: 'auto' })
    const cap = four.map((w) => (w.id === 'ip' ? { ...w, tags: ['IP', 'CAP'] as Waypoint['tags'] } : w))
    expect(fuelPlan(cap, s)).toMatchObject({ target: 1, targetKind: 'CAP' })
    const ipOnly = four.map((w) => (w.id === 'ip' ? { ...w, tags: ['IP'] as Waypoint['tags'] } : w))
    expect(fuelPlan(ipOnly, { ...s, targetId: 'ip' })).toMatchObject({ target: 1, targetKind: 'auto' })
    const tgt = ipOnly.map((w) => (w.id === 'b' ? { ...w, tags: ['TGT'] as Waypoint['tags'] } : w))
    expect(fuelPlan(tgt, { ...s, targetId: 'ip' })).toMatchObject({ target: 2, targetKind: 'TGT' })
  })

  it('F-4E fuel loads: internal, centerline tank, centerline + outboards', () => {
    expect(AIRCRAFT['F-4E'].fuelLoads.map((l) => l.lb)).toEqual([12200, 16100, 20800])
  })

  it('bingo never drops below the floor', () => {
    const near: Waypoint[] = [route[0], { ...route[0], id: 'x', lat: inc.lat + 0.1 }, { ...route[0], id: 'y' }]
    expect(fuelPlan(near, defaultSettings('F-4E', 0))!.bingo).toBe(AIRCRAFT['F-4E'].bingoFloor)
  })
})

describe('altitude', () => {
  const wp = (alt: Waypoint['alt'], elevFt?: number): Waypoint => ({ id: 'a', name: 'A', source: 'manual', lat: 35, lon: 36, alt, elevFt })

  it('MSL as typed, AGL from the elevation', () => {
    expect(altMsl(wp({ ft: 5000, ref: 'msl' }, 1200))).toBe(5000)
    expect(altAgl(wp({ ft: 5000, ref: 'msl' }, 1200))).toBe(3800)
  })

  it('AGL as typed, MSL from the elevation', () => {
    expect(altAgl(wp({ ft: 500, ref: 'agl' }, 1220))).toBe(500)
    expect(altMsl(wp({ ft: 500, ref: 'agl' }, 1220))).toBe(1720)
  })

  it('no elevation or no altitude leaves the conversion blank', () => {
    expect(altMsl(wp({ ft: 500, ref: 'agl' }))).toBeUndefined()
    expect(altAgl(wp({ ft: 500, ref: 'msl' }))).toBe(undefined)
    expect(altMsl(wp({ ref: 'msl' }, 100))).toBeUndefined()
    expect(altMsl(wp(undefined, 100))).toBeUndefined()
  })
})
