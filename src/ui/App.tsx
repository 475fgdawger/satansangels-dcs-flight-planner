import { useEffect, useMemo, useState } from 'preact/hooks'
import type { MissionExport } from '../nav/types'
import { catalog, kindLabel, parseMission, parseTacanFix, type CatalogPoint } from '../nav/mission'
import { clock, parseClock, parseLatLon } from '../nav/format'
import { AIRCRAFT, computeRows, defaultSettings, type AircraftId, type PlanSettings, type Waypoint } from '../nav/plan'
import { NavLog } from './NavLog'

const STORAGE_KEY = 'flightplanner.v1'

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

  function applyMission(json: unknown) {
    try {
      const m = parseMission(json)
      setMission(m)
      setRoute([])
      setSettings((s) => s ? { ...s, takeoff: m.mission.start_time } : defaultSettings('F-4E', m.mission.start_time))
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

  async function loadSample() {
    try {
      const res = await fetch('./data/targets_syria.json')
      applyMission(await res.json())
    } catch {
      setError('Could not load the Syria sample.')
    }
  }

  const rows = useMemo(() => (mission && settings ? computeRows(mission, route, settings) : []), [mission, route, settings])

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
          <button type="button" onClick={loadSample}>Load Syria sample</button>
          <span class="muted">or drop <code>targets_*.json</code> here</span>
        </div>
        {error && <p class="error">{error}</p>}
        {mission && (
          <p>
            <strong>{mission.mission.name}</strong> ({mission.mission.theatre}) · start {clock(mission.mission.start_time)} ·
            exported {mission.built_utc.replace('T', ' ')}
          </p>
        )}
      </section>

      {mission && settings && (
        <>
          <SettingsPanel settings={settings} onChange={setSettings} />
          <RoutePanel mission={mission} route={route} settings={settings} onChange={setRoute} />
          <NavLog mission={mission} rows={rows} settings={settings} />
        </>
      )}
    </>
  )
}

function num(v: string, fallback: number) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function SettingsPanel({ settings: s, onChange }: { settings: PlanSettings; onChange: (s: PlanSettings) => void }) {
  const set = (patch: Partial<PlanSettings>) => onChange({ ...s, ...patch })
  const field = (label: string, key: keyof PlanSettings, unit: string) => (
    <label class="field">
      <span>{label}</span>
      <input type="number" value={s[key] as number}
        onInput={(e) => set({ [key]: num((e.target as HTMLInputElement).value, s[key] as number) })} />
      <small>{unit}</small>
    </label>
  )
  return (
    <section class="panel no-print">
      <h2>Flight</h2>
      <div class="grid">
        <label class="field">
          <span>Aircraft</span>
          <select value={s.aircraft}
            onChange={(e) => onChange({ ...defaultSettings((e.target as HTMLSelectElement).value as AircraftId, s.takeoff),
              windDir: s.windDir, windKt: s.windKt })}>
            {Object.keys(AIRCRAFT).map((id) => <option value={id}>{id}</option>)}
          </select>
        </label>
        <label class="field">
          <span>Takeoff</span>
          <input type="text" value={clock(s.takeoff)}
            onChange={(e) => {
              const t = parseClock((e.target as HTMLInputElement).value)
              if (t !== null) set({ takeoff: t })
            }} />
          <small>mission time</small>
        </label>
        {field('Start fuel', 'startFuel', 'lb')}
        {field('Taxi/takeoff', 'taxiFuel', 'lb')}
        {field('TAS', 'tas', 'kt')}
        {field('Fuel flow', 'ff', 'lb/hr')}
        {field('Joker', 'joker', 'lb')}
        {field('Bingo', 'bingo', 'lb')}
        {field('Wind from', 'windDir', '° true')}
        {field('Wind speed', 'windKt', 'kt')}
      </div>
      <p class="muted small">Fuel numbers are placeholder estimates for {s.aircraft}, not flight-manual data. Edit them for your flight.</p>
    </section>
  )
}

function RoutePanel({ mission, route, settings, onChange }:
  { mission: MissionExport; route: Waypoint[]; settings: PlanSettings; onChange: (r: Waypoint[]) => void }) {
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
      wp = { id: newId(), name: picked.name, source: picked.kind, lat: picked.lat, lon: picked.lon }
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
        <table class="route">
          <thead>
            <tr><th>#</th><th>Name</th><th>From</th><th>TAS in (kt)</th><th>Fuel flow in (lb/hr)</th><th /></tr>
          </thead>
          <tbody>
            {route.map((w, i) => (
              <tr key={w.id}>
                <td>{i}</td>
                <td><input value={w.name} onInput={(e) => update(i, { name: (e.target as HTMLInputElement).value })} /></td>
                <td class="muted">{w.source === 'manual' ? 'Typed' : kindLabel(w.source as CatalogPoint['kind'])}</td>
                <td>{i > 0 && <input type="number" placeholder={String(settings.tas)} value={w.tas ?? ''}
                  onInput={(e) => update(i, { tas: optNum((e.target as HTMLInputElement).value) })} />}</td>
                <td>{i > 0 && <input type="number" placeholder={String(settings.ff)} value={w.ff ?? ''}
                  onInput={(e) => update(i, { ff: optNum((e.target as HTMLInputElement).value) })} />}</td>
                <td class="actions">
                  <button type="button" title="Move up" onClick={() => move(i, -1)}>↑</button>
                  <button type="button" title="Move down" onClick={() => move(i, 1)}>↓</button>
                  <button type="button" title="Remove" onClick={() => onChange(route.filter((_, j) => j !== i))}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {route.length > 0 && (
        <div class="row">
          <button type="button" onClick={() => onChange([])}>Clear route</button>
          <button type="button" onClick={() => window.print()}>Print nav log</button>
        </div>
      )}
    </section>
  )
}

function optNum(v: string): number | undefined {
  if (v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function optionLabel(p: CatalogPoint) {
  return `${p.name} (${kindLabel(p.kind)}${p.detail && p.kind !== 'zone' && p.kind !== 'place' && p.kind !== 'label' ? ` · ${p.detail}` : ''})`
}
