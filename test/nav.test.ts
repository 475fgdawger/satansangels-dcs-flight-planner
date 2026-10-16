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

  it('F-4E departure: taxi at the recorded ground idle and the recorded max AB takeoff to 450 KIAS', () => {
    const d = departureFuel(defaultSettings('F-4E', 43200))
    expect(AIRCRAFT['F-4E'].idleLbMin).toBe(37.5)
    expect(AIRCRAFT['F-4E'].perf!.ground.takeoff).toMatchObject({ kias: 450, lb: 732, nm: 2.2 })
    expect(d.taxi).toBeCloseTo(375, 6)
    // No Stores has its own recorded takeoff (the fuller of the two clean ones).
    expect(d.takeoff).toBe(756)
    expect(d.climb).toBe(0)
    expect(d.total).toBeCloseTo(1131, 6)
  })

  it('F-4E departure: loaded categories use their own takeoff, else the heaviest recorded loaded one', () => {
    const at = (drag: string) => departureFuel({ ...defaultSettings('F-4E'), drag }).takeoff
    expect(at('BFM Only')).toBe(904)
    expect(at('BFM and Bombs')).toBe(904)
    expect(at('Superbomber')).toBe(904)
    expect(at('No Stores')).toBe(756)
  })

  it('without recorded data (F-5E): fixed flows, with the MIL climb on the first leg', () => {
    const s = { ...defaultSettings('F-5E', 43200), tas: 420 }
    const d = departureFuel(s)
    expect(d.total).toBeCloseTo(10 * 12 + 0.75 * 20000 / 60 + 4 * 6000 / 60, 6)
    const rows = computeRows(m, route, s)
    const leg = rows[1].leg!
    expect(leg.nm).toBeGreaterThan(90)
    expect(leg.nm).toBeLessThan(95)
    expect(leg.ete).toBeCloseTo((leg.nm / 420) * 60, 6)
    expect(leg.climbMin).toBe(4)
    // The departure row shows fuel after taxi; the AB takeoff counts in leg 1.
    expect(d.beforeFirstLeg).toBeCloseTo(10 * 12, 6)
    expect(rows[0].fuelRemaining).toBeCloseTo(4400 - 120, 6)
    const want = 4400 - d.beforeFirstLeg - d.takeoff - (6000 * 4 + 2200 * (leg.ete - 4)) / 60
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
    const s = defaultSettings('F-5E', 43200)
    const plain = computeRows(m, route, s)
    const held = computeRows(m, [route[0], { ...route[1], phase: 'cruise-low', loiter: { min: 10 } }, route[2]], s)
    const lo = held[1].loiter!
    expect(lo.ff).toBe(3800)
    expect(lo.fuel).toBeCloseTo(3800 * 10 / 60, 6)
    expect(held[1].fuelAfter).toBeCloseTo(held[1].fuelRemaining - lo.fuel, 6)
    expect(held[1].elapsedAfter).toBeCloseTo(held[1].elapsed + 10, 6)
    expect(held[2].elapsed).toBeCloseTo(plain[2].elapsed + 10, 6)
    expect(held[2].eta).toBeCloseTo(plain[2].eta! + 600, 6)
    const hi = computeRows(m, [route[0], { ...route[1], loiter: { min: 6, phase: 'mil' } }], s)[1].loiter!
    expect(hi.fuel).toBeCloseTo(6000 * 6 / 60, 6)
    const combat = computeRows(m, [route[0], { ...route[1], loiter: { min: 6, phase: 'combat' } }], s)[1].loiter!
    expect(combat.ff).toBe((6000 + 20000) / 2)
    expect(combat.phase!.short).toBe('CMBT')
    expect(computeRows(m, [route[0], { ...route[1], loiter: { min: 0 } }], s)[1].loiter).toBeNull()
    expect(plain[1].loiter).toBeNull()
    expect(plain[1].fuelAfter).toBe(plain[1].fuelRemaining)
  })

  it('joker and bingo without recorded data (F-5E) follow the fixed-flow definitions', () => {
    const s = { ...defaultSettings('F-5E', 43200), tas: 460, abTas: 550 }
    const f = fuelPlan(route, s)!
    expect(f.target).toBe(1)
    expect(f.profiles).toBeUndefined()
    const rtb = f.rtbNm
    expect(f.calc.rtbFuel).toBeCloseTo((rtb / 460) * 2200, 6)
    expect(f.bingo).toBe(Math.max(1200, f.calc.rtbFuel))
    const joker = 20000 / 60 + (30 / 550) * 20000 + ((rtb - 30) / 460) * 2200
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
    expect(fuelPlan(near, defaultSettings('F-5E', 0))!.bingo).toBe(AIRCRAFT['F-5E'].bingoFloor)
    expect(fuelPlan(near, defaultSettings('F-4E', 0))!.bingo).toBeGreaterThan(AIRCRAFT['F-4E'].bingoFloor)
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

describe('mission fuel', () => {
  it('is the fuel burned from engine start to the last waypoint plus landing pattern fuel', async () => {
    const { missionFuel, defaultSettings, AIRCRAFT } = await import('../src/nav/plan')
    const s = { ...defaultSettings('F-4E'), startFuel: 12200 }
    const rows = [{ fuelAfter: 11000 }, { fuelAfter: 7000 }, { fuelAfter: 4000 }] as never
    const m = missionFuel(rows, s)!
    expect(m.burn).toBe(8200)
    expect(m.pattern).toBe(1500)
    expect(m.required).toBe(9700)
    expect(m.margin).toBe(2500)
    expect(missionFuel([{ fuelAfter: 11000 }] as never, s)).toBeNull()
    expect(AIRCRAFT['F-5E'].patternFuel).toBe(800)
    expect(AIRCRAFT['F-100D'].patternFuel).toBe(800)
  })
})

describe('departure and destination', () => {
  const ab = (id: string) => ({ id, name: id, source: 'airfield', lat: 37, lon: 35 })
  const wp = (id: string) => ({ id, name: id, source: 'manual', lat: 36, lon: 36 })

  it('reads the airfields at either end of the route', async () => {
    const { endpoints } = await import('../src/nav/plan')
    expect(endpoints([ab('A'), wp('1'), ab('B')]).departure?.name).toBe('A')
    expect(endpoints([ab('A'), wp('1'), ab('B')]).destination?.name).toBe('B')
    expect(endpoints([wp('1'), wp('2')])).toEqual({ departure: null, destination: null })
    expect(endpoints([ab('A')]).destination).toBeNull()
  })

  it('replaces an airfield at that end, or adds one', async () => {
    const { setEndpoint } = await import('../src/nav/plan')
    const ids = (r: { id: string }[]) => r.map((w) => w.id).join(' ')
    expect(ids(setEndpoint([ab('A'), wp('1'), ab('B')], 'departure', ab('C')))).toBe('C 1 B')
    expect(ids(setEndpoint([ab('A'), wp('1'), ab('B')], 'destination', ab('C')))).toBe('A 1 C')
    expect(ids(setEndpoint([wp('1'), wp('2')], 'departure', ab('C')))).toBe('C 1 2')
    expect(ids(setEndpoint([wp('1'), wp('2')], 'destination', ab('C')))).toBe('1 2 C')
    expect(ids(setEndpoint([ab('A')], 'destination', ab('A')))).toBe('A A')
    expect(ids(setEndpoint([], 'departure', ab('C')))).toBe('C')
    expect(ids(setEndpoint([ab('A'), wp('1'), ab('B')], 'destination', null))).toBe('A 1')
    expect(ids(setEndpoint([wp('1'), wp('2')], 'departure', null))).toBe('1 2')
  })
})

describe('adding waypoints', () => {
  it('keeps the destination airfield last', async () => {
    const { appendIndex } = await import('../src/nav/plan')
    const ab = (id: string) => ({ id, name: id, source: 'airfield', lat: 37, lon: 35 })
    const wp = (id: string) => ({ id, name: id, source: 'manual', lat: 36, lon: 36 })
    expect(appendIndex([ab('A'), wp('1'), ab('B')])).toBe(2)
    expect(appendIndex([ab('A'), wp('1')])).toBe(2)
    expect(appendIndex([ab('A')])).toBe(1)
    expect(appendIndex([])).toBe(0)
  })
})

describe('destination picked first', () => {
  it('stays the destination, whatever order the pickers and adds come in', async () => {
    const { appendIndex, endpoints, setEndpoint } = await import('../src/nav/plan')
    const ab = (id: string) => ({ id, name: id, source: 'airfield', lat: 37, lon: 35 })
    const wp = (id: string) => ({ id, name: id, source: 'manual', lat: 36, lon: 36 })
    const ids = (r: { id: string }[]) => r.map((w) => w.id).join(' ')
    let r = setEndpoint([], 'destination', ab('B'))
    expect(endpoints(r).departure).toBeNull()
    expect(endpoints(r).destination?.id).toBe('B')
    expect(appendIndex(r)).toBe(0)
    r = [...r.slice(0, appendIndex(r)), wp('1'), ...r.slice(appendIndex(r))]
    expect(ids(r)).toBe('1 B')
    r = setEndpoint(r, 'departure', ab('A'))
    expect(ids(r)).toBe('A 1 B')
    r = [...r.slice(0, appendIndex(r)), wp('2'), ...r.slice(appendIndex(r))]
    expect(ids(r)).toBe('A 1 2 B')
  })
})
