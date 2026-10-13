/* Playwright validation: species evidence stays tied to THIS water body, not a
   different identically-named or merely nearby one (Wisconsin has a dozen+
   lakes named "Bass Lake").

   Stocking evidence used to come from a DNR service queried by lake NAME plus
   a search radius, so this spec asserted that query carried a spatial filter.
   That service was removed by DNR (404), and stocking now comes from
   FH_ANNUAL_STOCKING_SUMMARY keyed by the lake's exact WBIC — which is
   resolved from the 24K hydro polygon directly under the selected point. So
   the guarantee is now stronger and the assertions follow it:
     - the WBIC lookup is a tight point query,
     - stocking is requested by that exact WBIC, never by name,
     - the removed service is never called,
     - iNaturalist (which has no name filter) keeps a size-scaled radius.

   Run: node test/species_accuracy.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
// The dev sandbox ships a pinned Chromium; anywhere else (CI) fall back to
// Playwright's own browser by leaving executablePath undefined.
const { existsSync } = await import('fs');
const PINNED_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = existsSync(PINNED_CHROME) ? PINNED_CHROME : undefined;

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext()).newPage();

let inatUrl = null, stockUrl = null, deadUrl = null, wbicUrl = null;

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  // WBIC comes from the 24K hydro polygon under the point; stocking is then
  // fetched by that exact WBIC (the old name+radius stocking service is gone).
  if (url.includes('WY_INLAND_WATER_RESOURCES')) {
    wbicUrl = url;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
      { attributes: { WATERBODY_ROW_NAME: 'Bass Lake', WATERBODY_WBIC: 1111111 } }
    ] }) });
  }
  if (url.includes('FH_ANNUAL_STOCKING_SUMMARY')) {
    stockUrl = url;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
      { attributes: { WBIC: 1111111, STOCKING_RECORDS_JSON: JSON.stringify([
        { year: new Date().getFullYear() - 2, species: 'WALLEYE', number_stocked: 4000 }
      ]) } }
    ] }) });
  }
  if (url.includes('FM_Fish_Stocking_Public')) deadUrl = url;
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

console.log('WBIC lookup URL:  ' + (wbicUrl || '(none captured)'));
console.log('Stocking URL:     ' + (stockUrl || '(none captured)'));
console.log('iNat request URL: ' + (inatUrl || '(none captured)'));

check('WBIC is resolved by a point query (not name-only)',
  !!wbicUrl && wbicUrl.includes('geometry=') && wbicUrl.includes('spatialRel=esriSpatialRelIntersects'));
check('WBIC point query is tight (150 m, the polygon under the point)',
  !!wbicUrl && /distance=150\b/.test(wbicUrl));
check('stocking is requested by the exact WBIC',
  !!stockUrl && decodeURIComponent(stockUrl).includes('WBIC=1111111'));
check('stocking is NOT requested by lake name',
  !!stockUrl && !/WATER_BODY_NAME|LIKE/i.test(decodeURIComponent(stockUrl)));
check('the removed FM_Fish_Stocking_Public service is never called', deadUrl === null);
var inatRadiusKm = inatUrl && (inatUrl.match(/radius=([\d.]+)/) || [])[1];
check('iNaturalist query uses a scaled radius within 1.6-5.0 km (not the old wide 8 km)',
  !!inatRadiusKm && +inatRadiusKm >= 1.6 && +inatRadiusKm <= 5.0);

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
