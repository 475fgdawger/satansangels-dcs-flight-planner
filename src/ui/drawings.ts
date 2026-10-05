// Mission editor drawings on the Leaflet map, styled like the DCS F10 map.

import L from 'leaflet'
import type { Drawing } from '../nav/types'
import { dashFor, dcsColor, strokeFor } from '../nav/map'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function drawingLayer(d: Drawing): L.Layer | null {
  const line = dcsColor(d.color) ?? { css: '#000000', opacity: 1 }
  const fill = dcsColor(d.fill)
  const weight = strokeFor(d.thickness)
  const stroke: L.PathOptions = { color: line.css, opacity: line.opacity, weight, dashArray: dashFor(d.style, weight),
    interactive: false }
  const area: L.PathOptions = { ...stroke, fill: !!fill && fill.opacity > 0, fillColor: fill?.css, fillOpacity: fill?.opacity ?? 0 }
  const pts = d.points.map(([lat, lon]) => [lat, lon] as [number, number])

  if (d.type === 'TextBox') {
    const lines = (d.text ?? d.name ?? '').split(/\r?\n/).map(esc).join('<br>')
    if (!lines) return null
    const size = Math.min(24, Math.max(10, d.font_size ?? 12))
    const bg = fill && fill.opacity > 0 ? `background:${rgba(fill)};padding:2px 5px;` : ''
    const border = d.thickness && d.thickness > 0 && bg ? `border:1px solid ${rgba(line)};` : ''
    return L.marker([d.lat, d.lon], { keyboard: false, icon: L.divIcon({ className: 'map-drawtext', iconSize: [0, 0],
      html: `<span style="color:${rgba(line)};font-size:${size}px;${bg}${border}">${lines}</span>` }) })
  }
  if (d.type === 'Icon') {
    return L.circleMarker([d.lat, d.lon], { radius: 5, color: line.css, weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(esc(d.name ?? 'Icon'), { direction: 'top' })
  }
  if (d.type === 'Polygon' && d.mode === 'circle' && d.radius_m) {
    return L.circle([d.lat, d.lon], { ...area, radius: d.radius_m })
  }
  if (pts.length < 2) return null
  if (d.type === 'Polygon') return L.polygon(pts, area)
  return d.closed ? L.polygon(pts, { ...stroke, fill: false }) : L.polyline(pts, stroke)
}

function rgba(c: { css: string; opacity: number }) {
  const n = parseInt(c.css.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${c.opacity.toFixed(2)})`
}
