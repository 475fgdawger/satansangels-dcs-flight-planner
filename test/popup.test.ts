import { describe, expect, it } from 'vitest'
import raw from './fixtures/targets_syria.json'
import { parseMission, airfields } from '../src/nav/mission'
import { attackRun, defaultSettings, popupInputs, type Waypoint } from '../src/nav/plan'
import { FT_NM, attackCard, defaultPopup, popupAttack, popupPicture, popupProblems, type PopupInputs } from '../src/nav/popup'
import { lookupElevations } from '../src/nav/elevation'

const m = parseMission(raw)

// The F-4E Pop-Up Planner artifact's default inputs.
const base: PopupInputs = { dive: 20, ktas: 450, track: 5, tgtElev: 4500, relAgl: 3000, g: 4, ipNm: 10, ingressKt: 480, hdg: 360, ingAlt: 5000 }

describe('pop-up attack', () => {
  const r = popupAttack(base)!
  const th = (20 * Math.PI) / 180
  const V = 450 * 1.68781

  it('dive, tracking and release', () => {
    expect(r.V).toBeCloseTo(V, 6)
    expect(r.trackAlt).toBeCloseTo(V * Math.sin(th) * 5, 6)
    expect(r.relRng).toBeCloseTo(3000 / Math.tan(th), 6)
    expect(r.wlAgl).toBeCloseTo(3000 + r.trackAlt, 6)
    const R = (V * V) / (4 * 32.174)
    expect(r.riAgl).toBeCloseTo(r.wlAgl + R * (1 - Math.cos(th)), 6)
  })

  it('ingress: IP to action point time, action and attack headings', () => {
    expect(r.legNm).toBeCloseTo(6, 9)
    expect(r.legSec).toBeCloseTo(45, 9)
    expect([r.actionLeft, r.actionRight]).toEqual(['340', '020'])
    expect(r.climb).toBe(30)
    expect(r.pullUpFt).toBeCloseTo(480 * 1.68781 * 4, 6)
    // After an action right the roll-in is right of the target line, so the attack heading points back left of it.
    expect(Number(r.attackRight)).toBeGreaterThan(330)
    expect(Number(r.attackLeft)).toBeLessThan(30)
    expect(r.riRng).toBeGreaterThan(r.relRng)
    expect(r.riRng).toBeLessThan(4 * FT_NM)
  })

  it('flags a roll-in too close for the pull-down and tracking', () => {
    const tight = popupAttack({ ...base, dive: 5, relAgl: 3000 })!
    expect(tight.warning).toMatch(/Roll-in comes/)
    expect(popupAttack({ ...base, dive: 5, relAgl: 1000, ingAlt: 12000 })!.warning).toMatch(/no climb/)
    expect(r.warning).toBeNull()
    expect(popupAttack({ ...base, ingAlt: 4000 })!.warning).toMatch(/below the target/)
  })

  it('reports missing inputs', () => {
    expect(popupProblems({ ...base, tgtElev: NaN })).toEqual(['an elevation on the TGT waypoint'])
    expect(popupProblems({ ...base, ipNm: 3 })[0]).toMatch(/IP at least 4 nm/)
    expect(popupAttack({ ...base, dive: 25 })).toBeNull()
  })

  it('builds the 9-step card and a picture', () => {
    const card = attackCard(r)
    expect(card.map((s) => s.title)).toEqual(['IP', 'IP to Action Point', 'Action Point', 'Pull-up', 'Roll-in', 'Wings level', 'Tracking', 'Release', 'Target'])
    expect(card[1].rows[1].value).toBe('0:45 (45 s)')
    const pic = popupPicture(r)
    expect(pic.svg).toContain('ROLL-IN')
    expect(pic.height).toBeGreaterThan(400)
  })
})

describe('attack run from the route', () => {
  const inc = airfields(m).find((a) => a.name === 'Incirlik')!
  const t5 = m.targets.find((t) => t.name === 'T-5')!
  const ip: Waypoint = { id: 'ip', name: 'DAN 300/75', source: 'manual', lat: 37.7307, lon: 34.1612, tags: ['IP'] }
  const route: Waypoint[] = [
    { id: 'a', name: 'Incirlik', source: 'airfield', lat: inc.lat, lon: inc.lon },
    ip,
    { id: 'x', name: 'turn', source: 'manual', lat: 37.7, lon: 33.9 },
    { id: 't', name: 'T-5', source: 'target', lat: t5.lat, lon: t5.lon, tags: ['TGT'], elevFt: 3300 },
    { id: 'b', name: 'Incirlik', source: 'airfield', lat: inc.lat, lon: inc.lon },
  ]
  const s = defaultSettings('F-4E')

  it('runs from the marked IP to the first TGT and feeds the pop-up', () => {
    const run = attackRun(m, route, s)!
    expect(run).toMatchObject({ ip: 1, tgt: 3, tas: 460, elevFt: 3300 })
    expect(run.ipNm).toBeGreaterThan(20)
    const p = popupInputs(run, { ...defaultPopup(), rel: 6300, relRef: 'msl' })
    expect(p.relAgl).toBe(3000)
    expect(p.ipNm).toBe(run.ipNm)
    expect(p.hdg).toBe(Math.round(run.magCourse))
    expect(popupInputs(run, { ...defaultPopup(), ipNm: 8, hdg: 250 })).toMatchObject({ ipNm: 8, hdg: 250, ingAlt: 3800 })
    expect(popupInputs(run, { ...defaultPopup(), ingAlt: 6000 }).ingAlt).toBe(6000)
  })

  it('without an IP mark, runs from the waypoint before the target; none without a TGT', () => {
    const noIp = route.map((w) => (w.id === 'ip' ? { ...w, tags: undefined } : w))
    expect(attackRun(m, noIp, s)!.ip).toBe(2)
    expect(attackRun(m, route.map((w) => ({ ...w, tags: undefined })), s)).toBeNull()
  })
})

describe('elevation lookup', () => {
  it('batches points and converts metres to feet', async () => {
    const urls: string[] = []
    const fake = (async (url: string) => {
      urls.push(url)
      const n = new URL(url).searchParams.get('latitude')!.split(',').length
      return new Response(JSON.stringify({ elevation: Array(n).fill(1000) }))
    }) as typeof fetch
    const pts = Array.from({ length: 150 }, (_, i) => ({ lat: 36 + i / 1000, lon: 37 }))
    const out = await lookupElevations(pts, fake)
    expect(urls).toHaveLength(2)
    expect(out).toHaveLength(150)
    expect(out[0]).toBe(3281)
  })
  it('fails cleanly on a bad response', async () => {
    const fake = (async () => new Response('no', { status: 429 })) as typeof fetch
    await expect(lookupElevations([{ lat: 1, lon: 1 }], fake)).rejects.toThrow(/429/)
  })
})
