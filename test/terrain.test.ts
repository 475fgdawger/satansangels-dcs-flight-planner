import { describe, expect, it } from 'vitest'
import { CONTOUR, contourInterval, decodeTerrain, heightAt, INDEX_CONTOUR, maxElevationNear, shadeTerrain, SHORE, terrainFile, tint,
  WATER, type TerrainMeta } from '../src/nav/terrain'

const meta: TerrainMeta = { schema: 1, north: 37, west: 36, step: 0.01, rows: 3, cols: 3 }
/** RGBA as a canvas reads the bot's PNG: R * 256 + G - 32768 metres. */
const rgba = (hs: number[]) => Uint8ClampedArray.from(hs.flatMap((h) => [(h + 32768) >> 8, (h + 32768) & 255, 0, 255]))

describe('terrain grid', () => {
  const g = decodeTerrain(meta, rgba([0, 100, 200, 100, 200, 300, -50, 1000, 4000]))

  it('decodes heights, including below sea level', () => {
    expect(Array.from(g.h)).toEqual([0, 100, 200, 100, 200, 300, -50, 1000, 4000])
  })

  it('interpolates between samples and is NaN off the grid', () => {
    expect(heightAt(g, 37, 36)).toBe(0)
    expect(heightAt(g, 36.99, 36.01)).toBeCloseTo(200, 6)
    expect(heightAt(g, 36.995, 36.005)).toBeCloseTo(100, 6)
    expect(heightAt(g, 36.98, 36.02)).toBeCloseTo(4000, 6)
    expect(heightAt(g, 37.001, 36)).toBeNaN()
    expect(heightAt(g, 36.99, 36.03)).toBeNaN()
  })

  it('finds the highest ground near a leg, in feet', () => {
    // A leg along the north edge; the 4,000 m sample is 1.2 nm south of its east end. Samples fall
    // between grid points, so the figure is close to it rather than exact.
    const near = maxElevationNear(g, { lat: 37, lon: 36 }, { lat: 37, lon: 36.02 }, 1.5)!
    expect(near).toBeGreaterThan(2500 * 3.28084)
    expect(near).toBeLessThanOrEqual(Math.round(4000 * 3.28084))
    expect(maxElevationNear(g, { lat: 37, lon: 36 }, { lat: 37, lon: 36.01 }, 0.3)).toBeLessThan(1500)
    expect(maxElevationNear(g, { lat: 10, lon: 10 }, { lat: 10.1, lon: 10 }, 1)).toBeNull()
  })

  it('picks a contour interval for about ten contours', () => {
    expect(contourInterval(0, 900)).toBe(100)
    expect(contourInterval(500, 4000)).toBe(500)
    expect(contourInterval(0, 12000)).toBe(1000)
  })

  it('names the file after the theatre the way the bot does', () => {
    expect(terrainFile('Syria')).toBe('syria')
    expect(terrainFile('Marianas WWII')).toBe('marianas_wwii')
  })
})

describe('terrain shading', () => {
  // 21 x 21 grid: sea in the west third, a slope rising east, 0.01 degree cells.
  const n = 21
  const hs = Array.from({ length: n * n }, (_, i) => (i % n < 7 ? -10 : ((i % n) - 6) * 100))
  const g = decodeTerrain({ ...meta, rows: n, cols: n }, rgba(hs))
  const W = 40, H = 40
  // North-up page over the grid, 0.5 cell per pixel.
  const ll = (x: number, y: number) => ({ lat: 37 - (y / H) * 0.2, lon: 36 + (x / W) * 0.2 })
  const s = shadeTerrain(g, ll, W, H, (0.2 * 60 * Math.cos((37 * Math.PI) / 180)) / W, 0)
  const px = (x: number, y: number) => Array.from(s.pixels.slice((y * W + x) * 4, (y * W + x) * 4 + 3))

  it('colours the sea blue and draws the coastline', () => {
    expect(px(2, 20)).toEqual([...WATER])
    const row = Array.from({ length: W }, (_, x) => px(x, 20).join())
    expect(row.slice(10, 16)).toContain(SHORE.join())
  })

  it('tints low ground green and high ground brown, shaded by the slope', () => {
    const isContour = (c: number[]) => c.join() === CONTOUR.join() || c.join() === INDEX_CONTOUR.join()
    const low = [15, 16, 17, 18].map((x) => px(x, 20)).filter((c) => !isContour(c))
    expect(low.length).toBeGreaterThan(0)
    for (const [r, g2, b] of low) { expect(g2).toBeGreaterThan(r); expect(g2).toBeGreaterThan(b) }
    const [r2, g3] = px(38, 20)
    expect(r2).toBeGreaterThan(g3)
    // Rising to the east, so the ground faces west: it catches the north-west light, but not head on.
    expect(px(30, 20)[0]).toBeLessThan(255)
  })

  it('reports the contour interval and draws brown contours across the slope', () => {
    expect(s.contourFt).toBeGreaterThanOrEqual(500)
    const row = Array.from({ length: W }, (_, x) => px(x, 30).join())
    expect(row.filter((v) => v === CONTOUR.join() || v === INDEX_CONTOUR.join()).length).toBeGreaterThan(2)
  })
})

describe('elevation tints', () => {
  it('runs from green at sea level to brown on high ground', () => {
    const [r0, g0] = tint(0)
    expect(g0).toBeGreaterThan(r0)
    const [r1, g1, b1] = tint(12000)
    expect(r1).toBeGreaterThan(g1)
    expect(g1).toBeGreaterThan(b1)
    expect(tint(500)[1]).toBeGreaterThan(tint(0)[1] - 1)
    expect(tint(99999)).toEqual(tint(15000))
  })
})
