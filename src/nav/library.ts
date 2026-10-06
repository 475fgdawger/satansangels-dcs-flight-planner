// Saved routes: named plans kept in this browser for reuse, with export/import as a JSON file so they
// can be backed up or moved to another machine. Each entry names its mission the same way a share link does.

import type { SharedPlan } from './share'

export const LIBRARY_KEY = 'flightplanner.routes.v1'

export interface SavedRoute {
  id: string
  name: string
  /** ISO time of the last save. */
  savedAt: string
  plan: SharedPlan
}

export interface LibraryFile {
  kind: 'flightplanner-routes'
  v: 1
  routes: SavedRoute[]
}

export function readLibrary(storage: Pick<Storage, 'getItem'>): SavedRoute[] {
  try {
    const list = JSON.parse(storage.getItem(LIBRARY_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter(isSavedRoute) : []
  } catch {
    return []
  }
}

export function writeLibrary(storage: Pick<Storage, 'setItem'>, routes: SavedRoute[]): boolean {
  try {
    storage.setItem(LIBRARY_KEY, JSON.stringify(routes))
    return true
  } catch {
    return false
  }
}

/** Saves a plan under a name; an existing entry with the same name (any case) is replaced. Newest first. */
export function saveRoute(routes: SavedRoute[], name: string, plan: SharedPlan, now = new Date()): SavedRoute[] {
  const clean = name.trim()
  const old = routes.find((r) => r.name.toLowerCase() === clean.toLowerCase())
  const entry: SavedRoute = { id: old?.id ?? `r${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: clean, savedAt: now.toISOString(), plan }
  return [entry, ...routes.filter((r) => r !== old)]
}

export function exportLibrary(routes: SavedRoute[]): LibraryFile {
  return { kind: 'flightplanner-routes', v: 1, routes }
}

/**
 * Merges an exported file into the library. Entries with a name already in the library replace it when the
 * file's copy is newer. Returns null when the file isn't a routes export.
 */
export function importLibrary(routes: SavedRoute[], file: unknown): { routes: SavedRoute[]; added: number } | null {
  const f = file as LibraryFile
  if (f?.kind !== 'flightplanner-routes' || !Array.isArray(f.routes)) return null
  let out = [...routes]
  let added = 0
  for (const r of f.routes.filter(isSavedRoute)) {
    const i = out.findIndex((x) => x.name.toLowerCase() === r.name.toLowerCase())
    if (i < 0) { out.push(r); added++ } else if (r.savedAt > out[i].savedAt) { out[i] = { ...r, id: out[i].id }; added++ }
  }
  out = out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
  return { routes: out, added }
}

function isSavedRoute(r: unknown): r is SavedRoute {
  const x = r as SavedRoute
  return typeof x?.id === 'string' && typeof x.name === 'string' && typeof x.savedAt === 'string'
    && x.plan?.v === 1 && !!x.plan.mission?.name && Array.isArray(x.plan.route) && !!x.plan.settings?.aircraft
}
