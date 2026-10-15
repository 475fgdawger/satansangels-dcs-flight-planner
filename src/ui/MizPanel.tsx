import { useState } from 'preact/hooks'
import type { MissionExport } from '../nav/types'
import type { Row } from '../nav/plan'
import { hasGrid } from '../nav/dcsgrid'
import { airdromeName, readMiz, routePoints, startOf, writeRoute, type Miz, type MizGroup } from '../nav/miz'

const MIZ_TYPES = [{ description: 'DCS mission', accept: { 'application/octet-stream': ['.miz'] } }]

/** A file picked with the browser's open dialog; passing it as startIn opens the save dialog in its folder. */
interface FileHandle { getFile(): Promise<File> }
type OpenPicker = (o: { id?: string; types: typeof MIZ_TYPES }) => Promise<FileHandle[]>
type SavePicker = (o: { id?: string; suggestedName: string; startIn?: FileHandle; types: typeof MIZ_TYPES }) =>
  Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>
const pickers = () => window as unknown as { showOpenFilePicker?: OpenPicker; showSaveFilePicker?: SavePicker }

/** Writes the planned route into chosen aircraft groups of a mission file and saves it as a new .miz. */
export function MizPanel({ mission, rows }: { mission: MissionExport; rows: Row[] }) {
  const [miz, setMiz] = useState<{ file: string; data: Miz; handle?: FileHandle } | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
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
      setChosen([])
      setShowAi(!data.groups.some((g) => g.human))
      if (data.theatre !== theatre) setMsg(`${file.name} is on the ${data.theatre} map; this plan is on ${theatre}.`)
    } catch (e) {
      setMiz(null)
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  async function save() {
    if (!miz || chosen.length === 0) return
    let bytes: Uint8Array
    try {
      bytes = writeRoute(miz.data, chosen, rows)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
      return
    }
    const name = miz.file.replace(/\.miz$/i, '') + '_planned.miz'
    const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' })
    const picker = pickers().showSaveFilePicker
    const done = `Wrote the route into ${chosen.length} group${chosen.length === 1 ? '' : 's'}`
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

  const groups = miz?.data.groups.filter((g) => showAi || g.human) ?? []
  const toggle = (k: string) => setChosen((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]))
  const wrongMap = !!miz && miz.data.theatre !== theatre
  // As written for the first ticked flight (a departure at its start isn't repeated).
  const sample = miz?.data.groups.find((g) => g.key === chosen[0]) ?? groups[0]
  const preview = miz && !wrongMap && rows.length > 1 && hasGrid(theatre) ? routePoints(theatre, rows, sample ? startOf(sample) : null) : []
  const lands = preview.at(-1)?.land

  return (
    <section class="panel no-print">
      <h2>Mission file</h2>
      <p class="muted small">
        Open a mission (.miz), tick the flights that should fly this plan, and save a copy. Each flight keeps its
        start (parking, runway or air start); its other waypoints are replaced by the planned route.
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
            <thead><tr><th /><th>Group</th><th>Side</th><th>Aircraft</th><th>Start</th><th>Waypoints now</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key} onClick={() => toggle(g.key)} style={{ cursor: 'pointer' }}>
                  <td><input type="checkbox" checked={chosen.includes(g.key)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(g.key)} /></td>
                  <td><b>{g.name}</b>{g.human && <span class="muted small"> · {g.units.length} client{g.units.length === 1 ? '' : 's'}</span>}</td>
                  <td>{g.coalition}</td>
                  <td>{aircraft(g)}</td>
                  <td class="small">{startText(miz.data.theatre, g)}</td>
                  <td>{g.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {groups.length === 0 && <p class="muted small">No flights with client or player slots in this mission.</p>}
          <div class="row">
            <label class="small"><input type="checkbox" checked={showAi} onChange={() => setShowAi(!showAi)} /> Show AI flights</label>
            <button type="button" disabled={chosen.length === 0 || rows.length < 2} onClick={save}>
              Write route to {chosen.length || ''} flight{chosen.length === 1 ? '' : 's'} and save
            </button>
          </div>
          <p class="muted small">
            {preview.length} waypoint{preview.length === 1 ? '' : 's'} after the start
            {lands ? `, ending with a landing at ${airdromeName(theatre, lands.airdromeId)}` : ', ending over the last waypoint (no DCS airfield there to land at)'}.
            Altitudes and speeds come from the plan. Open the saved mission in the editor to check it before flying.
          </p>
        </>
      )}
      {msg && <p class={wrongMap ? 'warn-text' : 'small'}>{msg}</p>}
    </section>
  )
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
