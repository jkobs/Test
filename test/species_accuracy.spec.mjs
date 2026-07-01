/* Playwright validation: species lookups are geographically constrained so a
   lake doesn't inherit species from a different, identically-named or merely
   nearby water body (e.g. Wisconsin has a dozen+ lakes named "Bass Lake";
   without a spatial filter the DNR name-only query pulled stocking records
   from ALL of them).

   This test intercepts the outgoing DNR/iNaturalist requests and asserts they
   carry a tight geographic constraint, rather than a name-only / wide-radius
   query that could pull in an unrelated water body's species.

   Run: node test/species_accuracy.spec.mjs
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

let dnrUrl = null, inatUrl = null;

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('FM_Fish_Stocking_Public')) {
    dnrUrl = url;
    // Two "Bass Lake" records with DIFFERENT WBICs simulate two distinct real
    // lakes sharing a name. The point is just to confirm the request itself
    // carries a spatial constraint — a live DNR server would only return the
    // geographically-matching one once the filter is applied server-side.
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
      { attributes: { SPECIES_NAME: 'Walleye', WBIC: '1111111' } }
    ] }) });
  }
  if (url.includes('api.inaturalist.org')) {
    inatUrl = url;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
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
    // Layer 12 (waterbodies): a "Bass Lake" covering the tapped point, so the
    // tap resolves to a real selection and triggers the species lookup.
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { GNIS_NAME: 'Bass Lake', AREASQKM: 1.2, FTYPE: 390 },
        geometry: { type: 'Polygon', coordinates: [[[-92.40,45.93],[-92.36,45.93],[-92.36,45.95],[-92.40,45.95],[-92.40,45.93]]] } }
    ] }) });
  }
  if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });
await page.waitForTimeout(1500);

// Trigger a species lookup for "Bass Lake" via the exposed test hook.
await page.evaluate(() => window.__testHooks.selectMapPoint(45.94, -92.38));
await page.waitForTimeout(2500);

console.log('DNR request URL:  ' + (dnrUrl || '(none captured)'));
console.log('iNat request URL: ' + (inatUrl || '(none captured)'));

check('DNR query includes a point geometry (not name-only)', !!dnrUrl && dnrUrl.includes('geometry='));
check('DNR query uses intersects spatial filter', !!dnrUrl && dnrUrl.includes('spatialRel=esriSpatialRelIntersects'));

// Distance/radius now scale with the water body's own size (floor ~1 mi /
// 1600m, cap ~3.1 mi / 5000m) instead of a flat number — a flat 1 mi radius
// returned zero species for large lakes. Assert the value stays within that
// bounded range (still far tighter than the old unconstrained/8km behavior),
// rather than pinning an exact literal.
var dnrDistM = dnrUrl && (dnrUrl.match(/distance=(\d+)/) || [])[1];
check('DNR query constrains distance within the scaled 1600-5000m range',
  !!dnrDistM && +dnrDistM >= 1600 && +dnrDistM <= 5000);
var inatRadiusKm = inatUrl && (inatUrl.match(/radius=([\d.]+)/) || [])[1];
check('iNaturalist query uses a scaled radius within 1.6-5.0 km (not the old wide 8 km)',
  !!inatRadiusKm && +inatRadiusKm >= 1.6 && +inatRadiusKm <= 5.0);

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
