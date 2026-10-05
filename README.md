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
   the TACAN fix under the cursor.
3. Set aircraft, takeoff time, fuel, TAS and wind. Per-leg TAS and fuel flow can be overridden.
4. Save the nav log as kneeboard PNGs (3:4 portrait, 1536x2048, one per page) or a PDF, or print it.
   PNGs go in `Saved Games\DCS\Kneeboard\<aircraft>` (or `Saved Games\DCS\Kneeboard` for every aircraft).
   The route is saved in the browser.

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

Fuel defaults per aircraft are placeholder estimates, not flight-manual data.

## Development

```sh
npm install
npm run dev     # local server
npm test        # nav math tests against test/fixtures/targets_syria.json
npm run build   # static site in dist/
```

Pushes to `main` deploy to GitHub Pages (Settings > Pages > Source: GitHub Actions).
