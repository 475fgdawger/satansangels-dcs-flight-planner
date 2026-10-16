// A folder the user picks once for kneeboard pages, kept in IndexedDB so it survives reloads.
// Uses the File System Access API (Chrome, Edge); other browsers fall back to downloads.

/** The parts of a directory handle this module uses; declared here so it builds whatever DOM typings are present. */
export interface DirHandle {
  name: string
  queryPermission(o: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(o: { mode: 'readwrite' }): Promise<PermissionState>
  getFileHandle(name: string, o?: { create?: boolean }): Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>
  removeEntry(name: string): Promise<void>
  keys(): AsyncIterableIterator<string>
}

type Picker = (o?: { id?: string; mode?: 'readwrite'; startIn?: string | DirHandle }) => Promise<DirHandle>

const picker = (): Picker | undefined => (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker

export const canPickFolder = () => typeof window !== 'undefined' && !!picker()

const DB = 'flightplanner', STORE = 'handles', KEY = 'kneeboard-folder'

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => ok(req.result)
    req.onerror = () => fail(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db()
  try {
    return await new Promise<T>((ok, fail) => {
      const req = run(d.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => ok(req.result as T)
      req.onerror = () => fail(req.error)
    })
  } finally {
    d.close()
  }
}

/** The folder picked earlier in this browser, if any. */
export async function savedFolder(): Promise<DirHandle | null> {
  if (!canPickFolder()) return null
  try {
    return (await tx<DirHandle | undefined>('readonly', (s) => s.get(KEY))) ?? null
  } catch {
    return null
  }
}

/** Asks the user for a folder and remembers it. Null when they cancel. */
export async function pickFolder(current: DirHandle | null): Promise<DirHandle | null> {
  const show = picker()
  if (!show) return null
  try {
    const dir = await show({ id: 'kneeboard', mode: 'readwrite', startIn: current ?? 'documents' })
    try { await tx('readwrite', (s) => s.put(dir, KEY)) } catch { /* still usable this session */ }
    return dir
  } catch {
    return null // cancelled
  }
}

export async function forgetFolder() {
  try { await tx('readwrite', (s) => s.delete(KEY)) } catch { /* nothing stored */ }
}

/** Write access to the folder; must be called straight from a click, before any other await. */
export async function allowWrite(dir: DirHandle): Promise<boolean> {
  try {
    if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true
    return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

/**
 * Earlier pages of this kneeboard that the new export doesn't replace: `base_N.jpg` beyond the pages just written
 * (a shorter route), and any `base_N.png` from before the export was JPEG, so DCS shows no stale pages.
 */
export function stalePages(names: string[], base: string, written: number): string[] {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)\\.(png|jpg)$`)
  return names.filter((n) => { const m = re.exec(n); return !!m && (m[2] === 'png' || Number(m[1]) > written) })
}

/** Writes the pages into the folder as base_1.jpg, base_2.jpg..., replacing any with those names. */
export async function writePages(dir: DirHandle, base: string, dataUrls: string[]) {
  for (const [i, url] of dataUrls.entries()) {
    const blob = await (await fetch(url)).blob()
    const w = await (await dir.getFileHandle(`${base}_${i + 1}.jpg`, { create: true })).createWritable()
    await w.write(blob)
    await w.close()
  }
  const names: string[] = []
  for await (const n of dir.keys()) names.push(n)
  for (const n of stalePages(names, base, dataUrls.length)) await dir.removeEntry(n)
}
