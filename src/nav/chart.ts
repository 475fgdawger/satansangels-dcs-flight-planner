// The kneeboard map page: a black-and-white chart of the route drawn as SVG, so it prints and
// exports like the rest of the kneeboard (no map tiles to fetch). North-up on true north, scaled
// to fit the route, with whatever the mission has around it: threat rings, targets, airfields,
// TACANs and the mission editor drawings.

import { heading3 } from './format'
import { airfields } from './mission'
import { dcsColor, threatRing } from './map'
import type { Row } from './plan'
import type { LatLon, MissionExport } from './types'

export interface ChartOptions {
  width: number
  height: number
}

export interface Chart {
  svg: string
  /** Nautical miles per pixel. */
  nmPerPx: number
  /** Length of the scale bar, nm. */
  scaleNm: number
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const f = (n: number) => n.toFixed(1)
const DEG = Math.PI / 180
// Margin around the route, as a share of the page; the edges also carry the grid labels.
const PAD = 0.09
// A one-waypoint route still gets a useful area around it.
const MIN_SPAN_NM = 30

/** Projection centred on the route: equirectangular, scaled by cos(lat), which is fine at kneeboard scales. */
function projection(points: LatLon[], w: number, h: number) {
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity
  for (const p of points) {
    south = Math.min(south, p.lat); north = Math.max(north, p.lat)
    west = Math.min(west, p.lon); east = Math.max(east, p.lon)
  }
  const c = { lat: (south + north) / 2, lon: (west + east) / 2 }
  const k = Math.cos(c.lat * DEG)
  const spanX = Math.max((east - west) * 60 * k, MIN_SPAN_NM)
  const spanY = Math.max((north - south) * 60, MIN_SPAN_NM)
  const nmPerPx = Math.max(spanX / (w * (1 - 2 * PAD)), spanY / (h * (1 - 2 * PAD)))
  const xy = (p: LatLon) => ({ x: w / 2 + ((p.lon - c.lon) * 60 * k) / nmPerPx, y: h / 2 - ((p.lat - c.lat) * 60) / nmPerPx })
  const ll = (x: number, y: number): LatLon => ({ lat: c.lat - ((y - h / 2) * nmPerPx) / 60, lon: c.lon + ((x - w / 2) * nmPerPx) / 60 / k })
  return { xy, ll, nmPerPx }
}

/** A round scale bar length near a quarter of the page width. */
function niceNm(target: number): number {
  for (const n of [1, 2, 5, 10, 20, 25, 50, 100, 200]) if (n >= target * 0.7) return n
  return 500
}

/** Grid spacing in minutes that gives a handful of lines across the page. */
function gridStep(spanDeg: number): number {
  for (const m of [5, 10, 15, 20, 30, 60, 120]) if ((spanDeg * 60) / m <= 7) return m
  return 300
}

const latText = (deg: number) => `${deg < 0 ? 'S' : 'N'}${Math.floor(Math.abs(deg) + 1e-9)}°${pad2(Math.round((Math.abs(deg) % 1) * 60) % 60)}'`
const lonText = (deg: number) => `${deg < 0 ? 'W' : 'E'}${String(Math.floor(Math.abs(deg) + 1e-9)).padStart(3, '0')}°${pad2(Math.round((Math.abs(deg) % 1) * 60) % 60)}'`
const pad2 = (n: number) => String(n).padStart(2, '0')

/** Simple label placement: a label is dropped when it would overlap one already placed. */
class Labels {
  private boxes: { x0: number; y0: number; x1: number; y1: number }[] = []
  constructor(private w: number, private h: number) {}
  /** Reserve an area (a symbol) without a label. */
  block(x: number, y: number, r: number) {
    this.boxes.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r })
  }
  reserve(x0: number, y0: number, x1: number, y1: number) {
    this.boxes.push({ x0, y0, x1, y1 })
  }
  /** Try the label at each offset in turn; returns where it fits, or null. */
  place(x: number, y: number, text: string, size: number, offsets: [number, number, 'start' | 'middle' | 'end'][]) {
    const tw = text.length * size * 0.58, th = size
    for (const [dx, dy, anchor] of offsets) {
      const lx = x + dx, ly = y + dy
      const x0 = anchor === 'start' ? lx : anchor === 'end' ? lx - tw : lx - tw / 2
      const b = { x0: x0 - 2, y0: ly - th * 0.8 - 1, x1: x0 + tw + 2, y1: ly + th * 0.25 + 1 }
      if (b.x0 < 2 || b.y0 < 2 || b.x1 > this.w - 2 || b.y1 > this.h - 2) continue
      if (this.boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue
      this.boxes.push(b)
      return { x: lx, y: ly, anchor }
    }
    return null
  }
}

const AROUND = (d: number): [number, number, 'start' | 'middle' | 'end'][] =>
  [[d, 4, 'start'], [-d, 4, 'end'], [0, -d, 'middle'], [0, d + 9, 'middle'], [d, -d, 'start'], [-d, -d, 'end'], [d, d + 6, 'start'], [-d, d + 6, 'end']]

/** The route chart for the kneeboard, as SVG markup for a width x height viewBox. */
export function routeChart(m: MissionExport, rows: Row[], { width: w, height: h }: ChartOptions): Chart {
  const route = rows.map((r) => r.wp)
  const { xy, ll, nmPerPx } = projection(route, w, h)
  const inView = (p: { x: number; y: number }, margin = 0) => p.x >= -margin && p.x <= w + margin && p.y >= -margin && p.y <= h + margin
  const labels = new Labels(w, h)
  const back: string[] = [], mid: string[] = [], top: string[] = [], text: string[] = []

  // Lat/lon grid with edge labels.
  const nw = ll(0, 0), se = ll(w, h)
  const step = gridStep(Math.max(se.lon - nw.lon, nw.lat - se.lat)) / 60
  for (let lat = Math.ceil(se.lat / step) * step; lat <= nw.lat; lat += step) {
    const y = xy({ lat, lon: nw.lon }).y
    back.push(`<line class="ch-grid" x1="0" y1="${f(y)}" x2="${w}" y2="${f(y)}"/>`)
    text.push(`<text class="ch-gl" x="4" y="${f(y - 3)}">${latText(lat)}</text>`)
    labels.block(30, y - 7, 28)
  }
  for (let lon = Math.ceil(nw.lon / step) * step; lon <= se.lon; lon += step) {
    const x = xy({ lat: nw.lat, lon }).x
    if (x > w - 60) continue
    back.push(`<line class="ch-grid" x1="${f(x)}" y1="0" x2="${f(x)}" y2="${h}"/>`)
    text.push(`<text class="ch-gl" x="${f(x + 3)}" y="12">${lonText(lon)}</text>`)
    labels.block(x + 34, 8, 6)
  }

  // Keep labels out from under the north arrow and scale bar.
  const scaleNm = niceNm((w / 4) * nmPerPx)
  const bar = scaleNm / nmPerPx
  const bx = w - 16 - bar, by = h - 18
  labels.reserve(bx - 8, by - 62, w, h)

  // Route first, so its labels win every overlap.
  const pts = route.map(xy)
  if (pts.length > 1) top.push(`<polyline class="ch-route" points="${pts.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}"/>`)
  pts.forEach((p) => labels.block(p.x, p.y, 12))
  rows.forEach((r, i) => {
    if (!r.leg || i === 0) return
    const a = pts[i - 1], b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 60) return
    // Label beside the middle of the leg, on the side away from the page centre.
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    const s = (mx - w / 2) * nx + (my - h / 2) * ny >= 0 ? 1 : -1
    const t = `${heading3(r.leg.magCourse)}° ${Math.round(r.leg.nm)}`
    // Far enough out along the normal that the label's box clears the line, whatever the leg's angle.
    const d = (t.length * 14 * 0.58) / 2 * Math.abs(nx) + 7 * Math.abs(ny) + 5
    const at = labels.place(mx, my, t, 14, [[s * nx * d, s * ny * d + 5, 'middle'], [-s * nx * d, -s * ny * d + 5, 'middle']])
    if (at) text.push(`<text class="ch-leg" x="${f(at.x)}" y="${f(at.y)}" text-anchor="middle">${t}</text>`)
  })
  // A waypoint on top of an earlier one (the recovery base) shares its mark: "0/5".
  const marks: { at: number; nums: number[] }[] = []
  pts.forEach((p, i) => {
    const same = marks.find((mk) => Math.hypot(pts[mk.at].x - p.x, pts[mk.at].y - p.y) < 4)
    if (same) same.nums.push(i)
    else marks.push({ at: i, nums: [i] })
  })
  for (const { at, nums } of marks) {
    const p = pts[at]
    const tags = [...new Set(nums.flatMap((i) => route[i].tags ?? []))]
    const num = nums.join('/')
    const r = 11, half = Math.max(r, num.length * 3.6 + 5)
    top.push(tags.includes('TGT')
      ? `<rect class="ch-wp ch-fill" x="${f(p.x - half + 1)}" y="${f(p.y - 10)}" width="${f(2 * half - 2)}" height="20"/>`
      : `<rect class="ch-wp${tags.length ? ' ch-fill' : ''}" x="${f(p.x - half)}" y="${f(p.y - r)}" width="${f(2 * half)}" height="${2 * r}" rx="${r}"/>`)
    top.push(`<text class="ch-wpn${tags.length ? ' inv' : ''}" x="${f(p.x)}" y="${f(p.y + 4.5)}" text-anchor="middle">${num}</text>`)
    labels.reserve(p.x - half - 1, p.y - r - 1, p.x + half + 1, p.y + r + 1)
    // The name, plus any marks it doesn't already say (an "IP" waypoint isn't labelled "IP IP").
    const wp = route[at]
    const extra = tags.filter((t) => t !== wp.name.trim().toUpperCase())
    const name = `${wp.name}${extra.length ? ` ${extra.join('/')}` : ''}`
    const lab = labels.place(p.x, p.y, name, 13, AROUND(half + 4))
    if (lab) text.push(`<text class="ch-wpl" x="${f(lab.x)}" y="${f(lab.y)}" text-anchor="${lab.anchor}">${esc(name)}</text>`)
  }

  // Threat rings, then point symbols. Rings are clipped by the page; points off the page are skipped.
  const ringLabels: { lab: string; x: number; y: number }[] = []
  for (const t of m.targets) {
    const ring = threatRing(t)
    if (!ring) continue
    const c = xy(t), r = ring.nm / nmPerPx
    if (!inView(c, r)) continue
    back.push(`<circle class="ch-threat" cx="${f(c.x)}" cy="${f(c.y)}" r="${f(r)}"/>`)
    const lab = `${ring.system} ${ring.nm}`
    if (ringLabels.some((q) => q.lab === lab && Math.hypot(q.x - c.x, q.y - c.y) < 2 * r + 40)) continue
    ringLabels.push({ lab, x: c.x, y: c.y })
    const at = labels.place(c.x, c.y + r, lab, 11, [[0, -4, 'middle'], [0, 12, 'middle']])
    if (at) text.push(`<text class="ch-ring" x="${f(at.x)}" y="${f(at.y)}" text-anchor="middle">${lab}</text>`)
  }

  drawings(m, xy, nmPerPx, inView, back, text, labels)

  for (const a of airfields(m)) {
    const p = xy(a)
    if (!inView(p)) continue
    mid.push(`<circle class="ch-af" cx="${f(p.x)}" cy="${f(p.y)}" r="5"/>`)
    const dx = Math.sin(a.rwy_heading_true * DEG) * 8, dy = -Math.cos(a.rwy_heading_true * DEG) * 8
    mid.push(`<line class="ch-rwy" x1="${f(p.x - dx)}" y1="${f(p.y - dy)}" x2="${f(p.x + dx)}" y2="${f(p.y + dy)}"/>`)
    labels.block(p.x, p.y, 7)
    const at = labels.place(p.x, p.y, a.name, 11, AROUND(9))
    if (at) text.push(`<text class="ch-pl" x="${f(at.x)}" y="${f(at.y)}" text-anchor="${at.anchor}">${esc(a.name)}</text>`)
  }

  for (const t of m.tacans) {
    const p = xy(t)
    if (!inView(p)) continue
    const hex = Array.from({ length: 6 }, (_, i) => `${f(p.x + 7 * Math.cos((i * 60) * DEG))},${f(p.y + 7 * Math.sin((i * 60) * DEG))}`).join(' ')
    mid.push(`<polygon class="ch-tacan" points="${hex}"/><circle cx="${f(p.x)}" cy="${f(p.y)}" r="1.5"/>`)
    labels.block(p.x, p.y, 8)
    const lab = `${t.id} ${t.chan}`
    const at = labels.place(p.x, p.y, lab, 13, AROUND(10))
    if (at) text.push(`<text class="ch-tl" x="${f(at.x)}" y="${f(at.y)}" text-anchor="${at.anchor}">${esc(lab)}</text>`)
  }

  for (const t of m.targets) {
    const p = xy(t)
    if (!inView(p)) continue
    const s = 5
    mid.push(t.kind === 'SAM' || t.kind === 'AAA'
      ? `<polygon class="ch-tg" points="${f(p.x)},${f(p.y - s - 1)} ${f(p.x + s)},${f(p.y + s - 1)} ${f(p.x - s)},${f(p.y + s - 1)}"/>`
      : `<rect class="ch-tg${t.kind === 'range' ? ' open' : ''}" x="${f(p.x - s + 1)}" y="${f(p.y - s + 1)}" width="${2 * s - 2}" height="${2 * s - 2}"/>`)
    labels.block(p.x, p.y, 6)
    const at = labels.place(p.x, p.y, t.name, 10.5, AROUND(8))
    if (at) text.push(`<text class="ch-pl" x="${f(at.x)}" y="${f(at.y)}" text-anchor="${at.anchor}">${esc(t.name)}</text>`)
  }

  // North arrow and scale bar, bottom right.
  const furniture = [
    `<rect class="ch-box" x="${f(bx - 8)}" y="${f(by - 62)}" width="${f(bar + 18)}" height="74"/>`,
    `<path class="ch-north" d="M${f(w - 24)},${f(by - 54)} l7,20 l-7,-5 l-7,5 z"/>`,
    `<text class="ch-gl" x="${f(w - 24)}" y="${f(by - 24)}" text-anchor="middle">TRUE N</text>`,
    `<path class="ch-scale" d="M${f(bx)},${f(by - 6)} v6 h${f(bar)} v-6"/>`,
    `<line class="ch-scale" x1="${f(bx + bar / 2)}" y1="${f(by - 3)}" x2="${f(bx + bar / 2)}" y2="${f(by)}"/>`,
    `<text class="ch-gl" x="${f(bx)}" y="${f(by - 10)}">0</text>`,
    `<text class="ch-gl" x="${f(bx + bar)}" y="${f(by - 10)}" text-anchor="end">${scaleNm} nm</text>`,
  ]

  const svg = [
    `<defs><clipPath id="ch-clip"><rect width="${w}" height="${h}"/></clipPath></defs>`,
    `<g clip-path="url(#ch-clip)">`, ...back, ...mid, ...top, ...text, `</g>`, ...furniture,
    `<rect class="ch-frame" x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}"/>`,
  ].join('')
  return { svg, nmPerPx, scaleNm }
}

/** Mission editor drawings on the visible layers (Red skipped, as on the map), in grey so the route stands out. */
function drawings(m: MissionExport, xy: (p: LatLon) => { x: number; y: number }, nmPerPx: number,
  inView: (p: { x: number; y: number }, margin?: number) => boolean, back: string[], text: string[], labels: Labels) {
  for (const d of m.drawings ?? []) {
    if (!d.layer_visible || d.layer.toLowerCase() === 'red') continue
    const dash = (d.style ?? 'solid').toLowerCase() === 'solid' ? '' : ' dash'
    if (d.type === 'TextBox') {
      const first = (d.text ?? '').split(/\r?\n/)[0].trim()
      const p = xy(d)
      if (!first || !inView(p)) continue
      const at = labels.place(p.x, p.y + 4, first, 11, [[0, 0, 'middle']])
      if (at) text.push(`<text class="ch-dt" x="${f(at.x)}" y="${f(at.y)}" text-anchor="middle">${esc(first)}</text>`)
      continue
    }
    const filled = (dcsColor(d.fill)?.opacity ?? 0) > 0 ? ' filled' : ''
    if (d.type === 'Polygon' && d.mode === 'circle' && d.radius_m) {
      const c = xy(d), r = d.radius_m / 1852 / nmPerPx
      if (inView(c, r)) back.push(`<circle class="ch-draw${dash}${filled}" cx="${f(c.x)}" cy="${f(c.y)}" r="${f(r)}"/>`)
      continue
    }
    if (d.points.length < 2) continue
    const pts = d.points.map(([lat, lon]) => xy({ lat, lon }))
    if (!pts.some((p) => inView(p, 50))) continue
    const list = pts.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')
    back.push(d.type === 'Polygon' || d.closed
      ? `<polygon class="ch-draw${dash}${d.type === 'Polygon' ? filled : ''}" points="${list}"/>`
      : `<polyline class="ch-draw${dash}" points="${list}"/>`)
  }
}
