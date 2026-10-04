// Visual pop-up attack geometry, ported from Patrick's F-4E Pop-Up Planner.
// Nil wind. Target at the origin; x runs toward the target along the IP line,
// y is right of track. Distances in feet unless the name says nm.

export const KT_FPS = 1.68781
export const FT_NM = 6076.12
/** Action point range from the target, nm. */
export const AP_NM = 4
/** Seconds from action turn rollout to pull-up. */
export const PU_DELAY = 4
const G0 = 32.174
/** Default ingress height above the target, ft. */
export const DEFAULT_INGRESS_AGL = 500
export const DIVES = [5, 10, 20, 30, 40, 45, 50, 60] as const

/**
 * Pop-up inputs the crew types in. IP range, ingress speed and heading come from the route
 * unless overridden; target elevation is the TGT waypoint's elevation.
 */
export interface PopupSettings {
  dive: number
  /** Dive speed, KTAS. */
  ktas: number
  /** Tracking time, seconds. */
  track: number
  /** Release altitude, ft, AGL or MSL per relRef. */
  rel: number
  relRef: 'agl' | 'msl'
  /** Pull-down load factor, g. */
  g: number
  /** Ingress altitude, ft MSL; unset = 500 ft above the target. */
  ingAlt?: number
  ipNm?: number
  ingressKt?: number
  hdg?: number
}

export const defaultPopup = (): PopupSettings => ({
  dive: 20, ktas: 450, track: 5, rel: 3000, relRef: 'agl', g: 4,
})

export interface PopupInputs {
  dive: number
  ktas: number
  track: number
  tgtElev: number
  /** Release altitude above the target, ft. */
  relAgl: number
  g: number
  ipNm: number
  ingressKt: number
  /** Ingress heading (magnetic), degrees. */
  hdg: number
  ingAlt: number
}

export interface Pt { x: number; y: number }

export interface PopupResult {
  inputs: PopupInputs
  legNm: number
  legSec: number
  /** Action turn headings, 3-digit strings. */
  actionLeft: string
  actionRight: string
  climb: number
  pullUpFt: number
  riAgl: number
  riRng: number
  /** Turn at roll-in toward the target, degrees. */
  turnAtRollIn: number
  pullDownLoss: number
  wlAgl: number
  wlRng: number
  attackLeft: string
  attackRight: string
  /** Dive speed, ft/s, and its vertical and horizontal parts. */
  V: number
  vv: number
  trackAlt: number
  trackGnd: number
  relRng: number
  /** Pull-down arc radius, ft. */
  R: number
  ingAgl: number
  AP: Pt
  PU: Pt
  RI: Pt
  /** Unit vector roll-in to target. */
  bx: number
  by: number
  warning: string | null
}

export const hdg3 = (h: number) => {
  const r = Math.round(((h % 360) + 360) % 360)
  return String(r === 0 ? 360 : r).padStart(3, '0')
}

/** Returns what is missing or wrong, or an empty list. */
export function popupProblems(p: PopupInputs): string[] {
  const bad: string[] = []
  if (!(DIVES as readonly number[]).includes(p.dive)) bad.push('a dive angle from the list')
  if (!(p.ktas > 0)) bad.push('a dive airspeed above 0 KTAS')
  if (!(p.track >= 0)) bad.push('a tracking time of 0 s or more')
  if (!Number.isFinite(p.tgtElev)) bad.push('an elevation on the TGT waypoint')
  if (!(p.g > 1)) bad.push('a pull-down load factor above 1 g')
  if (!(p.ipNm >= AP_NM)) bad.push(`an IP at least ${AP_NM} nm from the target`)
  if (!(p.ingressKt > 0)) bad.push('an ingress airspeed above 0 KTAS')
  if (!(p.hdg >= 0 && p.hdg <= 360)) bad.push('an ingress heading from 1 to 360°')
  if (!Number.isFinite(p.ingAlt)) bad.push('an ingress altitude')
  if (!bad.length && !(p.relAgl > 0)) bad.push('a release altitude above the target')
  return bad
}

export function popupAttack(p: PopupInputs): PopupResult | null {
  if (popupProblems(p).length) return null
  const th = (p.dive * Math.PI) / 180
  const V = p.ktas * KT_FPS
  const vv = V * Math.sin(th)
  const hv = V * Math.cos(th)
  const trackAlt = vv * p.track
  const trackGnd = hv * p.track
  const relRng = p.relAgl / Math.tan(th)
  const wlAgl = p.relAgl + trackAlt
  const wlRng = relRng + trackGnd
  // Pull-down: constant-radius arc from level to the dive angle, R = V²/(n·g).
  const R = (V * V) / (p.g * G0)
  const pullDownLoss = R * (1 - Math.cos(th))
  const pdGnd = R * Math.sin(th)
  const riAgl = wlAgl + pullDownLoss
  const ingAgl = p.ingAlt - p.tgtElev

  // Climb angle: dive + 5 for shallow dives, dive + 10 otherwise.
  const climb = p.dive <= 10 ? p.dive + 5 : p.dive + 10
  const cl = (climb * Math.PI) / 180
  const pullUpFt = p.ingressKt * KT_FPS * PU_DELAY
  const climbGnd = Math.max(riAgl - ingAgl, 0) / Math.tan(cl)
  const AP = { x: -AP_NM * FT_NM, y: 0 }
  // The action turn offsets the track by the dive angle (action right shown).
  const ux = Math.cos(th)
  const uy = Math.sin(th)
  const PU = { x: AP.x + pullUpFt * ux, y: AP.y + pullUpFt * uy }
  const RI = { x: PU.x + climbGnd * ux, y: PU.y + climbGnd * uy }
  const riRng = Math.hypot(RI.x, RI.y)
  const bx = -RI.x / riRng
  const by = -RI.y / riRng
  const attackOff = (Math.atan2(by, bx) * 180) / Math.PI
  const need = wlRng + pdGnd
  const legNm = p.ipNm - AP_NM
  const legSec = (legNm / p.ingressKt) * 3600

  let warning: string | null = null
  if (ingAgl < 0) {
    warning = `Ingress altitude is ${f(-ingAgl)} ft below the target elevation. Raise the ingress altitude.`
  } else if (riRng < need) {
    warning = `Roll-in comes ${(riRng / FT_NM).toFixed(2)} nm from the target, but the pull-down and tracking need ${(need / FT_NM).toFixed(2)} nm. Move the Action Point out or lower the roll-in.`
  } else if (riAgl <= ingAgl) {
    warning = 'Roll-in altitude is below the ingress altitude, so there is no climb. Check the release altitude and ingress altitude.'
  }

  return {
    inputs: p, legNm, legSec,
    actionLeft: hdg3(p.hdg - p.dive), actionRight: hdg3(p.hdg + p.dive),
    climb, pullUpFt, riAgl, riRng, turnAtRollIn: Math.abs(attackOff - p.dive), pullDownLoss, wlAgl, wlRng,
    attackLeft: hdg3(p.hdg - attackOff), attackRight: hdg3(p.hdg + attackOff),
    V, vv, trackAlt, trackGnd, relRng, R, ingAgl, AP, PU, RI, bx, by, warning,
  }
}

export interface CardStep {
  title: string
  rows: { label: string; value: string; key?: boolean }[]
}

const mmss = (sec: number) => {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The attack card in flying order, as plain text for the app and the kneeboard. */
export function attackCard(d: PopupResult): CardStep[] {
  const p = d.inputs
  const nm = (ft: number) => `${(ft / FT_NM).toFixed(2)} nm`
  return [
    { title: 'IP', rows: [
      { label: 'Range to target', value: `${p.ipNm.toFixed(1)} nm` },
      { label: 'Ingress', value: `${f(p.ingressKt)} KTAS · ${f(p.ingAlt)} MSL` },
      { label: 'Heading', value: `${hdg3(p.hdg)}°`, key: true },
    ] },
    { title: 'IP to Action Point', rows: [
      { label: 'Distance', value: `${d.legNm.toFixed(1)} nm` },
      { label: 'Time', value: `${mmss(d.legSec)} (${Math.round(d.legSec)} s)`, key: true },
    ] },
    { title: 'Action Point', rows: [
      { label: 'Range to target', value: `${AP_NM.toFixed(1)} nm` },
      { label: 'Action turn', value: `${p.dive}° off target line` },
      { label: 'Action left / right', value: `L ${d.actionLeft}° · R ${d.actionRight}°`, key: true },
    ] },
    { title: 'Pull-up', rows: [
      { label: 'After rollout', value: `${PU_DELAY} s · ${f(d.pullUpFt)} ft` },
      { label: 'Climb angle', value: `${d.climb}° nose up`, key: true },
    ] },
    { title: 'Roll-in', rows: [
      { label: 'Altitude', value: `${r10(p.tgtElev + d.riAgl)} MSL · ${r10(d.riAgl)} AGL`, key: true },
      { label: 'Range to target', value: nm(d.riRng) },
      { label: 'Turn to attack hdg', value: `${f(d.turnAtRollIn)}° toward target` },
      { label: 'Lost in pull-down', value: `${f(d.pullDownLoss)} ft` },
    ] },
    { title: 'Wings level', rows: [
      { label: 'Altitude', value: `${f(p.tgtElev + d.wlAgl)} MSL · ${f(d.wlAgl)} AGL` },
      { label: 'Range to target', value: nm(d.wlRng) },
      { label: 'Attack heading', value: `L ${d.attackLeft}° · R ${d.attackRight}°`, key: true },
    ] },
    { title: 'Tracking', rows: [
      { label: 'Time', value: `${f(p.track, 1).replace(/\.0$/, '')} s` },
      { label: 'Dive speed', value: `${f(p.ktas)} KTAS · ${f(d.V)} ft/s` },
      { label: 'Descent rate', value: `${f(Math.round((d.vv * 60) / 100) * 100)} fpm` },
      { label: 'Altitude lost', value: `${f(d.trackAlt)} ft` },
      { label: 'Ground covered', value: nm(d.trackGnd) },
    ] },
    { title: 'Release', rows: [
      { label: 'Altitude', value: `${f(p.tgtElev + p.relAgl)} MSL · ${f(p.relAgl)} AGL`, key: true },
      { label: 'Range to target', value: nm(d.relRng) },
    ] },
    { title: 'Target', rows: [
      { label: 'Elevation', value: `${f(p.tgtElev)} MSL` },
      { label: 'Dive angle', value: `${p.dive}°` },
    ] },
  ]
}

const f = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
const r10 = (n: number) => f(Math.round(n / 10) * 10)

function T(x: number, y: number, txt: string, cls = '', anchor = 'start') {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}" text-anchor="${anchor}">${txt}</text>`
}
const P = (x: number, y: number) => x.toFixed(1) + ',' + y.toFixed(1)

/** Plan view and side profile, both to scale, as SVG markup (900 wide). Styled by the pp-* CSS classes. */
export function popupPicture(d: PopupResult): { svg: string; height: number } {
  const o: string[] = []
  const W = 900
  const L = 50
  const Rt = 850
  const th = (d.inputs.dive * Math.PI) / 180
  const hdg = hdg3(d.inputs.hdg)

  // Plan view: AP to target in full; the IP leg runs in from the left edge.
  const WL = { x: -d.bx * d.wlRng, y: -d.by * d.wlRng }
  const REL = { x: -d.bx * d.relRng, y: -d.by * d.relRng }
  const xs = [d.AP.x, d.PU.x, d.RI.x, WL.x, REL.x, 0]
  const ys = [0, d.PU.y, d.RI.y, WL.y, REL.y].map(Math.abs)
  const minX = Math.min(...xs)
  const maxX = 0
  const maxY = Math.max(...ys, 1)
  const planTop = 44
  const planH = 190
  const mid = planTop + planH / 2 + 6
  const k1 = Math.min((Rt - (L + 180)) / (maxX - minX), (planH / 2 - 34) / maxY)
  const px = (x: number) => Rt - (maxX - x) * k1
  const py = (y: number) => mid + y * k1
  const mirror = (y: number) => py(0) - (py(y) - py(0))
  o.push(T(20, 28, 'PLAN VIEW', 'hd'), T(W - 20, 28, 'action right shown, left is the mirror image', 'dim', 'end'))
  for (let n = 1; n * FT_NM <= -minX + 1; n++) {
    const x = px(-n * FT_NM)
    o.push(`<line class="grid" x1="${x.toFixed(1)}" y1="${py(0) - 5}" x2="${x.toFixed(1)}" y2="${py(0) + 5}"/>`)
  }
  o.push(`<line class="path" x1="${L}" y1="${py(0)}" x2="${px(d.AP.x).toFixed(1)}" y2="${py(0)}"/>`)
  o.push(T(L, py(0) - 12, '◂ IP ' + f(d.inputs.ipNm, 1) + ' nm', 'lbl'), T(L, py(0) + 22, 'hdg ' + hdg + '°', 'dim'))
  o.push(`<line class="dash" x1="${px(d.AP.x).toFixed(1)}" y1="${py(0)}" x2="${px(0)}" y2="${py(0)}"/>`)
  o.push(`<polyline class="ghost" points="${P(px(d.AP.x), py(0))} ${P(px(d.PU.x), mirror(d.PU.y))} ${P(px(d.RI.x), mirror(d.RI.y))} ${P(px(0), py(0))}"/>`)
  o.push(`<polyline class="path" points="${P(px(d.AP.x), py(0))} ${P(px(d.PU.x), py(d.PU.y))} ${P(px(d.RI.x), py(d.RI.y))}"/>`)
  o.push(`<line class="path" x1="${px(d.RI.x).toFixed(1)}" y1="${py(d.RI.y).toFixed(1)}" x2="${px(REL.x).toFixed(1)}" y2="${py(REL.y).toFixed(1)}"/>`)
  o.push(`<line class="dash" x1="${px(REL.x).toFixed(1)}" y1="${py(REL.y).toFixed(1)}" x2="${px(0)}" y2="${py(0)}"/>`)
  const dot = (x: number, y: number, acc: boolean, r = 5) =>
    `<circle class="pt${acc ? ' acc' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`
  o.push(dot(px(d.AP.x), py(0), false), dot(px(d.PU.x), py(d.PU.y), true), dot(px(d.RI.x), py(d.RI.y), true),
    dot(px(WL.x), py(WL.y), false, 4), dot(px(REL.x), py(REL.y), true))
  o.push(`<rect class="tgt" x="${(px(0) - 7).toFixed(1)}" y="${(py(0) - 7).toFixed(1)}" width="14" height="14"/>`)
  o.push(T(px(d.AP.x), py(0) - 12, `AP ${AP_NM} nm`, 'lbl', 'middle'),
    T(px(d.AP.x), py(0) - 28, 'R ' + d.actionRight + '° · L ' + d.actionLeft + '°', 'acc', 'middle'),
    T((L + px(d.AP.x)) / 2 + 40, py(0) + 22, f(d.legNm, 1) + ' nm · ' + Math.round(d.legSec) + ' s', 'acc', 'middle'))
  o.push(T(px(d.PU.x), py(d.PU.y) + 22, 'PULL-UP', 'lbl', 'middle'))
  o.push(T(px(d.RI.x), py(d.RI.y) + 22, 'ROLL-IN ' + f(d.riRng / FT_NM, 1) + ' nm', 'lbl', 'middle'))
  o.push(T(px(REL.x), py(REL.y) + 22, 'REL ' + f(d.relRng / FT_NM, 1) + ' nm', 'acc', 'middle'))
  o.push(T(px(0) + 2, py(0) - 14, 'TGT', 'lbl', 'middle'))
  o.push(T(px(d.RI.x), py(d.RI.y) + 38, 'attack R ' + d.attackRight + '° · L ' + d.attackLeft + '°', 'dim', 'middle'))
  o.push(`<line class="sep" x1="0" y1="${planTop + planH + 22}" x2="${W}" y2="${planTop + planH + 22}"/>`)

  // Side profile: range from target vs height above target, same scale both axes.
  const top = planTop + planH + 38
  o.push(T(20, top + 14, 'SIDE PROFILE', 'hd'), T(W - 20, top + 14, 'range from target vs height, same scale both axes', 'dim', 'end'))
  const profH = 230
  const G = top + 40 + profH
  const puRng = Math.hypot(d.PU.x, d.PU.y)
  const apRng = AP_NM * FT_NM
  const riR = d.wlRng + d.R * Math.sin(th)
  const maxR = Math.max(apRng, puRng, d.riRng, riR, d.relRng)
  const maxA = Math.max(d.riAgl, d.ingAgl, 1)
  const k2 = Math.min((Rt - L - 40) / maxR, profH / maxA)
  const sx = (r: number) => Rt - r * k2
  const sy = (a: number) => G - Math.max(a, 0) * k2
  o.push(`<line class="gnd" x1="${L - 30}" y1="${G}" x2="${Rt + 30}" y2="${G}"/>`)
  for (let n = 0; n * FT_NM <= maxR + 1; n++) {
    const x = sx(n * FT_NM)
    o.push(`<line class="grid" x1="${x.toFixed(1)}" y1="${G}" x2="${x.toFixed(1)}" y2="${G + 6}"/>`, T(x, G + 20, n + ' nm', 'dim', 'middle'))
  }
  const arc: string[] = []
  for (let i = 0; i <= 16; i++) {
    const a = (th * i) / 16
    arc.push(P(sx(riR - d.R * Math.sin(a)), sy(d.riAgl - d.R * (1 - Math.cos(a)))))
  }
  const rel = d.inputs.relAgl
  const tgt = d.inputs.tgtElev
  o.push(`<polyline class="path" points="${P(sx(apRng), sy(d.ingAgl))} ${P(sx(puRng), sy(d.ingAgl))} ${P(sx(d.riRng), sy(d.riAgl))} ${arc.join(' ')} ${P(sx(d.relRng), sy(rel))}"/>`)
  o.push(`<line class="dash" x1="${sx(d.relRng).toFixed(1)}" y1="${sy(rel).toFixed(1)}" x2="${sx(0)}" y2="${G}"/>`)
  o.push(dot(sx(apRng), sy(d.ingAgl), false), dot(sx(puRng), sy(d.ingAgl), true), dot(sx(d.riRng), sy(d.riAgl), true),
    dot(sx(d.wlRng), sy(d.wlAgl), false, 4), dot(sx(d.relRng), sy(rel), true))
  o.push(`<rect class="tgt" x="${sx(0) - 7}" y="${G - 14}" width="14" height="14"/>`)
  const lblY = (a: number) => Math.max(sy(a) - 10, top + 34)
  o.push(T(sx(apRng), G + 38, 'AP', 'lbl', 'middle'))
  o.push(T(sx(puRng) - 4, sy(d.ingAgl) - 30, 'climb ' + d.climb + '°', 'acc', 'end'))
  o.push(T(sx(puRng) - 4, sy(d.ingAgl) - 12, 'PULL-UP', 'lbl', 'end'))
  o.push(T(sx(d.riRng) - 10, lblY(d.riAgl) - 14, 'ROLL-IN', 'lbl', 'end'),
    T(sx(d.riRng) - 10, lblY(d.riAgl) + 2, r10(tgt + d.riAgl) + ' MSL', 'acc', 'end'))
  const tw = 'WINGS LEVEL ' + r10(tgt + d.wlAgl) + ' MSL'
  const tr = 'RELEASE ' + r10(tgt + rel) + ' MSL · dive ' + d.inputs.dive + '°'
  const place = (x: number, txt: string): [number, string] => (x + 14 + txt.length * 7.9 > W - 8 ? [x - 14, 'end'] : [x + 14, 'start'])
  const yw = sy(d.wlAgl) - 4
  const yr = Math.max(sy(rel) + 4, yw + 20)
  const [xw, aw] = place(sx(d.wlRng), tw)
  const [xr, ar] = place(sx(d.relRng), tr)
  o.push(T(xw, yw, tw, 'dim', aw), T(xr, yr, tr, 'acc', ar))
  o.push(T(sx(0), G + 38, 'TGT ' + f(tgt) + ' MSL', 'lbl', 'end'))
  return { svg: o.join(''), height: G + 50 }
}
