// Kneeboard strip map: one page per leg, course up. The leg runs straight up the page from the
// waypoint it starts at (bottom) to the one it ends at (top), with distance-to-go ticks, time and a
// TACAN radial/DME checkpoint at each tick, and whatever the mission has either side of it: threat
// rings, targets, airfields, TACANs and the mission editor drawings. Drawn as SVG (no map tiles), so
// it prints and exports like the rest of the kneeboard.

import { heading3 } from './format'
import { direct, inverse } from './geodesy'
import { airfields, fixStations, tacanFixFrom } from './mission'
import { dcsColor, threatRing } from './map'
import type { Row } from './plan'
import type { LatLon, MissionExport } from './types'

export interface ChartOptions {
  width: number
  height: number
}

export interface Strip {
  svg: string
  /** Nautical miles per pixel. */
  nmPerPx: number
  /** Distance between ticks, nm. */
  tickNm: number
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const f = (n: number) => n.toFixed(1)
const DEG = Math.PI / 180
// Room above and below the leg for the waypoint marks and their labels.
const END_PAD = 70
// A short leg still shows this much either side of it.
const MIN_WIDTH_NM = 24

interface Projection {
  xy: (p: LatLon) => { x: number; y: number }
  nmPerPx: number
  /** Clockwise screen rotation of true north from straight up, radians. */
  turn: number
}

/**
 * Course-up projection for the leg a -> b: a local flat plane (equirectangular, scaled by cos(lat)
 * at the leg's middle, fine at kneeboard scales), turned so that a -> b points straight up.
 */
function courseUp(a: LatLon, b: LatLon, w: number, h: number): Projection {
  const c = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
  const k = Math.cos(c.lat * DEG)
  const local = (p: LatLon) => ({ e: (p.lon - c.lon) * 60 * k, n: (p.lat - c.lat) * 60 })
  const la = local(a), lb = local(b)
  const len = Math.max(Math.hypot(lb.e - la.e, lb.n - la.n), 0.1)
  const sin = (lb.e - la.e) / len, cos = (lb.n - la.n) / len
  const nmPerPx = Math.max(len / (h - 2 * END_PAD), MIN_WIDTH_NM / w)
  const xy = (p: LatLon) => {
    const { e, n } = local(p)
    return { x: w / 2 + (e * cos - n * sin) / nmPerPx, y: h / 2 - (e * sin + n * cos) / nmPerPx }
  }
  // Course up turns the chart left by the course, so north points at minus the course.
  return { xy, nmPerPx, turn: -Math.atan2(sin, cos) }
}

/** A round tick spacing giving about six ticks along the leg. */
function tickStep(nm: number): number {
  for (const s of [1, 2, 5, 10, 15, 20, 25, 50]) if (nm / s <= 7) return s
  return 100
}

const mmss = (min: number) => {
  const s = Math.round(min * 60)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

type Anchor = 'start' | 'middle' | 'end'

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
  /** The first of the boxes that is on the page and clear of everything placed, reserved; or null. */
  placeBox(candidates: { x0: number; y0: number; x1: number; y1: number }[]) {
    for (const b of candidates) {
      if (b.x0 < 2 || b.y0 < 2 || b.x1 > this.w - 2 || b.y1 > this.h - 2) continue
      if (this.boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue
      this.boxes.push(b)
      return b
    }
    return null
  }
  /** Try the label at each offset in turn; returns where it fits, or null. */
  place(x: number, y: number, text: string, size: number, offsets: [number, number, Anchor][]) {
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

const AROUND = (d: number): [number, number, Anchor][] =>
  [[d, 4, 'start'], [-d, 4, 'end'], [0, -d, 'middle'], [0, d + 9, 'middle'], [d, -d, 'start'], [-d, -d, 'end'], [d, d + 6, 'start'], [-d, d + 6, 'end']]

/** The strip map for the leg ending at rows[to], as SVG markup for a width x height viewBox. */
export function legStrip(m: MissionExport, rows: Row[], to: number, { width: w, height: h }: ChartOptions): Strip {
  const leg = rows[to]?.leg
  if (!leg || to < 1) throw new Error(`no leg into waypoint ${to}`)
  const route = rows.map((r) => r.wp)
  const A = route[to - 1], B = route[to]
  const { xy, nmPerPx, turn } = courseUp(A, B, w, h)
  const inView = (p: { x: number; y: number }, margin = 0) => p.x >= -margin && p.x <= w + margin && p.y >= -margin && p.y <= h + margin
  const labels = new Labels(w, h)
  const back: string[] = [], mid: string[] = [], top: string[] = [], text: string[] = []
  const pa = xy(A), pb = xy(B)

  // Corner furniture first so nothing is labelled underneath it: true north arrow (top left)
  // and the scale (bottom left).
  const scaleNm = [100, 50, 25, 20, 10, 5, 2, 1].find((n) => n <= (w / 5) * nmPerPx) ?? 1
  const bar = scaleNm / nmPerPx
  labels.reserve(0, 0, 70, 78)
  labels.reserve(0, h - 40, bar + 30, h)
  const nx = 35, ny = 34
  const furniture = [
    `<rect class="ch-box" x="4" y="4" width="62" height="70"/>`,
    `<g transform="rotate(${f(turn / DEG)} ${nx} ${ny})">`
      + `<path class="ch-north" d="M${nx},${ny - 22} l7,20 l-7,-5 l-7,5 z"/><line class="ch-scale" x1="${nx}" y1="${ny - 2}" x2="${nx}" y2="${ny + 16}"/></g>`,
    `<text class="ch-gl" x="${nx}" y="69" text-anchor="middle">TRUE N</text>`,
    `<path class="ch-scale" d="M16,${h - 22} v6 h${f(bar)} v-6"/>`,
    `<text class="ch-gl" x="16" y="${h - 26}">0</text>`,
    `<text class="ch-gl" x="${f(16 + bar)}" y="${h - 26}" text-anchor="end">${scaleNm} nm</text>`,
  ]

  // This leg, heavy, and the rest of the route, light, so the turn at each end shows.
  for (let i = 1; i < route.length; i++) {
    if (i === to) continue
    const p = xy(route[i - 1]), q = xy(route[i])
    top.push(`<line class="ch-other" x1="${f(p.x)}" y1="${f(p.y)}" x2="${f(q.x)}" y2="${f(q.y)}"/>`)
  }
  top.push(`<line class="ch-route" x1="${f(pa.x)}" y1="${f(pa.y)}" x2="${f(pb.x)}" y2="${f(pb.y)}"/>`)
  labels.reserve(pa.x - 5, pb.y, pa.x + 5, pa.y)

  // Waypoint marks. A waypoint on top of another (the recovery base) shares its mark: "0/5".
  const pts = route.map(xy)
  const marks: { at: number; nums: number[] }[] = []
  pts.forEach((p, i) => {
    const same = marks.find((mk) => Math.hypot(pts[mk.at].x - p.x, pts[mk.at].y - p.y) < 4)
    if (same) same.nums.push(i)
    else marks.push({ at: i, nums: [i] })
  })
  const ownLeg = (nums: number[]) => nums.includes(to) || nums.includes(to - 1)
  // The leg's own ends first, so their labels win.
  marks.sort((a, b) => Number(ownLeg(b.nums)) - Number(ownLeg(a.nums)))
  for (const { at, nums } of marks) {
    const p = pts[at]
    if (!inView(p, 12)) continue
    const tags = [...new Set(nums.flatMap((i) => route[i].tags ?? []))]
    const num = nums.join('/')
    const r = 11, half = Math.max(r, num.length * 3.6 + 5)
    const own = ownLeg(nums)
    top.push(tags.includes('TGT')
      ? `<rect class="ch-wp ch-fill" x="${f(p.x - half + 1)}" y="${f(p.y - 10)}" width="${f(2 * half - 2)}" height="20"/>`
      : `<rect class="ch-wp${tags.length ? ' ch-fill' : ''}" x="${f(p.x - half)}" y="${f(p.y - r)}" width="${f(2 * half)}" height="${2 * r}" rx="${r}"/>`)
    top.push(`<text class="ch-wpn${tags.length ? ' inv' : ''}" x="${f(p.x)}" y="${f(p.y + 4.5)}" text-anchor="middle">${num}</text>`)
    labels.reserve(p.x - half - 1, p.y - r - 1, p.x + half + 1, p.y + r + 1)
    // The name, plus any marks it doesn't already say (an "IP" waypoint isn't labelled "IP IP").
    const wp = route[at]
    const extra = tags.filter((t) => t !== wp.name.trim().toUpperCase())
    const name = `${wp.name}${extra.length ? ` ${extra.join('/')}` : ''}`
    const lab = labels.place(p.x, p.y, name, own ? 15 : 12, AROUND(half + 5))
    if (lab) text.push(`<text class="${own ? 'ch-wpl' : 'ch-pl'}" x="${f(lab.x)}" y="${f(lab.y)}" text-anchor="${lab.anchor}">${esc(name)}</text>`)
  }

  // Magnetic heading and leg distance boxed beside the start of the leg, where the turn onto it is flown.
  const mh = `MH ${heading3(leg.magHeading)}°`, dist = `${leg.nm.toFixed(1)} nm`
  const bw = Math.max(mh.length * 19 * 0.6, dist.length * 15 * 0.58) + 14, bh = 46
  const box = labels.placeBox([pa.y - 22, pa.y - 70, pa.y + 18].flatMap((bottom) => [
    { x0: pa.x + 16, y0: bottom - bh, x1: pa.x + 16 + bw, y1: bottom },
    { x0: pa.x - 16 - bw, y0: bottom - bh, x1: pa.x - 16, y1: bottom },
  ]))
  if (box) {
    top.push(`<rect class="ch-legbox" x="${f(box.x0)}" y="${f(box.y0)}" width="${f(bw)}" height="${bh}"/>`)
    text.push(`<text class="ch-mh" x="${f(box.x0 + 7)}" y="${f(box.y0 + 20)}">${mh}</text>`,
      `<text class="ch-dist" x="${f(box.x0 + 7)}" y="${f(box.y0 + 39)}">${dist}</text>`)
  }

  // Ticks along the leg: nm to go and time from the start of the leg on the left, a TACAN
  // radial/DME checkpoint on the right from the station nearest the leg.
  const tickNm = tickStep(leg.nm)
  const az = inverse(A.lat, A.lon, B.lat, B.lon).az
  const toLeg = (s: LatLon) => inverse(s.lat, s.lon, A.lat, A.lon).nm + inverse(s.lat, s.lon, B.lat, B.lon).nm
  const station = [...fixStations(m, { lat: (A.lat + B.lat) / 2, lon: (A.lon + B.lon) / 2 })].sort((s, t) => toLeg(s) - toLeg(t))[0]
  for (let d = tickNm; d < leg.nm - tickNm * 0.3; d += tickNm) {
    const y = pa.y + ((pb.y - pa.y) * d) / leg.nm
    top.push(`<line class="ch-tick" x1="${f(pa.x - 9)}" y1="${f(y)}" x2="${f(pa.x + 9)}" y2="${f(y)}"/>`)
    const togo = `${Math.round(leg.nm - d)}`
    const at = labels.place(pa.x, y, togo, 15, [[-14, 5, 'end']])
    if (at) {
      text.push(`<text class="ch-togo" x="${f(at.x)}" y="${f(at.y)}" text-anchor="end">${togo}</text>`)
      const t = `+${mmss((d / leg.gs) * 60)}`
      const tt = labels.place(pa.x, y, t, 11, [[-14, 22, 'end']])
      if (tt) text.push(`<text class="ch-time" x="${f(tt.x)}" y="${f(tt.y)}" text-anchor="end">${t}</text>`)
    }
    if (station) {
      const fix = tacanFixFrom(station, direct(A.lat, A.lon, az, d))
      const fa = labels.place(pa.x, y, fix, 12, [[14, 5, 'start']])
      if (fa) text.push(`<text class="ch-fix" x="${f(fa.x)}" y="${f(fa.y)}">${esc(fix)}</text>`)
    }
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
      ?? labels.place(c.x, c.y - r, lab, 11, [[0, 14, 'middle'], [0, -4, 'middle']])
    if (at) text.push(`<text class="ch-ring" x="${f(at.x)}" y="${f(at.y)}" text-anchor="middle">${lab}</text>`)
  }

  drawings(m, xy, nmPerPx, inView, back, text, labels)

  for (const a of airfields(m)) {
    const p = xy(a)
    if (!inView(p)) continue
    mid.push(`<circle class="ch-af" cx="${f(p.x)}" cy="${f(p.y)}" r="5"/>`)
    // Runway on the page: its true heading turned with the chart.
    const hdg = a.rwy_heading_true * DEG + turn
    const dx = Math.sin(hdg) * 8, dy = -Math.cos(hdg) * 8
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

  const svg = [
    `<defs><clipPath id="ch-clip-${to}"><rect width="${w}" height="${h}"/></clipPath></defs>`,
    `<g clip-path="url(#ch-clip-${to})">`, ...back, ...mid, ...top, ...text, `</g>`, ...furniture,
    `<rect class="ch-frame" x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}"/>`,
  ].join('')
  return { svg, nmPerPx, tickNm }
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
