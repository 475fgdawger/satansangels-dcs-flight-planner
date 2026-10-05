// Lists the mission exports the bot has pushed (public/data/missions/*.json) in index.json,
// which the site reads to offer "Current missions". Runs before every build.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'public/data/missions'
const missions = []
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort()) {
  try {
    const m = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    if (m.schema !== 1 || !m.mission) throw new Error('not a schema 1 export')
    missions.push({ file, name: m.mission.name, theatre: m.mission.theatre, built_utc: m.built_utc })
  } catch (e) {
    console.warn(`mission-index: skipping ${file}: ${e.message}`)
  }
}
writeFileSync(join(dir, 'index.json'), JSON.stringify(missions, null, 1) + '\n')
console.log(`mission-index: ${missions.length} mission(s)`)
