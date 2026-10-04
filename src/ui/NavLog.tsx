import type { MissionExport } from '../nav/types'
import { clock, ddm, dms, duration, heading3 } from '../nav/format'
import { magVarAt, nearRef, tacanFix } from '../nav/mission'
import type { PlanSettings, Row } from '../nav/plan'
import { COMMON_COMMS, EXTRA_BEACONS } from './comms'

/** The printable kneeboard card. */
export function NavLog({ mission, rows, settings: s }: { mission: MissionExport; rows: Row[]; settings: PlanSettings }) {
  if (rows.length === 0) {
    return <section class="panel no-print muted">Add waypoints to see the nav log.</section>
  }
  const last = rows[rows.length - 1]
  const beacons = [
    ...mission.tacans.map((t) => ({ id: t.id, chan: t.chan, site: '' })),
    ...(EXTRA_BEACONS[mission.mission.theatre] ?? []),
  ]
  const lowFuel = (f: number) => (f < s.bingo ? 'bingo' : f < s.joker ? 'joker' : '')

  return (
    <section class="navlog">
      <div class="navlog-head">
        <div>
          <h2>{mission.mission.name}</h2>
          <div>{s.aircraft} · T/O {clock(s.takeoff)} · {Math.round(last.totalNm)} nm · {duration(last.elapsed)} enroute</div>
        </div>
        <div class="right">
          <div>Fuel {s.startFuel} lb · Joker {s.joker} · Bingo {s.bingo}</div>
          <div>{s.windKt > 0 ? `Wind ${heading3(s.windDir)}/${s.windKt} kt (true)` : 'No wind'}</div>
        </div>
      </div>

      <table class="log">
        <thead>
          <tr>
            <th>#</th>
            <th>Waypoint</th>
            <th>TACAN</th>
            <th>Lat/Lon (DDM, INS)</th>
            <th>Lat/Lon (DMS)</th>
            <th>MC</th>
            <th>MH</th>
            <th>Dist</th>
            <th>GS</th>
            <th>ETE</th>
            <th>ETA</th>
            <th>Fuel</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const mv = magVarAt(mission, r.wp)
            return (
              <tr key={r.wp.id} class={lowFuel(r.fuelRemaining)}>
                <td>{i}</td>
                <td>
                  <strong>{r.wp.name}</strong>
                  <div class="sub">{nearRef(mission, r.wp, mv)}</div>
                </td>
                <td class="mono">{tacanFix(mission, r.wp)}</td>
                <td class="mono">{ddm(r.wp)}</td>
                <td class="mono">{dms(r.wp)}</td>
                <td class="num">{r.leg ? heading3(r.leg.magCourse) : ''}</td>
                <td class="num">{r.leg ? heading3(r.leg.magHeading) : ''}</td>
                <td class="num">{r.leg ? r.leg.nm.toFixed(1) : ''}</td>
                <td class="num">{r.leg ? Math.round(r.leg.gs) : ''}</td>
                <td class="num">{r.leg ? duration(r.leg.ete) : ''}</td>
                <td class="num">{clock(r.eta)}</td>
                <td class="num">{Math.round(r.fuelRemaining)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div class="navlog-foot">
        <table class="mini">
          <thead><tr><th colspan={2}>TACAN</th></tr></thead>
          <tbody>
            {beacons.map((b) => <tr><td>{b.id}</td><td>{b.chan}{b.site ? ` · ${b.site}` : ''}</td></tr>)}
          </tbody>
        </table>
        <table class="mini">
          <thead><tr><th colspan={2}>Comms</th></tr></thead>
          <tbody>
            {COMMON_COMMS.map((c) => <tr><td>{c.name}</td><td>{c.freq}{c.note ? ` · ${c.note}` : ''}</td></tr>)}
          </tbody>
        </table>
        <div class="notes">
          <div>MC/MH magnetic; TACAN fixes are radial from the station / nm.</div>
          <div>Fuel is remaining at the waypoint (lb), after {s.taxiFuel} lb taxi/takeoff.</div>
          <div>Data exported {mission.built_utc}.</div>
        </div>
      </div>
    </section>
  )
}
