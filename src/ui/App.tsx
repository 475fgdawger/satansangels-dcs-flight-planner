import { useEffect, useMemo, useState } from 'preact/hooks'
import type { MissionExport } from '../nav/types'
import { catalog, kindLabel, parseMission, parseTacanFix, type CatalogPoint } from '../nav/mission'
import { clock, parseClock, parseLatLon } from '../nav/format'
import { AIRCRAFT, computeRows, defaultSettings, departureFuel, fuelPlan, phaseOf, type AircraftId, type FuelPlan, type PhaseId,
  type PlanSettings, type Waypoint } from '../nav/plan'
import { Kneeboard } from './Kneeboard'

const STORAGE_KEY = 'flightplanner.v2'

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
      setSettings((s) => s ?? defaultSettings('F-4E'))
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
  const fuel = useMemo(() => (settings ? fuelPlan(route, settings) : null), [route, settings])

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
          <SettingsPanel settings={settings} fuel={fuel} onChange={setSettings} />
          <RoutePanel mission={mission} route={route} settings={settings} fuel={fuel}
            onChange={setRoute} onSettings={setSettings} />
          <Kneeboard mission={mission} rows={rows} settings={settings} fuel={fuel} />
        </>
      )}
    </>
  )
}

function num(v: string, fallback: number) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function SettingsPanel({ settings: s, fuel, onChange }:
  { settings: PlanSettings; fuel: FuelPlan | null; onChange: (s: PlanSettings) => void }) {
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
      <div class="grid">
        <label class="field">
          <span>Aircraft</span>
          <select value={s.aircraft}
            onChange={(e) => onChange({ ...defaultSettings((e.target as HTMLSelectElement).value as AircraftId, s.takeoff),
              windDir: s.windDir, windKt: s.windKt, targetId: s.targetId })}>
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
        <label class="field">
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
        <label class="field">
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
          Joker and bingo are fuel states at the target ({fuel.rtbNm.toFixed(0)} nm from base).
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

function RoutePanel({ mission, route, settings, fuel, onChange, onSettings }:
  { mission: MissionExport; route: Waypoint[]; settings: PlanSettings; fuel: FuelPlan | null;
    onChange: (r: Waypoint[]) => void; onSettings: (s: PlanSettings) => void }) {
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
            <tr><th>#</th><th>Name</th><th>From</th><th>Phase in</th><th>Custom flow (lb/hr)</th><th>TAS in (kt)</th><th title="Target or CAP station for joker/bingo">Target</th><th /></tr>
          </thead>
          <tbody>
            {route.map((w, i) => (
              <tr key={w.id}>
                <td>{i}</td>
                <td><input value={w.name} onInput={(e) => update(i, { name: (e.target as HTMLInputElement).value })} /></td>
                <td class="muted">{w.source === 'manual' ? 'Typed' : kindLabel(w.source as CatalogPoint['kind'])}</td>
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
                <td>{i > 0 && <input type="number" value={w.ff ?? ''}
                  placeholder={String(phaseOf(settings.aircraft, w.phase ?? settings.phase).ff)}
                  onInput={(e) => update(i, { ff: optNum((e.target as HTMLInputElement).value) })} />}</td>
                <td>{i > 0 && <input type="number" placeholder={String(settings.tas)} value={w.tas ?? ''}
                  onInput={(e) => update(i, { tas: optNum((e.target as HTMLInputElement).value) })} />}</td>
                <td>{i < route.length - 1 && (
                  <input type="radio" name="target" checked={fuel?.target === i}
                    onChange={() => onSettings({ ...settings, targetId: w.id })} />
                )}</td>
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
