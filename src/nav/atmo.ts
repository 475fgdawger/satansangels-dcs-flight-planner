// Standard atmosphere and airspeed conversions: KCAS <-> Mach <-> KTAS at a pressure altitude.
// The performance data treats DCS IAS as calibrated airspeed (standard pitot formulas, Rayleigh above Mach 1),
// the same way the performance manual does.

/** Speed of sound at sea level, standard day, kt. */
export const A0_KT = 661.47
const T0_K = 288.15
const TROPOPAUSE_FT = 36089

/** ISA temperature at a pressure altitude, K. */
export function isaTempK(altFt: number): number {
  return altFt < TROPOPAUSE_FT ? T0_K - 0.0019812 * altFt : 216.65
}

/** Static pressure ratio p/p0 at a pressure altitude. */
export function pressureRatio(altFt: number): number {
  if (altFt < TROPOPAUSE_FT) return Math.pow(isaTempK(altFt) / T0_K, 5.25588)
  return 0.22336 * Math.exp(-(altFt - TROPOPAUSE_FT) / 20806)
}

/** Speed of sound, kt, at a pressure altitude and ISA deviation (°C). */
export function speedOfSoundKt(altFt: number, isaDev = 0): number {
  return A0_KT * Math.sqrt((isaTempK(altFt) + isaDev) / T0_K)
}

/** Pitot impact pressure over static pressure at a Mach number (Rayleigh formula above Mach 1). */
function qcOverP(mach: number): number {
  if (mach <= 1) return Math.pow(1 + 0.2 * mach * mach, 3.5) - 1
  return (166.921585 * Math.pow(mach, 7)) / Math.pow(7 * mach * mach - 1, 2.5) - 1
}

/** The Mach number giving an impact pressure ratio (inverse of qcOverP). */
function machFromQcp(qcp: number): number {
  if (qcp <= Math.pow(1.2, 3.5) - 1) return Math.sqrt(5 * (Math.pow(qcp + 1, 2 / 7) - 1))
  let lo = 1, hi = 5
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (qcOverP(mid) < qcp) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export function machFromKcas(kcas: number, altFt: number): number {
  return machFromQcp(qcOverP(kcas / A0_KT) / pressureRatio(altFt))
}

export function kcasFromMach(mach: number, altFt: number): number {
  return A0_KT * machFromQcp(qcOverP(mach) * pressureRatio(altFt))
}

export function ktasFromMach(mach: number, altFt: number, isaDev = 0): number {
  return mach * speedOfSoundKt(altFt, isaDev)
}
