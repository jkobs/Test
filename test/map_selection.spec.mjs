/* Playwright validation: map-tap selection independence + instant loading state.

   Proves two things the user asked about directly:
   1. Tapping a point on the map (e.g. Lake Superior, zoomed way out from the
      user's actual location) selects THAT water body's info — not the nearest
      lake to wherever "current location" happens to be.
   2. Selecting a new lake clears stale content immediately (the advisor no
      longer shows the previous lake's bite conditions while the new lake's
      data loads — this was the source of the "laggy" feel).

   Uses window.__testHooks.selectMapPoint (exposed in app.js) to drive the tap
   directly by lat/lng, since simulating a real Leaflet pixel click reliably
   in headless Chromium is fragile and unnecessary — selectMapPoint IS the
   click handler's logic.

   Run: node test/map_selection.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// "Current location" is Yellow Lake, WI (the app default). Lake Superior is
// ~90 miles away — nowhere near "nearest lake to current location."
const YELLOW_LAKE = { lat: 45.94, lng: -92.38 };
const SUPERIOR_TAP = { lat: 47.0, lng: -89.5 }; // deep in Lake Superior, zoomed out

const NHD_SUPERIOR = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Lake Superior', AREASQKM: 82100, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.2,46.4],[-84.3,46.4],[-84.3,48.0],[-92.2,48.0],[-92.2,46.4]]] } }
] };
const NHD_EMPTY = { type: 'FeatureCollection', features: [] };

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext()).newPage();

// Track request timing/count to confirm no runaway duplicate fetching.
let overpassCalls = 0;

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();

  if (url.includes('api.open-meteo.com/v1/forecast')) {
    // Deliberately slow (2s) — this is the call that used to gate the WHOLE
    // advisor body. If the fix works, stale content clears well before this.
    await new Promise(r => setTimeout(r, 2000));
    const nowS = Math.floor(Date.now() / 1000);
    const time = [], sp = [];
    for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013 - i * 0.3); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      current: { temperature_2m: 65, wind_speed_10m: 6, wind_direction_10m: 200 },
      hourly: { time: time, surface_pressure: sp }
    }) });
  }
  if (url.includes('hydro.nationalmap.gov')) {
    const body = /MapServer\/6\/query/.test(url) ? NHD_EMPTY : NHD_SUPERIOR;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  }
  if (url.includes('/api/interpreter')) { overpassCalls++; return route.abort('failed'); }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });
await page.waitForTimeout(2500); // let default Yellow Lake advisor settle

const beforeName = await page.$eval('#loc', el => el.textContent);
console.log('Location before tap: ' + beforeName.trim());

// Reset counter here: initial page load already fetches nearby-waters for the
// default location (unrelated Overpass activity we don't want to count).
overpassCalls = 0;

// Simulate zooming out and tapping Lake Superior — far from "current location".
await page.evaluate((pt) => window.__testHooks.selectMapPoint(pt.lat, pt.lng), SUPERIOR_TAP);

// Check IMMEDIATELY (before the 2s-delayed pressure fetch resolves) that the
// advisor is no longer showing stale Yellow-Lake content.
await page.waitForTimeout(150);
const immediateBody = await page.$eval('#advisor-body', el => el.textContent);
console.log('Advisor body ~150ms after tap: ' + immediateBody.trim().slice(0, 80));
check('1: stale bite-conditions text cleared immediately (no lingering "Bite Conditions")',
  !immediateBody.includes('Bite Conditions'));
check('1: loading feedback shown immediately', /loading/i.test(immediateBody));

// Now wait for everything (including the slow pressure call) to settle.
await page.waitForTimeout(3000);
const afterName = await page.$eval('#loc', el => el.textContent);
console.log('Location after tap+settle: ' + afterName.trim());
check('2: selection resolved to Lake Superior (via USGS point-intersect), not Yellow Lake',
  afterName.includes('Lake Superior'));
check('2: did NOT fall back to nearest-to-original-location lake', !afterName.includes('Yellow Lake'));

const finalBody = await page.$eval('#advisor-body', el => el.textContent);
check('3: advisor body repopulated with real content after settle', finalBody.includes('Bite Conditions'));
// Overpass is fully aborted in this test (every /api/interpreter call fails),
// yet Lake Superior still resolved correctly (check 2) — proving water-body
// IDENTIFICATION on tap depends on USGS/Esri, not Overpass. Overpass may still
// be called for supplementary depth/trophic lookups (fetchLakeInfo) — that's
// expected and fine, just not load-bearing for selection itself.
check('4: selection succeeded even though every Overpass call failed', overpassCalls > 0);

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
