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
}

export interface NamedPoint {
  name: string
  lat: number
  lon: number
}

export interface Label {
  text: string
  lat: number
  lon: number
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

export interface MissionExport {
  schema: number
  mission: { name: string; file: string; theatre: string; date: string; start_time: number }
  built_utc: string
  mag_var: { source: string; fallback: number }
  tacans: Tacan[]
  targets: Target[]
  places: NamedPoint[]
  zones: NamedPoint[]
  labels: Label[]
  airbases: Airbase[]
}

export interface LatLon {
  lat: number
  lon: number
}
