// DCS's own terrain for the strip maps: a height grid the bot samples with land.getHeight over the mission
// area and commits once per theatre (public/data/terrain/<theatre>.png + .json). The PNG is RGB, one pixel
// per sample, row 0 north, column 0 west; height in whole metres = R * 256 + G - 32768.

import { direct, inverse } from './geodesy'
import type { LatLon } from './types'

export interface TerrainMeta {
  schema: 1
  north: number
  west: number
  /** Grid spacing, degrees of latitude and longitude. */
  step: number
  rows: number
  cols: number
  theatre?: string
}

export interface TerrainGrid extends TerrainMeta {
  /** Metres MSL, row-major. */
  h: Int16Array
}

const FT = 3.28084

/** File name the bot uses for a theatre: 'Syria' -> 'syria'. */
export const terrainFile = (theatre: string) =>
  theatre.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'

/** The grid from the PNG's RGBA pixels (as a canvas reads them) and its JSON. */
export function decodeTerrain(meta: TerrainMeta, rgba: Uint8ClampedArray | Uint8Array): TerrainGrid {
  const n = meta.rows * meta.cols
  if (rgba.length < n * 4) throw new Error(`terrain image is ${rgba.length / 4} pixels, expected ${n}`)
  const h = new Int16Array(n)
  for (let i = 0; i < n; i++) h[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] - 32768
  return { ...meta, h }
}

/** Height in metres at a point (bilinear), or NaN outside the grid. */
export function heightAt(g: TerrainGrid, lat: number, lon: number): number {
  // Snap floating-point noise at the grid's edges (37 - 36.98 is not quite 0.02).
  const snap = (v: number, max: number) => (v < 0 && v > -1e-6 ? 0 : v > max && v < max + 1e-6 ? max : v)
  const r = snap((g.north - lat) / g.step, g.rows - 1), c = snap((lon - g.west) / g.step, g.cols - 1)
  if (!(r >= 0 && c >= 0 && r <= g.rows - 1 && c <= g.cols - 1)) return NaN
  const r0 = Math.min(Math.floor(r), g.rows - 2), c0 = Math.min(Math.floor(c), g.cols - 2)
  const fr = r - r0, fc = c - c0
  const i = r0 * g.cols + c0
  const top = g.h[i] + (g.h[i + 1] - g.h[i]) * fc
  const bot = g.h[i + g.cols] + (g.h[i + g.cols + 1] - g.h[i + g.cols]) * fc
  return top + (bot - top) * fr
}

/**
 * Highest terrain (ft MSL) within nm either side of the leg a -> b, and within nm of its ends; null when
 * the leg is off the grid. Sampled at about a third of the grid spacing.
 */
export function maxElevationNear(g: TerrainGrid, a: LatLon, b: LatLon, nm: number): number | null {
  const { az, nm: len } = inverse(a.lat, a.lon, b.lat, b.lon)
  const stepNm = (g.step * 60) / 3
  let best = -Infinity
  for (let d = -nm; d <= len + nm; d += stepNm) {
    const on = direct(a.lat, a.lon, az, d)
    for (let x = -nm; x <= nm; x += stepNm) {
      const p = x === 0 ? on : direct(on.lat, on.lon, az + 90, x)
      const h = heightAt(g, p.lat, p.lon)
      if (h > best) best = h
    }
  }
  return Number.isFinite(best) ? Math.round(best * FT) : null
}

/** Contour interval (ft) giving about ten contours over the relief on a page. */
export function contourInterval(minFt: number, maxFt: number): number {
  for (const ft of [100, 200, 250, 500, 1000, 2000]) if ((maxFt - minFt) / ft <= 12) return ft
  return 5000
}

export interface Shading {
  /** RGBA, width x height. */
  pixels: Uint8ClampedArray
  /** Contour interval, ft; index contours every fifth one are darker. */
  contourFt: number
}

/**
 * Grey hill shading with contours for a chart page. ll maps a page pixel to lat/lon; turn is how far true
 * north is rotated clockwise on the page (radians), so the light still comes from the north-west; nmPerPx
 * gives the slope. Sea (0 m and below) and anything off the grid stay white.
 */
export function shadeTerrain(g: TerrainGrid, ll: (x: number, y: number) => LatLon, width: number, height: number,
  nmPerPx: number, turn: number): Shading {
  const hs = new Float32Array(width * height)
  let lo = Infinity, hi = -Infinity
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = ll(x + 0.5, y + 0.5)
      const v = heightAt(g, p.lat, p.lon)
      hs[y * width + x] = v
      if (v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    }
  }
  // Bilinear heights show the grid's cells as facets once shaded; a box blur about half a cell wide
  // smooths them out (and the contours with them).
  const cellPx = (g.step * 60) / nmPerPx
  smooth(hs, width, height, Math.round(cellPx / 2))
  const contourFt = Number.isFinite(lo) ? contourInterval(lo * FT, hi * FT) : 1000
  const band = (v: number) => Math.floor((v * FT) / contourFt)

  // Light from true azimuth 315 at 45 degrees, turned onto the page; 2x vertical exaggeration.
  const az = (315 * Math.PI) / 180 + turn, alt = Math.PI / 4, ex = 2
  const lx = Math.cos(alt) * Math.sin(az), ly = -Math.cos(alt) * Math.cos(az), lz = Math.sin(alt)
  const metresPerPx = nmPerPx * 1852
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const v = hs[i]
      let grey = 255
      if (v > 0) {
        const at = (xx: number, yy: number) => {
          const w = hs[Math.min(height - 1, Math.max(0, yy)) * width + Math.min(width - 1, Math.max(0, xx))]
          return Number.isNaN(w) ? v : Math.max(0, w)
        }
        const dzdx = ((at(x + 1, y) - at(x - 1, y)) / (2 * metresPerPx)) * ex
        const dzdy = ((at(x, y + 1) - at(x, y - 1)) / (2 * metresPerPx)) * ex
        const shade = Math.max(0, (-dzdx * lx - dzdy * ly + lz) / Math.hypot(dzdx, dzdy, 1))
        // Flat ground a light grey, slopes away from the light darker, higher ground a touch darker.
        grey = (255 - (0.9 - shade) * 110) * (1 - 0.12 * Math.min(1, v / 3000))
        const b = band(v)
        const right = x + 1 < width ? hs[i + 1] : v, down = y + 1 < height ? hs[i + width] : v
        const edge = (w: number) => !Number.isNaN(w) && (w <= 0 || band(w) !== b)
        if (edge(right) || edge(down)) {
          const level = Math.max(b, band(Math.max(0, right)), band(Math.max(0, down)))
          grey = level % 5 === 0 ? 95 : 150
        }
      } else if (!Number.isNaN(v) && v <= 0) {
        // Coastline: sea next to land.
        const right = x + 1 < width ? hs[i + 1] : v, down = y + 1 < height ? hs[i + width] : v
        if (right > 0 || down > 0) grey = 95
      }
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = Math.round(Math.min(255, Math.max(0, grey)))
      out[i * 4 + 3] = 255
    }
  }
  return { pixels: out, contourFt }
}

/** Separable box blur in place, radius r px; NaN (off the grid) stays NaN and doesn't spread. */
function smooth(a: Float32Array, w: number, h: number, r: number) {
  if (r < 1) return
  const tmp = new Float32Array(a.length)
  const pass = (src: Float32Array, dst: Float32Array, n: number, lines: number, at: (line: number, i: number) => number) => {
    for (let line = 0; line < lines; line++) {
      for (let i = 0; i < n; i++) {
        const k = at(line, i)
        if (Number.isNaN(src[k])) { dst[k] = NaN; continue }
        let sum = 0, cnt = 0
        for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) {
          const v = src[at(line, j)]
          if (!Number.isNaN(v)) { sum += v; cnt++ }
        }
        dst[k] = sum / cnt
      }
    }
  }
  pass(a, tmp, w, h, (y, x) => y * w + x)
  pass(tmp, a, h, w, (x, y) => y * w + x)
}
