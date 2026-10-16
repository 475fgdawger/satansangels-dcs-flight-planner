import { useMemo, useRef, useState } from 'preact/hooks'
import type { MissionExport } from '../nav/types'
import { clock, ddm, dms, duration, heading3 } from '../nav/format'
import { briefing, type FieldInfo, type TimePoint } from '../nav/briefing'
import { AIRCRAFT, planTitle, type AttackRun, type FuelPlan, type PlanSettings, type Row } from '../nav/plan'
import { NO_STORES } from '../nav/perf'
import { COMMON_COMMS, EXTRA_BEACONS } from './comms'
import { overviewProjection, routeOverview, routeSections, type Section } from '../nav/chart'
import { shadeTerrain, type TerrainGrid } from '../nav/terrain'
import { shadingImage } from './terrain'
import { inlineSvgStyles } from './Kneeboard'

// US Letter at 96 dpi; the PDF is the same page at 2x.
const PAGE_W = 816
const PAGE_H = 1056
// The route overview fills page 2 under a one-line heading.
const MAP_W = 776
const MAP_H = 980

const lb = (n: number) => Math.round(n).toLocaleString('en-US')
const when = (t: TimePoint) => (t.clock === null ? `T/O+${duration(t.elapsed)}` : `${clock(t.clock)}`)

/** A one-page mission briefing for this flight plan, with PDF export. */
export function BriefingPanel({ mission, rows, settings: s, fuel, run, terrain }: {
  mission: MissionExport; rows: Row[]; settings: PlanSettings; fuel: FuelPlan | null; run: AttackRun | null
  terrain: TerrainGrid | null
}) {
  const pagesRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const size = { width: MAP_W, height: MAP_H }
  // Terrain only changes with the route's extent, so it isn't redrawn for every edit.
  const extent = rows.map((r) => `${r.wp.lat.toFixed(3)},${r.wp.lon.toFixed(3)}`).join(';')
  // The whole route, then closer sections when it's too big to read the terrain on one page.
  const maps = useMemo(() => {
    if (rows.length < 2) return []
    const all: (Section & { whole: boolean })[] = [{ from: 0, to: rows.length - 1, whole: true }]
    for (const sec of routeSections(rows, size)) all.push({ ...sec, whole: false })
    return all.map((sec) => {
      const p = overviewProjection(rows, size, sec)
      const ground = terrain ? shadingImage(shadeTerrain(terrain, p.ll, MAP_W, MAP_H, p.nmPerPx, p.turn), MAP_W, MAP_H) : undefined
      return { sec, ground }
    })
  }, [terrain, extent])
  if (rows.length < 2) return null

  const title = planTitle(mission.mission.name, s)
  const b = briefing(mission, rows, s, fuel, run)
  const fileBase = `${title}_briefing`.replace(/[^A-Za-z0-9_-]+/g, '_')
  const perf = AIRCRAFT[s.aircraft].perf
  const beacons = [
    ...mission.tacans.map((t) => `${t.id} ${t.chan}`),
    ...(EXTRA_BEACONS[mission.mission.theatre] ?? []).map((x) => `${x.id} ${x.chan}`),
  ]

  async function savePdf() {
    const els = Array.from(pagesRef.current?.querySelectorAll<HTMLElement>('.bf-page') ?? [])
    if (els.length === 0) return
    setBusy(true)
    try {
      const { toJpeg } = await import('html-to-image')
      const images: string[] = []
      const restore = inlineSvgStyles(els)
      try {
        for (const el of els) images.push(await toJpeg(el, { pixelRatio: 2, width: PAGE_W, height: PAGE_H, backgroundColor: '#ffffff', quality: 0.92 }))
      } finally {
        restore()
      }
      const { jsPDF } = await import('jspdf')
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' })
      images.forEach((url, i) => {
        if (i > 0) pdf.addPage('letter', 'portrait')
        pdf.addImage(url, 'JPEG', 0, 0, 612, 792)
      })
      pdf.save(`${fileBase}.pdf`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="panel briefing">
      <div class="row no-print">
        <h2>Mission briefing</h2>
        <button type="button" disabled={busy} onClick={savePdf}>{busy ? 'Making PDF…' : 'Save briefing PDF'}</button>
        <span class="muted small">Briefing sheet, a full-page route overview, and closer section maps when the route is too big to read on one page.</span>
      </div>
      <div ref={pagesRef} class="bf-pages">
      <div class="bf-page">
        <div class="bf-head">
          <div>
            <div class="bf-kicker">MISSION BRIEFING</div>
            <div class="bf-title">{title}</div>
          </div>
          <div class="bf-flight">
            {s.callsign?.trim() && <div class="bf-callsign">{s.callsign.trim().toUpperCase()}</div>}
            <div>{s.aircraft}{perf ? ` · ${(s.drag ?? NO_STORES).toUpperCase()}` : ''}</div>
          </div>
        </div>

        <div class="bf-times">
          <Cell k="DATE" v={b.date} />
          <Cell k="MISSION START" v={clock(b.missionStart)} />
          <Cell k="TAKEOFF" v={b.takeoff === null ? '______' : clock(b.takeoff)} />
          <Cell k={b.tot?.kind === 'CAP' ? 'ON STATION' : 'TOT'} v={b.tot ? when(b.tot) : '—'} />
          <Cell k="LAND" v={when(b.land)} />
          <Cell k="ROUTE" v={`${Math.round(b.totalNm)} nm`} />
        </div>

        <div class="bf-cols">
          <Field label="DEPARTURE" f={b.departure} />
          <Field label="RECOVERY" f={b.destination} />
          <Field label="DIVERT" f={b.divert}
            extra={b.divert ? `${heading3(b.divert.magBearing)}° / ${Math.round(b.divert.nm)} nm from ${b.destination?.name}` : undefined} />
        </div>

        <h3>{b.tot?.kind === 'CAP' ? 'CAP STATION' : 'TARGET'}</h3>
        {b.target ? (
          <div class="bf-box bf-target">
            <div class="bf-tname">{b.target.name}{b.target.kind && <span class="tag">{b.target.kind}</span>}</div>
            <div>{b.target.near}{b.target.elevFt !== undefined && <> · elevation <b>{lb(b.target.elevFt)} ft</b></>}</div>
            <div>INS <b>{ddm(b.target)}</b> · {dms(b.target)} · <b>{b.target.tacan}</b></div>
            {b.attack && <div>Run in from <b>{b.attack.ip}</b>: {heading3(b.attack.magCourse)}° M, {b.attack.ipNm.toFixed(1)} nm IP to target</div>}
          </div>
        ) : <div class="bf-box muted">No target or CAP marked on the route.</div>}

        <h3>THREATS ALONG THE ROUTE</h3>
        {b.threats.length ? (
          <table class="bf-table">
            <thead><tr><th>THREAT</th><th>SYSTEM</th><th class="n">RING</th><th class="n">CLOSEST</th><th>LEG</th><th>TACAN</th></tr></thead>
            <tbody>
              {b.threats.slice(0, 8).map((t) => (
                <tr key={t.name} class={t.inside ? 'bf-inside' : ''}>
                  <td>{t.name}</td><td>{t.system}</td><td class="n">{t.ringNm} nm</td>
                  <td class="n">{t.inside ? 'INSIDE ' : ''}{t.closestNm.toFixed(1)} nm</td>
                  <td>{rows[t.leg - 1].wp.name} → {rows[t.leg].wp.name}</td><td>{t.tacan}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div class="bf-box muted">No known SAM or AAA within 10 nm of its ring.</div>}

        <h3>ROUTE</h3>
        <table class="bf-table">
          <thead><tr><th>#</th><th>WAYPOINT</th><th class="n">MC</th><th class="n">DIST</th><th class="n">ALT</th><th class="n">ETE</th><th class="n">{b.takeoff === null ? 'T/O+' : 'ETA'}</th><th class="n">FUEL</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.wp.id}>
                <td>{i}</td>
                <td>{r.wp.name}{r.wp.tags?.map((t) => <span key={t} class="tag">{t}</span>)}</td>
                <td class="n">{r.leg ? heading3(r.leg.magCourse) : ''}</td>
                <td class="n">{r.leg ? r.leg.nm.toFixed(1) : ''}</td>
                <td class="n">{r.wp.alt?.ft !== undefined ? `${lb(r.wp.alt.ft)} ${r.wp.alt.ref.toUpperCase()}` : ''}</td>
                <td class="n">{r.leg ? duration(r.leg.ete) : ''}</td>
                <td class="n">{i === 0 ? '' : r.eta === null ? duration(r.elapsed) : clock(r.eta)}</td>
                <td class="n">{lb(r.fuelRemaining)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div class="bf-fuel">
          <Cell k="START" v={lb(b.fuel.start)} />
          <Cell k="MISSION" v={b.fuel.required === null ? '—' : lb(b.fuel.required)}
            sub={b.fuel.margin === null ? undefined : b.fuel.margin < 0 ? `${lb(-b.fuel.margin)} SHORT` : `+${lb(b.fuel.margin)} spare`} />
          <Cell k="JOKER" v={b.fuel.joker === null ? '—' : lb(b.fuel.joker)} />
          <Cell k="BINGO" v={b.fuel.bingo === null ? '—' : lb(b.fuel.bingo)} />
        </div>

        <div class="bf-strip"><small>COMMS</small> {COMMON_COMMS.map((c) => `${c.name} ${c.freq}${c.note ? ` (${c.note})` : ''}`).join(' · ')}</div>
        <div class="bf-strip"><small>TACAN</small> {beacons.join(' · ')}</div>

        <h3>NOTES</h3>
        <div class="bf-notes">
          <div><small>WEATHER</small></div>
          <div><small>FORMATION / TACTICS</small></div>
          <div><small>CONTINGENCIES</small></div>
        </div>
      </div>
      {maps.map(({ sec, ground }, i) => (
        <div key={`${sec.from}-${sec.to}`} class="bf-page bf-map">
          <div class="bf-maphead">
            <b>{title}</b>
            <span>
              {sec.whole ? 'ROUTE OVERVIEW' : `SECTION ${i}/${maps.length - 1}: ${sec.from} ${rows[sec.from].wp.name} → ${sec.to} ${rows[sec.to].wp.name}`}
              {' · '}{Math.round(rows[sec.to].totalNm - rows[sec.from].totalNm)} nm{s.callsign?.trim() ? ` · ${s.callsign.trim().toUpperCase()}` : ''}
            </span>
          </div>
          <svg class="kb-chart" viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            dangerouslySetInnerHTML={{ __html: routeOverview(mission, rows, size, ground, sec).svg }} />
        </div>
      ))}
      </div>
    </section>
  )
}

function Cell({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return <div><small>{k}</small><b>{v}</b>{sub && <span class="bf-sub">{sub}</span>}</div>
}

function Field({ label, f, extra }: { label: string; f: FieldInfo | null; extra?: string }) {
  return (
    <div class="bf-box">
      <small>{label}</small>
      {f ? (
        <>
          <div class="bf-fname">{f.name}{f.code && <span class="muted"> {f.code}</span>}</div>
          {extra && <div>{extra}</div>}
          <div>RWY <b>{f.runways || '—'}</b> · elev {lb(f.elevFt)} ft</div>
          {f.tacan && <div>TACAN <b>{f.tacan}</b></div>}
          {f.freqs.length > 0 && <div class="bf-freqs">{f.freqs.join(' · ')}</div>}
        </>
      ) : <div class="muted">Not an airfield</div>}
    </div>
  )
}
