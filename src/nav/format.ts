// Text formats used on the nav log. They follow the bot's target list so the two
// read the same: DMS N36°17'53" E037°09'32", TACAN fix "DAN 112/93".

import { norm360 } from './geodesy'
import type { LatLon } from './types'

const pad = (n: number, width: number) => String(n).padStart(width, '0')

function hemi(v: number, isLat: boolean) {
  return isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W')
}

/** One coordinate as DMS: latitude 2-digit degrees, longitude 3-digit, seconds rounded with carry. */
export function dmsOne(v: number, isLat: boolean): string {
  const total = Math.round(Math.abs(v) * 3600)
  const d = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${hemi(v, isLat)}${pad(d, isLat ? 2 : 3)}°${pad(m, 2)}'${pad(s, 2)}"`
}

export const dms = (p: LatLon) => `${dmsOne(p.lat, true)} ${dmsOne(p.lon, false)}`

/** Decimal places of minutes in the degrees + decimal minutes format (F-4E INS entry). */
export const DDM_DECIMALS = 2

/** One coordinate as degrees + decimal minutes, e.g. N36°17.88'. */
export function ddmOne(v: number, isLat: boolean, decimals = DDM_DECIMALS): string {
  const scale = 10 ** decimals
  const total = Math.round(Math.abs(v) * 60 * scale)
  const d = Math.floor(total / (60 * scale))
  const mScaled = total % (60 * scale)
  const m = (mScaled / scale).toFixed(decimals).padStart(decimals + 3, '0')
  return `${hemi(v, isLat)}${pad(d, isLat ? 2 : 3)}°${m}'`
}

export const ddm = (p: LatLon) => `${ddmOne(p.lat, true)} ${ddmOne(p.lon, false)}`

/** Whole degrees, 3 digits, 000 written as 360. */
export function heading3(d: number): string {
  const r = norm360(Math.round(d))
  return pad(r === 0 ? 360 : r, 3)
}

const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export function compass16(d: number): string {
  return COMPASS16[Math.round(norm360(d) / 22.5) % 16]
}

/** Minutes as H:MM:SS or M:SS. */
export function duration(minutes: number): string {
  const secs = Math.round(minutes * 60)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`
}

/** Seconds after midnight as HH:MM. */
export function clock(secondsOfDay: number): string {
  const t = ((Math.round(secondsOfDay / 60) % 1440) + 1440) % 1440
  return `${pad(Math.floor(t / 60), 2)}:${pad(t % 60, 2)}`
}

/** Parse "HH:MM" or "HHMM" into seconds after midnight. */
export function parseClock(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2}):?(\d{2})$/)
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 3600 + min * 60
}

/**
 * Parse a typed coordinate. Accepts decimal degrees ("37.6, 33.5"),
 * DMS (N37°37'03" E033°30'39") and degrees + decimal minutes (N37 37.05 E033 30.65).
 */
export function parseLatLon(text: string): LatLon | null {
  const t = text.trim().toUpperCase()
  const dec = t.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/)
  if (dec) return checked(Number(dec[1]), Number(dec[2]))

  const parts = t.match(/([NS])([^NSEW]+)([EW])([^NSEW]+)/)
  if (!parts) return null
  const lat = parseAngle(parts[2])
  const lon = parseAngle(parts[4])
  if (lat === null || lon === null) return null
  return checked(parts[1] === 'S' ? -lat : lat, parts[3] === 'W' ? -lon : lon)
}

function parseAngle(s: string): number | null {
  const nums = s.match(/\d+(?:\.\d+)?/g)
  if (!nums || nums.length > 3) return null
  const [d, m = '0', sec = '0'] = nums
  const mm = Number(m), ss = Number(sec)
  if (mm >= 60 || ss >= 60) return null
  return Number(d) + mm / 60 + ss / 3600
}

function checked(lat: number, lon: number): LatLon | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}
