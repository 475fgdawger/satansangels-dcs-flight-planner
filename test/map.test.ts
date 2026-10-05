import { describe, expect, it } from 'vitest'
import raw from './fixtures/targets_syria.json'
import { inverse } from '../src/nav/geodesy'
import { parseMission } from '../src/nav/mission'
import { boundsOf, legMidpoint, missionBounds, threatRing } from '../src/nav/map'

const m = parseMission(raw)
const target = (name: string) => m.targets.find((t) => t.name === name)!

describe('map helpers', () => {
  it('rings the SAMs and Fire Cans, not ranges or EWRs', () => {
    expect(threatRing(target('Aleppo SA-2'))).toEqual({ nm: 24, system: 'SA-2' })
    expect(threatRing(target('Minakh Fire Can 1'))).toEqual({ nm: 4, system: 'Fire Can' })
    expect(threatRing(target('T-1'))).toBeNull()
    expect(threatRing(target('Aleppo EWR'))).toBeNull()
  })

  it('frames the TACANs and targets, padded', () => {
    const b = missionBounds(m)!
    for (const p of [...m.tacans, ...m.targets]) {
      expect(p.lat).toBeGreaterThan(b.south)
      expect(p.lat).toBeLessThan(b.north)
      expect(p.lon).toBeGreaterThan(b.west)
      expect(p.lon).toBeLessThan(b.east)
    }
    expect(boundsOf([])).toBeNull()
  })

  it('puts the leg label halfway along the leg', () => {
    const a = m.tacans[0], b = target('T-1')
    const mid = legMidpoint(a, b)
    const total = inverse(a.lat, a.lon, b.lat, b.lon).nm
    expect(inverse(a.lat, a.lon, mid.lat, mid.lon).nm).toBeCloseTo(total / 2, 3)
    expect(inverse(mid.lat, mid.lon, b.lat, b.lon).nm).toBeCloseTo(total / 2, 3)
  })
})
