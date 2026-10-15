import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import raw from './fixtures/targets_syria.json'
import { parseMission } from '../src/nav/mission'
import { computeRows, defaultSettings, type Waypoint } from '../src/nav/plan'
import { parseLuaAssignments, luaGet, luaList } from '../src/nav/lua'
import { readMiz, writeRoutes } from '../src/nav/miz'
import { toDcs } from '../src/nav/dcsgrid'

const m = parseMission(raw)
const af = (name: string) => m.airbases.find((a) => a.name === name)!
const wp = (id: string, name: string, p: { lat: number; lon: number }, extra: Partial<Waypoint> = {}): Waypoint =>
  ({ id, name, source: 'manual', lat: p.lat, lon: p.lon, ...extra })

const inc = af('Incirlik'), incXY = toDcs('Syria', inc.lat, inc.lon)

// A mission as the DCS editor saves it: one client F-4E flight at Incirlik, one AI flight in the air.
const group = (name: string, skill: string, first: string) => `
				[1] = 
				{
					["name"] = "${name}",
					["task"] = "CAS",
					["units"] = 
					{
						[1] = 
						{
							["type"] = "F-4E-45MC",
							["skill"] = "${skill}",
							["name"] = "${name}-1",
						}, -- end of [1]
					}, -- end of ["units"]
					["route"] = 
					{
						["points"] = 
						{
							[1] = 
							{
${first}
							}, -- end of [1]
							[2] = 
							{
								["x"] = 1,
								["y"] = 2,
								["type"] = "Turning Point",
							}, -- end of [2]
						}, -- end of ["points"]
					}, -- end of ["route"]
				}, -- end of [1]`
const parking = `								["alt"] = 18,
								["action"] = "From Parking Area",
								["type"] = "TakeOffParking",
								["airdromeId"] = 16,
								["x"] = ${incXY.x},
								["y"] = ${incXY.y},
								["name"] = "Ramp \\"A\\"",`
const air = `								["alt"] = 6000,
								["type"] = "Turning Point",
								["x"] = 0,
								["y"] = 0,`
const missionText = `mission = 
{
	["theatre"] = "Syria",
	["coalition"] = 
	{
		["blue"] = 
		{
			["country"] = 
			{
				[1] = 
				{
					["name"] = "USA",
					["plane"] = 
					{
						["group"] = 
						{${group('Satan 1', 'Client', parking)}
							[2] = { ["name"] = "Bandit", ["units"] = { [1] = { ["type"] = "MiG-21Bis", ["skill"] = "High", ["name"] = "b" } },
								["route"] = { ["points"] = { [1] = { ${air.replace(/\n\s*/g, ' ')} } } } },
						}, -- end of ["group"]
					}, -- end of ["plane"]
				}, -- end of [1]
			}, -- end of ["country"]
		}, -- end of ["blue"]
	}, -- end of ["coalition"]
} -- end of mission
`
const miz = () => zipSync({ mission: strToU8(missionText), 'l10n/DEFAULT/dictionary': strToU8('dictionary = {}\n') })

const route = [
  wp('a', 'Incirlik', inc, { source: 'airfield', end: 'departure', elevFt: 190 }),
  wp('b', 'Hatay', af('Hatay'), { alt: { ft: 20000, ref: 'msl' } }),
  wp('c', 'IP "low"', { lat: 36.42, lon: 36.75 }, { alt: { ft: 500, ref: 'agl' }, elevFt: 1000 }),
  wp('d', 'Incirlik', inc, { source: 'airfield', end: 'destination', elevFt: 190 }),
]
const rows = computeRows(m, route, defaultSettings('F-4E'))

describe('mission (.miz) route writing', () => {
  it('lists aircraft groups with their start', () => {
    const r = readMiz(miz())
    expect(r.theatre).toBe('Syria')
    expect(r.groups.map((g) => [g.name, g.human, g.start, g.airdromeId, g.points])).toEqual([
      ['Satan 1', true, 'TakeOffParking', 16, 2],
      ['Bandit', false, 'Turning Point', undefined, 1],
    ])
  })

  it('replaces only the chosen group\'s route, keeping its start point and everything else', () => {
    const r = readMiz(miz())
    const out = unzipSync(writeRoutes(r, { [r.groups[0].key]: rows }))
    expect(strFromU8(out['l10n/DEFAULT/dictionary'])).toBe('dictionary = {}\n')
    const text = strFromU8(out.mission)
    // Text before and after the replaced table is unchanged.
    const t = r.groups[0].pointsTable
    expect(text.startsWith(missionText.slice(0, t.start))).toBe(true)
    expect(text.endsWith(missionText.slice(t.end))).toBe(true)

    const mission = parseLuaAssignments(text).get('mission')
    const groups = luaList(luaGet(mission, 'coalition', 'blue', 'country', 1, 'plane', 'group'))
    const pts = luaList(luaGet(groups[0], 'route', 'points'))
    // Start kept; the departure isn't repeated; Hatay, IP, then landing back at Incirlik.
    expect(pts.map((p) => luaGet(p, 'type'))).toEqual(['TakeOffParking', 'Turning Point', 'Turning Point', 'Land'])
    expect(luaGet(pts[0], 'name')).toBe('Ramp "A"')
    expect(luaGet(pts[2], 'name')).toBe('IP "low"')
    expect(luaGet(pts[1], 'alt')).toBeCloseTo(20000 * 0.3048, 1)
    expect(luaGet(pts[1], 'alt_type')).toBe('BARO')
    expect(luaGet(pts[2], 'alt')).toBeCloseTo(500 * 0.3048, 1)
    expect(luaGet(pts[2], 'alt_type')).toBe('RADIO')
    expect(luaGet(pts[3], 'airdromeId')).toBe(16)
    expect(luaGet(pts[3], 'action')).toBe('Landing')
    const hatay = toDcs('Syria', af('Hatay').lat, af('Hatay').lon)
    expect(luaGet(pts[1], 'x')).toBeCloseTo(hatay.x, 0)
    expect(luaGet(pts[1], 'y')).toBeCloseTo(hatay.y, 0)
    expect(luaGet(pts[1], 'speed')).toBeCloseTo(rows[1].leg!.tas * 1852 / 3600, 1)
    // The other group is untouched.
    expect(luaList(luaGet(groups[1], 'route', 'points'))).toHaveLength(1)
  })

  it('writes a different plan into each flight in one save', () => {
    const r = readMiz(miz())
    const short = computeRows(m, [route[0], route[1], route[3]], defaultSettings('F-4E'))
    const text = strFromU8(unzipSync(writeRoutes(r, { [r.groups[0].key]: rows, [r.groups[1].key]: short })).mission)
    const groups = luaList(luaGet(parseLuaAssignments(text).get('mission'), 'coalition', 'blue', 'country', 1, 'plane', 'group'))
    const names = (g: unknown) => luaList(luaGet(g as never, 'route', 'points')).map((p) => luaGet(p, 'name'))
    expect(names(groups[0])).toEqual(['Ramp "A"', 'Hatay', 'IP "low"', 'Incirlik'])
    // The air-start flight is far from Incirlik, so its plan starts with the departure.
    expect(names(groups[1])).toEqual([undefined, 'Incirlik', 'Hatay', 'Incirlik'])
  })

  it('rejects a file that is not a mission', () => {
    expect(() => readMiz(strToU8('hello'))).toThrow(/not a DCS mission/)
  })
})
