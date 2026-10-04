import { useRef, useState } from 'preact/hooks'
import type { MissionExport } from '../nav/types'
import { clock, ddm, dms, duration, heading3 } from '../nav/format'
import { magVarAt, nearRef, tacanFix } from '../nav/mission'
import { departureFuel, phaseOf, type AttackRun, type FuelPlan, type PlanSettings, type Row } from '../nav/plan'
import { COMMON_COMMS, EXTRA_BEACONS } from './comms'
import { AttackCard, AttackPicture } from './Popup'
import type { PopupResult } from '../nav/popup'

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
export function Kneeboard({ mission, rows, settings: s, fuel, run, attack }: {
  mission: MissionExport; rows: Row[]; settings: PlanSettings; fuel: FuelPlan | null
  run: AttackRun | null; attack: PopupResult | null
}) {
  const pagesRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<string | null>(null)

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
  const fileBase = `${mission.mission.theatre}_navlog`.replace(/[^A-Za-z0-9_-]+/g, '_')

  async function exportAs(kind: 'png' | 'pdf') {
    const els = Array.from(pagesRef.current?.querySelectorAll<HTMLElement>('.kb-page') ?? [])
    if (els.length === 0) return
    setBusy(kind === 'png' ? 'Making PNG…' : 'Making PDF…')
    try {
      const { toJpeg, toPng } = await import('html-to-image')
      const opts = { pixelRatio: EXPORT_SCALE, width: PAGE_W, height: PAGE_H, backgroundColor: '#ffffff' }
      const images = []
      // PNG for the DCS kneeboard folder; JPEG inside the PDF keeps the file small.
      for (const el of els) images.push(kind === 'png' ? await toPng(el, opts) : await toJpeg(el, { ...opts, quality: 0.92 }))
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
            <th>#</th><th>WAYPOINT</th><th class="n">MC</th><th class="n">MH</th><th class="n">DIST</th><th>PWR</th><th class="n">ETE</th><th class="n">ETA</th><th class="n">FUEL</th>
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
                <td>{r.leg ? powerLabel(r.leg, s) : ''}</td>
                <td class="n">{r.leg ? duration(r.leg.ete) : ''}</td>
                <td class="n">{r.eta === null ? '' : clock(r.eta)}</td>
                <td class="n">{lb(r.fuelRemaining)}</td>
              </tr>
              <tr class="kb-sub">
                <td />
                <td colSpan={8}>
                  <span class="kb-tacan">{tacanFix(mission, r.wp)}</span>
                  <span>INS {ddm(r.wp)}</span>
                  <span class="kb-dms">{dms(r.wp)}</span>
                  {r.wp.elevFt !== undefined && <span>ELEV {lb(r.wp.elevFt)}{r.wp.elevSource === 'dem' ? '≈' : ''}</span>}
                </td>
              </tr>
              {r.loiter && (
                <tr class={`kb-loiter ${lowFuel(r.fuelAfter)}`}>
                  <td />
                  <td colSpan={5}>
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
        MC/MH magnetic · TACAN radial from station/nm · Fuel lb remaining after {lb(dep.taxi)} taxi + {lb(dep.takeoff)} AB T/O;
        leg 1 includes {lb(dep.climb)} MIL climb; fuel shown on arrival, OUT = leaving after loiter{fuel ? ' · shaded rows below joker/bingo' : ''}
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

function powerLabel(leg: NonNullable<Row['leg']>, s: PlanSettings): string {
  const main = leg.phase ? leg.phase.short : `${Math.round(leg.ff)}`
  return leg.climbMin > 0 ? `${phaseOf(s.aircraft, 'mil').short}/${main}` : main
}

function download(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}
