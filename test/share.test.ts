import { describe, expect, it } from 'vitest'
import { defaultSettings, type Waypoint } from '../src/nav/plan'
import { decodePlan, encodePlan, planFromHash, type SharedPlan } from '../src/nav/share'

const route: Waypoint[] = Array.from({ length: 12 }, (_, i) => ({
  id: `wp${i}`, name: `WP${i}`, source: 'target', lat: 36 + i / 10, lon: 37 - i / 10, elevFt: 1000 + i, elevSource: 'dcs',
  tags: i === 5 ? ['TGT'] : undefined, loiter: i === 5 ? { min: 5, phase: 'cruise-low' } : undefined,
}))
const plan: SharedPlan = {
  v: 1, mission: { name: 'Syria TDY 433rd', theatre: 'Syria' }, route,
  settings: { ...defaultSettings('F-4E', 43200), windDir: 270, windKt: 25, popup: { dive: 30, ktas: 480, track: 4, rel: 4000, relRef: 'agl', g: 4 } },
}

describe('share links', () => {
  it('round-trips the whole plan', async () => {
    const text = await encodePlan(plan)
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await decodePlan(text)).toEqual(JSON.parse(JSON.stringify(plan)))
  })

  it('stays short enough for a chat message', async () => {
    expect((await encodePlan(plan)).length).toBeLessThan(2000)
  })

  it('rejects damaged or foreign text', async () => {
    expect(await decodePlan('not-a-plan')).toBeNull()
    const text = await encodePlan({ ...plan, v: 2 } as unknown as SharedPlan)
    expect(await decodePlan(text)).toBeNull()
  })

  it('finds the plan in the URL hash', () => {
    expect(planFromHash('#plan=abc_-1')).toBe('abc_-1')
    expect(planFromHash('#x=1&plan=abc')).toBe('abc')
    expect(planFromHash('#other')).toBeNull()
    expect(planFromHash('')).toBeNull()
  })
})
