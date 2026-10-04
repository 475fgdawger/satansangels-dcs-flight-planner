// Squadron radio presets and extra beacons per theatre (from the mission-editor
// labels and FREQUENCIES.txt). The export's airbase frequencies are DCS defaults,
// not the squadron's presets, so the nav log uses these instead.

export interface Comm {
  name: string
  freq: string
  note?: string
}

export const COMMON_COMMS: Comm[] = [
  { name: 'Tower', freq: '236.6' },
  { name: 'Squadron', freq: '265.435' },
  { name: 'ARCO (tanker)', freq: '272.4', note: 'TACAN 1X ARC' },
  { name: 'SHELL (tanker)', freq: '272.5', note: 'TACAN 3X SHL' },
]

/** Beacons named in the mission-editor labels that are not in the export's TACAN list. */
export const EXTRA_BEACONS: Record<string, { id: string; chan: string; site: string }[]> = {
  Syria: [{ id: 'WRS', chan: '8X', site: 'Weapons Range South' }],
}
