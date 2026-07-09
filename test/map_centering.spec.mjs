/* Playwright validation: selecting a water body centers the map on the LAKE
   (its bounding-box center), not the nearest-edge point used for "X mi away"
   distance display.

   Real bug this catches: a screenshot showed the Fishing Advisor map framed
   on farmland with only slivers of water at the image edges after selecting
   "Bass Lake" from the nearby-waters dropdown. Root cause: the map was
   centered on the boundary-clamped nearest-edge point (used correctly for
   distance math) instead of the lake's actual center, so most of the lake
   fell outside the visible map viewport.

   This test picks a lake whose bounds put the user's location far from the
   lake's true center, so the nearest-edge point and the center are clearly
   different coordinates, then asserts the map focuses on the center.

   Run: node test/map_centering.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext()).newPage();

// A large lake stretching well north of the user's position. Bounds:
// lat 46.60-46.70, lng -90.90--90.80. User is at 46.59 (just south of it).
// Nearest-edge point = (46.60, -90.85) — the southern tip.
// True center       = (46.65, -90.85) — ~0.05deg (~3.5 mi) further north.
const LAKE_BOUNDS = { minlat: 46.60, minlon: -90.90, maxlat: 46.70, maxlon: -90.80 };
const EXPECTED_CENTER = { lat: (LAKE_BOUNDS.minlat + LAKE_BOUNDS.maxlat) / 2, lng: (LAKE_BOUNDS.minlon + LAKE_BOUNDS.maxlon) / 2 };
const USER = { lat: 46.59, lng: -90.85 };

const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Stretch Lake', AREASQKM: 30, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[
      [LAKE_BOUNDS.minlon, LAKE_BOUNDS.minlat], [LAKE_BOUNDS.maxlon, LAKE_BOUNDS.minlat],
      [LAKE_BOUNDS.maxlon, LAKE_BOUNDS.maxlat], [LAKE_BOUNDS.minlon, LAKE_BOUNDS.maxlat],
      [LAKE_BOUNDS.minlon, LAKE_BOUNDS.minlat]
    ]] } }
] };

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('geocoding-api.open-meteo.com')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      results: [{ name: 'Test City', admin1: 'Wisconsin', country_code: 'US',
        latitude: USER.lat, longitude: USER.lng, timezone: 'America/Chicago' }]
    }) });
  }
  if (url.includes('api.open-meteo.com/v1/forecast')) {
    const nowS = Math.floor(Date.now() / 1000);
    const time = [], sp = [];
    for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      current: { temperature_2m: 65, wind_speed_10m: 5, wind_direction_10m: 180 },
      hourly: { time, surface_pressure: sp }
    }) });
  }
  if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_WB) });
  }
  if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com') || url.includes('wikipedia.org'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
  if (url.includes('/api/interpreter')) return route.abort('failed');
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
// The search stack lives in a sheet toggled by #loc-pill (Stage 2 header
// collapse) — open it before the first search interaction.
await page.click('#loc-pill');
await page.fill('#city-input', 'Test City, Wisconsin');
await page.click('#city-go');
await page.waitForSelector('.city-result', { timeout: 15000 });
await page.click('.city-result');
await page.click('.tab[data-tab="lake"]');
await page.waitForSelector('#nearby-select', { timeout: 20000 });
await page.waitForTimeout(2000);

// The #loc pill only shows the lake NAME now (coordinates were dropped —
// they don't fit a pill), so read the resolved lat/lng straight from the
// window.__testHooks.getLoc() test hook instead of parsing pill text.
const loc = await page.evaluate(() => window.__testHooks.getLoc());
console.log('Location: ' + JSON.stringify(loc));

const shownLat = loc.lat, shownLng = loc.lng;
console.log('Shown coords:  ' + shownLat + ', ' + shownLng);
console.log('Lake center:   ' + EXPECTED_CENTER.lat + ', ' + EXPECTED_CENTER.lng);
console.log('Nearest edge:  ' + LAKE_BOUNDS.minlat + ', ' + USER.lng + ' (what it used to incorrectly show)');

check('lake selected (Stretch Lake)', loc.name.includes('Stretch Lake'));
check('map focuses on the lake CENTER (within 0.01deg)',
  Math.abs(shownLat - EXPECTED_CENTER.lat) < 0.01 && Math.abs(shownLng - EXPECTED_CENTER.lng) < 0.01);
check('map does NOT focus on the nearest-edge point (the old bug)',
  Math.abs(shownLat - LAKE_BOUNDS.minlat) > 0.02);

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
