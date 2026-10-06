import { useState } from 'preact/hooks'
import { exportLibrary, importLibrary, readLibrary, saveRoute, writeLibrary, type SavedRoute } from '../nav/library'
import type { SharedPlan } from '../nav/share'

/** Saved routes in this browser: save the current plan by name, open, rename, delete, export and import. */
export function LibraryPanel({ current, defaultName, onOpen }: {
  current: SharedPlan | null; defaultName: string
  onOpen: (plan: SharedPlan, name: string) => Promise<boolean>
}) {
  const [routes, setRoutes] = useState<SavedRoute[]>(() => readLibrary(localStorage))
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const store = (next: SavedRoute[], note: string) => {
    setRoutes(next)
    setMsg(writeLibrary(localStorage, next) ? note : 'Could not save: this browser blocked or filled its storage.')
  }

  function save() {
    if (!current || current.route.length === 0) return
    const n = (name.trim() || defaultName).trim()
    if (!n) return
    const exists = routes.some((r) => r.name.toLowerCase() === n.toLowerCase())
    if (exists && !confirm(`Replace the saved route "${n}"?`)) return
    store(saveRoute(routes, n, current), `Saved "${n}".`)
    setName('')
  }

  function rename(r: SavedRoute) {
    const n = prompt('Rename saved route', r.name)?.trim()
    if (!n || n === r.name) return
    if (routes.some((x) => x !== r && x.name.toLowerCase() === n.toLowerCase())) { setMsg(`"${n}" is already taken.`); return }
    store(routes.map((x) => (x === r ? { ...x, name: n } : x)), `Renamed to "${n}".`)
  }

  function remove(r: SavedRoute) {
    if (!confirm(`Delete the saved route "${r.name}"?`)) return
    store(routes.filter((x) => x !== r), `Deleted "${r.name}".`)
  }

  function exportFile() {
    const blob = new Blob([JSON.stringify(exportLibrary(routes), null, 1)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `flightplanner-routes-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
  }

  async function importFile(file: File | undefined) {
    if (!file) return
    let res: ReturnType<typeof importLibrary> = null
    try { res = importLibrary(routes, JSON.parse(await file.text())) } catch { /* not JSON */ }
    if (!res) { setMsg(`${file.name} is not a saved-routes export.`); return }
    store(res.routes, `Imported ${res.added} route${res.added === 1 ? '' : 's'} from ${file.name}.`)
  }

  return (
    <section class="panel no-print">
      <h2>Saved routes</h2>
      {current && current.route.length > 0 && (
        <form class="row" onSubmit={(e) => { e.preventDefault(); save() }}>
          <input class="grow" value={name} placeholder={defaultName || 'Name this route'}
            onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button type="submit">Save route</button>
        </form>
      )}
      {routes.length > 0 ? (
        <table class="library">
          <thead><tr><th>Name</th><th>Mission</th><th>Aircraft</th><th>Waypoints</th><th>Saved</th><th /></tr></thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b>{r.plan.settings.callsign && <span class="muted small"> · {r.plan.settings.callsign}</span>}</td>
                <td>{r.plan.mission.name} <span class="muted small">({r.plan.mission.theatre})</span></td>
                <td>{r.plan.settings.aircraft}</td>
                <td>{r.plan.route.length}</td>
                <td class="muted small">{r.savedAt.slice(0, 16).replace('T', ' ')}Z</td>
                <td class="library-actions">
                  <button type="button" onClick={async () => { if (await onOpen(r.plan, r.name)) setMsg(`Opened "${r.name}".`) }}>Open</button>
                  <button type="button" onClick={() => rename(r)}>Rename</button>
                  <button type="button" title="Delete" onClick={() => remove(r)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="muted small">No saved routes yet. Build a route, then save it here to reuse it later.</p>
      )}
      <div class="row">
        <button type="button" disabled={routes.length === 0} onClick={exportFile}>Export all</button>
        <label class="button">
          Import
          <input type="file" accept=".json,application/json" hidden
            onChange={(e) => { const i = e.target as HTMLInputElement; importFile(i.files?.[0]); i.value = '' }} />
        </label>
        <span class="muted small">{msg ?? 'Saved in this browser. Export to back up or move routes to another computer.'}</span>
      </div>
    </section>
  )
}
