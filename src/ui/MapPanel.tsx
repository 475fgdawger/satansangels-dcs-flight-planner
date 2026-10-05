import { useEffect, useRef } from 'preact/hooks'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { LatLon, MissionExport, Target } from '../nav/types'
import { ddm, heading3 } from '../nav/format'
import { airfields, magVarAt, nearRef, runwayPairs, tacanFix, M_TO_FT, type PointKind } from '../nav/mission'
import type { Row, Waypoint } from '../nav/plan'
import { boundsOf, drawingLayers, legMidpoint, missionBounds, threatRing, type Bounds } from '../nav/map'
import { drawingLayer } from './drawings'

const NM = 1852
const PREFS_KEY = 'flightplanner.map.v1'

// The DCS maps are real-world terrain, so real-world tiles line up with the export's lat/lon.
const BASES = {
  Terrain: () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc',
    attribution: 'Map data © OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)',
  }),
  Satellite: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  }),
  Street: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap contributors',
  }),
} as const
type BaseName = keyof typeof BASES

const OVERLAYS = {
  route: 'Route',
  threats: 'Threat rings (approx.)',
  targets: 'Targets',
  airfields: 'Airfields',
  tacans: 'TACANs',
  tacanRings: 'TACAN DME rings',
  zones: 'Mission zones',
  labels: 'Map labels',
} as const
type OverlayId = keyof typeof OVERLAYS
const DEFAULT_ON: OverlayId[] = ['route', 'threats', 'targets', 'airfields', 'tacans', 'labels']
const DME_RINGS_NM = [25, 50, 100]

const KIND_COLOR: Record<Target['kind'], string> = {
  range: '#e07b00',
  bridge: '#795548',
  SAM: '#d32f2f',
  AAA: '#8e0000',
  EWR: '#7b1fa2',
}

interface Prefs {
  base: BaseName
  on: OverlayId[]
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '') as Prefs
    if (p.base in BASES && Array.isArray(p.on)) return p
  } catch { /* first visit or storage blocked */ }
  return { base: 'Terrain', on: DEFAULT_ON }
}

function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* not critical */ }
}

let nextId = 1
const newId = () => `wpm${Date.now().toString(36)}${nextId++}`

const toLeaflet = (b: Bounds) => L.latLngBounds([b.south, b.west], [b.north, b.east])

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Interactive map of the mission and route: click anything to add it, drag waypoints to move them. */
export function MapPanel({ mission, route, rows, onRoute }: {
  mission: MissionExport; route: Waypoint[]; rows: Row[]; onRoute: (r: Waypoint[]) => void
}) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const groups = useRef<Record<OverlayId, L.LayerGroup> | null>(null)
  const layersCtl = useRef<L.Control.Layers | null>(null)
  // One overlay per mission editor draw layer; replaced when the mission changes.
  const drawGroups = useRef<L.LayerGroup[]>([])
  // Leaflet handlers outlive renders, so they read the latest route and callback from here.
  const live = useRef({ mission, route, onRoute })
  live.current = { mission, route, onRoute }
  const fitted = useRef<string | null>(null)

  // Create the map once.
  useEffect(() => {
    if (!el.current) return
    const prefs = loadPrefs()
    const m = L.map(el.current, { zoomSnap: 0.5, worldCopyJump: true })
    const bases = Object.fromEntries(Object.keys(BASES).map((k) => [k, BASES[k as BaseName]()])) as Record<BaseName, L.TileLayer>
    bases[prefs.base].addTo(m)
    const g = Object.fromEntries(Object.keys(OVERLAYS).map((k) => [k, L.layerGroup()])) as Record<OverlayId, L.LayerGroup>
    for (const id of prefs.on) g[id]?.addTo(m)
    layersCtl.current = L.control.layers(bases,
      Object.fromEntries(Object.entries(OVERLAYS).map(([k, label]) => [label, g[k as OverlayId]])), { position: 'topright' }).addTo(m)
    L.control.scale({ position: 'bottomright', imperial: true, metric: false }).addTo(m)

    const remember = () => {
      const base = (Object.keys(bases) as BaseName[]).find((k) => m.hasLayer(bases[k])) ?? 'Terrain'
      savePrefs({ base, on: (Object.keys(g) as OverlayId[]).filter((k) => m.hasLayer(g[k])) })
    }
    m.on('baselayerchange overlayadd overlayremove', remember)

    // Cursor readout: TACAN fix and coordinates under the mouse.
    const readout = new L.Control({ position: 'bottomleft' })
    let readoutEl: HTMLDivElement | null = null
    readout.onAdd = () => {
      readoutEl = L.DomUtil.create('div', 'map-readout')
      readoutEl.textContent = 'Point at the map for a TACAN fix'
      return readoutEl
    }
    readout.addTo(m)
    m.on('mousemove', (e: L.LeafletMouseEvent) => {
      if (!readoutEl) return
      const p = { lat: e.latlng.lat, lon: e.latlng.lng }
      readoutEl.textContent = `${tacanFix(live.current.mission, p)} · ${ddm(p)}`
    })

    // Click on open map: offer a waypoint there.
    m.on('click', (e: L.LeafletMouseEvent) => {
      const p = { lat: e.latlng.lat, lon: e.latlng.lng }
      const n = live.current.route.length + 1
      L.popup().setLatLng(e.latlng)
        .setContent(pointPopup(live.current.mission, { name: `WP${n}`, detail: 'Map point', ...p }, 'Add waypoint here', () => {
          addWaypoint({ id: newId(), name: `WP${n}`, source: 'manual', ...p })
          m.closePopup()
        }))
        .openOn(m)
    })

    map.current = m
    groups.current = g
    return () => {
      m.remove()
      map.current = null
      groups.current = null
      layersCtl.current = null
      drawGroups.current = []
    }
  }, [])

  function addWaypoint(wp: Waypoint) {
    const { route: r, onRoute: set } = live.current
    set([...r, wp])
  }

  // Mission layers.
  useEffect(() => {
    const m = map.current, g = groups.current
    if (!m || !g) return
    for (const id of ['threats', 'targets', 'airfields', 'tacans', 'tacanRings', 'zones', 'labels'] as OverlayId[]) g[id].clearLayers()

    const addable = (layer: L.Layer, p: { name: string; detail: string; kind: PointKind } & LatLon & { elevFt?: number }) => {
      layer.bindPopup(() => pointPopup(mission, p, 'Add to route', () => {
        addWaypoint({ id: newId(), name: p.name, source: p.kind, lat: p.lat, lon: p.lon,
          ...(p.elevFt === undefined ? {} : { elevFt: Math.round(p.elevFt), elevSource: 'dcs' as const }) })
        m.closePopup()
      }))
      return layer
    }

    for (const t of mission.targets) {
      const ring = threatRing(t)
      if (ring) {
        L.circle([t.lat, t.lon], { radius: ring.nm * NM, color: KIND_COLOR[t.kind], weight: 1.5, dashArray: '6 6',
          fillOpacity: 0.06, interactive: false }).addTo(g.threats)
      }
      addable(L.circleMarker([t.lat, t.lon], { radius: t.kind === 'range' ? 4 : 6, color: '#fff', weight: 1.5, bubblingMouseEvents: false,
        fillColor: KIND_COLOR[t.kind], fillOpacity: 1 })
        .bindTooltip(esc(t.name) + (ring ? ` (${ring.system}, ~${ring.nm} nm)` : ''), { direction: 'top' }),
      { name: t.name, kind: 'target', detail: `${t.section} · ${t.near}${ring ? ` · ${ring.system} ring ~${ring.nm} nm (approx.)` : ''}`,
        lat: t.lat, lon: t.lon, elevFt: t.elev_ft }).addTo(g.targets)
    }

    for (const a of airfields(mission)) {
      addable(L.marker([a.lat, a.lon], { icon: L.divIcon({ className: 'map-af', html: '✈', iconSize: [15, 15] }) })
        .bindTooltip(esc(a.name), { direction: 'top', offset: [0, -8] }),
      { name: a.name, kind: 'airfield', lat: a.lat, lon: a.lon, elevFt: a.elev_m * M_TO_FT,
        detail: [a.code, `RWY ${runwayPairs(a.runways).join(', ')}`, `${Math.round(a.elev_m * M_TO_FT)} ft`].filter(Boolean).join(' · ') })
        .addTo(g.airfields)
    }

    for (const t of mission.tacans) {
      addable(L.marker([t.lat, t.lon], { icon: L.divIcon({ className: 'map-tacan', iconSize: [0, 0],
        html: `<span class="map-tacan-sym"></span><span class="map-tacan-id">${esc(t.id)} ${esc(t.chan)}</span>` }) }),
      { name: t.id, kind: 'tacan', detail: `TACAN ${t.chan}`, lat: t.lat, lon: t.lon, elevFt: t.elev_ft }).addTo(g.tacans)
      for (const nm of DME_RINGS_NM) {
        L.circle([t.lat, t.lon], { radius: nm * NM, color: '#1f4e79', weight: 1, opacity: 0.6, fill: false, interactive: false })
          .bindTooltip(`${t.id} ${nm}`, { permanent: true, direction: 'center', className: 'map-dme' }).addTo(g.tacanRings)
      }
    }

    const targetNames = new Set(mission.targets.map((t) => t.name))
    for (const z of mission.zones) {
      if (targetNames.has(z.name)) continue
      addable(L.circleMarker([z.lat, z.lon], { radius: 4, color: '#455a64', weight: 1.5, bubblingMouseEvents: false, fillColor: '#cfd8dc', fillOpacity: 1 })
        .bindTooltip(esc(z.name), { direction: 'top' }),
      { name: z.name, kind: 'zone', detail: 'Mission zone', lat: z.lat, lon: z.lon, elevFt: z.elev_ft }).addTo(g.zones)
    }

    // Mission editor drawings, one overlay per draw layer. They include the text boxes, so the
    // plain map labels are only drawn for older exports without drawings.
    for (const dg of drawGroups.current) {
      m.removeLayer(dg)
      layersCtl.current?.removeLayer(dg)
    }
    drawGroups.current = drawingLayers(mission.drawings).map(({ name, on }) => {
      const dg = L.layerGroup()
      for (const d of mission.drawings!) {
        if (d.layer !== name) continue
        const layer = drawingLayer(d)
        if (!layer) continue
        // Text boxes are named places (ranges, tankers), so they can be added to the route like labels.
        const text = d.type === 'TextBox' ? (d.text ?? '').split(/\r?\n/)[0].trim() : ''
        if (text) addable(layer, { name: text, kind: 'label', detail: `Drawing (${name} layer)`, lat: d.lat, lon: d.lon })
        layer.addTo(dg)
      }
      layersCtl.current?.addOverlay(dg, `Drawings: ${esc(name)}`)
      if (on) dg.addTo(m)
      return dg
    })
    const hasDrawings = (mission.drawings?.length ?? 0) > 0

    for (const l of hasDrawings ? [] : mission.labels) {
      addable(L.marker([l.lat, l.lon], { icon: L.divIcon({ className: 'map-label', iconSize: [0, 0],
        html: `<span>${esc(l.text)}</span>` }) }),
      { name: l.text, kind: 'label', detail: 'Map label', lat: l.lat, lon: l.lon }).addTo(g.labels)
    }
  }, [mission])

  // Route layer.
  useEffect(() => {
    const m = map.current, g = groups.current
    if (!m || !g) return
    g.route.clearLayers()
    if (route.length === 0) return
    L.polyline(route.map((w) => [w.lat, w.lon] as [number, number]), { color: '#d81b60', weight: 3, opacity: 0.9, interactive: false })
      .addTo(g.route)

    rows.forEach((r, i) => {
      if (!r.leg) return
      const mid = legMidpoint(route[i - 1], route[i])
      L.marker([mid.lat, mid.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'map-leg', iconSize: [0, 0],
        html: `<span>${heading3(r.leg.magCourse)}° ${Math.round(r.leg.nm)} nm</span>` }) }).addTo(g.route)
    })

    route.forEach((w, i) => {
      const tags = w.tags ?? []
      const cls = ['map-wp', ...tags.map((t) => `tag-${t.toLowerCase()}`)].join(' ')
      const marker = L.marker([w.lat, w.lon], { draggable: true, autoPan: true, zIndexOffset: 1000,
        icon: L.divIcon({ className: cls, iconSize: [24, 24], html: `<span>${i}</span>` }) })
        .bindTooltip(`${i} ${esc(w.name)}${tags.length ? ` · ${tags.join(' ')}` : ''}`, { direction: 'top', offset: [0, -12] })
        .bindPopup(() => waypointPopup(mission, w, i, () => {
          const { route: r, onRoute: set } = live.current
          set(r.filter((x) => x.id !== w.id))
          m.closePopup()
        }))
      // Dragging moves the waypoint: it becomes a typed point (renamed if it was a named place)
      // and gets a fresh elevation lookup.
      marker.on('dragend', () => {
        const ll = marker.getLatLng()
        const { route: r, onRoute: set } = live.current
        set(r.map((x, j) => (x.id === w.id
          ? { ...x, id: newId(), name: x.source === 'manual' ? x.name : `WP${j}`, lat: ll.lat, lon: ll.lng, source: 'manual',
            elevFt: undefined, elevSource: undefined }
          : x)))
      })
      marker.addTo(g.route)
    })
  }, [route, rows, mission])

  // Frame the mission when a different one is loaded (the route if there is one); an Update keeps the view.
  useEffect(() => {
    const m = map.current
    if (!m) return
    const key = mission.mission.file
    if (fitted.current === key) return
    fit(route.length > 1 ? 'route' : 'mission')
    fitted.current = key
  }, [mission])

  function fit(what: 'route' | 'mission') {
    const m = map.current
    if (!m) return
    const b = what === 'route' && route.length > 0 ? boundsOf(route, 10) : missionBounds(mission)
    if (b) m.fitBounds(toLeaflet(b), { maxZoom: 11 })
    else m.setView([0, 0], 2)
  }

  return (
    <section class="panel no-print">
      <div class="map-head">
        <h2>Map</h2>
        <div class="row">
          <button type="button" onClick={() => fit('route')} disabled={route.length === 0}>Show route</button>
          <button type="button" onClick={() => fit('mission')}>Show mission area</button>
        </div>
      </div>
      <div ref={el} class="map" />
      <p class="muted small">
        Click a target, airfield, TACAN, zone or label to add it to the route, or click open map for a waypoint there.
        Drag a numbered waypoint to move it. Threat rings are approximate maximum ranges, for awareness only.
      </p>
    </section>
  )
}

function pointPopup(mission: MissionExport, p: { name: string; detail: string } & LatLon & { elevFt?: number },
  action: string, onAction: () => void): HTMLElement {
  const div = document.createElement('div')
  div.className = 'map-pop'
  const near = nearRef(mission, p, magVarAt(mission, p))
  div.innerHTML = `<b>${esc(p.name)}</b><div class="muted">${esc(p.detail)}</div>`
    + `<div class="mono">${esc(tacanFix(mission, p))}</div><div class="mono">${esc(ddm(p))}</div>`
    + (near ? `<div class="muted">${esc(near)}</div>` : '')
    + (p.elevFt === undefined ? '' : `<div class="muted">Elev ${Math.round(p.elevFt).toLocaleString('en-US')} ft</div>`)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = action
  btn.addEventListener('click', (e) => { e.stopPropagation(); onAction() })
  div.appendChild(btn)
  return div
}

function waypointPopup(mission: MissionExport, w: Waypoint, i: number, onRemove: () => void): HTMLElement {
  const detail = [w.tags?.join(' '), w.elevFt === undefined ? '' : `Elev ${w.elevFt.toLocaleString('en-US')} ft${w.elevSource === 'dem' ? ' ≈' : ''}`]
    .filter(Boolean).join(' · ')
  return pointPopup(mission, { name: `${i} ${w.name}`, detail: detail || 'Waypoint', lat: w.lat, lon: w.lon }, 'Remove from route', onRemove)
}
