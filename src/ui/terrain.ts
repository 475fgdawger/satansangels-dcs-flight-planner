// Browser side of the terrain grid: fetch and decode the theatre's PNG, and turn shading into an image.

import { decodeTerrain, terrainFile, type Shading, type TerrainGrid, type TerrainMeta } from '../nav/terrain'

/** The theatre's terrain grid from the site, or null when the bot hasn't pushed one. */
export async function loadTerrain(theatre: string): Promise<TerrainGrid | null> {
  const base = `./data/terrain/${terrainFile(theatre)}`
  const res = await fetch(`${base}.json`)
  if (!res.ok) return null
  const meta = (await res.json()) as TerrainMeta
  const img = new Image()
  img.src = `${base}.png`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = meta.cols
  canvas.height = meta.rows
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })!
  ctx.drawImage(img, 0, 0)
  return decodeTerrain(meta, ctx.getImageData(0, 0, meta.cols, meta.rows).data)
}

/** Shading as a PNG data URL, for an SVG <image>. */
export function shadingImage(s: Shading, width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(s.pixels), width, height), 0, 0)
  return canvas.toDataURL('image/png')
}
