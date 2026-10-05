// Map helpers that don't need Leaflet: threat ring sizes, the area to show for a
// mission, and where to label each leg. Everything comes from the export, so a
// new theatre needs no map-specific code.

import { direct, inverse } from './geodesy'
import type { LatLon, MissionExport, Target } from './types'
import { airfields } from './mission'

export interface ThreatRing {
  /** Radius, nm. */
  nm: number
  /** Short system name for the legend and popups. */
  system: string
}

// Approximate maximum engagement ranges, for situational awareness only.
// SA-2 and SA-3 match DCS's own launcher ranges (45 km / 25 km); the Fire Can
// ring is the 100 mm KS-19 guns it directs in DCS.
const RINGS: { match: RegExp; ring: ThreatRing }[] = [
  { match: /SA-?2\b|S-75/i, ring: { nm: 24, system: 'SA-2' } },
  { match: /SA-?3\b|S-125/i, ring: { nm: 13, system: 'SA-3' } },
  { match: /SA-?6\b|Kub/i, ring: { nm: 13, system: 'SA-6' } },
  { match: /Fire ?Can|KS-?19/i, ring: { nm: 4, system: 'Fire Can' } },
]

/** Threat ring for a target, or null when it doesn't shoot (ranges, bridges, EWRs). */
export function threatRing(t: Target): ThreatRing | null {
  if (t.kind !== 'SAM' && t.kind !== 'AAA') return null
  const text = `${t.name} ${t.group ?? ''}`
  for (const r of RINGS) if (r.match.test(text)) return r.ring
  return t.kind === 'SAM' ? { nm: 24, system: 'SAM' } : { nm: 2, system: 'AAA' }
}

export interface Bounds {
  south: number
  west: number
  north: number
  east: number
}

export function boundsOf(points: LatLon[], padNm = 0): Bounds | null {
  if (points.length === 0) return null
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity
  for (const p of points) {
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
    west = Math.min(west, p.lon)
    east = Math.max(east, p.lon)
  }
  if (padNm > 0) {
    const sw = direct(south, west, 225, padNm * Math.SQRT2)
    const ne = direct(north, east, 45, padNm * Math.SQRT2)
    return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon }
  }
  return { south, west, north, east }
}

/**
 * The area worth showing for a mission before a route exists: its TACANs and
 * targets. Airfields cover the whole DCS map, so they only count when there's
 * nothing else.
 */
export function missionBounds(m: MissionExport): Bounds | null {
  const core: LatLon[] = [...m.tacans, ...m.targets]
  return boundsOf(core.length > 0 ? core : airfields(m), 20)
}

/** Midpoint of a leg on the ellipsoid, for its course/distance label. */
export function legMidpoint(a: LatLon, b: LatLon): LatLon {
  const { az, nm } = inverse(a.lat, a.lon, b.lat, b.lon)
  return direct(a.lat, a.lon, az, nm / 2)
}
