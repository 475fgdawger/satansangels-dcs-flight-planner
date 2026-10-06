import { useMemo, useRef, useState } from 'preact/hooks'
import type { MissionExport } from '../nav/types'
import { clock, ddm, dms, duration, heading3 } from '../nav/format'
import { magVarAt, nearRef, tacanFix } from '../nav/mission'
import { altAgl, altMsl, departureFuel, planTitle, phaseOf, type AttackRun, type Waypoint, type FuelPlan, type PlanSettings, type Row } from '../nav/plan'
import { COMMON_COMMS, EXTRA_BEACONS } from './comms'
import { AttackCard, AttackPicture } from './Popup'
import type { PopupResult } from '../nav/popup'
import { legStrip, stripProjection } from '../nav/chart'
import { maxElevationNear, shadeTerrain, type TerrainGrid } from '../nav/terrain'
import { shadingImage } from './terrain'

// DCS kneeboard pages are 3:4 portrait; 768x1024 is the usual size. PNGs are
// exported at 2x (1536x2048) so text stays sharp, same aspect ratio.
export const PAGE_W = 768
export const PAGE_H = 1024
const EXPORT_SCALE = 2
const ROWS_PER_PAGE = 10
// A loiter line is about 40% of a waypoint's height on the page.
const LOITER_ROW = 0.4

const COMM_SHORT: Record<string, string> = { Tower: 'TWR', Squadron: 'SQN', 'ARCO (tanker)': 'ARCO', 'SHELL (tanker)': 'SHELL' }

/** The nav log as one or more kneeboard pages, with PNG and PDF export. */
export function Kneeboard({ mission: exported, rows, settings: s, fuel, run, attack, terrain }: {
  mission: MissionExport; rows: Row[]; settings: PlanSettings; fuel: FuelPlan | null
  run: AttackRun | null; attack: PopupResult | null; terrain: TerrainGrid | null
}) {
  const pagesRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // Every page heads with the mission name; the crew's title block replaces it.
  const title = planTitle(exported.mission.name, s)
  const mission = { ...exported, mission: { ...exported.mission, name: title } }

  if (rows.length === 0) {
    return <section class="panel no-print muted">Add waypoints to see the nav log.</section>
  }

  const pages: { first: number; rows: Row[] }[] = []
  let used = Infinity
  rows.forEach((r, i) => {
    const h = 1 + (r.loiter ? LOITER_ROW : 0)
    if (used + h > ROWS_PER_PAGE) {
      pages.push({ first: i, rows: [] })
      used = 0
    }
    pages[pages.length - 1].rows.push(r)
    used += h
  })
  const fileBase = `${s.title?.trim() || mission.mission.theatre}_navlog`.replace(/[^A-Za-z0-9_-]+/g, '_')

  async function exportAs(kind: 'png' | 'pdf') {
    const els = Array.from(pagesRef.current?.querySelectorAll<HTMLElement>('.kb-page') ?? [])
    if (els.length === 0) return
    setBusy(kind === 'png' ? 'Making PNG…' : 'Making PDF…')
    try {
      const { toJpeg, toPng } = await import('html-to-image')
      const opts = { pixelRatio: EXPORT_SCALE, width: PAGE_W, height: PAGE_H, backgroundColor: '#ffffff' }
      const images = []
      const restore = inlineSvgStyles(els)
      try {
        // PNG for the DCS kneeboard folder; JPEG inside the PDF keeps the file small.
        for (const el of els) images.push(kind === 'png' ? await toPng(el, opts) : await toJpeg(el, { ...opts, quality: 0.92 }))
      } finally {
        restore()
      }
      if (kind === 'png') {
        images.forEach((url, i) => download(url, `${fileBase}_${i + 1}.png`))
      } else {
        const { jsPDF } = await import('jspdf')
        // 576 x 768 pt = 8 x 10.67 in, the same 3:4 as the kneeboard.
        const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: [576, 768] })
        images.forEach((url, i) => {
          if (i > 0) pdf.addPage([576, 768], 'portrait')
          pdf.addImage(url, 'JPEG', 0, 0, 576, 768)
        })
        pdf.save(`${fileBase}.pdf`)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <section class="kneeboard">
      <div class="row no-print">
        <button type="button" disabled={!!busy} onClick={() => exportAs('png')}>Save kneeboard PNG</button>
        <button type="button" disabled={!!busy} onClick={() => exportAs('pdf')}>Save PDF</button>
        <button type="button" onClick={() => window.print()}>Print</button>
        <span class="muted small">
          {busy ?? <>PNGs go in <code>Saved Games\DCS\Kneeboard\{s.aircraft}</code> (or <code>Kneeboard</code> for every aircraft).</>}
        </span>
      </div>
      <div ref={pagesRef} class="kb-pages">
        {pages.map((pg, p) => (
          <Page key={p} mission={mission} all={rows} rows={pg.rows} first={pg.first}
            page={p + 1} pageCount={pages.length} settings={s} fuel={fuel} />
        ))}
        {rows.map((r, i) => r.leg && i > 0 && <LegPage key={`leg${r.wp.id}`} mission={mission} rows={rows} to={i} settings={s} fuel={fuel} terrain={terrain} />)}
        {run && attack && <AttackPage mission={mission} rows={rows} run={run} attack={attack} />}
      </div>
    </section>
  )
}

function Page({ mission, all, rows, first, page, pageCount, settings: s, fuel }: {
  mission: MissionExport; all: Row[]; rows: Row[]; first: number; page: number; pageCount: number
  settings: PlanSettings; fuel: FuelPlan | null
}) {
  const last = all[all.length - 1]
  const lb = (n: number) => Math.round(n).toLocaleString('en-US')
  const lowFuel = (f: number) => (!fuel ? '' : f < fuel.bingo ? 'bingo' : f < fuel.joker ? 'joker' : '')
  const dep = departureFuel(s)
  const beacons = [
    ...mission.tacans.map((t) => `${t.id} ${t.chan}`),
    ...(EXTRA_BEACONS[mission.mission.theatre] ?? []).map((b) => `${b.id} ${b.chan}`),
  ]

  return (
    <div class="kb-page">
      <div class="kb-title">
        <span>{mission.mission.name}</span>
        <span class="kb-pageno">NAV LOG {page}/{pageCount}</span>
      </div>
      <div class="kb-line">
        {s.callsign?.trim() && <span><b>{s.callsign.trim().toUpperCase()}</b></span>}
        <span><b>{s.aircraft}</b></span>
        <span>T/O <b>{s.takeoff === undefined ? '______' : clock(s.takeoff)}</b></span>
        <span><b>{Math.round(last.totalNm)}</b> nm</span>
        <span><b>{duration(last.elapsedAfter)}</b> enroute</span>
        <span>{s.windKt > 0 ? <>Wind <b>{heading3(s.windDir)}/{s.windKt}</b>T</> : 'No wind'}</span>
      </div>
      <div class="kb-fuel">
        <div><small>START</small><b>{lb(s.startFuel)}</b></div>
        <div class="joker"><small>JOKER</small><b>{fuel ? lb(fuel.joker) : '—'}</b></div>
        <div class="bingo"><small>BINGO</small><b>{fuel ? lb(fuel.bingo) : '—'}</b></div>
        <div><small>AT {fuel?.targetKind === 'CAP' ? 'CAP' : 'TGT'}</small><b>{fuel ? all[fuel.target].wp.name : '—'}</b></div>
      </div>
      <div class="kb-strip"><small>TACAN</small> {beacons.join(' · ')}</div>
      <div class="kb-strip">
        <small>COMMS</small> {COMMON_COMMS.map((c) => `${COMM_SHORT[c.name] ?? c.name} ${c.freq}`).join(' · ')}
      </div>

      <table class="kb-table">
        <thead>
          <tr>
            <th>#</th><th>WAYPOINT</th><th class="n">MC</th><th class="n">MH</th><th class="n">DIST</th><th class="n">ALT</th><th>PWR</th><th class="n">ETE</th><th class="n">ETA</th><th class="n">FUEL</th>
          </tr>
        </thead>
        {rows.map((r, k) => {
          const i = first + k
          const mv = magVarAt(mission, r.wp)
          const cls = lowFuel(r.fuelRemaining)
          return (
            <tbody key={r.wp.id} class={cls}>
              <tr class="kb-main">
                <td class="kb-num">{i}</td>
                <td class="kb-name">
                  {r.wp.name}{r.wp.tags?.map((t) => <span key={t} class="tag">{t}</span>)}
                  <div class="kb-near">{nearRef(mission, r.wp, mv)}</div>
                </td>
                <td class="n">{r.leg ? heading3(r.leg.magCourse) : ''}</td>
                <td class="n">{r.leg ? heading3(r.leg.magHeading) : ''}</td>
                <td class="n">{r.leg ? r.leg.nm.toFixed(1) : ''}</td>
                <td class="n kb-alt"><AltCell wp={r.wp} /></td>
                <td>{r.leg ? powerLabel(r.leg, s) : ''}</td>
                <td class="n">{r.leg ? duration(r.leg.ete) : ''}</td>
                <td class="n">{r.eta === null ? '' : clock(r.eta)}</td>
                <td class="n">{lb(r.fuelRemaining)}</td>
              </tr>
              <tr class="kb-sub">
                <td />
                <td colSpan={9}>
                  <span class="kb-tacan">{tacanFix(mission, r.wp)}</span>
                  <span>INS {ddm(r.wp)}</span>
                  <span class="kb-dms">{dms(r.wp)}</span>
                  {r.wp.elevFt !== undefined && <span>ELEV {lb(r.wp.elevFt)}{r.wp.elevSource === 'dem' ? '≈' : ''}</span>}
                </td>
              </tr>
              {r.loiter && (
                <tr class={`kb-loiter ${lowFuel(r.fuelAfter)}`}>
                  <td />
                  <td colSpan={6}>
                    <b>LOITER {duration(r.loiter.min)}</b>
                    <span>{r.loiter.phase ? r.loiter.phase.short : `${Math.round(r.loiter.ff)} lb/hr`}</span>
                    <span>{lb(r.loiter.fuel)} lb</span>
                  </td>
                  <td class="n">OUT</td>
                  <td class="n">{s.takeoff === undefined ? '' : clock(s.takeoff + r.elapsedAfter * 60)}</td>
                  <td class="n">{lb(r.fuelAfter)}</td>
                </tr>
              )}
            </tbody>
          )
        })}
      </table>

      <div class="kb-foot">
        MC/MH magnetic · ALT ft as planned, other reference below · TACAN radial from station/nm · Fuel lb remaining after {lb(dep.taxi)} taxi + {lb(dep.takeoff)} AB T/O;
        leg 1 includes {lb(dep.climb)} MIL climb; fuel shown on arrival, OUT = leaving after loiter{fuel ? ' · shaded rows below joker/bingo' : ''}
      </div>
    </div>
  )
}

// The strip fills the page between the leg data and the from-waypoint line.
const STRIP_W = PAGE_W - 44
const STRIP_H = 764
// Corridor either side of a leg for its highest-terrain figure.
const TERRAIN_CLEAR_NM = 5

/** One leg as a course-up strip map, with the numbers to fly it. Follows the nav log pages. */
function LegPage({ mission, rows, to, settings: s, fuel, terrain }: {
  mission: MissionExport; rows: Row[]; to: number; settings: PlanSettings; fuel: FuelPlan | null
  terrain: TerrainGrid | null
}) {
  const r = rows[to], leg = r.leg!
  const from = rows[to - 1]
  const size = { width: STRIP_W, height: STRIP_H }
  // Terrain only changes with the leg's ends, so moving other waypoints doesn't redraw it.
  const ground = useMemo(() => {
    if (!terrain) return null
    const p = stripProjection(rows, to, size)
    const shading = shadeTerrain(terrain, p.ll, STRIP_W, STRIP_H, p.nmPerPx, p.turn)
    return { image: shadingImage(shading, STRIP_W, STRIP_H), contourFt: shading.contourFt,
      maxFt: maxElevationNear(terrain, from.wp, r.wp, TERRAIN_CLEAR_NM) }
  }, [terrain, from.wp.lat, from.wp.lon, r.wp.lat, r.wp.lon])
  const strip = legStrip(mission, rows, to, size, ground?.image)
  const lb = (n: number) => Math.round(n).toLocaleString('en-US')
  const low = !fuel ? '' : r.fuelRemaining < fuel.bingo ? 'bingo' : r.fuelRemaining < fuel.joker ? 'joker' : ''
  const tags = (w: Waypoint) => w.tags?.map((t) => <span key={t} class="tag">{t}</span>)
  const fix = (w: Waypoint) => (
    <>
      <span class="kb-tacan">{tacanFix(mission, w)}</span> · INS {ddm(w)}
      {w.elevFt !== undefined && <> · ELEV {lb(w.elevFt)}{w.elevSource === 'dem' ? '≈' : ''}</>}
    </>
  )
  return (
    <div class="kb-page kb-leg">
      <div class="kb-title">
        <span>{mission.mission.name}</span>
        <span class="kb-pageno">LEG {to}/{rows.length - 1}</span>
      </div>
      <div class="kb-legname">
        <span>{to - 1} {from.wp.name}{tags(from.wp)}</span> <span class="kb-arrow">→</span> <span><b>{to} {r.wp.name}</b>{tags(r.wp)}</span>
      </div>
      <div class="kb-legdata">
        <div><small>MC</small><b>{heading3(leg.magCourse)}°</b></div>
        <div><small>MH</small><b>{heading3(leg.magHeading)}°</b></div>
        <div><small>DIST</small><b>{leg.nm.toFixed(1)}</b></div>
        <div><small>GS / TAS</small><b>{Math.round(leg.gs)}</b><i>/{Math.round(leg.tas)}</i></div>
        <div><small>ETE</small><b>{duration(leg.ete)}</b></div>
        <div><small>{r.eta === null ? 'ELAPSED' : 'ETA'}</small><b>{r.eta === null ? duration(r.elapsed) : clock(r.eta)}</b></div>
        <div><small>ALT</small><b class="kb-alt"><AltCell wp={r.wp} /></b></div>
        <div class={low}><small>FUEL AT {to}</small><b>{lb(r.fuelRemaining)}</b></div>
        {ground?.maxFt != null && <div><small>TERR ±{TERRAIN_CLEAR_NM}</small><b>{lb(ground.maxFt)}</b></div>}
      </div>
      <div class="kb-strip"><small>TO {to}</small> {fix(r.wp)}</div>
      {r.loiter && (
        <div class="kb-strip"><small>LOITER</small> {duration(r.loiter.min)} {r.loiter.phase ? r.loiter.phase.short : `${lb(r.loiter.ff)} lb/hr`},
          out with {lb(r.fuelAfter)} lb{s.takeoff === undefined ? '' : ` at ${clock(s.takeoff + r.elapsedAfter * 60)}`}</div>
      )}
      <svg class="kb-chart" viewBox={`0 0 ${STRIP_W} ${STRIP_H}`} dangerouslySetInnerHTML={{ __html: strip.svg }} />
      <div class="kb-strip"><small>FROM {to - 1}</small> {fix(from.wp)}</div>
      <div class="kb-foot">
        Course up · ticks every {strip.tickNm} nm: nm to go and time from {from.wp.name} on the left, TACAN radial/DME on the right ·
        ▲ SAM/AAA, dashed ring approx. max range · ⬡ TACAN · ⊖ airfield · outlines = mission drawings
        {ground && <> · DCS terrain, contours every {lb(ground.contourFt)} ft · TERR = highest ground within {TERRAIN_CLEAR_NM} nm of the leg</>}
      </div>
    </div>
  )
}

/** The pop-up attack card and picture as its own kneeboard page. */
function AttackPage({ mission, rows, run, attack }: { mission: MissionExport; rows: Row[]; run: AttackRun; attack: PopupResult }) {
  const tgt = rows[run.tgt].wp
  const ip = rows[run.ip].wp
  const p = attack.inputs
  return (
    <div class="kb-page kb-attack">
      <div class="kb-title">
        <span>{mission.mission.name}</span>
        <span class="kb-pageno">POP-UP ATTACK</span>
      </div>
      <div class="kb-line">
        <span>IP <b>{ip.name}</b></span>
        <span>TGT <b>{tgt.name}</b></span>
        <span>Elev <b>{Math.round(p.tgtElev).toLocaleString('en-US')}</b>{tgt.elevSource === 'dem' ? '≈' : ''} MSL</span>
        <span>Dive <b>{p.dive}°</b></span>
        <span>Rel <b>{Math.round(p.relAgl).toLocaleString('en-US')}</b> AGL</span>
      </div>
      <div class="kb-strip"><small>TGT</small> {tacanFix(mission, tgt)} · INS {ddm(tgt)}</div>
      {attack.warning && <div class="kb-warn">{attack.warning}</div>}
      <AttackCard attack={attack} />
      <AttackPicture attack={attack} />
      <div class="kb-foot">Nil wind · action right drawn, left is the mirror image · ranges are ground distance to the target</div>
    </div>
  )
}

/** The altitude as typed, with the other reference (MSL or AGL) below it when the elevation is known. */
function AltCell({ wp }: { wp: Waypoint }) {
  const ft = wp.alt?.ft
  if (ft === undefined) return null
  const ref = wp.alt!.ref
  const other = ref === 'msl' ? altAgl(wp) : altMsl(wp)
  const approx = wp.elevSource === 'dem' ? '≈' : ''
  const n = (v: number) => Math.round(v).toLocaleString('en-US')
  return (
    <>
      {n(ft)}<small>{ref.toUpperCase()}</small>
      {other !== undefined && <div class="kb-alt2">{approx}{n(other)} {ref === 'msl' ? 'AGL' : 'MSL'}</div>}
    </>
  )
}

function powerLabel(leg: NonNullable<Row['leg']>, s: PlanSettings): string {
  const main = leg.phase ? leg.phase.short : `${Math.round(leg.ff)}`
  return leg.climbMin > 0 ? `${phaseOf(s.aircraft, 'mil').short}/${main}` : main
}

// html-to-image loses stylesheet rules on SVG shapes (they export as solid black), so the
// pictures' computed styles are written onto each shape for the capture and removed after.
const SVG_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linejoin', 'opacity',
  'paint-order', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing']

function inlineSvgStyles(pages: HTMLElement[]): () => void {
  const saved: [Element, string | null][] = []
  for (const page of pages) {
    for (const node of Array.from(page.querySelectorAll('svg *'))) {
      const cs = getComputedStyle(node)
      saved.push([node, node.getAttribute('style')])
      ;(node as SVGElement).style.cssText += SVG_PROPS.map((k) => `${k}:${cs.getPropertyValue(k)}`).join(';')
    }
  }
  return () => {
    for (const [node, style] of saved) {
      if (style === null) node.removeAttribute('style')
      else node.setAttribute('style', style)
    }
  }
}

function download(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}
