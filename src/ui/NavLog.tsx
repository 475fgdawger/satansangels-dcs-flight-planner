import type { MissionExport } from '../nav/types'
import { clock, ddm, dms, duration, heading3 } from '../nav/format'
import { magVarAt, nearRef, tacanFix } from '../nav/mission'
import { departureFuel, phaseOf, type FuelPlan, type PlanSettings, type Row } from '../nav/plan'
import { COMMON_COMMS, EXTRA_BEACONS } from './comms'

/** The printable kneeboard card. */
export function NavLog({ mission, rows, settings: s, fuel }:
  { mission: MissionExport; rows: Row[]; settings: PlanSettings; fuel: FuelPlan | null }) {
  if (rows.length === 0) {
    return <section class="panel no-print muted">Add waypoints to see the nav log.</section>
  }
  const last = rows[rows.length - 1]
  const beacons = [
    ...mission.tacans.map((t) => ({ id: t.id, chan: t.chan, site: '' })),
    ...(EXTRA_BEACONS[mission.mission.theatre] ?? []),
  ]
  const lowFuel = (f: number) => (!fuel ? '' : f < fuel.bingo ? 'bingo' : f < fuel.joker ? 'joker' : '')
  const lb = (n: number) => Math.round(n).toLocaleString('en-US')
  const dep = departureFuel(s)

  return (
    <section class="navlog">
      <div class="navlog-head">
        <div>
          <h2>{mission.mission.name}</h2>
          <div>{s.aircraft} · T/O {s.takeoff === undefined ? '______' : clock(s.takeoff)} · {Math.round(last.totalNm)} nm · {duration(last.elapsed)} enroute</div>
        </div>
        <div class="right">
          <div>Fuel {lb(s.startFuel)} lb{fuel && <> · Joker {lb(fuel.joker)} · Bingo {lb(fuel.bingo)} (at {rows[fuel.target].wp.name})</>}</div>
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
            <th>Pwr</th>
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
                  <strong>{r.wp.name}</strong>{fuel?.target === i && <span class="tag">TGT</span>}
                  <div class="sub">{nearRef(mission, r.wp, mv)}</div>
                </td>
                <td class="mono">{tacanFix(mission, r.wp)}</td>
                <td class="mono">{ddm(r.wp)}</td>
                <td class="mono">{dms(r.wp)}</td>
                <td class="num">{r.leg ? heading3(r.leg.magCourse) : ''}</td>
                <td class="num">{r.leg ? heading3(r.leg.magHeading) : ''}</td>
                <td class="num">{r.leg ? r.leg.nm.toFixed(1) : ''}</td>
                <td class="num">{r.leg ? Math.round(r.leg.gs) : ''}</td>
                <td>{r.leg ? powerLabel(r.leg, s) : ''}</td>
                <td class="num">{r.leg ? duration(r.leg.ete) : ''}</td>
                <td class="num">{r.eta === null ? '' : clock(r.eta)}</td>
                <td class="num">{lb(r.fuelRemaining)}</td>
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
          <div>Fuel remaining at each waypoint (lb), after {lb(dep.taxi)} taxi + {lb(dep.takeoff)} AB takeoff to 400 kt; leg 1 starts with {lb(dep.climb)} MIL climb.</div>
          {fuel && <div>Joker/bingo are fuel states at TGT; rows below them are shaded.</div>}
          <div>Data exported {mission.built_utc}.</div>
        </div>
      </div>
    </section>
  )
}

function powerLabel(leg: NonNullable<Row['leg']>, s: PlanSettings): string {
  const main = leg.phase ? leg.phase.short : `${Math.round(leg.ff)}/hr`
  return leg.climbMin > 0 ? `${phaseOf(s.aircraft, 'mil').short} ${Math.round(leg.climbMin)}m, ${main}` : main
}
