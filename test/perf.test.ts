import { describe, expect, it } from 'vitest'
import raw from './fixtures/targets_syria.json'
import { airfields, parseMission } from '../src/nav/mission'
import { isaTempK, kcasFromMach, ktasFromMach, machFromKcas } from '../src/nav/atmo'
import { PERF, bestRangeKias, climb, cruiseAt, descent, dragCategories, dragFactor, dragOf, levelAtRpm, powerFf } from '../src/nav/perf'
import { AIRCRAFT, bingoDragOf, bingoProfile, carryLegData, computeRows, defaultSettings, fuelPlan, routeAltitudes, type Waypoint } from '../src/nav/plan'

const m = parseMission(raw)
const p = PERF['F-4E']!

describe('airspeeds', () => {
  it('KCAS and Mach match the performance manual (standard pitot formulas)', () => {
    expect(kcasFromMach(0.634, 20000)).toBeCloseTo(292, 0)
    expect(ktasFromMach(0.634, 20000)).toBeCloseTo(389, 0)
    expect(machFromKcas(kcasFromMach(0.85, 30000), 30000)).toBeCloseTo(0.85, 6)
    // Supersonic (Rayleigh): the 20,000 ft dash point, Mach 1.51 = 722 KCAS.
    expect(kcasFromMach(1.511, 20294)).toBeCloseTo(723, 0)
    expect(machFromKcas(723, 20294)).toBeCloseTo(1.511, 2)
  })
})

describe('F-4E tables', () => {
  it('a recorded level point comes back as recorded', () => {
    const c = cruiseAt(p, 20000, 0.649)
    expect(c.ff).toBeCloseTo(4828, 0)
    expect(c.rpm).toBeCloseTo(82.3, 1)
    expect(c.flags).toEqual([])
  })

  it('warmer than standard: fuel flow and RPM scale with sqrt(T / T std) at the same Mach', () => {
    const k = Math.sqrt((isaTempK(20000) + 10) / isaTempK(20000))
    const hot = cruiseAt(p, 20000, 0.649, 1, 10)
    expect(hot.ff).toBeCloseTo(4828 * k, 0)
    expect(hot.rpm).toBeCloseTo(82.3 * k, 1)
  })

  it('flags speeds outside the recorded envelope and wide gaps', () => {
    expect(cruiseAt(p, 20000, 1.2).flags).toContain('fast')
    expect(cruiseAt(p, 10000, 0.5).flags).toContain('slow')
    // No band has a wide gap any more (2026-10-08 fill-in flight).
    expect(p.bands.every((b) => b.gaps.length === 0)).toBe(true)
    expect(cruiseAt(p, 1000, machFromKcas(420, 1000)).flags).toEqual([])
    expect(cruiseAt(p, 40000, 0.85).flags).toContain('high')
  })

  it('drag categories, lowest first, with their factors', () => {
    expect(dragCategories(p).map((c) => c.name)).toEqual(['No Stores', 'BFM Only', 'BFM No Tank', 'BFM and Bombs', 'SEAD', 'Superbomber', 'BFM + High Drag'])
    expect(dragFactor(p, undefined)).toBe(1)
    expect(dragFactor(p, 'SEAD')).toBe(1.58)
  })

  // Every loaded level point recorded (7.5 units AoA or less) comes back from the planner's lookup: from the
  // category's own curve where it has two or more points in the band, else from the factor its one point gives.
  const loaded = p.configs.flatMap((c) => (c.bands ?? []).flatMap((b) => b.points.map((q) => ({ name: c.name, alt: b.alt_ft, q }))))
  it('has loaded curves for every drag category', () => {
    expect(new Set(loaded.map((x) => x.name))).toEqual(new Set(dragCategories(p).filter((c) => c.factor !== 1).map((c) => c.name)))
  })
  it.each(loaded.map((x) => [x.name, x.alt, x.q.kias, x.q] as const))('%s at %i ft and %i KIAS matches the recorded point', (name, alt, kias, q) => {
    const c = cruiseAt(p, alt, q.mach, dragOf(p, name))
    expect(Math.abs(c.ff / q.ff - 1)).toBeLessThan(0.005)
    expect(c.rpm!).toBeCloseTo(q.rpm!, 0)
    expect(levelAtRpm(p, alt, q.rpm!, dragOf(p, name)).mach).toBeCloseTo(q.mach, 2)
    void kias
  })

  it('between and beyond the loaded bands: interpolated, then the factor', () => {
    // Between bands at the same Mach, as for the No Stores tables.
    const bombs = dragOf(p, 'BFM and Bombs')
    const at15 = cruiseAt(p, 15000, 0.75, bombs).ff
    const at10 = cruiseAt(p, 10000, 0.75, bombs).ff
    const at20 = cruiseAt(p, 20000, 0.75, bombs).ff
    expect(at15).toBeGreaterThan(Math.min(at10, at20))
    expect(at15).toBeLessThan(Math.max(at10, at20))
    // 30,000 ft has no loaded run: the No Stores band with the overall factor.
    const m30 = machFromKcas(300, 30000)
    expect(cruiseAt(p, 30000, m30, bombs).ff).toBeCloseTo(cruiseAt(p, 30000, m30, dragFactor(p, 'BFM and Bombs')).ff, 6)
  })

  it('level speed at an RPM: 95 % at sea level is the escape speed; a loaded jet is slower at the same fuel flow', () => {
    const sl = levelAtRpm(p, 1000, 95)
    expect(ktasFromMach(sl.mach, 1000)).toBeCloseTo(612, -1)
    expect(sl.ff).toBeCloseTo(18794, -1)
    const bfm = levelAtRpm(p, 1000, 95, 1.16)
    expect(bfm.ff).toBe(sl.ff)
    expect(kcasFromMach(bfm.mach, 1000)).toBeCloseTo(kcasFromMach(sl.mach, 1000) / Math.sqrt(1.16), 3)
  })

  it('best-range speed is 7.5 units AoA, about 290-300 KIAS', () => {
    expect(bestRangeKias(p, 20000)).toBe(292)
    expect(bestRangeKias(p, 30000)).toBe(297)
    expect(bestRangeKias(p, 10000)).toBe(292)
  })

  it('MIL climb and idle descent from the cumulative tables', () => {
    expect(climb(p, 0, 20000)).toMatchObject({ min: 3.61, nm: 31.8, lb: 1135, flags: [] })
    expect(climb(p, 1000, 20000).lb).toBe(1135 - 157)
    const loaded = climb(p, 1000, 20000, 1.47)
    expect(loaded.lb).toBeCloseTo((1135 - 157) * Math.sqrt(1.47), 6)
    expect(loaded.flags).toContain('est')
    expect(descent(p, 35000, 1000)).toMatchObject({ min: 6.09, nm: 38.9, lb: 164 })
    expect(climb(p, 20000, 10000).lb).toBe(0)
    expect(descent(p, 10000, 20000).lb).toBe(0)
  })

  it('MIL and max AB fuel flow from the recorded points', () => {
    const [alt, mach, ff] = p.power.MIL[0]
    expect(powerFf(p, 'MIL', alt, mach)).toBe(ff)
    expect(powerFf(p, 'ABMAX', 20000, 0.9)).toBeGreaterThan(powerFf(p, 'MIL', 20000, 0.9) * 2)
  })
})

describe('F-4E route planning from the tables', () => {
  const inc = airfields(m).find((a) => a.name === 'Incirlik')!
  const t5 = m.targets.find((t) => t.name === 'T-5')!
  const home: Waypoint = { id: 'a', name: 'Incirlik', source: 'airfield', lat: inc.lat, lon: inc.lon, elevFt: 240 }
  const tgt: Waypoint = { id: 'b', name: 'T-5', source: 'target', lat: t5.lat, lon: t5.lon, elevFt: 1500, alt: { ft: 20000, ref: 'msl' } }
  const route: Waypoint[] = [home, tgt, { ...home, id: 'c' }]
  const s = defaultSettings('F-4E', 43200)

  it('altitudes: as planned, else carried from the waypoint before; takeoff and landing at field elevation', () => {
    const mid: Waypoint = { ...tgt, id: 'm', alt: undefined }
    expect(routeAltitudes([home, tgt, mid, { ...home, id: 'c' }])).toEqual([240, 20000, 20000, 240])
    expect(routeAltitudes([home, { ...tgt, alt: { ft: 500, ref: 'agl' } }, home])).toEqual([240, 2000, 240])
  })

  it('a new waypoint takes the altitude and phase from the one before; airfields stay blank', () => {
    const r: Waypoint[] = [home, { ...tgt, phase: 'mil' }]
    const pt: Waypoint = { id: 'n', name: 'WP3', source: 'manual', lat: 36, lon: 36 }
    expect(carryLegData(r, 2, pt)).toMatchObject({ alt: { ft: 20000, ref: 'msl' }, phase: 'mil' })
    // Nearest typed altitude, skipping blanks; the takeoff field's own altitude doesn't carry.
    const blank = [...r, { ...pt, id: 'b2', alt: undefined, phase: undefined }]
    expect(carryLegData(blank, 3, pt).alt).toEqual({ ft: 20000, ref: 'msl' })
    expect(carryLegData([{ ...home, alt: { ft: 240, ref: 'msl' } }], 1, pt).alt).toBeUndefined()
    // Typed values on the new waypoint win; inserting mid-route copies from the waypoint before the slot.
    expect(carryLegData(r, 2, { ...pt, alt: { ft: 500, ref: 'agl' } }).alt).toEqual({ ft: 500, ref: 'agl' })
    expect(carryLegData(r, 1, pt)).toEqual(pt)
    expect(carryLegData(r, 2, { ...home, id: 'z' })).toEqual({ ...home, id: 'z' })
  })

  it('climb leg: MIL climb at the start, then cruise at 7.5 units', () => {
    const rows = computeRows(m, route, s)
    const leg = rows[1].leg!
    expect(leg.altFt).toBe(20000)
    expect(leg.kias).toBeCloseTo(292, 0)
    expect(leg.rpm!).toBeCloseTo(82.2, 0)
    // The climb table starts at 0 ft: from field elevation, 240 ft of the first 1,000 ft row is already flown.
    const climbLb = 1135 - 157 * 0.24
    expect(leg.climb).toMatchObject({ fromFt: 240, toFt: 20000 })
    expect(leg.climb!.lb).toBeCloseTo(climbLb, 6)
    expect(leg.descent).toBeNull()
    const cruiseMin = ((leg.nm - leg.climb!.nm) / leg.gs) * 60
    expect(leg.ete).toBeCloseTo(leg.climb!.min + cruiseMin, 6)
    expect(leg.fuelUsed).toBeCloseTo(climbLb + (leg.ff * cruiseMin) / 60, 6)
    expect(rows[1].fuelRemaining).toBeCloseTo(12200 - 1115 - leg.fuelUsed, 6)
  })

  it('descent leg: cruise high, idle descent at the end with the top of descent', () => {
    const leg = computeRows(m, route, s)[2].leg!
    expect(leg.altFt).toBe(20000)
    expect(leg.climb).toBeNull()
    expect(leg.descent).toMatchObject({ fromFt: 20000, toFt: 240 })
    expect(leg.descent!.nm).toBeGreaterThan(15)
    expect(leg.fuelUsed).toBeGreaterThan(leg.descent!.lb)
  })

  it('low-level legs default to the low-level speed; Mach and KIAS can be typed', () => {
    const low = { ...tgt, alt: { ft: 500, ref: 'agl' as const } }
    expect(computeRows(m, [home, low], s)[1].leg!.kias).toBeCloseTo(420, 3)
    expect(computeRows(m, [home, low], { ...s, lowKias: 480 })[1].leg!.kias).toBeCloseTo(480, 3)
    expect(computeRows(m, [home, { ...tgt, speed: { v: 0.85, unit: 'mach' } }], s)[1].leg!.mach).toBe(0.85)
    expect(computeRows(m, [home, { ...tgt, speed: { v: 350, unit: 'kias' } }], s)[1].leg!.kias).toBeCloseTo(350, 3)
  })

  it('drag category and temperature change the leg', () => {
    const clean = computeRows(m, route, s)[1].leg!
    const bombs = computeRows(m, route, { ...s, drag: 'BFM and Bombs' })[1].leg!
    expect(bombs.ff).toBeGreaterThan(clean.ff * 1.2)
    expect(bombs.rpm!).toBeGreaterThan(clean.rpm!)
    expect(bombs.flags).toContain('est')
    const hot = computeRows(m, route, { ...s, isaDev: 15 })[1].leg!
    expect(hot.tas).toBeGreaterThan(clean.tas)
    expect(hot.kias).toBeCloseTo(clean.kias!, 6)
  })

  it('MIL and AB legs use the power tables and give no RPM', () => {
    const mil = computeRows(m, [home, { ...tgt, phase: 'mil' }], s)[1].leg!
    expect(mil.rpm).toBeNull()
    expect(mil.ff).toBeCloseTo(powerFf(p, 'MIL', 20000, mil.mach!), 6)
    const ab = computeRows(m, [home, { ...tgt, phase: 'ab' }], s)[1].leg!
    expect(ab.ff).toBeGreaterThan(mil.ff)
  })

  it('a climb that does not fit the leg is cut to it and flagged', () => {
    const close: Waypoint = { ...tgt, lat: inc.lat + 0.2, lon: inc.lon, alt: { ft: 35000, ref: 'msl' } }
    const leg = computeRows(m, [home, close], s)[1].leg!
    expect(leg.flags).toContain('short')
    expect(leg.climb!.nm).toBeCloseTo(leg.nm, 6)
  })

  it('combat loiter burns (MIL + max AB) / 2 at the waypoint altitude', () => {
    const rows = computeRows(m, [home, { ...tgt, loiter: { min: 5, phase: 'combat' } }, route[2]], s)
    const mach = rows[1].leg!.mach!
    const want = (powerFf(p, 'MIL', 20000, mach) + powerFf(p, 'ABMAX', 20000, mach)) / 2
    expect(rows[1].loiter!.ff).toBeCloseTo(want, 6)
    expect(rows[1].loiter!.fuel).toBeCloseTo((want * 5) / 60, 6)
  })

  it('bingo is flown at BFM No Tank drag, whatever the plan\'s drag category', () => {
    const at = (drag?: string) => fuelPlan(route, { ...s, drag })!
    expect(at().profiles!.bingoDrag).toBe('BFM No Tank')
    expect(at('Superbomber').bingo).toBeCloseTo(at().bingo, 6)
    expect(at('BFM No Tank').bingo).toBeCloseTo(at().bingo, 6)
    expect(at('Superbomber').joker).toBeGreaterThan(at().joker)
    expect(bingoDragOf({ ...defaultSettings('F-5E'), drag: 'SEAD' })).toBe('SEAD')
  })

  it('bingo: best-range return plus the landing reserve, up to the ceiling', () => {
    const f = fuelPlan(route, s, computeRows(m, route, s))!
    const b = f.profiles!.bingo
    expect(f.profiles!.reserve).toBe(3000)
    expect(f.bingo).toBeCloseTo(b.fuel + 3000, 6)
    expect(b.altFt).toBeGreaterThanOrEqual(20000)
    expect(b.kias).toBeCloseTo(bestRangeKias(p, b.altFt)!, 0)
    expect(b.descent!.toFt).toBe(240)
    // A Superbomber can't hold 7.5 units level up high: a bingo profile at that drag stays where it can.
    const heavy = bingoProfile(p, { ...s, drag: 'Superbomber' }, 20000, 240, f.rtbNm, 107)
    expect(heavy.flags).not.toContain('fast')
    expect(heavy.altFt).toBeLessThan(35000)
    const capped = fuelPlan(route, { ...s, bingoCapFt: 22000 })!.profiles!.bingo
    expect(capped.altFt).toBeLessThanOrEqual(22000)
    expect(capped.fuel).toBeGreaterThanOrEqual(b.fuel)
  })

  it('bingo stays lower on a short return', () => {
    const near: Waypoint[] = [home, { ...tgt, lat: inc.lat + 0.25, lon: inc.lon, alt: { ft: 2000, ref: 'msl' } }, { ...home, id: 'c' }]
    const b = fuelPlan(near, s)!.profiles!.bingo
    expect(b.altFt).toBeLessThan(20000)
    expect(b.flags).not.toContain('short')
  })

  it('joker: loiter, 1 min max AB, 30 nm escape at 95 % low, climb to 20,000 and home at 95 %, plus reserve', () => {
    const r = [home, { ...tgt, loiter: { min: 10 } }, route[2]]
    const rows = computeRows(m, r, s)
    const f = fuelPlan(r, s, rows)!
    const j = f.profiles!.joker
    expect(j.loiter).toBeCloseTo(rows[1].loiter!.fuel, 6)
    expect(j.escape.nm).toBe(30)
    expect(j.escape.altFt).toBe(2000)
    expect(j.escape.rpm).toBe(95)
    expect(j.home.altFt).toBe(20000)
    expect(j.home.rpm).toBe(95)
    expect(f.calc.joker).toBeCloseTo(Math.max(f.calc.bingo, j.loiter + j.ab + j.escape.fuel + j.home.fuel + 3000), 6)
    expect(f.joker).toBeGreaterThan(f.bingo)
    const loaded = fuelPlan(r, { ...s, drag: 'Superbomber' }, computeRows(m, r, { ...s, drag: 'Superbomber' }))!
    expect(loaded.joker).toBeGreaterThan(f.joker)
    expect(loaded.bingo).toBeCloseTo(f.bingo, 6)
    expect(fuelPlan(r, { ...s, jokerOverride: 9000 }, rows)!.joker).toBe(9000)
  })

  it('older F-4E plans: fixed phases fall back to cruise and a typed TAS becomes the leg speed', () => {
    const old = computeRows(m, [home, { ...tgt, phase: 'cruise-high', tas: 450 }], { ...s, phase: 'cruise-high' })[1].leg!
    expect(old.phase!.id).toBe('cruise')
    expect(old.tas).toBeCloseTo(450, 6)
    expect(AIRCRAFT['F-4E'].phases.map((x) => x.id)).toEqual(['cruise', 'mil', 'ab'])
  })
})
