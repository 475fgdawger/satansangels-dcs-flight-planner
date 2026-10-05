// Share links: the route and settings packed into the URL hash (#plan=...), so a flight member who opens
// the link gets the same plan. The mission data itself is not in the link; it names the mission, and the
// site loads it from the missions the bot has pushed.

import type { PlanSettings, Waypoint } from './plan'

export const SHARE_KEY = 'plan'

export interface SharedPlan {
  v: 1
  mission: { name: string; theatre: string }
  route: Waypoint[]
  settings: PlanSettings
}

const toB64url = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromB64url = (text: string) => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

/** The plan as a compact URL-safe string. */
export async function encodePlan(plan: SharedPlan): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(plan))
  return toB64url(await pipe(json, new CompressionStream('deflate-raw')))
}

/** Reads a plan back; null when the text isn't a plan this version understands. */
export async function decodePlan(text: string): Promise<SharedPlan | null> {
  try {
    const json = await pipe(fromB64url(text), new DecompressionStream('deflate-raw'))
    const p = JSON.parse(new TextDecoder().decode(json)) as SharedPlan
    if (p?.v !== 1 || !p.mission?.name || !Array.isArray(p.route) || !p.settings?.aircraft) return null
    return p
  } catch {
    return null
  }
}

/** The encoded plan in a location hash like "#plan=...", or null. */
export function planFromHash(hash: string): string | null {
  const m = /^#?(?:.*&)?plan=([A-Za-z0-9_-]+)/.exec(hash)
  return m ? m[1] : null
}
