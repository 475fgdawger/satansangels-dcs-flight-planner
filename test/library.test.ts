import { describe, expect, it } from 'vitest'
import { exportLibrary, importLibrary, readLibrary, saveRoute, writeLibrary, LIBRARY_KEY } from '../src/nav/library'
import { defaultSettings } from '../src/nav/plan'
import type { SharedPlan } from '../src/nav/share'

const plan = (n: number): SharedPlan => ({ v: 1, mission: { name: 'Syria TDY', theatre: 'Syria' },
  route: Array.from({ length: n }, (_, i) => ({ id: `w${i}`, name: `WP${i}`, source: 'manual', lat: 36 + i, lon: 36 })),
  settings: { ...defaultSettings('F-4E'), title: 'Strike Karapinar' } })

describe('saved routes', () => {
  it('saves newest first and replaces a same-named route', () => {
    let lib = saveRoute([], 'Alpha', plan(2), new Date('2026-10-06T10:00:00Z'))
    lib = saveRoute(lib, 'Bravo', plan(3), new Date('2026-10-06T11:00:00Z'))
    lib = saveRoute(lib, ' alpha ', plan(4), new Date('2026-10-06T12:00:00Z'))
    expect(lib.map((r) => r.name)).toEqual(['alpha', 'Bravo'])
    expect(lib[0].plan.route).toHaveLength(4)
  })

  it('round-trips through storage and ignores junk', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    const lib = saveRoute([], 'Alpha', plan(2))
    expect(writeLibrary(storage, lib)).toBe(true)
    expect(readLibrary(storage)).toEqual(lib)
    mem.set(LIBRARY_KEY, JSON.stringify([...lib, { name: 'broken' }]))
    expect(readLibrary(storage)).toEqual(lib)
    mem.set(LIBRARY_KEY, 'not json')
    expect(readLibrary(storage)).toEqual([])
  })

  it('imports an export, keeping the newer copy of a same-named route', () => {
    const mine = saveRoute([], 'Alpha', plan(2), new Date('2026-10-06T10:00:00Z'))
    const theirs = saveRoute(saveRoute([], 'Alpha', plan(5), new Date('2026-10-06T12:00:00Z')),
      'Charlie', plan(3), new Date('2026-10-06T09:00:00Z'))
    const res = importLibrary(mine, exportLibrary(theirs))!
    expect(res.added).toBe(2)
    expect(res.routes.map((r) => r.name)).toEqual(['Alpha', 'Charlie'])
    expect(res.routes[0].plan.route).toHaveLength(5)
    expect(res.routes[0].id).toBe(mine[0].id)
    expect(importLibrary(mine, { hello: 1 })).toBeNull()
  })
})
