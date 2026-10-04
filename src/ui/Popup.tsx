import { AP_NM, DEFAULT_INGRESS_AGL, DIVES, attackCard, defaultPopup, popupPicture, popupProblems, type PopupResult, type PopupSettings } from '../nav/popup'
import { popupInputs, type AttackRun, type PlanSettings, type Waypoint } from '../nav/plan'

/** Pop-up attack inputs and attack card, fed by the IP-to-TGT run on the route. */
export function PopupPanel({ route, run, settings, attack, onSettings, onRoute }: {
  route: Waypoint[]; run: AttackRun | null; settings: PlanSettings; attack: PopupResult | null
  onSettings: (s: PlanSettings) => void; onRoute: (r: Waypoint[]) => void
}) {
  const p = settings.popup ?? defaultPopup()
  const set = (patch: Partial<PopupSettings>) => onSettings({ ...settings, popup: { ...p, ...patch } })
  const num = (v: string) => (v.trim() === '' ? NaN : Number(v))
  const opt = (v: string) => (v.trim() === '' ? undefined : Number(v))

  if (!run) {
    return (
      <section class="panel no-print">
        <h2>Pop-up attack</h2>
        <p class="muted">Mark a waypoint TGT (and the IP before it) to plan a pop-up attack on it.</p>
      </section>
    )
  }
  const tgt = route[run.tgt]
  const problems = popupProblems(popupInputs(run, p))

  return (
    <section class="panel no-print">
      <h2>Pop-up attack · {route[run.ip].name} to {tgt.name}</h2>
      <div class="pp-strip">
        <label class="field"><span>Dive</span>
          <select value={p.dive} onChange={(e) => set({ dive: Number((e.target as HTMLSelectElement).value) })}>
            {DIVES.map((d) => <option value={d}>{d}°</option>)}
          </select></label>
        <label class="field"><span>Dive speed (KTAS)</span>
          <input type="number" step="5" value={p.ktas} onInput={(e) => set({ ktas: num((e.target as HTMLInputElement).value) })} /></label>
        <label class="field"><span>Track (s)</span>
          <input type="number" step="0.5" value={p.track} onInput={(e) => set({ track: num((e.target as HTMLInputElement).value) })} /></label>
        <label class="field"><span>Release (ft)</span>
          <div class="pp-pair">
            <input type="number" step="50" value={p.rel} onInput={(e) => set({ rel: num((e.target as HTMLInputElement).value) })} />
            <select value={p.relRef} onChange={(e) => set({ relRef: (e.target as HTMLSelectElement).value as 'agl' | 'msl' })}>
              <option value="agl">AGL</option><option value="msl">MSL</option>
            </select>
          </div></label>
        <label class="field"><span>Pull-down (g)</span>
          <input type="number" step="0.5" value={p.g} onInput={(e) => set({ g: num((e.target as HTMLInputElement).value) })} /></label>
        <label class="field"><span>Ingress alt (ft MSL)</span>
          <input type="number" step="50" value={p.ingAlt ?? ''}
            placeholder={tgt.elevFt === undefined ? '' : String(Math.round(tgt.elevFt + DEFAULT_INGRESS_AGL))}
            onInput={(e) => set({ ingAlt: opt((e.target as HTMLInputElement).value) })} />
          <small>blank = {DEFAULT_INGRESS_AGL} ft above target</small></label>
        <label class="field"><span>Target elev (ft MSL)</span>
          <input type="number" step="10" value={tgt.elevFt ?? ''} placeholder="needed"
            onInput={(e) => onRoute(route.map((w, i) => (i === run.tgt ? { ...w, elevFt: opt((e.target as HTMLInputElement).value), elevSource: 'typed' as const } : w)))} />
          <small>{tgt.elevSource === 'dem' ? 'terrain lookup, ≈ DCS' : tgt.elevSource === 'dcs' ? 'from DCS export' : 'same as the TGT waypoint'}</small></label>
        <label class="field"><span>IP range (nm)</span>
          <input type="number" step="0.1" value={p.ipNm ?? ''} placeholder={run.ipNm.toFixed(1)}
            onInput={(e) => set({ ipNm: opt((e.target as HTMLInputElement).value) })} />
          <small>from route</small></label>
        <label class="field"><span>Ingress (KTAS)</span>
          <input type="number" step="5" value={p.ingressKt ?? ''} placeholder={String(run.tas)}
            onInput={(e) => set({ ingressKt: opt((e.target as HTMLInputElement).value) })} />
          <small>from route</small></label>
        <label class="field"><span>Ingress hdg (°M)</span>
          <input type="number" step="1" value={p.hdg ?? ''} placeholder={String(Math.round(run.magCourse) || 360)}
            onInput={(e) => set({ hdg: opt((e.target as HTMLInputElement).value) })} />
          <small>from route</small></label>
      </div>
      {problems.length > 0 && <p class="error">Enter {problems.join(', ')}.</p>}
      {attack && (
        <>
          {attack.warning && <p class="error">{attack.warning}</p>}
          <AttackCard attack={attack} />
          <AttackPicture attack={attack} />
          <p class="muted small">
            Nil wind. Action point {AP_NM} nm from the target; the pull-down assumes a steady pull from level at the dive speed.
            Ranges are ground distance to the target, pipper on target at release.
          </p>
        </>
      )}
    </section>
  )
}

export function AttackCard({ attack }: { attack: PopupResult }) {
  return (
    <ol class="pp-card">
      {attackCard(attack).map((step, i) => (
        <li key={step.title}>
          <div class="pp-ev"><span class="pp-n">{i + 1}</span>{step.title}</div>
          {step.rows.map((r) => (
            <div class={`pp-row${r.key ? ' key' : ''}`}><span>{r.label}</span><b>{r.value}</b></div>
          ))}
        </li>
      ))}
    </ol>
  )
}

export function AttackPicture({ attack }: { attack: PopupResult }) {
  const { svg, height } = popupPicture(attack)
  return <svg class="pp-pic" viewBox={`0 0 900 ${height}`} dangerouslySetInnerHTML={{ __html: svg }} />
}
