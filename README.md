# 433rd TFS Flight Planner

A browser flight planner for the Satan's Angels Cold War server (Syria TDY, NTTR, Operation Steel Tiger).
Load a mission's target list export from the bot, build a route, and print a nav log with a TACAN
radial/DME fix and coordinates for every waypoint.

## Using it

1. Open the app and load `targets_<mission>.json` (the DCSServerBot targetlist export), or click
   **Load Syria sample**.
2. Add waypoints: pick an airfield, mission zone, range target, TACAN station, map label or place, or
   type a TACAN fix (`DAN 287/99`) or coordinates (`N37 37.05 E033 30.65`, DMS or decimal also work).
3. Set aircraft, takeoff time, fuel, TAS and wind. Per-leg TAS and fuel flow can be overridden.
4. Print the nav log (landscape). The route is saved in the browser.

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
