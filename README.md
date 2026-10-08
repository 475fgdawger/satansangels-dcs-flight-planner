# 433rd TFS Flight Planner

A browser flight planner for the Satan's Angels Cold War server (Syria TDY, NTTR, Operation Steel Tiger).
Load a mission's target list export from the bot, build a route, and print a nav log with a TACAN
radial/DME fix and coordinates for every waypoint.

## Using it

1. Open the app and pick one of the **Current missions** (pushed by the bot), or open or drop a
   `targets_<mission>.json` file (the DCSServerBot targetlist export).
2. Add waypoints: pick an airfield, mission zone, range target, TACAN station, map label or place, or
   type a TACAN fix (`DAN 287/99`) or coordinates (`N37 37.05 E033 30.65`, DMS or decimal also work).
   On the map, click a target, airfield, TACAN, zone or label to add it, click open map for a waypoint
   there, or drag a waypoint to move it. The map shows threat rings (approximate), TACAN DME rings and
   the TACAN fix under the cursor, plus the mission editor's drawings (one overlay per draw layer) when
   the bot export includes them.
3. Set aircraft, takeoff time, fuel and wind. For the F-4E (recorded performance data, see below) also set the
   drag category and temperature, then an altitude at each waypoint and, if you want other than the default, a speed
   (KIAS or Mach) for each leg. The planner works out the RPM to set, fuel flow, MIL climbs and idle descents (with
   top of descent), and joker and bingo. Per-leg fuel flow can be overridden. Aircraft without recorded data use a
   TAS and a fixed fuel flow per phase.
4. Save the nav log as kneeboard PNGs (3:4 portrait, 1536x2048, one per page) or a PDF, or print it. A strip map page per
   leg follows the nav log: course up, with MC/MH, distance, GS, ETE, altitude and fuel, distance-to-go and time ticks,
   a TACAN radial/DME checkpoint at each tick, threat rings, TACANs, airfields and the mission drawings.
   PNGs go in `Saved Games\DCS\Kneeboard\<aircraft>` (or `Saved Games\DCS\Kneeboard` for every aircraft).
   The route is saved in the browser.
5. **Copy share link** puts the route and settings in a link; anyone who opens it gets the same plan
   (the mission loads from the site's Current missions).

## Mission data from the bot

The bot's targetlist plugin writes `targets_<mission>.json` each time a mission's target list is built.
With `github:` set in `config/plugins/targetlist.yaml` it also commits the file to
`public/data/missions/` here; the commit redeploys the site, and `scripts/mission-index.mjs` lists
the missions at build time. Every point carries `elev_ft` (DCS `land.getHeight`, ft MSL). Points
without it (typed fixes) get a real-world terrain estimate in the browser, shown with ≈.

## Nav conventions

These match the bot's target list, and the tests check them against a real export:

- TACAN fix: magnetic radial FROM the station using the station's mag var, then nm (`DAN 112/93`,
  `000` written `360`). Distances and bearings are on the WGS84 ellipsoid.
- Coordinates: degrees + decimal minutes for F-4E INS entry, and DMS to match the target list.
- Nearby reference: `8 nm NNW of Aleppo` (16-point compass, mag var at the point).
- MC/MH on each leg use the mag var at the leg's start point, interpolated from DCS's values in the export.

## Performance data

`src/data/perf/<aircraft>.json` is recorded in DCS with dcs-perf-recorder (`perfrec.py export` writes
`out/planner/<aircraft>.app.json`; copy it here). It holds the same numbers as the squadron performance manual:

- **Level cruise**: No Stores level points per altitude band (sea level to 35,000 ft), standard day, with RPM.
  Lookups interpolate along Mach and between bands; flags mark interpolation across wide gaps (≈) and speeds
  above max level / below min level.
- **Drag categories**: a factor per category from loaded runs at 10,000 ft. A loaded jet at a speed uses the
  No Stores fuel flow and RPM at KIAS × √factor (the loaded jet holds KIAS / √factor at the same RPM).
- **Temperature**: at the same Mach and pressure altitude, TAS, fuel flow and RPM scale with √(T / T std).
- **Climb / descent**: MIL climb and idle descent tables; loaded climbs are the No Stores climb × √factor (estimate,
  flagged, until a loaded climb is recorded).
- **MIL / max AB** fuel flow points, ground idle and the max AB takeoff (brake release to 450 KIAS; the MIL climb
  follows on the first leg).

Joker and bingo with recorded data (fuel states at the TGT or CAP):

- **Bingo**: MIL climb to the altitude (up to the bingo ceiling) that needs the least fuel home, cruise at 7.5 units
  AoA, idle descent, plus the 3,000 lb landing reserve. Always at BFM Only drag (stores gone, missiles and tank kept),
  whatever the plan's drag category.
- **Joker**: the planned loiter, 1 min max AB, 30 nm escape at 95 % RPM at 500 ft above the target, MIL climb to
  20,000 ft, home at 95 % RPM, idle descent, plus the reserve. Never below bingo.

F-5E and F-100D fuel defaults are placeholder estimates, not flight-manual data.

## Development

```sh
npm install
npm run dev     # local server
npm test        # nav math tests against test/fixtures/targets_syria.json
npm run build   # static site in dist/
```

Pushes to `main` deploy to GitHub Pages (Settings > Pages > Source: GitHub Actions).
