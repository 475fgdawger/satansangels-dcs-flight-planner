// Shape of the DCSServerBot targetlist export (schema 1).
// lat/lon are WGS84 decimal degrees; mag_var is degrees, east positive (magnetic = true - mag_var).

export interface Tacan {
  id: string
  chan: string
  lat: number
  lon: number
  mag_var: number
}

export interface Target {
  name: string
  kind: 'range' | 'bridge' | 'SAM' | 'EWR' | 'AAA'
  section: string
  group: string | null
  lat: number
  lon: number
  mag_var: number
  latlon: string
  tacan: string
  near: string
  line: string
  /** Ground elevation, ft MSL (optional; added by newer bot exports). */
  elev_ft?: number
}

export interface NamedPoint {
  name: string
  lat: number
  lon: number
  elev_ft?: number
}

export interface Label {
  text: string
  lat: number
  lon: number
  elev_ft?: number
}

export interface Airbase {
  name: string
  code: string
  type: string
  lat: number
  lon: number
  elev_m: number
  runways: string[]
  rwy_heading_true: number
  frequencies_hz: [number, number][]
  mag_var: number
}

/**
 * A mission editor drawing (draw layers: Red, Blue, Neutral, Common, Author). Added by newer bot
 * exports. points are the outline in lat/lon; a circle has radius_m instead. Colors are DCS
 * "0xRRGGBBAA" strings.
 */
export interface Drawing {
  layer: string
  layer_visible: boolean
  name?: string
  type: 'Line' | 'Polygon' | 'TextBox' | 'Icon' | string
  /** lineMode (segment, segments, free) or polygonMode (rect, circle, oval, arrow, free). */
  mode?: string
  closed: boolean
  color?: string
  fill?: string
  thickness?: number
  style?: string
  text?: string
  font_size?: number
  angle?: number
  file?: string
  radius_m?: number
  lat: number
  lon: number
  points: [number, number][]
}

export interface MissionExport {
  schema: number
  mission: { name: string; file: string; theatre: string; date: string; start_time: number }
  built_utc: string
  mag_var: { source: string; fallback: number }
  tacans: (Tacan & { elev_ft?: number })[]
  targets: Target[]
  places: NamedPoint[]
  zones: NamedPoint[]
  labels: Label[]
  /** Mission editor drawings; missing from older exports. */
  drawings?: Drawing[]
  airbases: Airbase[]
}

export interface LatLon {
  lat: number
  lon: number
}
