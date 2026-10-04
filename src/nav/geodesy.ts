// WGS84 ellipsoid geodesics (Vincenty). The bot computes its TACAN fixes on the
// ellipsoid; a spherical great circle is off by 1 degree or 1 nm on many targets.

const A = 6378137.0
const F = 1 / 298.257223563
const B = A * (1 - F)
const M_PER_NM = 1852

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI
export const norm360 = (d: number) => ((d % 360) + 360) % 360

/** Initial true azimuth (deg) and distance (nm) from point 1 to point 2. */
export function inverse(lat1: number, lon1: number, lat2: number, lon2: number): { az: number; nm: number } {
  if (lat1 === lat2 && lon1 === lon2) return { az: 0, nm: 0 }
  const L = rad(lon2 - lon1)
  const U1 = Math.atan((1 - F) * Math.tan(rad(lat1)))
  const U2 = Math.atan((1 - F) * Math.tan(rad(lat2)))
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1)
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2)

  let lambda = L
  let sinSigma = 0, cosSigma = 0, sigma = 0, cos2Alpha = 0, cos2SigmaM = 0
  for (let i = 0; i < 200; i++) {
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda)
    sinSigma = Math.hypot(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL)
    if (sinSigma === 0) return { az: 0, nm: 0 }
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma
    cos2Alpha = 1 - sinAlpha * sinAlpha
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha))
    const prev = lambda
    lambda = L + (1 - C) * F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
    if (Math.abs(lambda - prev) < 1e-12) break
  }
  const u2 = (cos2Alpha * (A * A - B * B)) / (B * B)
  const bigA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
  const bigB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
  const deltaSigma = bigB * sinSigma * (cos2SigmaM + (bigB / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
    (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
  const meters = B * bigA * (sigma - deltaSigma)
  const az = Math.atan2(cosU2 * Math.sin(lambda), cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lambda))
  return { az: norm360(deg(az)), nm: meters / M_PER_NM }
}

/** Point reached from (lat, lon) along true azimuth az (deg) for nm nautical miles. */
export function direct(lat: number, lon: number, az: number, nm: number): { lat: number; lon: number } {
  const s = nm * M_PER_NM
  const alpha1 = rad(az)
  const sinAlpha1 = Math.sin(alpha1), cosAlpha1 = Math.cos(alpha1)
  const tanU1 = (1 - F) * Math.tan(rad(lat))
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1
  const sigma1 = Math.atan2(tanU1, cosAlpha1)
  const sinAlpha = cosU1 * sinAlpha1
  const cos2Alpha = 1 - sinAlpha * sinAlpha
  const u2 = (cos2Alpha * (A * A - B * B)) / (B * B)
  const bigA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
  const bigB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))

  let sigma = s / (B * bigA)
  let cos2SigmaM = 0, sinSigma = 0, cosSigma = 0
  for (let i = 0; i < 200; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma)
    sinSigma = Math.sin(sigma)
    cosSigma = Math.cos(sigma)
    const deltaSigma = bigB * sinSigma * (cos2SigmaM + (bigB / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
      (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
    const prev = sigma
    sigma = s / (B * bigA) + deltaSigma
    if (Math.abs(sigma - prev) < 1e-12) break
  }
  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1
  const lat2 = Math.atan2(sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - F) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp))
  const lambda = Math.atan2(sinSigma * sinAlpha1, cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1)
  const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha))
  const L = lambda - (1 - C) * F * sinAlpha *
    (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
  return { lat: deg(lat2), lon: deg(rad(lon) + L) }
}
