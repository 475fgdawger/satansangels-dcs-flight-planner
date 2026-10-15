// DCS map coordinates. Each theatre is a transverse Mercator grid on WGS84 (k0 0.9996) with its own central
// meridian and false origin; DCS x points north and y east, in metres. Parameters as published by pydcs
// (dcs/terrain/*/projection.py), checked against DCS airfield positions in test/dcsgrid.test.ts.

interface Grid { lon0: number; fe: number; fn: number }

const GRIDS: Record<string, Grid> = {
  Caucasus: { lon0: 33, fe: -99516.9999999732, fn: -4998114.999999984 },
  Syria: { lon0: 39, fe: 282801.00000003993, fn: -3879865.9999999935 },
  Nevada: { lon0: -117, fe: -193996.80999964548, fn: -4410028.063999966 },
  PersianGulf: { lon0: 57, fe: 75755.99999999645, fn: -2894933.0000000377 },
  MarianaIslands: { lon0: 147, fe: 238417.99999989968, fn: -1491840.000000048 },
  Normandy: { lon0: -3, fe: -195526.00000000204, fn: -5484812.999999951 },
  TheChannel: { lon0: 3, fe: 99376.00000000288, fn: -5636889.00000001 },
  Falklands: { lon0: -57, fe: 147639.99999997593, fn: 5815417.000000032 },
  SinaiMap: { lon0: 33, fe: 169221.9999999585, fn: -3325312.9999999693 },
  Kola: { lon0: 21, fe: -62702.00000000087, fn: -7543624.999999979 },
}

export const hasGrid = (theatre: string) => theatre in GRIDS

// Krüger series (as in proj's tmerc), WGS84.
const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996
const N = F / (2 - F)
const AA = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64)
const ALPHA = [
  N / 2 - (2 / 3) * N ** 2 + (5 / 16) * N ** 3,
  (13 / 48) * N ** 2 - (3 / 5) * N ** 3,
  (61 / 240) * N ** 3,
]
const BETA = [
  N / 2 - (2 / 3) * N ** 2 + (37 / 96) * N ** 3,
  (1 / 48) * N ** 2 + (1 / 15) * N ** 3,
  (17 / 480) * N ** 3,
]
const DELTA = [
  2 * N - (2 / 3) * N ** 2 - 2 * N ** 3,
  (7 / 3) * N ** 2 - (8 / 5) * N ** 3,
  (56 / 15) * N ** 3,
]
const RAD = Math.PI / 180
const E2 = 2 * Math.sqrt(N) / (1 + N)

function grid(theatre: string): Grid {
  const g = GRIDS[theatre]
  if (!g) throw new Error(`No DCS map grid for theatre ${theatre}`)
  return g
}

/** DCS map position (x north, y east, metres) of a lat/lon on this theatre. */
export function toDcs(theatre: string, lat: number, lon: number): { x: number; y: number } {
  const g = grid(theatre)
  const phi = lat * RAD, lam = (lon - g.lon0) * RAD
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - E2 * Math.atanh(E2 * Math.sin(phi)))
  const xi0 = Math.atan2(t, Math.cos(lam))
  const eta0 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t))
  let xi = xi0, eta = eta0
  ALPHA.forEach((a, j) => {
    const k = 2 * (j + 1)
    xi += a * Math.sin(k * xi0) * Math.cosh(k * eta0)
    eta += a * Math.cos(k * xi0) * Math.sinh(k * eta0)
  })
  return { x: K0 * AA * xi + g.fn, y: K0 * AA * eta + g.fe }
}

/** Lat/lon of a DCS map position on this theatre. */
export function fromDcs(theatre: string, x: number, y: number): { lat: number; lon: number } {
  const g = grid(theatre)
  const xi = (x - g.fn) / (K0 * AA), eta = (y - g.fe) / (K0 * AA)
  let xi0 = xi, eta0 = eta
  BETA.forEach((b, j) => {
    const k = 2 * (j + 1)
    xi0 -= b * Math.sin(k * xi) * Math.cosh(k * eta)
    eta0 -= b * Math.cos(k * xi) * Math.sinh(k * eta)
  })
  const chi = Math.asin(Math.sin(xi0) / Math.cosh(eta0))
  let phi = chi
  DELTA.forEach((d, j) => { phi += d * Math.sin(2 * (j + 1) * chi) })
  return { lat: phi / RAD, lon: g.lon0 + Math.atan2(Math.sinh(eta0), Math.cos(xi0)) / RAD }
}
