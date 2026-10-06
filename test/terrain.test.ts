import { describe, expect, it } from 'vitest'
import { contourInterval, decodeTerrain, heightAt, maxElevationNear, shadeTerrain, terrainFile, type TerrainMeta } from '../src/nav/terrain'

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
  const grey = (x: number, y: number) => s.pixels[(y * W + x) * 4]

  it('leaves the sea white and draws the coastline', () => {
    expect(grey(2, 20)).toBe(255)
    const row = Array.from({ length: W }, (_, x) => grey(x, 20))
    expect(row.slice(10, 16).some((v) => v <= 100)).toBe(true)
  })

  it('shades a slope facing away from the north-west light darker than flat ground would be', () => {
    // Rising to the east, so the ground faces west: it catches the north-west light, but not head on.
    const land = grey(30, 20)
    expect(land).toBeLessThan(255)
    expect(land).toBeGreaterThan(120)
  })

  it('reports the contour interval and draws contours across the slope', () => {
    expect(s.contourFt).toBeGreaterThanOrEqual(500)
    const row = Array.from({ length: W }, (_, x) => grey(x, 30))
    expect(row.filter((v) => v === 150 || v === 95).length).toBeGreaterThan(2)
  })
})
