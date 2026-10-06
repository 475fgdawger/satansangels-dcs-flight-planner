import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { TerrainGrid } from '../nav/terrain'
import { loadTerrain } from './terrain'
import type { MissionExport } from '../nav/types'
import { catalog, kindLabel, parseMission, parseTacanFix, type CatalogPoint } from '../nav/mission'
import { clock, parseClock, parseLatLon } from '../nav/format'
import { AIRCRAFT, WAYPOINT_TAGS, altAgl, altMsl, attackRun, planTitle, refreshElevations, computeRows, popupInputs, defaultSettings, departureFuel, fuelPlan, phaseOf, type AircraftId, type FuelPlan, type PhaseId,
  type PlanSettings, type Waypoint } from '../nav/plan'
import { Kneeboard } from './Kneeboard'
import { PopupPanel } from './Popup'
import { MapPanel } from './MapPanel'
import { defaultPopup, popupAttack } from '../nav/popup'
import { lookupElevations } from '../nav/elevation'
import { decodePlan, encodePlan, planFromHash, SHARE_KEY, type SharedPlan } from '../nav/share'
import { LibraryPanel } from './Library'

const STORAGE_KEY = 'flightplanner.v2'

interface MissionEntry {
  file: string
  name: string
  theatre: string
  built_utc: string
}


interface Saved {
  mission: MissionExport
  route: Waypoint[]
  settings: PlanSettings
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Saved) : null
  } catch {
    return null
  }
}

function save(s: Saved) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // Storage full or blocked: the plan still works for this visit.
  }
}

let nextId = 1
const newId = () => `wp${Date.now().toString(36)}${nextId++}`

export function App() {
  const saved = useMemo(load, [])
  const [mission, setMission] = useState<MissionExport | null>(saved?.mission ?? null)
  const [route, setRoute] = useState<Waypoint[]>(saved?.route ?? [])
  const [settings, setSettings] = useState<PlanSettings | null>(saved?.settings ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (mission && settings) save({ mission, route, settings })
  }, [mission, route, settings])

  // DCS's terrain for the mission's theatre, for the strip maps; null until loaded or when there is none.
  const theatre = mission?.mission.theatre ?? ''
  const [terrain, setTerrain] = useState<TerrainGrid | null>(null)
  useEffect(() => {
    let live = true
    setTerrain(null)
    if (theatre) loadTerrain(theatre).then((g) => live && setTerrain(g)).catch(() => live && setTerrain(null))
    return () => { live = false }
  }, [theatre])

  // Missions the bot has pushed to the site (public/data/missions, listed at build time).
  const [missions, setMissions] = useState<MissionEntry[]>([])
  useEffect(() => {
    fetch('./data/missions/index.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setMissions(Array.isArray(list) ? list : []))
      .catch(() => setMissions([]))
  }, [])

  /** Opens a shared or saved plan, loading its mission from the site when it isn't the one open. */
  async function openPlan(plan: SharedPlan, what: string): Promise<boolean> {
    if (route.length > 0 && !confirm(`Open ${what}? It replaces your current route.`)) return false
    let m = mission
    if (!m || m.mission.name !== plan.mission.name || m.mission.theatre !== plan.mission.theatre) {
      try {
        const list: MissionEntry[] = await (await fetch('./data/missions/index.json')).json()
        const e = list.find((x) => x.name === plan.mission.name && x.theatre === plan.mission.theatre)
        if (!e) throw new Error()
        m = parseMission(await (await fetch(`./data/missions/${encodeURIComponent(e.file)}`)).json())
      } catch {
        setError(`That plan is for ${plan.mission.name} (${plan.mission.theatre}), which isn't on the site. `
          + 'Open its target list JSON, then try again.')
        return false
      }
    }
    setMission(m)
    setRoute(refreshElevations(m, plan.route))
    setSettings(plan.settings)
    setError(null)
    return true
  }

  // A shared link (#plan=...) opens that plan.
  const [shareMsg, setShareMsg] = useState<string | null>(null)
  useEffect(() => {
    const text = planFromHash(location.hash)
    if (!text) return
    history.replaceState(null, '', location.pathname + location.search)
    ;(async () => {
      const plan = await decodePlan(text)
      if (!plan) { setError('That share link is damaged or from a newer version of the planner.'); return }
      if (await openPlan(plan, `the shared plan for ${plan.mission.name}`)) setShareMsg(`Opened a shared plan for ${plan.mission.name}.`)
    })()
  }, [])

  const currentPlan = (): SharedPlan | null => (mission && settings
    ? { v: 1, mission: { name: mission.mission.name, theatre: mission.mission.theatre }, route, settings } : null)

  async function copyShareLink() {
    const plan = currentPlan()
    if (!plan) return
    const text = await encodePlan(plan)
    const url = `${location.origin}${location.pathname}#${SHARE_KEY}=${text}`
    try {
      await navigator.clipboard.writeText(url)
      setShareMsg('Link copied. Anyone who opens it gets this route, settings and kneeboard.')
    } catch {
      window.prompt('Copy this link:', url)
    }
  }

  /** Loads an export. The same mission again (newer data) keeps the route and refreshes its elevations. */
  function applyMission(json: unknown) {
    try {
      const m = parseMission(json)
      const same = mission?.mission.name === m.mission.name && mission?.mission.theatre === m.mission.theatre
      setMission(m)
      setRoute((r) => (same ? refreshElevations(m, r) : []))
      // A different mission starts a new plan, so its title goes too.
      setSettings((s) => (s ? (same ? s : { ...s, title: undefined }) : defaultSettings('F-4E')))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    try {
      applyMission(JSON.parse(await file.text()))
    } catch {
      setError(`${file.name} is not valid JSON.`)
    }
  }

  async function loadMission(e: MissionEntry) {
    try {
      const res = await fetch(`./data/missions/${encodeURIComponent(e.file)}`)
      if (!res.ok) throw new Error()
      applyMission(await res.json())
    } catch {
      setError(`Could not load ${e.name}.`)
    }
  }
  const newer = mission ? missions.find((e) => e.name === mission.mission.name && e.theatre === mission.mission.theatre
    && e.built_utc > mission.built_utc) : undefined

  const rows = useMemo(() => (mission && settings ? computeRows(mission, route, settings) : []), [mission, route, settings])
  const fuel = useMemo(() => (settings ? fuelPlan(route, settings) : null), [route, settings])
  // Waypoints with no elevation get one from the terrain lookup; each is tried once per visit.
  const tried = useRef(new Set<string>())
  useEffect(() => {
    const need = route.filter((w) => w.elevFt === undefined && !tried.current.has(w.id))
    if (need.length === 0) return
    need.forEach((w) => tried.current.add(w.id))
    lookupElevations(need)
      .then((elev) => {
        const byId = new Map(need.map((w, i) => [w.id, elev[i]]))
        setRoute((r) => r.map((w) => (w.elevFt === undefined && byId.has(w.id)
          ? { ...w, elevFt: byId.get(w.id), elevSource: 'dem' as const } : w)))
      })
      .catch(() => { /* offline or blocked: elevations stay blank and can be typed */ })
  }, [route])

  const run = useMemo(() => (mission && settings ? attackRun(mission, route, settings) : null), [mission, route, settings])
  const attack = useMemo(() => (run && settings ? popupAttack(popupInputs(run, settings.popup ?? defaultPopup())) : null),
    [run, settings])

  return (
    <>
      <header class="app-header no-print">
        <h1>433rd TFS Flight Planner</h1>
        <p class="muted">Build a route and print a nav log with TACAN fixes for every waypoint.</p>
      </header>

      <section
        class="panel no-print"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer?.files[0]) }}
      >
        <h2>Mission</h2>
        <div class="row">
          <label class="button">
            Open target list JSON
            <input type="file" accept=".json,application/json" hidden
              onChange={(e) => onFile((e.target as HTMLInputElement).files?.[0])} />
          </label>
          <span class="muted">or drop <code>targets_*.json</code> here</span>
        </div>
        {missions.length > 0 && (
          <div class="row missions">
            <span class="muted">Current missions:</span>
            {missions.map((e) => (
              <button type="button" key={e.file} onClick={() => loadMission(e)}
                title={`Exported by the bot ${e.built_utc.replace('T', ' ')}`}>
                {e.name} <span class="muted small">({e.theatre})</span>
              </button>
            ))}
          </div>
        )}
        {mission && route.length > 0 && (
          <div class="row">
            <button type="button" onClick={copyShareLink}>Copy share link</button>
            {shareMsg && <span class="muted small">{shareMsg}</span>}
          </div>
        )}
        {newer && (
          <p class="notice">
            Newer data for this mission from {newer.built_utc.replace('T', ' ')}.{' '}
            <button type="button" onClick={() => loadMission(newer)}>Update</button>{' '}
            <span class="muted small">Your route stays.</span>
          </p>
        )}
        {error && <p class="error">{error}</p>}
        {mission && (
          <p>
            <strong>{mission.mission.name}</strong> ({mission.mission.theatre}) · start {clock(mission.mission.start_time)} ·
            exported {mission.built_utc.replace('T', ' ')}
          </p>
        )}
      </section>

      <LibraryPanel current={currentPlan()} defaultName={mission && settings ? planTitle(mission.mission.name, settings) : ''}
        onOpen={(p, name) => openPlan(p, `"${name}"`)} />

      {mission && settings && (
        <>
          <SettingsPanel settings={settings} missionName={mission.mission.name} route={route} fuel={fuel} onChange={setSettings} />
          <RoutePanel mission={mission} route={route} settings={settings} onChange={setRoute} />
          <MapPanel mission={mission} route={route} rows={rows} onRoute={setRoute} />
          <PopupPanel route={route} run={run} settings={settings} attack={attack} onSettings={setSettings} onRoute={setRoute} />
          <Kneeboard mission={mission} rows={rows} settings={settings} fuel={fuel} run={run} attack={attack} terrain={terrain} />
        </>
      )}
    </>
  )
}

function num(v: string, fallback: number) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function SettingsPanel({ settings: s, missionName, route, fuel, onChange }:
  { settings: PlanSettings; missionName: string; route: Waypoint[]; fuel: FuelPlan | null; onChange: (s: PlanSettings) => void }) {
  const a = AIRCRAFT[s.aircraft]
  const set = (patch: Partial<PlanSettings>) => onChange({ ...s, ...patch })
  const field = (label: string, key: keyof PlanSettings, unit: string) => (
    <label class="field">
      <span>{label}</span>
      <input type="number" value={s[key] as number}
        onInput={(e) => set({ [key]: num((e.target as HTMLInputElement).value, s[key] as number) })} />
      <small>{unit}</small>
    </label>
  )
  const override = (label: string, key: 'jokerOverride' | 'bingoOverride', calc: number | undefined) => (
    <label class="field">
      <span>{label}</span>
      <input type="number" value={s[key] ?? ''} placeholder={calc === undefined ? '' : String(Math.round(calc))}
        onInput={(e) => set({ [key]: optNum((e.target as HTMLInputElement).value) })} />
      <small>{s[key] === undefined ? 'lb, calculated' : 'lb, typed (clear to calculate)'}</small>
    </label>
  )
  const load = a.fuelLoads.find((l) => l.lb === s.startFuel)
  return (
    <section class="panel no-print">
      <h2>Flight</h2>
      <div class="grid title-block">
        <label class="field">
          <span>Title</span>
          <input type="text" value={s.title ?? ''} placeholder={missionName}
            onInput={(e) => set({ title: (e.target as HTMLInputElement).value || undefined })} />
          <small>heads every kneeboard page; blank uses the mission name</small>
        </label>
        <label class="field">
          <span>Callsign</span>
          <input type="text" value={s.callsign ?? ''} placeholder="e.g. Satan 1"
            onInput={(e) => set({ callsign: (e.target as HTMLInputElement).value || undefined })} />
          <small>optional</small>
        </label>
      </div>
      <div class="grid">
        <label class="field">
          <span>Aircraft</span>
          <select value={s.aircraft}
            onChange={(e) => onChange({ ...defaultSettings((e.target as HTMLSelectElement).value as AircraftId, s.takeoff),
              windDir: s.windDir, windKt: s.windKt, targetId: s.targetId, title: s.title, callsign: s.callsign })}>
            {Object.keys(AIRCRAFT).map((id) => <option value={id}>{id}</option>)}
          </select>
        </label>
        <label class="field">
          <span>Takeoff</span>
          <input type="text" value={s.takeoff === undefined ? '' : clock(s.takeoff)} placeholder="HH:MM"
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).value
              if (v.trim() === '') set({ takeoff: undefined })
              const t = parseClock(v)
              if (t !== null) set({ takeoff: t })
            }} />
          <small>optional; blank leaves T/O and ETA blank</small>
        </label>
        <label class="field span2">
          <span>Fuel load</span>
          <select value={load ? String(load.lb) : 'custom'}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value
              if (v !== 'custom') set({ startFuel: Number(v) })
            }}>
            {a.fuelLoads.map((l) => <option value={String(l.lb)}>{l.label} ({l.lb.toLocaleString('en-US')})</option>)}
            {!load && <option value="custom">Custom</option>}
          </select>
        </label>
        {field('Start fuel', 'startFuel', 'lb')}
        {field('Taxi', 'taxiMin', `min at idle (${a.idleLbMin} lb/min)`)}
        {field('AB takeoff', 'abTakeoffMin', 'min, full AB to 400 kt')}
        {field('MIL climb', 'climbMin', 'min, start of first leg')}
        {field('Cruise TAS', 'tas', 'kt')}
        <label class="field span2">
          <span>Default phase</span>
          <select value={s.phase} onChange={(e) => set({ phase: (e.target as HTMLSelectElement).value as PhaseId })}>
            {a.phases.map((p) => <option value={p.id}>{p.label} ({p.ff.toLocaleString('en-US')} lb/hr)</option>)}
          </select>
        </label>
        {field('AB egress TAS', 'abTas', 'kt, for joker')}
        {override('Joker', 'jokerOverride', fuel?.calc.joker)}
        {override('Bingo', 'bingoOverride', fuel?.calc.bingo)}
        {field('Wind from', 'windDir', '° true')}
        {field('Wind speed', 'windKt', 'kt')}
      </div>
      <p class="muted small">
        Departure (taxi, AB takeoff to 400 kt, MIL climb): {Math.round(departureFuel(s).total).toLocaleString('en-US')} lb
        = {Math.round(departureFuel(s).taxi)} taxi + {Math.round(departureFuel(s).takeoff)} AB
        + {Math.round(departureFuel(s).climb)} climb. The climb is flown at the start of the first leg.
      </p>
      {fuel && (
        <p class="muted small">
          Joker and bingo are fuel states at {fuel.targetKind === 'auto'
            ? <>{route[fuel.target].name}, the farthest point from base (mark a TGT or CAP to change it)</>
            : <>the {fuel.targetKind} ({route[fuel.target].name})</>}, {fuel.rtbNm.toFixed(0)} nm from base.
          Bingo: the higher of {a.bingoFloor.toLocaleString('en-US')} lb and {Math.round(fuel.calc.rtbFuel)} lb to fly home at
          high cruise. Joker: {Math.round(fuel.calc.abLoiter)} lb for 1 min AB + {Math.round(fuel.calc.abEgress)} lb AB
          for the first 30 nm + {Math.round(fuel.calc.cruiseHome)} lb high cruise home.
        </p>
      )}
      <p class="muted small">
        {a.placeholder
          ? `${s.aircraft} fuel numbers are placeholders, not squadron figures. Edit them for your flight.`
          : `${s.aircraft} fuel numbers are the squadron's initial planning figures.`}
      </p>
    </section>
  )
}

function RoutePanel({ mission, route, settings, onChange }:
  { mission: MissionExport; route: Waypoint[]; settings: PlanSettings; onChange: (r: Waypoint[]) => void }) {
  const phases = AIRCRAFT[settings.aircraft].phases
  const points = useMemo(() => catalog(mission), [mission])
  const byLabel = useMemo(() => new Map(points.map((p) => [optionLabel(p), p])), [points])
  const [text, setText] = useState('')
  const [hint, setHint] = useState<string | null>(null)

  function add() {
    const t = text.trim()
    if (!t) return
    const picked = byLabel.get(t) ?? points.find((p) => p.name.toLowerCase() === t.toLowerCase())
    let wp: Waypoint | null = null
    if (picked) {
      wp = { id: newId(), name: picked.name, source: picked.kind, lat: picked.lat, lon: picked.lon,
        ...(picked.elevFt === undefined ? {} : { elevFt: Math.round(picked.elevFt), elevSource: 'dcs' as const }) }
    } else {
      const fix = parseTacanFix(mission, t)
      const ll = fix ?? parseLatLon(t)
      if (ll) wp = { id: newId(), name: fix ? t.toUpperCase() : `WP${route.length + 1}`, source: 'manual', ...ll }
    }
    if (!wp) {
      setHint('Not found. Pick from the list, or type a TACAN fix (DAN 287/99) or coordinates (N37 37.05 E033 30.65).')
      return
    }
    onChange([...route, wp])
    setText('')
    setHint(null)
  }

  const update = (i: number, patch: Partial<Waypoint>) => onChange(route.map((w, j) => (j === i ? { ...w, ...patch } : w)))
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= route.length) return
    const r = [...route]
    ;[r[i], r[j]] = [r[j], r[i]]
    onChange(r)
  }

  return (
    <section class="panel no-print">
      <h2>Route</h2>
      <form class="row" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input class="grow" list="points" placeholder="Airfield, zone, target, TACAN fix (DAN 287/99) or coordinates"
          value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <datalist id="points">
          {points.map((p) => <option value={optionLabel(p)} />)}
        </datalist>
        <button type="submit">Add waypoint</button>
      </form>
      {hint && <p class="error">{hint}</p>}
      {route.length > 0 && (
        <div class="route-wrap">
        <table class="route">
          <thead>
            <tr><th>#</th><th>Name</th><th>From</th><th title="Ground elevation, ft MSL">Elev (ft)</th><th title="Planned altitude at this waypoint, ft above sea level (MSL) or above the ground (AGL)">Altitude (ft)</th><th>Phase in</th><th>Custom flow (lb/hr)</th><th>TAS in (kt)</th><th title="Hold at this waypoint before the next leg">Loiter (min)</th><th title="Initial point, CAP station, target, egress point. The first TGT or CAP sets where joker and bingo are measured.">Marks</th><th /></tr>
          </thead>
          <tbody>
            {route.map((w, i) => (
              <tr key={w.id}>
                <td>{i}</td>
                <td><input value={w.name} onInput={(e) => update(i, { name: (e.target as HTMLInputElement).value })} /></td>
                <td class="muted">{w.source === 'manual' ? 'Typed' : kindLabel(w.source as CatalogPoint['kind'])}</td>
                <td><input type="number" class="elev" value={w.elevFt ?? ''} placeholder="MSL"
                  title={elevTitle(w)}
                  onInput={(e) => {
                    const v = optElev((e.target as HTMLInputElement).value)
                    update(i, { elevFt: v, elevSource: v === undefined ? undefined : 'typed' })
                  }} />{w.elevSource === 'dem' && <span class="muted small" title={elevTitle(w)}> ≈</span>}</td>
                <td>
                  <div class="alt">
                    <input type="number" step="any" value={w.alt?.ft ?? ''} title={altTitle(w)}
                      onInput={(e) => {
                        const ft = optElev((e.target as HTMLInputElement).value)
                        update(i, { alt: ft === undefined && !w.alt ? undefined : { ref: w.alt?.ref ?? 'msl', ft } })
                      }} />
                    <div class="stack">
                      {(['msl', 'agl'] as const).map((ref) => (
                        <label key={ref}>
                          <input type="radio" name={`alt-${w.id}`} checked={(w.alt?.ref ?? 'msl') === ref}
                            onChange={() => update(i, { alt: { ...w.alt, ref } })} />
                          {ref.toUpperCase()}
                        </label>
                      ))}
                    </div>
                  </div>
                </td>
                <td>{i > 0 && (
                  <select value={w.phase ?? ''} disabled={w.ff !== undefined}
                    onChange={(e) => {
                      const v = (e.target as HTMLSelectElement).value
                      update(i, { phase: v === '' ? undefined : (v as PhaseId) })
                    }}>
                    <option value="">Default ({phaseOf(settings.aircraft, settings.phase).label})</option>
                    {phases.map((p) => <option value={p.id} title={p.note}>{p.label} ({p.ff.toLocaleString('en-US')})</option>)}
                  </select>
                )}</td>
                <td>{i > 0 && <input type="number" class="num" value={w.ff ?? ''}
                  placeholder={String(phaseOf(settings.aircraft, w.phase ?? settings.phase).ff)}
                  onInput={(e) => update(i, { ff: optNum((e.target as HTMLInputElement).value) })} />}</td>
                <td>{i > 0 && <input type="number" class="num" placeholder={String(settings.tas)} value={w.tas ?? ''}
                  onInput={(e) => update(i, { tas: optNum((e.target as HTMLInputElement).value) })} />}</td>
                <td>{i > 0 && (
                  <div class="loiter">
                    <input type="checkbox" title="Loiter here" checked={w.loiter !== undefined}
                      onChange={(e) => update(i, { loiter: (e.target as HTMLInputElement).checked ? { min: 10 } : undefined })} />
                    {w.loiter && <>
                      <input type="number" min="0" step="any" value={w.loiter.min || ''} title="Loiter minutes"
                        onInput={(e) => update(i, { loiter: { ...w.loiter!, min: optNum((e.target as HTMLInputElement).value) ?? 0 } })} />
                      <select value={w.loiter.phase ?? ''} title="Power while loitering"
                        onChange={(e) => {
                          const v = (e.target as HTMLSelectElement).value
                          update(i, { loiter: { ...w.loiter!, phase: v === '' ? undefined : (v as PhaseId) } })
                        }}>
                        <option value="">Same as leg in</option>
                        {phases.map((p) => <option value={p.id} title={p.note}>{p.label} ({p.ff.toLocaleString('en-US')})</option>)}
                      </select>
                    </>}
                  </div>
                )}</td>
                <td>
                  <div class="marks">
                    {WAYPOINT_TAGS.map((tag) => (
                      <label key={tag}>
                        <input type="checkbox" checked={w.tags?.includes(tag) ?? false}
                          onChange={(e) => {
                            const on = (e.target as HTMLInputElement).checked
                            const tags = WAYPOINT_TAGS.filter((t) => (t === tag ? on : w.tags?.includes(t)))
                            update(i, { tags: tags.length ? tags : undefined })
                          }} />
                        {tag}
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  <div class="actions">
                    <button type="button" title="Move up" onClick={() => move(i, -1)}>↑</button>
                    <button type="button" title="Move down" onClick={() => move(i, 1)}>↓</button>
                    <button type="button" title="Remove" onClick={() => onChange(route.filter((_, j) => j !== i))}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {route.length > 0 && (
        <div class="row">
          <button type="button" onClick={() => onChange([])}>Clear route</button>
        </div>
      )}
    </section>
  )
}

function altTitle(w: Waypoint) {
  if (w.alt?.ft === undefined) return 'Planned altitude, ft'
  const other = w.alt.ref === 'msl' ? altAgl(w) : altMsl(w)
  const otherRef = w.alt.ref === 'msl' ? 'AGL' : 'MSL'
  return other === undefined ? `Needs the waypoint elevation for ${otherRef}` : `${Math.round(other).toLocaleString('en-US')} ft ${otherRef}`
}

function elevTitle(w: Waypoint) {
  return w.elevSource === 'dcs' ? 'From the DCS export'
    : w.elevSource === 'dem' ? 'Real-world terrain lookup (close to DCS, not exact). Type a value to replace it.'
    : w.elevSource === 'typed' ? 'Typed' : 'Looking up…'
}

/** Elevation may be zero or below sea level. */
function optElev(v: string): number | undefined {
  if (v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function optNum(v: string): number | undefined {
  if (v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function optionLabel(p: CatalogPoint) {
  return `${p.name} (${kindLabel(p.kind)}${p.detail && p.kind !== 'zone' && p.kind !== 'place' && p.kind !== 'label' ? ` · ${p.detail}` : ''})`
}
