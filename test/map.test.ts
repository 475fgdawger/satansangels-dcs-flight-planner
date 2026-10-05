import { describe, expect, it } from 'vitest'
import raw from './fixtures/targets_syria.json'
import { inverse } from '../src/nav/geodesy'
import { parseMission } from '../src/nav/mission'
import { boundsOf, dashFor, dcsColor, drawingLayers, legMidpoint, missionBounds, threatRing } from '../src/nav/map'

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

describe('mission editor drawings', () => {
  it('reads DCS colors', () => {
    expect(dcsColor('0xff0000ff')).toEqual({ css: '#ff0000', opacity: 1 })
    expect(dcsColor('0x0000FF80')!.opacity).toBeCloseTo(128 / 255)
    expect(dcsColor('red')).toBeNull()
    expect(dcsColor(undefined)).toBeNull()
  })

  it('dashes non-solid lines', () => {
    expect(dashFor('solid', 2)).toBeUndefined()
    expect(dashFor('dash', 2)).toBe('8 6')
    expect(dashFor('dot2', 2)).toBe('1 5')
  })

  it('lists draw layers once each, Red and hidden layers off', () => {
    const d = (layer: string, layer_visible = true) => ({ layer, layer_visible })
    expect(drawingLayers([d('Blue'), d('Red'), d('Blue'), d('Author', false), d('Common')])).toEqual([
      { name: 'Blue', on: true }, { name: 'Red', on: false }, { name: 'Author', on: false }, { name: 'Common', on: true },
    ])
    expect(drawingLayers(undefined)).toEqual([])
  })
})
