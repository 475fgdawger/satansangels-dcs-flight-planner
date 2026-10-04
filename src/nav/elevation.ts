// Ground elevation for points the DCS export doesn't cover (typed coordinates, TACAN fixes, map labels).
// Uses Open-Meteo's free elevation API (Copernicus 90 m terrain model). DCS terrain is built from
// real-world elevation data, so this is close but not exact; the export's own values win when present.

import { M_TO_FT } from './mission'
import type { LatLon } from './types'

const URL_BASE = 'https://api.open-meteo.com/v1/elevation'
/** The API takes up to 100 points per request. */
const BATCH = 100

/** Elevations in ft MSL, in the same order as the points. */
export async function lookupElevations(points: LatLon[], fetcher: typeof fetch = fetch): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH)
    const lat = batch.map((p) => p.lat.toFixed(5)).join(',')
    const lon = batch.map((p) => p.lon.toFixed(5)).join(',')
    const res = await fetcher(`${URL_BASE}?latitude=${lat}&longitude=${lon}`)
    if (!res.ok) throw new Error(`Elevation lookup failed (${res.status})`)
    const body = (await res.json()) as { elevation?: number[] }
    if (!Array.isArray(body.elevation) || body.elevation.length !== batch.length) throw new Error('Elevation lookup returned no data')
    out.push(...body.elevation.map((m) => Math.round(m * M_TO_FT)))
  }
  return out
}
