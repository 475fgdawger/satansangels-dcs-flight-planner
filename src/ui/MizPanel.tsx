import { useState } from 'preact/hooks'
import type { MissionExport } from '../nav/types'
import { computeRows, planTitle, type PlanSettings, type Row } from '../nav/plan'
import { hasGrid } from '../nav/dcsgrid'
import { readLibrary } from '../nav/library'
import { airdromeName, readMiz, routePoints, startOf, writeRoutes, type Miz, type MizGroup } from '../nav/miz'

const MIZ_TYPES = [{ description: 'DCS mission', accept: { 'application/octet-stream': ['.miz'] } }]

/** A file picked with the browser's open dialog; passing it as startIn opens the save dialog in its folder. */
interface FileHandle { getFile(): Promise<File> }
type OpenPicker = (o: { id?: string; types: typeof MIZ_TYPES }) => Promise<FileHandle[]>
type SavePicker = (o: { id?: string; suggestedName: string; startIn?: FileHandle; types: typeof MIZ_TYPES }) =>
  Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>
const pickers = () => window as unknown as { showOpenFilePicker?: OpenPicker; showSaveFilePicker?: SavePicker }

const CURRENT = 'current'

interface PlanChoice { id: string; label: string; rows: Row[] }

/**
 * Writes flight plans into aircraft groups of a mission file and saves it as a new .miz: each flight gets the plan
 * open in the planner or one of the saved routes on the same map, all in one save.
 */
export function MizPanel({ mission, rows, settings }: { mission: MissionExport; rows: Row[]; settings: PlanSettings }) {
  const [miz, setMiz] = useState<{ file: string; data: Miz; handle?: FileHandle } | null>(null)
  /** Group key -> plan id (CURRENT or a saved route's id). */
  const [assigned, setAssigned] = useState<Record<string, string>>({})
  const [showAi, setShowAi] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const theatre = mission.mission.theatre

  /** Open dialog that remembers the file, so the save dialog can start in the same folder. */
  async function pick() {
    try {
      const [handle] = await pickers().showOpenFilePicker!({ id: 'miz', types: MIZ_TYPES })
      await open(await handle.getFile(), handle)
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setMsg(`Could not open: ${(e as Error)?.message ?? e}`)
    }
  }

  async function open(file: File | undefined, handle?: FileHandle) {
    if (!file) return
    setMsg(null)
    try {
      const data = readMiz(new Uint8Array(await file.arrayBuffer()))
      setMiz({ file: file.name, data, handle })
      setAssigned({})
      setShowAi(!data.groups.some((g) => g.human))
      if (data.theatre !== theatre) setMsg(`${file.name} is on the ${data.theatre} map; this plan is on ${theatre}.`)
    } catch (e) {
      setMiz(null)
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  async function save() {
    const keys = Object.keys(assigned)
    if (!miz || keys.length === 0) return
    let bytes: Uint8Array
    try {
      const plans: Record<string, Row[]> = {}
      for (const k of keys) {
        const p = choices.find((c) => c.id === assigned[k])
        if (p) plans[k] = p.rows
      }
      bytes = writeRoutes(miz.data, plans)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
      return
    }
    const name = miz.file.replace(/\.miz$/i, '') + '_planned.miz'
    const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' })
    const picker = pickers().showSaveFilePicker
    const done = `Wrote flight plans into ${keys.length} flight${keys.length === 1 ? '' : 's'}`
    if (picker) {
      try {
        // Starts in the folder the mission was opened from.
        const handle = await picker({ id: 'miz', suggestedName: name, startIn: miz.handle, types: MIZ_TYPES })
        const w = await handle.createWritable()
        await w.write(blob)
        await w.close()
        setMsg(`${done}. Saved.`)
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') setMsg(`Could not save: ${(e as Error)?.message ?? e}`)
      }
      return
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
    setMsg(`${done} and saved ${name} to Downloads.`)
  }

  const groups = miz?.data.groups.filter((g) => showAi || g.human || assigned[g.key]) ?? []
  const wrongMap = !!miz && miz.data.theatre !== theatre
  // The plan open now, then every saved route on this map (read fresh, so routes saved since show up).
  const choices: PlanChoice[] = []
  if (miz && !wrongMap) {
    if (rows.length > 1) choices.push({ id: CURRENT, label: `This plan: ${planTitle(mission.mission.name, settings)} (${settings.aircraft})`, rows })
    for (const r of readLibrary(localStorage)) {
      if (r.plan.mission.theatre !== theatre || r.plan.route.length < 2) continue
      try {
        const other = r.plan.mission.name === mission.mission.name ? '' : `, ${r.plan.mission.name}`
        choices.push({ id: r.id, label: `${r.name} (${r.plan.settings.aircraft}${other})`, rows: computeRows(mission, r.plan.route, r.plan.settings) })
      } catch { /* a saved plan this version can't read */ }
    }
  }
  const assign = (k: string, id: string) => setAssigned((a) => {
    const next = { ...a }
    if (id) next[k] = id
    else delete next[k]
    return next
  })
  const count = Object.keys(assigned).length

  return (
    <section class="panel no-print">
      <h2>Mission file</h2>
      <p class="muted small">
        Open a mission (.miz), choose a flight plan for each flight, and save a copy. Each flight keeps its start
        (parking, runway or air start); its other waypoints are replaced by its plan.
      </p>
      {!hasGrid(theatre) && <p class="warn-text">The planner can't convert positions for the {theatre} map yet.</p>}
      <div class="row">
        {pickers().showOpenFilePicker ? (
          <button type="button" onClick={pick}>Open .miz</button>
        ) : (
          <label class="button">
            Open .miz
            <input type="file" accept=".miz" hidden onChange={(e) => { const i = e.target as HTMLInputElement; open(i.files?.[0]); i.value = '' }} />
          </label>
        )}
        {miz && <span class="small"><b>{miz.file}</b> <span class="muted">({miz.data.theatre}, {miz.data.groups.length} aircraft groups)</span></span>}
      </div>
      {miz && !wrongMap && (
        <>
          <table class="library">
            <thead><tr><th>Flight</th><th>Side</th><th>Aircraft</th><th>Start</th><th>Flight plan</th><th>Writes</th></tr></thead>
            <tbody>
              {groups.map((g) => {
                const plan = choices.find((c) => c.id === assigned[g.key])
                return (
                  <tr key={g.key}>
                    <td><b>{g.name}</b>{g.human && <span class="muted small"> · {g.units.length} client{g.units.length === 1 ? '' : 's'}</span>}</td>
                    <td>{g.coalition}</td>
                    <td>{aircraft(g)}</td>
                    <td class="small">{startText(miz.data.theatre, g)}</td>
                    <td>
                      <select value={assigned[g.key] ?? ''} onChange={(e) => assign(g.key, (e.target as HTMLSelectElement).value)}>
                        <option value="">Leave as is ({g.points} waypoint{g.points === 1 ? '' : 's'})</option>
                        {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </td>
                    <td class="small">{plan ? summary(theatre, plan.rows, g) : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {groups.length === 0 && <p class="muted small">No flights with client or player slots in this mission.</p>}
          {choices.length === 0 && <p class="muted small">Build a route or save one under Saved routes to have a plan to assign.</p>}
          <div class="row">
            <label class="small"><input type="checkbox" checked={showAi} onChange={() => setShowAi(!showAi)} /> Show AI flights</label>
            <button type="button" disabled={count === 0} onClick={save}>
              Write {count || ''} flight plan{count === 1 ? '' : 's'} and save
            </button>
          </div>
          <p class="muted small">
            Pick a plan for each flight, then save once. Plans come from this page and from Saved routes on the
            {' '}{theatre} map. Altitudes and speeds come from each plan. Open the saved mission in the editor to check it before flying.
          </p>
        </>
      )}
      {msg && <p class={wrongMap ? 'warn-text' : 'small'}>{msg}</p>}
    </section>
  )
}

/** What a plan writes into this flight: waypoints after its start, and where it ends. */
function summary(theatre: string, rows: Row[], g: MizGroup): string {
  try {
    const pts = routePoints(theatre, rows, startOf(g))
    const land = pts.at(-1)?.land
    return `${pts.length} waypoint${pts.length === 1 ? '' : 's'}, ${land ? `lands ${airdromeName(theatre, land.airdromeId)}` : 'no landing'}`
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

function aircraft(g: MizGroup): string {
  const n = new Map<string, number>()
  for (const u of g.units) n.set(u.type, (n.get(u.type) ?? 0) + 1)
  return [...n].map(([t, k]) => (k > 1 ? `${k}× ${t}` : t)).join(', ')
}


function startText(theatre: string, g: MizGroup): string {
  const where = g.airdromeId !== undefined ? ` at ${airdromeName(theatre, g.airdromeId)}` : ''
  switch (g.start) {
    case 'TakeOffParking': return `Parking, cold${where}`
    case 'TakeOffParkingHot': return `Parking, hot${where}`
    case 'TakeOff': return `Runway${where}`
    case 'TakeOffGround': case 'TakeOffGroundHot': return 'Ground (FARP or ship)'
    case 'Turning Point': return startOf(g) ? 'In the air' : 'Air'
    default: return g.start || '?'
  }
}
