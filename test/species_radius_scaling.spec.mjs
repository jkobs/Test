/* Playwright validation: species search radius scales with the lake's own
   size instead of using a flat distance.

   Reproduces the exact "Cedar Lake" bug from a live screenshot: a large
   1120-acre lake showed NO species at all (not even a wrong one — the fixed
   ~1 mi search radius used after the previous accuracy fix was too tight for
   a lake this size, so both DNR and iNaturalist queries came up empty).

   This test uses a lake sized to roughly match Cedar Lake and asserts the
   resulting DNR/iNaturalist search radius is meaningfully larger than the
   1600m floor used for small lakes — proving big lakes get a proportionally
   wider search rather than being stuck at the same tight radius that only
   suits small lakes.

   Run: node test/species_radius_scaling.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

// Cedar Lake is ~1120 acres (~1.75 sq mi). A roughly square lake of that area
// is about 1.32 mi on a side -> bounds spanning ~0.019 degrees lat/lng.
const CEDAR_BOUNDS = { minlat: 45.30, minlon: -93.06, maxlat: 45.319, maxlon: -93.021 };
const CEDAR_CENTER = { lat: (CEDAR_BOUNDS.minlat + CEDAR_BOUNDS.maxlat) / 2, lng: (CEDAR_BOUNDS.minlon + CEDAR_BOUNDS.maxlon) / 2 };

const NHD_CEDAR = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Cedar Lake', AREASQKM: 4.5, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[
      [CEDAR_BOUNDS.minlon, CEDAR_BOUNDS.minlat], [CEDAR_BOUNDS.maxlon, CEDAR_BOUNDS.minlat],
      [CEDAR_BOUNDS.maxlon, CEDAR_BOUNDS.maxlat], [CEDAR_BOUNDS.minlon, CEDAR_BOUNDS.maxlat],
      [CEDAR_BOUNDS.minlon, CEDAR_BOUNDS.minlat]
    ]] } }
] };

let dnrDistances = [], inatRadii = [];

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext()).newPage();

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('api.open-meteo.com/v1/forecast')) {
    const nowS = Math.floor(Date.now() / 1000);
    const time = [], sp = [];
    for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      current: { temperature_2m: 65, wind_speed_10m: 5, wind_direction_10m: 180 },
      hourly: { time, surface_pressure: sp }
    }) });
  }
  if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_CEDAR) });
  if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com') && !url.includes('FM_Fish_Stocking'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
  if (url.includes('/api/interpreter')) return route.abort('failed');
  if (url.includes('FM_Fish_Stocking_Public')) {
    var m = url.match(/distance=(\d+)/);
    if (m) dnrDistances.push(+m[1]);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
      { attributes: { SPECIES_NAME: 'Walleye', WBIC: '9998887' } }
    ] }) });
  }
  if (url.includes('api.inaturalist.org')) {
    var rm = url.match(/radius=([\d.]+)/);
    if (rm) inatRadii.push(+rm[1]);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });

await page.evaluate((pt) => window.__testHooks.selectMapPoint(pt.lat, pt.lng), CEDAR_CENTER);
await page.waitForTimeout(3000);

console.log('DNR distances requested (m): ' + JSON.stringify(dnrDistances));
console.log('iNat radii requested (km):   ' + JSON.stringify(inatRadii));

const lakeInfoText = await page.$eval('#lake-info', el => el.textContent).catch(() => '');
console.log('Lake info: ' + lakeInfoText.replace(/\s+/g, ' ').trim());

check('Cedar Lake resolved correctly', lakeInfoText.includes('Cedar Lake'));
check('DNR search distance scaled UP beyond the 1600m small-lake floor', dnrDistances.some(d => d > 1600));
check('iNaturalist radius scaled UP beyond the 1.6km small-lake floor', inatRadii.some(r => r > 1.6));
check('species now found for the large lake (was empty before this fix)', lakeInfoText.includes('Walleye'));

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
