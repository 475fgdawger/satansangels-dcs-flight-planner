import { describe, expect, it } from 'vitest'
import syria from './fixtures/targets_syria.json'
import tiger from '../public/data/missions/targets_steel_tiger.json'
import { fromDcs, toDcs } from '../src/nav/dcsgrid'
import { AIRDROMES } from '../src/nav/miz'

const table = AIRDROMES

describe('DCS map grid', () => {
  it('puts every Syria airbase in the export within 3 m of its DCS position', () => {
    const errs = syria.airbases.map((a) => {
      const ref = table.Syria.find((r) => r[1] === a.name)!
      const p = toDcs('Syria', a.lat, a.lon)
      return Math.hypot(p.x - ref[2], p.y - ref[3])
    })
    expect(errs.length).toBeGreaterThan(200)
    expect(Math.max(...errs)).toBeLessThan(3)
  })

  it('puts the Caucasus airfields in Steel Tiger within 3 m of their DCS positions', () => {
    const fields = tiger.airbases.filter((a) => table.Caucasus.some((r) => r[1] === a.name))
    expect(fields.length).toBeGreaterThan(15)
    for (const a of fields) {
      const ref = table.Caucasus.find((r) => r[1] === a.name)!
      const p = toDcs('Caucasus', a.lat, a.lon)
      expect(Math.hypot(p.x - ref[2], p.y - ref[3])).toBeLessThan(3)
    }
  })

  it('round-trips', () => {
    const p = toDcs('Caucasus', 41.6103, 41.6)
    const back = fromDcs('Caucasus', p.x, p.y)
    expect(back.lat).toBeCloseTo(41.6103, 7)
    expect(back.lon).toBeCloseTo(41.6, 7)
  })
})
